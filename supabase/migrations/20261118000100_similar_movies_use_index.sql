-- similar_movies v2: use the HNSW index.
-- v1 read the source embedding inside the same query (cross join), so the planner
-- couldn't use the vector index and scanned every row, which timed out for anon
-- (3 s limit) once the table held ~9k movies. Looking the embedding up first and
-- then ordering by a fixed value lets the index do the work.

create or replace function public.similar_movies(
  p_movie_id    bigint,
  p_match_count int default 6
)
returns table (
  id bigint, title text, year int, runtime int, rating numeric,
  genres text[], director text, overview text, poster_path text,
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
           m.genres, m.director, m.overview, m.poster_path,
           m.doc, 1 - (m.embedding <=> src) as similarity
    from public.movies m
    where m.id <> p_movie_id
    order by m.embedding <=> src
    limit least(greatest(p_match_count, 1), 50);
end;
$$;

grant execute on function public.similar_movies to anon, authenticated;
