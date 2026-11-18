import { embed, getChat, getEmbeddings } from "./ai";
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
  route: "vector" | "sql";
}

const MATCH_COUNT = 8;

/**
 * The full RAG loop:
 *   1. plan:     LLM turns the question into SQL filters + a semantic topic
 *   2. retrieve: hybrid search (filters, then vector similarity) or plain SQL
 *   3. generate: LLM answers using ONLY the retrieved movies
 */
export async function ask(question: string, history: Turn[] = []): Promise<AskResult> {
  const chat = getChat();

  // 1. Plan
  const planOutput = await chat.complete({
    system: planSystem(),
    prompt: `${formatHistory(history)}Question: ${question}`,
    jsonSchema: SEARCH_PLAN_JSON_SCHEMA,
    maxTokens: 1024,
  });
  const plan = parsePlan(planOutput, question);

  // 2. Retrieve
  const route = plan.topic ? "vector" : "sql";
  const movies = route === "vector" ? await vectorSearch(plan) : await sqlSearch(plan);

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
      `Top search results (${movies.length} movies):\n\n${formatSources(movies)}\n\nQuestion: ${question}`,
    maxTokens: 2048,
  });

  return { answer: answer.trim(), movies, plan, route };
}

/** Hybrid search: SQL filters narrow the set, then rank by meaning. */
export async function vectorSearch(plan: SearchPlan): Promise<MovieHit[]> {
  const [queryEmbedding] = await embed(getEmbeddings(), [plan.topic], "query");
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

export function formatSources(movies: MovieHit[]): string {
  return movies
    .map((m, i) => {
      const facts = [
        m.runtime ? `${m.runtime} min` : null,
        m.rating !== null ? `rated ${m.rating}/10` : null,
      ]
        .filter(Boolean)
        .join(", ");
      return `[${i + 1}] ${facts ? `(${facts})\n` : ""}${m.doc}`;
    })
    .join("\n\n---\n\n");
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
