-- Keyword search for the website's free tier, which has no embedding model.
--
-- A GIN index on the movie doc's full-text vector (an expression index, so the table
-- isn't rewritten), and keyword_movies(): the same filters as match_movies, but
-- ranked by full-text relevance x popularity instead of vector similarity.

create index if not exists movies_doc_fts_idx
  on public.movies using gin (to_tsvector('english', doc));

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
         (ts_rank_cd(to_tsvector('english', m.doc), q.tsq) * ln(10 + m.vote_count))::double precision as similarity
  from public.movies m, q
  where to_tsvector('english', m.doc) @@ q.tsq
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
