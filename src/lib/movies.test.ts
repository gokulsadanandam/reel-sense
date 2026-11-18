import { describe, expect, it } from "vitest";
import { buildMovieRow, type TmdbMovieDetails } from "./movies";
import { isLlama3, llama3ChatPrompt, normaliseEmbeddingOutput, withE5Prefix } from "./ai/replicate";

describe("llama3ChatPrompt", () => {
  it("embeds the system message in Llama 3 chat format", () => {
    const p = llama3ChatPrompt("Only use sources.", "Hi");
    expect(p).toContain("<|start_header_id|>system<|end_header_id|>\n\nOnly use sources.<|eot_id|>");
    expect(p.endsWith("<|start_header_id|>assistant<|end_header_id|>\n\n")).toBe(true);
    expect(isLlama3("meta/meta-llama-3-70b-instruct")).toBe(true);
    expect(isLlama3("ibm-granite/granite-3.3-8b-instruct")).toBe(false);
  });
});

describe("withE5Prefix", () => {
  it("adds query/passage prefixes for e5 models only", () => {
    const e5 = "beautyyuyanli/multilingual-e5-large:abc123";
    expect(withE5Prefix(e5, ["heist"], "query")).toEqual(["query: heist"]);
    expect(withE5Prefix(e5, ["plot"], "document")).toEqual(["passage: plot"]);
    expect(withE5Prefix("nateraw/bge-large-en-v1.5:def", ["x"], "query")).toEqual(["x"]);
  });
});

const inception: TmdbMovieDetails = {
  id: 27205,
  title: "Inception",
  release_date: "2010-07-15",
  runtime: 148,
  vote_average: 8.4,
  vote_count: 35000,
  genres: [{ name: "Action" }, { name: "Science Fiction" }],
  overview: "A thief who steals corporate secrets through dream-sharing technology...",
  tagline: "Your mind is the scene of the crime.",
  poster_path: "/abc.jpg",
  credits: {
    cast: [
      { name: "Joseph Gordon-Levitt", order: 1 },
      { name: "Leonardo DiCaprio", order: 0 },
    ],
    crew: [
      { name: "Hans Zimmer", job: "Original Music Composer" },
      { name: "Christopher Nolan", job: "Director" },
    ],
  },
  keywords: { keywords: [{ name: "dream" }, { name: "subconscious" }] },
  reviews: { results: [{ content: "A   puzzle box\n\nof a film." }] },
};

describe("buildMovieRow", () => {
  const row = buildMovieRow(inception);

  it("extracts filterable facts as columns", () => {
    expect(row.year).toBe(2010);
    expect(row.runtime).toBe(148);
    expect(row.rating).toBe(8.4);
    expect(row.director).toBe("Christopher Nolan");
    expect(row.genres).toEqual(["Action", "Science Fiction"]);
    expect(row.cast_names).toEqual(["Leonardo DiCaprio", "Joseph Gordon-Levitt"]);
  });

  it("puts descriptive text in the embedded doc", () => {
    expect(row.doc).toContain("Title: Inception (2010)");
    expect(row.doc).toContain("Keywords: dream, subconscious");
    expect(row.doc).toContain("Plot: A thief");
    expect(row.doc).toContain("What viewers say: A puzzle box of a film.");
  });

  it("handles movies with missing data", () => {
    const bare = buildMovieRow({ id: 1, title: "Untitled" });
    expect(bare.year).toBeNull();
    expect(bare.director).toBeNull();
    expect(bare.doc).toBe("Title: Untitled");
  });
});

describe("normaliseEmbeddingOutput", () => {
  it("accepts both common Replicate output shapes", () => {
    expect(normaliseEmbeddingOutput([[1, 2]])).toEqual([[1, 2]]);
    expect(normaliseEmbeddingOutput([{ embedding: [3, 4] }])).toEqual([[3, 4]]);
  });

  it("rejects unexpected output", () => {
    expect(() => normaliseEmbeddingOutput("nope")).toThrow();
  });
});

import { throttleDelaySeconds } from "./ai/replicate";

describe("throttleDelaySeconds", () => {
  it("reads retry_after from a Replicate 429 error", () => {
    const err = new Error('failed with status 429 Too Many Requests: {"detail":"throttled","status":429,"retry_after":5}');
    expect(throttleDelaySeconds(err)).toBe(5);
  });
  it("ignores other errors", () => {
    expect(throttleDelaySeconds(new Error("status 422 invalid version"))).toBeNull();
  });
});
