import { z } from "zod";

// Step 1 of answering: turn a free-text question into a search plan,
// i.e. hard SQL filters plus a "topic" to search by meaning.

/** TMDB's genre names, exactly as stored in movies.genres. */
export const GENRES = [
  "Action", "Adventure", "Animation", "Comedy", "Crime", "Documentary", "Drama",
  "Family", "Fantasy", "History", "Horror", "Music", "Mystery", "Romance",
  "Science Fiction", "TV Movie", "Thriller", "War", "Western",
] as const;

const GENRE_ALIASES: Record<string, (typeof GENRES)[number]> = {
  "sci-fi": "Science Fiction",
  scifi: "Science Fiction",
  "sci fi": "Science Fiction",
  "science-fiction": "Science Fiction",
  animated: "Animation",
  cartoon: "Animation",
  romantic: "Romance",
  "rom-com": "Romance",
  romcom: "Romance",
  scary: "Horror",
  funny: "Comedy",
  documentaries: "Documentary",
  musical: "Music",
  historical: "History",
};

export const SearchPlanSchema = z.object({
  topic: z.string(),
  min_year: z.number().int().nullable(),
  max_year: z.number().int().nullable(),
  max_runtime: z.number().int().nullable(),
  min_rating: z.number().nullable(),
  genre: z.string().nullable(),
  director: z.string().nullable(),
  // Optional so a model that forgets the field still produces a usable plan.
  language: z.string().nullable().optional().transform((v) => v ?? null),
  sort: z.enum(["relevance", "rating", "newest"]),
});

export type SearchPlan = z.infer<typeof SearchPlanSchema>;

/** Same shape as SearchPlanSchema, as JSON Schema for providers that support constrained output. */
export const SEARCH_PLAN_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["topic", "min_year", "max_year", "max_runtime", "min_rating", "genre", "director", "language", "sort"],
  properties: {
    topic: { type: "string" },
    min_year: { type: ["integer", "null"] },
    max_year: { type: ["integer", "null"] },
    max_runtime: { type: ["integer", "null"] },
    min_rating: { type: ["number", "null"] },
    genre: { type: ["string", "null"] },
    director: { type: ["string", "null"] },
    language: { type: ["string", "null"] },
    sort: { type: "string", enum: ["relevance", "rating", "newest"] },
  },
};

/** Language names users type -> ISO 639-1 codes, as stored in movies.original_language. */
const LANGUAGES: Record<string, string> = {
  english: "en", tamil: "ta", hindi: "hi", bollywood: "hi", telugu: "te", tollywood: "te",
  malayalam: "ml", kannada: "kn", bengali: "bn", marathi: "mr", punjabi: "pa",
  korean: "ko", japanese: "ja", chinese: "zh", mandarin: "zh", cantonese: "cn",
  french: "fr", spanish: "es", german: "de", italian: "it", portuguese: "pt",
  russian: "ru", turkish: "tr", persian: "fa", farsi: "fa", arabic: "ar", thai: "th",
  indonesian: "id", swedish: "sv", danish: "da", norwegian: "no", polish: "pl", dutch: "nl",
};

/** The planner prompt. Includes today's date so "this year" / "recent" resolve correctly. */
export function planSystem(today: Date = new Date()): string {
  const date = today.toISOString().slice(0, 10);
  const year = today.getUTCFullYear();
  return `You convert movie questions into a search plan for a movie database.
Today's date is ${date}.

Fields:
- topic: what the movie should be ABOUT or FEEL like, rewritten as a short descriptive phrase
  (themes, plot, mood, "similar to X" expanded into X's themes). Use "" when the question is
  purely about facts (e.g. "top rated Nolan films", "who directed Parasite").
- min_year / max_year: from decades or dates ("90s" -> 1990 and 1999). Relative dates use
  today's date: "this year" -> ${year} and ${year}, "last year" -> ${year - 1} and ${year - 1},
  "recent" / "new" -> ${year - 2} and ${year}. Otherwise null.
- max_runtime: in minutes ("under 2 hours" -> 120). Otherwise null.
- min_rating: 0-10 scale, only if the user asks for highly rated / acclaimed (use 7.5). Otherwise null.
- genre: ONE of: ${GENRES.join(", ")}. Otherwise null.
- director: the director's name if mentioned. Otherwise null.
- language: the film's original language as an ISO 639-1 code if the user asks for one or
  names a film industry ("Tamil" -> "ta", "Korean" -> "ko", "Bollywood" -> "hi"). Otherwise null.
  Don't repeat the language in the topic.
- sort: "rating" for best/top-rated, "newest" for recent/latest, else "relevance".

Use earlier conversation turns to resolve follow-ups like "only the older ones".
Output only the JSON object.`;
}

/** Pulls the first JSON object out of a model reply (some models wrap it in prose or fences). */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("No JSON object in model output");
  return JSON.parse(text.slice(start, end + 1));
}

/** Validates the model's plan; falls back to a plain semantic search if it's unusable. */
export function parsePlan(modelOutput: string, question: string): SearchPlan {
  const fallback: SearchPlan = {
    topic: question,
    min_year: null,
    max_year: null,
    max_runtime: null,
    min_rating: null,
    genre: null,
    director: null,
    language: null,
    sort: "relevance",
  };

  let parsed: SearchPlan;
  try {
    const result = SearchPlanSchema.safeParse(extractJson(modelOutput));
    if (!result.success) return fallback;
    parsed = result.data;
  } catch {
    return fallback;
  }

  return {
    ...parsed,
    topic: parsed.topic.trim(),
    genre: normaliseGenre(parsed.genre),
    director: parsed.director?.trim() || null,
    language: normaliseLanguage(parsed.language),
    min_year: clampYear(parsed.min_year),
    max_year: clampYear(parsed.max_year),
    max_runtime: parsed.max_runtime && parsed.max_runtime > 0 ? parsed.max_runtime : null,
    min_rating:
      parsed.min_rating !== null && parsed.min_rating >= 0 && parsed.min_rating <= 10
        ? parsed.min_rating
        : null,
  };
}

export function normaliseGenre(genre: string | null): string | null {
  if (!genre) return null;
  const g = genre.trim().toLowerCase();
  const exact = GENRES.find((name) => name.toLowerCase() === g);
  return exact ?? GENRE_ALIASES[g] ?? null;
}

/** Accepts an ISO 639-1 code ("ta") or a language name ("Tamil"); anything else -> null. */
export function normaliseLanguage(language: string | null): string | null {
  if (!language) return null;
  const l = language.trim().toLowerCase();
  if (/^[a-z]{2}$/.test(l)) return l;
  return LANGUAGES[l] ?? null;
}

function clampYear(year: number | null): number | null {
  return year !== null && year >= 1880 && year <= 2100 ? year : null;
}
