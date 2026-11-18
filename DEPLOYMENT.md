# Deploying ReelSense

This guide puts ReelSense online with:

| Piece | Service | What it does |
|---|---|---|
| Database | **Supabase** (cloud) | Postgres + pgvector: stores movies and their embeddings, runs the search |
| Web app | **Vercel** (or Railway, see the end) | Hosts the Next.js site and the `/api/ask` endpoint |
| AI models | **Replicate** | Llama 3 writes the answers; multilingual-e5-large makes the embeddings |
| Movie data | **TMDB** | Source of titles, plots, cast and posters (ingested once) |

Total time: about 30–45 minutes the first time.

---

## 0. Accounts and keys you need

| Service | Sign up | Key to copy | Where it goes |
|---|---|---|---|
| Supabase | supabase.com | Project URL, **publishable/anon** key, **secret/service_role** key | `.env.remote`; only the URL + anon key go to Vercel |
| Replicate | replicate.com | API token (Account → API tokens) | `.env.remote` and Vercel |
| TMDB | themoviedb.org | API Read Access Token (Settings → API) | `.env.remote` only |
| Vercel | vercel.com (sign in with GitHub) | none | |
| GitHub | github.com | none | push the repo here |

> Replicate is pay-per-use, so add a payment method under Billing. Use the billing page to keep
> an eye on spend; a public demo calls paid models on every question (see step 7).

---

## 1. Create the Supabase project

1. Supabase dashboard → **New project**. Pick a region close to your users (for India:
   *Mumbai, ap-south-1*). Save the database password somewhere safe.
2. When it's ready, open **Project Settings → API** (or **API Keys**) and copy:
   - **Project URL**, e.g. `https://abcd1234.supabase.co`
   - **Publishable key** (`sb_publishable_…`), or the legacy **anon** key. Either works.
   - **Secret key** (`sb_secret_…`), or the legacy **service_role** key.
     **This one bypasses all security. Never put it in Vercel, Git, or browser code.**

> **Reusing an existing Supabase project** (e.g. one that already hosts another app)? That's
> fine: ReelSense only adds a `movies` table and two `*_movies` functions to the `public` schema,
> which don't clash with other apps' tables. Copy that project's URL and keys as above, then
> apply the migration with the **SQL Editor option** below, not `supabase db push`. The CLI
> would refuse, because the project's migration history holds the other app's migrations,
> and running SQL by hand keeps that history clean for the other app.

## 2. Apply the database migration

The migration enables pgvector and creates the `movies` table, the vector index, read-only
security rules, and the `match_movies` / `similar_movies` search functions.

```bash
npx supabase login                          # opens the browser once
npx supabase link --project-ref abcd1234    # the ref is the subdomain of your Project URL
npx supabase db push                        # applies supabase/migrations/*.sql
```

Check: Supabase dashboard → **Table Editor** shows an empty `movies` table.

*(No CLI? Open **SQL Editor** in the dashboard and run each file in
`supabase/migrations/` in name order: paste its contents and click Run.)*

## 3. Choose the Replicate models

| Role | Model | Notes |
|---|---|---|
| Answers + search planning | `meta/meta-llama-3-70b-instruct` | Official model: always warm, no version hash. Best quality for RAG. |
| (cheaper alternative) | `meta/meta-llama-3-8b-instruct` | Much cheaper and faster; more likely to ignore the sources on tricky questions. Fine for testing. |
| Embeddings | `beautyyuyanli/multilingual-e5-large` | Replicate's featured text-embedding pick: 1024-dim vectors (matches the database), about $0.004 per run, usually finishes in seconds. |

The embedding model is a **community model**, so Replicate needs its exact version:

1. Open replicate.com/beautyyuyanli/multilingual-e5-large → **Versions** tab.
2. Copy the latest version hash.
3. Use it as `beautyyuyanli/multilingual-e5-large:a06276a89f1a902d5fc225a9ca32b6e8e6292b7f3b136518878da97c458e2bad`.

> Community models can "cold start" (boot for a while) after sitting idle. The first question
> after a quiet spell may be slow; later ones are fast. `/api/ask` allows 60 seconds for this.

## 4. Load the movies (run once, from your computer)

Create `.env.remote` in the project root. It's git-ignored, but double-check before committing.

```ini
SUPABASE_URL=https://abcd1234.supabase.co
SUPABASE_ANON_KEY=sb_publishable_...
SUPABASE_SERVICE_ROLE_KEY=sb_secret_...
TMDB_READ_TOKEN=eyJ...
INGEST_START_YEAR=1920
INGEST_MIN_VOTES=500
INGEST_RECENT_YEARS=2
INGEST_RECENT_MIN_VOTES=50
INGEST_EXTRA_LANGUAGES=ta,hi,te,ml,kn
INGEST_EXTRA_MIN_VOTES=20
TMDB_CONCURRENCY=2

AI_PROVIDER=replicate
EMBED_PROVIDER=replicate
REPLICATE_API_TOKEN=r8_...
REPLICATE_CHAT_MODEL=meta/meta-llama-3-70b-instruct
REPLICATE_EMBED_MODEL=beautyyuyanli/multilingual-e5-large:a06276a89f1a902d5fc225a9ca32b6e8e6292b7f3b136518878da97c458e2bad
```

Then run:

```bash
npm install
INGEST_DRY_RUN=true npm run ingest:remote   # counts what would be ingested; free
INGEST_MAX=50 npm run ingest:remote         # small paid test
npm run ingest:remote                       # the full run, ~9.3k movies
```

The defaults select films with ≥500 votes from every year, plus ≥50 votes from the last
2 years, plus Indian-language films with ≥20 votes: about 11,500 movies, ~$0.20–0.55 on
Replicate, 40–75 minutes. Check:
**Table Editor → movies** has rows, and the `embedding` column is filled.

- Progress is saved in chunks, and movies already stored are skipped. If a run stops,
  run the same command again to continue.
- Re-run occasionally to pick up new releases. `INGEST_REFRESH=true` re-processes everything.
- (`VAR=value npm run …` works in Git Bash/macOS/Linux. In PowerShell, set the value in
  the env file instead.)

## 5. Push the code to GitHub

```bash
git init
git add .
git status            # make sure .env.local / .env.remote are NOT listed
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<you>/reelsense.git
git push -u origin main
```

## 6. Deploy to Vercel

1. vercel.com → **Add New → Project** → import the GitHub repo. It detects Next.js automatically.
2. Before clicking Deploy, open **Environment Variables** and add:

   | Name | Value |
   |---|---|
   | `SUPABASE_URL` | `https://abcd1234.supabase.co` |
   | `SUPABASE_ANON_KEY` | the publishable/anon key |
   | `AI_PROVIDER` | `replicate` |
   | `EMBED_PROVIDER` | `replicate` |
   | `REPLICATE_API_TOKEN` | `r8_...` |
   | `REPLICATE_CHAT_MODEL` | `meta/meta-llama-3-70b-instruct` |
   | `REPLICATE_EMBED_MODEL` | `beautyyuyanli/multilingual-e5-large:a06276a89f1a902d5fc225a9ca32b6e8e6292b7f3b136518878da97c458e2bad` (**same** as used for ingest) |

   **Do not add** `SUPABASE_SERVICE_ROLE_KEY` or `TMDB_READ_TOKEN`; the live site doesn't need them.

3. **Deploy.** Optional: Project → Settings → Functions → Region, set it to the region nearest
   your Supabase project (e.g. Mumbai `bom1`) to cut database round-trips.

**Check it works:** open the Vercel URL, click an example question, and you should get an
answer with poster cards. Then click **More like this** on any card.

## 7. Before you share the link

`/api/ask` is public, and every question costs money on Replicate. For a portfolio demo:

- Watch your spending on Replicate's billing page, especially after sharing the link.
- If it gets real traffic, add rate limiting to `/api/ask` (e.g. per-IP limits with Upstash
  Redis or Vercel's firewall rules) and/or switch to `meta-llama-3-8b-instruct`.
- Revoke and regenerate the Replicate token if it's ever exposed.

---

## Updating later

| Change | What to do |
|---|---|
| Code | `git push`; Vercel redeploys automatically |
| New migration in `supabase/migrations/` | `npx supabase db push` |
| More or refreshed movies | `npm run ingest:remote` |
| **Different embedding model** | Change it in `.env.remote` **and** Vercel, re-run `npm run ingest:remote`, then redeploy. Old and new vectors can't be mixed. If the new model isn't 1024-dim, also change `vector(1024)` in a new migration. |

## Alternative: Railway instead of Vercel

Railway runs the app as an always-on server, so there are no function time limits.

1. railway.com → **New Project → Deploy from GitHub repo**.
2. **Variables**: add the same variables as in step 6.
3. Railway detects Node and runs `npm run build` and then `npm start`. Next.js listens on Railway's `PORT` automatically.
4. **Settings → Networking → Generate Domain** to get a public URL.

Supabase setup and ingest (steps 1–4) are the same.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `Missing environment variable …` | Variable not set in Vercel (or `.env.remote`). After adding variables in Vercel, **redeploy**. |
| `returned 768-dim vectors but the database expects 1024` | The embedding model isn't 1024-dim. Use multilingual-e5-large or another 1024-dim model. |
| Replicate `422` / `version not found` | The embedding model is missing its `:<hash>`, or the hash was mistyped. |
| Replicate `401` | Wrong or revoked `REPLICATE_API_TOKEN`. |
| Answers say nothing matches | Ingest didn't run against *this* project, or the site and the ingest used different embedding models. |
| Request times out on the first question | Embedding model cold start. Try again; or keep it warm by asking a question shortly before a demo. |
| `match_movies failed: permission denied` | The migration didn't fully apply. Re-run `npx supabase db push`. |
