-- Movies + embeddings for RAG search.
-- Hard facts (year, runtime, rating, genres, director) are plain columns used
-- as SQL filters; descriptive text lives in `doc` and is embedded.

create extension if not exists vector with schema extensions;

create table public.movies (
  id           bigint primary key,           -- TMDB id
  title        text not null,
  year         int,
  runtime      int,                          -- minutes
  rating       numeric(3, 1),                -- TMDB vote average, 0-10
  vote_count   int not null default 0,
  genres       text[] not null default '{}',
  director     text,
  cast_names   text[] not null default '{}',
  overview     text,
  poster_path  text,
  doc          text not null,                -- the text that was embedded
  embedding    extensions.vector(1024),      -- must match the embedding model
  updated_at   timestamptz not null default now()
);

create index movies_embedding_idx on public.movies
  using hnsw (embedding extensions.vector_cosine_ops);
create index movies_year_idx on public.movies (year);
create index movies_genres_idx on public.movies using gin (genres);

-- Public read-only catalogue. Writes only via the service role (ingest script).
-- Explicit grant: projects that revoke Supabase's default table privileges
-- (deny-by-default setups) would otherwise block reads despite the RLS policy.
grant select on public.movies to anon, authenticated;
alter table public.movies enable row level security;
create policy "movies are readable by everyone"
  on public.movies for select
  to anon, authenticated
  using (true);

-- Hybrid search: SQL filters first, then rank by vector similarity.
create or replace function public.match_movies(
  p_query_embedding extensions.vector(1024),
  p_match_count     int     default 8,
  p_min_year        int     default null,
  p_max_year        int     default null,
  p_max_runtime     int     default null,
  p_min_rating      numeric default null,
  p_genre           text    default null,
  p_director        text    default null
)
returns table (
  id bigint, title text, year int, runtime int, rating numeric,
  genres text[], director text, overview text, poster_path text,
  doc text, similarity double precision
)
language sql stable
set search_path = public, extensions
as $$
  select m.id, m.title, m.year, m.runtime, m.rating,
         m.genres, m.director, m.overview, m.poster_path,
         m.doc, 1 - (m.embedding <=> p_query_embedding) as similarity
  from public.movies m
  where m.embedding is not null
    and (p_min_year    is null or m.year    >= p_min_year)
    and (p_max_year    is null or m.year    <= p_max_year)
    and (p_max_runtime is null or m.runtime <= p_max_runtime)
    and (p_min_rating  is null or m.rating  >= p_min_rating)
    and (p_genre       is null or p_genre = any (m.genres))
    and (p_director    is null or m.director ilike '%' || p_director || '%')
  order by m.embedding <=> p_query_embedding
  limit least(greatest(p_match_count, 1), 50);
$$;

-- "More like this": nearest neighbours of a movie's own embedding (no LLM call).
create or replace function public.similar_movies(
  p_movie_id    bigint,
  p_match_count int default 6
)
returns table (
  id bigint, title text, year int, runtime int, rating numeric,
  genres text[], director text, overview text, poster_path text,
  doc text, similarity double precision
)
language sql stable
set search_path = public, extensions
as $$
  select m.id, m.title, m.year, m.runtime, m.rating,
         m.genres, m.director, m.overview, m.poster_path,
         m.doc, 1 - (m.embedding <=> src.embedding) as similarity
  from public.movies m
  cross join (select embedding from public.movies where id = p_movie_id) src
  where m.id <> p_movie_id
    and m.embedding is not null
  order by m.embedding <=> src.embedding
  limit least(greatest(p_match_count, 1), 50);
$$;

grant execute on function public.match_movies   to anon, authenticated;
grant execute on function public.similar_movies to anon, authenticated;
