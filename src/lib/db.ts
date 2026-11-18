import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireEnv } from "./env";

/** Read-only client for the web app (RLS allows SELECT on movies). */
export function readClient(): SupabaseClient {
  return createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_ANON_KEY"), {
    auth: { persistSession: false },
  });
}

/** Privileged client: ONLY for the ingest script. Never import from app code. */
export function adminClient(): SupabaseClient {
  return createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });
}

/** Shape returned by match_movies / similar_movies and the SQL-only path. */
export interface MovieHit {
  id: number;
  title: string;
  year: number | null;
  runtime: number | null;
  rating: number | null;
  genres: string[];
  director: string | null;
  original_language?: string | null;
  overview: string | null;
  poster_path: string | null;
  doc: string;
  similarity?: number;
}

export const MOVIE_COLUMNS =
  "id, title, year, runtime, rating, genres, director, original_language, overview, poster_path, doc";
