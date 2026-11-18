-- Language filter ("Tamil", "Korean", ...) + reliable results under strict filters.
--
-- 1. movies.original_language: ISO 639-1 code from TMDB ("ta", "ko", "en"...).
--    `npm run ingest` fills it for movies already stored (no embedding cost).
-- 2. match_movies gains p_language and returns original_language.
-- 3. Strict filters (e.g. Tamil + 2026) can starve an HNSW scan: the index hands back
--    ~40 nearest candidates, the filters drop all of them, and the query returns nothing.
--    pgvector 0.8+ can keep scanning ("iterative scan"); we enable it when available.
--    similar_movies also returns original_language and keeps the index-friendly form.

alter table public.movies add column if not exists original_language text;
create index if not exists movies_language_idx on public.movies (original_language);

-- Return types change, so drop and recreate.
drop function if exists public.match_movies(extensions.vector, int, int, int, int, numeric, text, text);
drop function if exists public.similar_movies(bigint, int);

create function public.match_movies(
  p_query_embedding extensions.vector(1024),
  p_match_count     int     default 8,
  p_min_year        int     default null,
  p_max_year        int     default null,
  p_max_runtime     int     default null,
  p_min_rating      numeric default null,
  p_genre           text    default null,
  p_director        text    default null,
  p_language        text    default null
)
returns table (
  id bigint, title text, year int, runtime int, rating numeric,
  genres text[], director text, original_language text, overview text, poster_path text,
  doc text, similarity double precision
)
language plpgsql stable
set search_path = public, extensions
as $$
begin
  -- Keep scanning the index until enough rows pass the filters (pgvector >= 0.8).
  begin
    perform set_config('hnsw.iterative_scan', 'relaxed_order', true);
  exception when others then
    null; -- older pgvector: setting doesn't exist; results may be fewer under strict filters
  end;

  return query
    with hits as materialized (
      select m.id, m.title, m.year, m.runtime, m.rating,
             m.genres, m.director, m.original_language, m.overview, m.poster_path,
             m.doc, m.embedding <=> p_query_embedding as distance
      from public.movies m
      where m.embedding is not null
        and (p_min_year    is null or m.year    >= p_min_year)
        and (p_max_year    is null or m.year    <= p_max_year)
        and (p_max_runtime is null or m.runtime <= p_max_runtime)
        and (p_min_rating  is null or m.rating  >= p_min_rating)
        and (p_genre       is null or p_genre = any (m.genres))
        and (p_director    is null or m.director ilike '%' || p_director || '%')
        and (p_language    is null or m.original_language = p_language)
      order by m.embedding <=> p_query_embedding
      limit least(greatest(p_match_count, 1), 50)
    )
    -- relaxed_order can return slightly out-of-order rows; re-sort the few we keep.
    select h.id, h.title, h.year, h.runtime, h.rating, h.genres, h.director,
           h.original_language, h.overview, h.poster_path, h.doc, 1 - h.distance
    from hits h
    order by h.distance;
end;
$$;

create function public.similar_movies(
  p_movie_id    bigint,
  p_match_count int default 6
)
returns table (
  id bigint, title text, year int, runtime int, rating numeric,
  genres text[], director text, original_language text, overview text, poster_path text,
  doc text, similarity double precision
)
language plpgsql stable
set search_path = public, extensions
as $$
declare
  src extensions.vector(1024);
begin
  select m.embedding into src from public.movies m where m.id = p_movie_id;
  if src is null then
    return;
  end if;

  return query
    select m.id, m.title, m.year, m.runtime, m.rating,
           m.genres, m.director, m.original_language, m.overview, m.poster_path,
           m.doc, 1 - (m.embedding <=> src) as similarity
    from public.movies m
    where m.id <> p_movie_id
    order by m.embedding <=> src
    limit least(greatest(p_match_count, 1), 50);
end;
$$;

grant execute on function public.match_movies   to anon, authenticated;
grant execute on function public.similar_movies to anon, authenticated;
