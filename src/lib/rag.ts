import { embed, getChat, getEmbeddings, type ChatProvider, type EmbeddingProvider } from "./ai";
import { MOVIE_COLUMNS, readClient, type MovieHit } from "./db";
import { SEARCH_PLAN_JSON_SCHEMA, parsePlan, planSystem, type SearchPlan } from "./plan";

export interface Turn {
  role: "user" | "assistant";
  content: string;
}

export interface AskResult {
  answer: string;
  movies: MovieHit[];
  plan: SearchPlan;
  route: Route;
}

/** vector: filters + meaning · keyword: filters + full-text (no embedding model) · sql: filters only */
export type Route = "vector" | "keyword" | "sql";

const MATCH_COUNT = 8;

/** Which models answer this request. Defaults to the AI_PROVIDER / EMBED_PROVIDER env settings. */
export interface AskProviders {
  chat: ChatProvider;
  /** null = no embedding model available (the free tier): topics use keyword search instead. */
  embeddings: EmbeddingProvider | null;
  /** Model for the planning step, if different from `chat` (spreads per-model rate limits). */
  planner?: ChatProvider;
  /** Send shorter movie descriptions to the answer step (for tight token budgets). */
  compactSources?: boolean;
}

/**
 * The full RAG loop:
 *   1. plan:     LLM turns the question into SQL filters + a semantic topic
 *   2. retrieve: hybrid search (filters, then vector similarity) or plain SQL
 *   3. generate: LLM answers using ONLY the retrieved movies
 */
export async function ask(
  question: string,
  history: Turn[] = [],
  providers: AskProviders = { chat: getChat(), embeddings: getEmbeddings() },
): Promise<AskResult> {
  const { chat } = providers;

  // 1. Plan
  const planOutput = await (providers.planner ?? chat).complete({
    system: planSystem(),
    prompt: `${formatHistory(history)}Question: ${question}`,
    jsonSchema: SEARCH_PLAN_JSON_SCHEMA,
    maxTokens: 1024,
  });
  const plan = parsePlan(planOutput, question);

  // 2. Retrieve
  let route: Route = !plan.topic ? "sql" : providers.embeddings ? "vector" : "keyword";
  let movies =
    route === "vector"
      ? await vectorSearch(plan, providers.embeddings ?? undefined)
      : route === "keyword"
        ? await keywordSearch(plan)
        : await sqlSearch(plan);

  // Keywords can miss when the words don't appear in any plot ("something fun"):
  // fall back to the filters alone so the user still gets matching films.
  if (route === "keyword" && movies.length === 0) {
    route = "sql";
    movies = await sqlSearch(plan);
  }

  if (movies.length === 0) {
    return {
      answer: `I couldn't find any movies in the database matching ${describeFilters(plan) || "that"}. Try loosening the filters (years, language, runtime, genre).`,
      movies,
      plan,
      route,
    };
  }

  // 3. Generate
  const answer = await chat.complete({
    system: ANSWER_SYSTEM,
    prompt:
      `${formatHistory(history)}Search filters applied: ${describeFilters(plan) || "none"}\n\n` +
      `Top search results (${movies.length} movies):\n\n${formatSources(movies, { compact: providers.compactSources })}\n\nQuestion: ${question}`,
    maxTokens: 2048,
  });

  return { answer: answer.trim(), movies, plan, route };
}

/**
 * Minimum votes for a rating-sorted list, mirroring the ingest thresholds: regional
 * cinema and a director's full filmography have fewer votes, as do recent releases.
 */
export function minVotesForRating(plan: SearchPlan, today: Date = new Date()): number {
  if (plan.language || plan.director) return 20;
  if (plan.min_year !== null && plan.min_year >= today.getUTCFullYear() - 2) return 50;
  return 200;
}

/** Words that appear in nearly every plot or question and only slow keyword search down. */
const GENERIC_WORDS = new Set([
  "movie", "movies", "film", "films", "story", "stories", "about", "something", "like", "similar",
  "kind", "type", "good", "great", "best", "show", "watch", "recommend", "recommendation",
]);

/** The topic minus generic words; falls back to the full topic if nothing distinctive is left. */
export function keywordQuery(topic: string): string {
  // Split on hyphens too: Postgres would turn "feel-good" into "feel" + "good" anyway.
  const words = topic
    .split(/[\s\-‐-―]+/)
    .filter((w) => w && !GENERIC_WORDS.has(w.toLowerCase().replace(/[^a-z]/g, "")));
  return words.length > 0 ? words.join(" ") : topic;
}

/** Free-tier search without an embedding model: SQL filters + Postgres full-text relevance. */
export async function keywordSearch(plan: SearchPlan): Promise<MovieHit[]> {
  const { data, error } = await readClient().rpc("keyword_movies", {
    p_query: keywordQuery(plan.topic),
    p_match_count: MATCH_COUNT,
    p_min_year: plan.min_year,
    p_max_year: plan.max_year,
    p_max_runtime: plan.max_runtime,
    p_min_rating: plan.min_rating,
    p_genre: plan.genre,
    p_director: plan.director,
    p_language: plan.language,
  });
  if (error) {
    // A very broad query can still be slow; return nothing so ask() falls back to filters-only SQL.
    if (/timeout/i.test(error.message)) return [];
    throw new Error(`keyword_movies failed: ${error.message}`);
  }
  return (data ?? []) as MovieHit[];
}

/** Hybrid search: SQL filters narrow the set, then rank by meaning. */
export async function vectorSearch(plan: SearchPlan, embeddings: EmbeddingProvider = getEmbeddings()): Promise<MovieHit[]> {
  const [queryEmbedding] = await embed(embeddings, [plan.topic], "query");
  const { data, error } = await readClient().rpc("match_movies", {
    p_query_embedding: JSON.stringify(queryEmbedding),
    p_match_count: MATCH_COUNT,
    p_min_year: plan.min_year,
    p_max_year: plan.max_year,
    p_max_runtime: plan.max_runtime,
    p_min_rating: plan.min_rating,
    p_genre: plan.genre,
    p_director: plan.director,
    p_language: plan.language,
  });
  if (error) throw new Error(`match_movies failed: ${error.message}`);
  return (data ?? []) as MovieHit[];
}

/** Fact questions ("top rated Nolan films") need no embeddings, just SQL. */
export async function sqlSearch(plan: SearchPlan): Promise<MovieHit[]> {
  let query = readClient().from("movies").select(MOVIE_COLUMNS);
  if (plan.min_year !== null) query = query.gte("year", plan.min_year);
  if (plan.max_year !== null) query = query.lte("year", plan.max_year);
  if (plan.max_runtime !== null) query = query.lte("runtime", plan.max_runtime);
  if (plan.min_rating !== null) query = query.gte("rating", plan.min_rating);
  if (plan.genre) query = query.contains("genres", [plan.genre]);
  if (plan.director) query = query.ilike("director", `%${plan.director}%`);
  if (plan.language) query = query.eq("original_language", plan.language);
  // A 10/10 from five voters isn't "top rated": rank only films with enough votes.
  if (plan.sort !== "newest") query = query.gte("vote_count", minVotesForRating(plan));

  query =
    plan.sort === "newest"
      ? query.order("year", { ascending: false, nullsFirst: false })
      : query.order("rating", { ascending: false, nullsFirst: false });

  const { data, error } = await query.limit(MATCH_COUNT);
  if (error) throw new Error(`movie query failed: ${error.message}`);
  return (data ?? []) as MovieHit[];
}

/** "More like this": nearest neighbours of a movie's own embedding. No LLM call. */
export async function similarMovies(movieId: number, count = 6): Promise<MovieHit[]> {
  const { data, error } = await readClient().rpc("similar_movies", {
    p_movie_id: movieId,
    p_match_count: count,
  });
  if (error) throw new Error(`similar_movies failed: ${error.message}`);
  return (data ?? []) as MovieHit[];
}

const ANSWER_SYSTEM = `You are a friendly movie expert answering questions about a movie database.

You are given the top search results for the question, NOT the whole database, along with
the filters the search used. Never describe what the database as a whole contains.

Rules:
- Use ONLY the movies listed under "Top search results". Never recommend or mention
  a movie that isn't in that list, even if you know it.
- If the user asked for something (a language, a year, a genre) and the results don't
  match it, say plainly that you couldn't find that in the database, then offer the closest
  results only if they're still useful.
- Refer to movies by title and year in bold, e.g. **Dark City (1998)**.
- For recommendations, pick the best 3-5 matches and say in one sentence why each fits.
- If none of the listed movies really fit, say so honestly instead of stretching.
- Keep it concise.`;

const COMPACT_PLOT_CHARS = 350;
const COMPACT_DOC_LINES = /^(Title|Genres|Directed by|Starring):/;

/**
 * The retrieved movies as text for the answer prompt. `compact` keeps only the
 * title/genres/people lines and a trimmed plot (~5x fewer tokens than the full doc
 * with keywords and review snippets), for providers with tight token budgets.
 */
export function formatSources(movies: MovieHit[], { compact = false }: { compact?: boolean } = {}): string {
  return movies
    .map((m, i) => {
      const facts = [
        m.runtime ? `${m.runtime} min` : null,
        m.rating !== null ? `rated ${m.rating}/10` : null,
      ]
        .filter(Boolean)
        .join(", ");
      const body = compact ? compactDoc(m) : m.doc;
      return `[${i + 1}] ${facts ? `(${facts})\n` : ""}${body}`;
    })
    .join("\n\n---\n\n");
}

function compactDoc(m: MovieHit): string {
  const lines = m.doc.split("\n").filter((l) => COMPACT_DOC_LINES.test(l));
  const plot = (m.overview ?? "").trim();
  if (plot) lines.push(`Plot: ${plot.length > COMPACT_PLOT_CHARS ? `${plot.slice(0, COMPACT_PLOT_CHARS).trimEnd()}…` : plot}`);
  return lines.join("\n");
}

/** Human-readable summary of a plan's hard filters, e.g. "language ta, 2026, genre Action". */
export function describeFilters(plan: SearchPlan): string {
  const parts: string[] = [];
  if (plan.language) parts.push(`language ${plan.language}`);
  if (plan.min_year !== null && plan.min_year === plan.max_year) parts.push(`${plan.min_year}`);
  else if (plan.min_year !== null || plan.max_year !== null) parts.push(`years ${plan.min_year ?? "…"}–${plan.max_year ?? "…"}`);
  if (plan.genre) parts.push(`genre ${plan.genre}`);
  if (plan.director) parts.push(`director ${plan.director}`);
  if (plan.max_runtime !== null) parts.push(`≤ ${plan.max_runtime} min`);
  if (plan.min_rating !== null) parts.push(`rating ≥ ${plan.min_rating}`);
  return parts.join(", ");
}

function formatHistory(history: Turn[]): string {
  if (history.length === 0) return "";
  const recent = history.slice(-6);
  return `Earlier conversation:\n${recent.map((t) => `${t.role}: ${t.content}`).join("\n")}\n\n`;
}
