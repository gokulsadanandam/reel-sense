-- Keyword search v3: bounded work per query.
--
-- v2 ranked EVERY movie containing any query word. A common word ("good", "time")
-- matches thousands of docs, and ranking each one reads its full-text vector, so a
-- cold database could still pass the 3 s limit. v3 first takes the 300 best-known
-- matches (vote_count comes from the row itself, no full-text read), then ranks only
-- those. Cost no longer grows with how common the words are.

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
  ),
  candidates as materialized (
    select m.id
    from public.movies m, q
    where m.doc_tsv @@ q.tsq
      and (p_min_year    is null or m.year    >= p_min_year)
      and (p_max_year    is null or m.year    <= p_max_year)
      and (p_max_runtime is null or m.runtime <= p_max_runtime)
      and (p_min_rating  is null or m.rating  >= p_min_rating)
      and (p_genre       is null or p_genre = any (m.genres))
      and (p_director    is null or m.director ilike '%' || p_director || '%')
      and (p_language    is null or m.original_language = p_language)
    order by m.vote_count desc
    limit 300
  )
  select m.id, m.title, m.year, m.runtime, m.rating,
         m.genres, m.director, m.original_language, m.overview, m.poster_path, m.doc,
         -- Relevance, nudged towards films people know (log of the vote count).
         (ts_rank_cd(m.doc_tsv, q.tsq) * ln(10 + m.vote_count))::double precision as similarity
  from candidates c
  join public.movies m on m.id = c.id
  cross join q
  order by similarity desc
  limit least(greatest(p_match_count, 1), 50);
$$;

grant execute on function public.keyword_movies to anon, authenticated;
