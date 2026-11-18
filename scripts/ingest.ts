// Ingest: TMDB discover -> details -> doc per movie -> embed -> upsert into Supabase.
//
//   npm run ingest            (reads .env.local)
//   npm run ingest:remote     (reads .env.remote)
//
// Selection (see .env.example): films from every year with >= INGEST_MIN_VOTES votes,
// plus films from the last INGEST_RECENT_YEARS years with >= INGEST_RECENT_MIN_VOTES.
//
// Work is saved in chunks, and movies already in the database are skipped, so an
// interrupted run can simply be re-run. INGEST_REFRESH=true re-processes everything.
// INGEST_DRY_RUN=true only counts what would be ingested (no Replicate cost).

import { embed, getEmbeddings } from "../src/lib/ai/index";
import { adminClient } from "../src/lib/db";
import { env, requireEnv } from "../src/lib/env";
import { buildWindows, type DiscoverWindow } from "../src/lib/ingest-windows";
import { buildMovieRow, type TmdbMovieDetails } from "../src/lib/movies";

const TMDB = "https://api.themoviedb.org/3";
const EMBED_BATCH = 32;
const CHUNK = 64; // movies fetched + embedded + saved per step

const int = (name: string, fallback: number) => {
  const n = Number.parseInt(env(name, String(fallback)), 10);
  return Number.isFinite(n) ? n : fallback;
};
const bool = (name: string) => env(name, "false").toLowerCase() === "true";

const config = {
  startYear: int("INGEST_START_YEAR", 1920),
  minVotes: int("INGEST_MIN_VOTES", 500),
  recentYears: int("INGEST_RECENT_YEARS", 2),
  recentMinVotes: int("INGEST_RECENT_MIN_VOTES", 50),
  // e.g. "ta,hi,te,ml,kn": these languages also get every film with >= extraMinVotes.
  extraLanguages: env("INGEST_EXTRA_LANGUAGES", "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[a-z]{2}$/.test(s)),
  extraMinVotes: int("INGEST_EXTRA_MIN_VOTES", 20),
  max: int("INGEST_MAX", 0), // 0 = no limit; set e.g. 50 for a quick test
  refresh: bool("INGEST_REFRESH"),
  dryRun: bool("INGEST_DRY_RUN"),
  concurrency: Math.max(1, int("TMDB_CONCURRENCY", 2)),
};

// ---------------------------------------------------------------- TMDB client
// Some networks reset bursts of parallel connections to TMDB (ECONNRESET), so keep
// concurrency low and retry network errors / rate limits with backoff.
const MAX_ATTEMPTS = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tmdb<T>(path: string): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${TMDB}${path}`, {
        headers: { authorization: `Bearer ${requireEnv("TMDB_READ_TOKEN")}`, accept: "application/json" },
      });
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw new Error(`TMDB ${path}: network error after ${attempt} attempts`, { cause: err });
      await sleep(500 * 2 ** (attempt - 1));
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** (attempt - 1));
      continue;
    }
    if (res.status === 401) throw new Error("TMDB rejected the token (401). Check TMDB_READ_TOKEN is the long 'API Read Access Token'.");
    if (!res.ok) throw new Error(`TMDB ${path} failed: ${res.status}`);
    return (await res.json()) as T;
  }
}

/** Runs `fn` over `items` with at most `limit` in flight. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

// ---------------------------------------------------------------- selection
interface DiscoverPage {
  page: number;
  total_pages: number;
  total_results: number;
  results: { id: number; original_language?: string }[];
}

/** Original language of every discovered movie, used to backfill rows stored before the column existed. */
const languageById = new Map<number, string>();

const windowFilter = (w: DiscoverWindow) =>
  `primary_release_date.gte=${w.from}&primary_release_date.lte=${w.to}&vote_count.gte=${w.minVotes}`;

/** All movies matching a discover filter (e.g. a year window, or one language). */
async function discoverIds(filter: string): Promise<number[]> {
  const base = `/discover/movie?include_adult=false&include_video=false&language=en-US&sort_by=vote_count.desc&${filter}`;
  const remember = (results: DiscoverPage["results"]) =>
    results.map((m) => {
      if (m.original_language) languageById.set(m.id, m.original_language);
      return m.id;
    });
  const first = await tmdb<DiscoverPage>(`${base}&page=1`);
  const ids = remember(first.results);
  const lastPage = Math.min(first.total_pages, 500); // TMDB's hard cap
  if (first.total_pages > 500) {
    console.warn(`\n  ! ${filter} has ${first.total_results} results; only the first 10,000 are reachable`);
  }
  for (let page = 2; page <= lastPage; page++) {
    const data = await tmdb<DiscoverPage>(`${base}&page=${page}`);
    ids.push(...remember(data.results));
  }
  return ids;
}

async function existingIds(): Promise<Set<number>> {
  const db = adminClient();
  const ids = new Set<number>();
  const PAGE = 1000; // PostgREST returns at most 1000 rows per request by default
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from("movies").select("id").order("id").range(from, from + PAGE - 1);
    if (error) throw new Error(`Reading existing movies failed: ${error.message}`);
    data.forEach((r: { id: number }) => ids.add(r.id));
    if (data.length < PAGE) return ids;
  }
}

/** Fills movies.original_language for stored rows that lack it (free: data comes from discover). */
async function backfillLanguages(): Promise<number> {
  const db = adminClient();
  const missing: number[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("movies").select("id").is("original_language", null).order("id").range(from, from + 999);
    if (error) throw new Error(`Reading movies without a language failed: ${error.message}`);
    missing.push(...data.map((r: { id: number }) => r.id));
    if (data.length < 1000) break;
  }

  // Group by language so one UPDATE covers many movies. Keep each UPDATE small: every
  // updated row is a new row version that must be re-inserted into the HNSW index,
  // and large updates hit Supabase's statement timeout.
  const byLang = new Map<string, number[]>();
  for (const id of missing) {
    const lang = languageById.get(id);
    if (lang) byLang.set(lang, [...(byLang.get(lang) ?? []), id]);
  }
  if (byLang.size === 0) return 0;
  let updated = 0;
  const total = [...byLang.values()].reduce((n, ids) => n + ids.length, 0);
  for (const [lang, ids] of byLang) {
    for (let i = 0; i < ids.length; i += LANG_CHUNK) {
      const part = ids.slice(i, i + LANG_CHUNK);
      await updateLanguage(db, lang, part);
      updated += part.length;
      process.stdout.write(`\r  setting languages: ${updated}/${total}   `);
    }
  }
  process.stdout.write("\n");
  return updated;
}

const LANG_CHUNK = 50;

async function updateLanguage(db: ReturnType<typeof adminClient>, lang: string, ids: number[], attempt = 1): Promise<void> {
  const { error } = await db.from("movies").update({ original_language: lang }).in("id", ids);
  if (!error) return;
  if (!/timeout/i.test(error.message)) throw new Error(`Setting language failed: ${error.message}`);
  if (ids.length > 1) {
    const mid = Math.ceil(ids.length / 2);
    await updateLanguage(db, lang, ids.slice(0, mid));
    await updateLanguage(db, lang, ids.slice(mid));
    return;
  }
  if (attempt >= 4) throw new Error(`Setting language failed after ${attempt} attempts: ${error.message}`);
  await sleep(2000 * attempt);
  await updateLanguage(db, lang, ids, attempt + 1);
}

/**
 * Inserting into the HNSW vector index gets slower as the table grows, and Supabase
 * cancels statements that run too long. On a timeout, retry the batch in halves
 * (down to single rows) so each statement stays short.
 */
async function upsertRows(db: ReturnType<typeof adminClient>, rows: Record<string, unknown>[], attempt = 1): Promise<void> {
  const { error } = await db.from("movies").upsert(rows);
  if (!error) return;
  const timedOut = /statement timeout|timeout/i.test(error.message);
  if (!timedOut) throw new Error(`Upsert failed: ${error.message}`);
  if (rows.length > 1) {
    const mid = Math.ceil(rows.length / 2);
    await upsertRows(db, rows.slice(0, mid));
    await upsertRows(db, rows.slice(mid));
    return;
  }
  if (attempt >= 4) throw new Error(`Upsert failed after ${attempt} attempts: ${error.message}`);
  await sleep(2000 * attempt);
  await upsertRows(db, rows, attempt + 1);
}

// ---------------------------------------------------------------- main
async function main() {
  // No request time limit here: if Replicate throttles us, keep waiting (up to 10 min per call).
  process.env.REPLICATE_MAX_THROTTLE_WAIT_MS ??= "600000";
  const windows = buildWindows({ today: new Date(), ...config });
  console.log(
    `Selecting movies: >= ${config.minVotes} votes since ${config.startYear}, ` +
      `>= ${config.recentMinVotes} votes in the last ${config.recentYears} year(s)`,
  );

  const selected = new Set<number>();
  for (const [i, w] of windows.entries()) {
    (await discoverIds(windowFilter(w))).forEach((id) => selected.add(id));
    process.stdout.write(`\r  scanned ${i + 1}/${windows.length} year windows · ${selected.size} movies`);
  }
  process.stdout.write("\n");

  // Regional cinema gets far fewer TMDB votes (no Tamil film has 500), so selected
  // languages get their own, lower bar across all years.
  for (const lang of config.extraLanguages) {
    const before = selected.size;
    (await discoverIds(`with_original_language=${lang}&vote_count.gte=${config.extraMinVotes}`)).forEach((id) => selected.add(id));
    console.log(`  + ${selected.size - before} more in '${lang}' (>= ${config.extraMinVotes} votes)`);
  }

  const already = config.refresh ? new Set<number>() : await existingIds();
  let todo = [...selected].filter((id) => !already.has(id));
  if (config.max > 0) todo = todo.slice(0, config.max);

  const batches = Math.ceil(todo.length / EMBED_BATCH);
  console.log(
    `  ${selected.size} selected · ${selected.size - [...selected].filter((id) => !already.has(id)).length} already stored · ` +
      `${todo.length} to ingest (${batches} embedding batches)`,
  );
  if (config.dryRun) {
    console.log("Dry run: nothing fetched, embedded or stored.");
    return;
  }
  const backfilled = await backfillLanguages();
  if (backfilled > 0) console.log(`  set the original language on ${backfilled} stored movies`);
  if (todo.length === 0) {
    console.log("Nothing new to ingest.");
    return;
  }

  const embedder = getEmbeddings();
  const db = adminClient();
  console.log(`Ingesting with ${embedder.name}...`);
  const started = Date.now();
  let stored = 0;
  let skipped = 0;

  for (let i = 0; i < todo.length; i += CHUNK) {
    const ids = todo.slice(i, i + CHUNK);
    const details = await mapLimit(ids, config.concurrency, (id) =>
      tmdb<TmdbMovieDetails>(`/movie/${id}?language=en-US&append_to_response=credits,keywords,reviews`),
    );
    // A movie with no plot makes a poor search target; skip it.
    const rows = details.filter((d) => d.overview?.trim()).map(buildMovieRow);
    skipped += details.length - rows.length;

    for (let j = 0; j < rows.length; j += EMBED_BATCH) {
      const batch = rows.slice(j, j + EMBED_BATCH);
      const vectors = await embed(embedder, batch.map((r) => r.doc), "document");
      await upsertRows(
        db,
        batch.map((row, k) => ({ ...row, embedding: JSON.stringify(vectors[k]), updated_at: new Date().toISOString() })),
      );
      stored += batch.length;
    }

    const done = Math.min(i + CHUNK, todo.length);
    const perMovie = (Date.now() - started) / done;
    const etaMin = Math.round(((todo.length - done) * perMovie) / 60_000);
    process.stdout.write(`\r  ${done}/${todo.length} processed · ${stored} stored · ${skipped} skipped (no plot) · ~${etaMin} min left   `);
  }
  process.stdout.write(`\nDone in ${Math.round((Date.now() - started) / 60_000)} min. Re-run any time to pick up new releases.\n`);
}

main().catch((err) => {
  console.error("\nIngest failed:", err instanceof Error ? err.message : err);
  // Node's fetch hides the real reason ("fetch failed") in err.cause.
  let cause = err instanceof Error ? err.cause : undefined;
  while (cause) {
    console.error("  caused by:", cause instanceof Error ? `${cause.name}: ${cause.message}` : cause);
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  console.error("Progress so far is saved. Re-run the same command to continue.");
  process.exit(1);
});
