-- Keyword search v2: store the full-text vector instead of computing it per query.
--
-- v1 indexed to_tsvector(doc) as an expression, which finds matches fast but then
-- re-parses every matching doc to rank it. Broad questions ("time loops": "time"
-- appears in thousands of plots) ran past the 3 s statement limit for anon.
--
-- Adding a stored generated column rewrites the table once (and rebuilds its
-- indexes, including the vector index), so allow this script more time than the
-- default. Ingest needs no change: Postgres computes the column itself.

set statement_timeout = '15min';

drop index if exists public.movies_doc_fts_idx;

alter table public.movies
  add column if not exists doc_tsv tsvector
  generated always as (to_tsvector('english', doc)) stored;

create index if not exists movies_doc_tsv_idx on public.movies using gin (doc_tsv);

create or replace function public.keyword_movies(
  p_query       text,
  p_match_count int     default 8,
  p_min_year    int     default null,
  p_max_year    int     default null,
  p_max_runtime int     default null,
  p_min_rating  numeric default null,
  p_genre       text    default null,
  p_director    text    default null,
  p_language    text    default null
)
returns table (
  id bigint, title text, year int, runtime int, rating numeric,
  genres text[], director text, original_language text, overview text, poster_path text,
  doc text, similarity double precision
)
language sql stable
set search_path = public
as $$
  with q as (
    -- Any word may match ("dreams heist" -> dreams | heist); punctuation is dropped so a
    -- leading "-" can't turn a word into a NOT. Movies matching more words rank higher.
    select websearch_to_tsquery(
      'english',
      array_to_string(
        regexp_split_to_array(trim(regexp_replace(coalesce(p_query, ''), '[^[:alnum:][:space:]]+', ' ', 'g')), '\s+'),
        ' or '
      )
    ) as tsq
  )
  select m.id, m.title, m.year, m.runtime, m.rating,
         m.genres, m.director, m.original_language, m.overview, m.poster_path, m.doc,
         -- Relevance, nudged towards films people know (log of the vote count).
         (ts_rank_cd(m.doc_tsv, q.tsq) * ln(10 + m.vote_count))::double precision as similarity
  from public.movies m, q
  where m.doc_tsv @@ q.tsq
    and (p_min_year    is null or m.year    >= p_min_year)
    and (p_max_year    is null or m.year    <= p_max_year)
    and (p_max_runtime is null or m.runtime <= p_max_runtime)
    and (p_min_rating  is null or m.rating  >= p_min_rating)
    and (p_genre       is null or p_genre = any (m.genres))
    and (p_director    is null or m.director ilike '%' || p_director || '%')
    and (p_language    is null or m.original_language = p_language)
  order by similarity desc
  limit least(greatest(p_match_count, 1), 50);
$$;

grant execute on function public.keyword_movies to anon, authenticated;
