import { describe, expect, it } from "vitest";
import { groqRetryDelayMs } from "./ai/groq";
import type { MovieHit } from "./db";
import { formatSources, keywordQuery, minVotesForRating } from "./rag";
import type { SearchPlan } from "./plan";

describe("groqRetryDelayMs", () => {
  it("prefers retry-after, then parses x-ratelimit-reset-tokens", () => {
    expect(groqRetryDelayMs(new Headers({ "retry-after": "3" }))).toBe(3000);
    expect(groqRetryDelayMs(new Headers({ "x-ratelimit-reset-tokens": "7.5s" }))).toBe(7500);
    expect(groqRetryDelayMs(new Headers({ "x-ratelimit-reset-tokens": "1m2s" }))).toBe(62000);
    expect(groqRetryDelayMs(new Headers())).toBeNull();
  });
});

describe("formatSources compact", () => {
  const movie: MovieHit = {
    id: 1, title: "Dark City", year: 1998, runtime: 100, rating: 7.3, genres: ["Science Fiction"],
    director: "Alex Proyas", overview: "A man wakes up with no memory. ".repeat(20), poster_path: null,
    doc: "Title: Dark City (1998)\nGenres: Science Fiction\nDirected by: Alex Proyas\nStarring: Rufus Sewell\nKeywords: memory, city\nReview: long review text",
  };

  it("keeps the identifying lines and a trimmed plot, drops keywords and reviews", () => {
    const text = formatSources([movie], { compact: true });
    expect(text).toContain("Title: Dark City (1998)");
    expect(text).toContain("Starring: Rufus Sewell");
    expect(text).not.toContain("Keywords:");
    expect(text).not.toContain("Review:");
    expect(text.length).toBeLessThan(formatSources([movie]).length + 600);
    expect(text).toMatch(/Plot: .{300,360}…/);
  });

  it("sends the full doc when not compact", () => {
    expect(formatSources([movie])).toContain("Review: long review text");
  });
});

describe("keywordQuery", () => {
  it("drops words that match nearly every plot", () => {
    expect(keywordQuery("feel-good movie about friendship")).toBe("feel friendship");
    expect(keywordQuery("mind‑bending sci‑fi heist")).toBe("mind bending sci fi heist");
    expect(keywordQuery("time loop stories")).toBe("time loop");
  });
  it("keeps the topic when only generic words are left", () => {
    expect(keywordQuery("a good movie")).toBe("a");
    expect(keywordQuery("movies")).toBe("movies");
  });
});

describe("minVotesForRating", () => {
  const base: SearchPlan = {
    topic: "", min_year: null, max_year: null, max_runtime: null, min_rating: null,
    genre: null, director: null, language: null, sort: "rating",
  };
  const today = new Date("2026-11-19T00:00:00Z");
  it("uses the ingest thresholds", () => {
    expect(minVotesForRating(base, today)).toBe(200);
    expect(minVotesForRating({ ...base, min_year: 2025 }, today)).toBe(50);
    expect(minVotesForRating({ ...base, language: "ta" }, today)).toBe(20);
    expect(minVotesForRating({ ...base, director: "Christopher Nolan" }, today)).toBe(20);
  });
});
