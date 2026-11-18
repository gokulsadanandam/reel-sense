# ReelSense

**Movie search that understands what you mean.** Ask for movies in plain English, e.g. *"something like Inception but from the 90s, under 2 hours"*,
and get recommendations drawn **only** from your own movie database, with posters and a
"More like this" button.

Built with Next.js, TypeScript, Supabase (Postgres + **pgvector**), and swappable AI providers:
**Replicate** (default), **Ollama** (free, local), **Claude**, and **Voyage AI**.

Deploying to Supabase cloud + Vercel (or Railway): see **[DEPLOYMENT.md](DEPLOYMENT.md)**.

## How it works

```
INGEST (once)                                        ASK (every question)
─────────────                                        ────────────────────
TMDB API                                             "90s Inception vibes, under 2h"
  │  well-known + recent movies,                        │
  │  with credits,                                      │
  │  keywords, reviews                                  ▼
  ▼                                                  1. PLAN (LLM → JSON)
buildMovieRow()                                         filters: 1990–1999, ≤120 min
  ├─ facts → columns (year, runtime,                    topic:   "dreams, reality-bending heist"
  │          rating, genres, director)                  │
  └─ doc  → plot + tagline + keywords                   ▼
            + people + review snippets               2. RETRIEVE
  │                                                     topic?  → embed → match_movies()
  ▼                                                               SQL filters, then nearest vectors
embedding model (1024-dim)                              no topic → plain SQL (fact questions)
  │                                                     │
  ▼                                                     ▼
Supabase: movies.embedding (HNSW index)              3. GENERATE (LLM)
                                                        "Recommend ONLY from these movies"
                                                        → answer + source cards
```

### Design decisions (and why)

| Decision | Why |
|---|---|
| **Movies chosen by vote count, with a lower bar for recent years** | Vote count signals a film people know and a rating you can trust; sorting by rating alone surfaces brand-new films with a handful of votes. New releases haven't had time to collect votes, so the last 2 years use a lower bar (≥50 instead of ≥500). Regional cinema is under-voted on TMDB (no Tamil film has 500 votes), so chosen languages get their own bar (`INGEST_EXTRA_LANGUAGES`, ≥20). |
| **The planner knows today's date and the language** | "This year" and "recent" resolve to real years, and "Tamil" / "Korean" become an exact `original_language` filter instead of a vague embedding hint. |
| **Iterative index scans under strict filters** | An HNSW scan returns ~40 nearest candidates; strict filters (Tamil + 2026) can discard all of them. pgvector's iterative scan keeps searching until enough rows pass. |
| **Hard facts are SQL columns, not embedded** | Vectors are good at meaning ("a heist gone wrong") but bad at exact facts ("before 2000", "under 2 hours"). Filtering with SQL first makes those constraints reliable. |
| **Hybrid search in one Postgres function** (`match_movies`) | Filters and vector ranking run in a single query: no extra service, and RLS still applies. |
| **The LLM plans the search before answering** | Turns free text into structured filters. Fact questions ("top rated Nolan films") skip embeddings entirely and use plain SQL, which is faster, cheaper and exact. |
| **Answers come only from retrieved movies** | The prompt forbids mentioning movies not in the results, so every recommendation is a real row you can show a card for. |
| **Swappable AI providers** | One interface (`src/lib/ai`), chosen by env var. Develop free on Ollama, demo on Claude + Voyage, switch with no code changes. No vendor lock-in. |
| **"More like this" uses no LLM** | It's nearest neighbours of a movie's own embedding: instant and free. |
| **Plan output is validated** (`zod`) with a safe fallback | Small models sometimes return bad JSON; the app falls back to a plain semantic search instead of erroring. |

## Setup

Prerequisites: Node 22+, Docker Desktop (for local Supabase), a free
[TMDB API read token](https://www.themoviedb.org/settings/api).

```bash
npm install
npm run db:start                  # boots local Supabase, prints URL + keys
cp .env.example .env.local        # paste Supabase keys, TMDB_READ_TOKEN, REPLICATE_API_TOKEN,
                                  # and the e5 version hash (see the comments in the file)
npm run db:reset                  # applies the migration (movies table + search functions)
npm run ingest                    # ~9.3k well-known + recent movies (see .env.example)
npm run dev                       # http://127.0.0.1:3000
```

No Docker? Skip `db:start`/`db:reset` and point `.env.local` at a free Supabase cloud
project instead (steps 1–2 of [DEPLOYMENT.md](DEPLOYMENT.md)).

## Choosing providers

Set in `.env.local`. The chat and embedding providers are chosen separately.

| | `AI_PROVIDER` (chat) | `EMBED_PROVIDER` (embeddings) | Cost |
|---|---|---|---|
| Replicate (default) | `replicate` (meta-llama-3-70b-instruct; 8b for cheaper) | `replicate` (multilingual-e5-large, with version hash) | Pay per use |
| Ollama | `ollama` (llama3.1:8b) | `ollama` (mxbai-embed-large) | Free, runs locally |
| Claude / Voyage | `anthropic` (claude-opus-5-5; set `ANTHROPIC_MODEL=claude-haiku-5-5` for cheapest) | `voyage` (voyage-3.5) | Pay per use |

**Changing the embedding provider means re-running `npm run ingest`.** Vectors from different
models live in different spaces and can't be compared. Every default here outputs 1024
dimensions to match `vector(1024)` in the migration. The app checks this and fails with a clear
message if they don't match.

## Project layout

```
supabase/migrations/   movies table, HNSW index, RLS, match_movies(), similar_movies()
scripts/ingest.ts      TMDB → docs → embeddings → upsert
src/lib/ai/            provider interface + ollama / replicate / anthropic / voyage
src/lib/movies.ts      TMDB → row + embedded doc
src/lib/plan.ts        question → search plan (schema, prompt, validation)
src/lib/rag.ts         plan → retrieve (hybrid or SQL) → generate
src/app/               chat UI + /api/ask + /api/similar
```

## Tests

```bash
npm test          # doc building, plan parsing/validation, provider output normalisation
npm run check     # typecheck + tests
```

## Ideas to extend

- Stream answers token by token
- Add a reranking step (e.g. Voyage rerank) between retrieval and generation
- Store "where to watch" data and filter on it
- Deploy: Supabase cloud + Vercel (move the ingest to a scheduled job)
