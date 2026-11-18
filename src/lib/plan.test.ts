import { describe, expect, it } from "vitest";
import { extractJson, normaliseGenre, normaliseLanguage, parsePlan, planSystem } from "./plan";

const valid = {
  topic: "mind-bending dreams and reality",
  min_year: 1990,
  max_year: 1999,
  max_runtime: 120,
  min_rating: null,
  genre: "sci-fi",
  director: null,
  sort: "relevance",
};

describe("extractJson", () => {
  it("finds JSON wrapped in prose or code fences", () => {
    expect(extractJson('Sure! ```json\n{"a":1}\n``` hope that helps')).toEqual({ a: 1 });
  });

  it("throws when there is no object", () => {
    expect(() => extractJson("no json here")).toThrow();
  });
});

describe("parsePlan", () => {
  it("accepts a valid plan and normalises the genre alias", () => {
    const plan = parsePlan(JSON.stringify(valid), "q");
    expect(plan.genre).toBe("Science Fiction");
    expect(plan.min_year).toBe(1990);
    expect(plan.max_runtime).toBe(120);
  });

  it("falls back to a plain semantic search on garbage output", () => {
    const plan = parsePlan("I am not JSON", "heist gone wrong");
    expect(plan.topic).toBe("heist gone wrong");
    expect(plan.sort).toBe("relevance");
    expect(plan.genre).toBeNull();
  });

  it("falls back when fields have the wrong types", () => {
    const plan = parsePlan(JSON.stringify({ ...valid, min_year: "nineties" }), "q");
    expect(plan.topic).toBe("q");
  });

  it("drops out-of-range values instead of filtering on them", () => {
    const plan = parsePlan(
      JSON.stringify({ ...valid, min_year: 90, min_rating: 85, max_runtime: -5 }),
      "q",
    );
    expect(plan.min_year).toBeNull();
    expect(plan.min_rating).toBeNull();
    expect(plan.max_runtime).toBeNull();
  });

  it("keeps an empty topic so fact questions route to SQL", () => {
    const plan = parsePlan(
      JSON.stringify({ ...valid, topic: "  ", genre: null, director: "Christopher Nolan", sort: "rating" }),
      "top rated nolan films",
    );
    expect(plan.topic).toBe("");
    expect(plan.director).toBe("Christopher Nolan");
  });
});

describe("normaliseGenre", () => {
  it("matches TMDB names case-insensitively", () => {
    expect(normaliseGenre("science fiction")).toBe("Science Fiction");
  });

  it("returns null for unknown genres rather than filtering everything out", () => {
    expect(normaliseGenre("cyberpunk")).toBeNull();
  });
});

describe("language", () => {
  it("normalises names and codes", () => {
    expect(normaliseLanguage("Tamil")).toBe("ta");
    expect(normaliseLanguage("ko")).toBe("ko");
    expect(normaliseLanguage("Klingon")).toBeNull();
    expect(normaliseLanguage(null)).toBeNull();
  });

  it("parses a plan with a language, and one where the model left it out", () => {
    expect(parsePlan(JSON.stringify({ ...valid, language: "Tamil" }), "q").language).toBe("ta");
    expect(parsePlan(JSON.stringify(valid), "q").language).toBeNull();
  });
});

describe("planSystem", () => {
  it("tells the model today's date so 'this year' resolves", () => {
    const prompt = planSystem(new Date("2026-11-18T00:00:00Z"));
    expect(prompt).toContain("Today's date is 2026-11-18");
    expect(prompt).toContain('"this year" -> 2026 and 2026');
  });
});
