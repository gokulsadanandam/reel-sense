// Turns a TMDB movie into a database row plus the text we embed ("doc").

/** The subset of TMDB's /movie/{id}?append_to_response=credits,keywords,reviews we use. */
export interface TmdbMovieDetails {
  id: number;
  title: string;
  release_date?: string;
  original_language?: string;
  runtime?: number | null;
  vote_average?: number;
  vote_count?: number;
  genres?: { name: string }[];
  overview?: string;
  tagline?: string;
  poster_path?: string | null;
  credits?: {
    cast?: { name: string; order?: number }[];
    crew?: { name: string; job: string }[];
  };
  keywords?: { keywords?: { name: string }[] };
  reviews?: { results?: { content: string }[] };
}

export interface MovieRow {
  id: number;
  title: string;
  year: number | null;
  runtime: number | null;
  rating: number | null;
  vote_count: number;
  genres: string[];
  director: string | null;
  cast_names: string[];
  original_language: string | null;
  overview: string | null;
  poster_path: string | null;
  doc: string;
}

const MAX_REVIEWS = 2;
const MAX_REVIEW_CHARS = 600;
const MAX_CAST = 5;

export function buildMovieRow(m: TmdbMovieDetails): MovieRow {
  const year = m.release_date ? Number.parseInt(m.release_date.slice(0, 4), 10) : NaN;
  const genres = (m.genres ?? []).map((g) => g.name);
  const director = m.credits?.crew?.find((c) => c.job === "Director")?.name ?? null;
  const cast = [...(m.credits?.cast ?? [])]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .slice(0, MAX_CAST)
    .map((c) => c.name);

  return {
    id: m.id,
    title: m.title,
    year: Number.isFinite(year) ? year : null,
    runtime: m.runtime || null,
    rating: m.vote_average ?? null,
    vote_count: m.vote_count ?? 0,
    genres,
    director,
    cast_names: cast,
    original_language: m.original_language ?? null,
    overview: m.overview || null,
    poster_path: m.poster_path ?? null,
    doc: buildMovieDoc(m, { year: Number.isFinite(year) ? year : null, genres, director, cast }),
  };
}

/**
 * The descriptive text that gets embedded. Meaning-heavy fields only:
 * plot, tagline, keywords, genres, people, and a little review text for "vibe".
 * Exact facts (rating, runtime) are filtered with SQL instead.
 */
export function buildMovieDoc(
  m: TmdbMovieDetails,
  derived: { year: number | null; genres: string[]; director: string | null; cast: string[] },
): string {
  const lines: string[] = [];
  lines.push(`Title: ${m.title}${derived.year ? ` (${derived.year})` : ""}`);
  if (derived.genres.length) lines.push(`Genres: ${derived.genres.join(", ")}`);
  if (derived.director) lines.push(`Directed by: ${derived.director}`);
  if (derived.cast.length) lines.push(`Starring: ${derived.cast.join(", ")}`);
  if (m.tagline) lines.push(`Tagline: ${m.tagline}`);

  const keywords = (m.keywords?.keywords ?? []).slice(0, 15).map((k) => k.name);
  if (keywords.length) lines.push(`Keywords: ${keywords.join(", ")}`);
  if (m.overview) lines.push(`Plot: ${m.overview}`);

  const reviews = (m.reviews?.results ?? [])
    .slice(0, MAX_REVIEWS)
    .map((r) => clip(r.content.replace(/\s+/g, " ").trim(), MAX_REVIEW_CHARS));
  if (reviews.length) lines.push(`What viewers say: ${reviews.join(" | ")}`);

  return lines.join("\n");
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

export function posterUrl(path: string | null, size: "w185" | "w342" = "w342"): string | null {
  return path ? `https://image.tmdb.org/t/p/${size}${path}` : null;
}
