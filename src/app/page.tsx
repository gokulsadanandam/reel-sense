"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { posterUrl } from "@/lib/movies";

interface Movie {
  id: number;
  title: string;
  year: number | null;
  runtime: number | null;
  rating: number | null;
  genres: string[];
  poster_path: string | null;
  similarity?: number;
}

interface Turn {
  id: number;
  question: string;
  answer?: string;
  movies?: Movie[];
  route?: "vector" | "sql";
  error?: string;
}

const EXAMPLES = [
  "Something like Inception but from the 90s, under 2 hours",
  "Top rated Christopher Nolan films",
  "A feel-good movie about friendship",
  "Dark crime thrillers from the 2000s",
];

export default function Home() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const nextId = useRef(0);
  const endRef = useRef<HTMLDivElement>(null);
  const turnRefs = useRef(new Map<number, HTMLElement>());

  // Scrolling, like a chat:
  //  - a new question was added -> scroll to the end (question + "Searching…" visible)
  //  - its answer arrived       -> scroll that turn's top into view, so a long answer is
  //                                read from the start instead of jumping past it to the cards
  const last = turns.at(-1);
  const lastAnswered = Boolean(last?.answer || last?.error);
  useEffect(() => {
    if (!last) return;
    const behavior: ScrollBehavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    if (lastAnswered) turnRefs.current.get(last.id)?.scrollIntoView({ behavior, block: "start" });
    else endRef.current?.scrollIntoView({ behavior, block: "end" });
    // Only react to a new turn or to the latest turn getting its answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last?.id, lastAnswered]);

  /** Adds a turn and returns its id, so the reply updates the right turn even if another one was added since. */
  function addTurn(question: string): number {
    const id = nextId.current++;
    setTurns((prev) => [...prev, { id, question }]);
    return id;
  }

  function updateTurn(id: number, patch: Partial<Turn>) {
    setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }

  async function ask(question: string) {
    if (!question.trim() || loading) return;
    setInput("");
    setLoading(true);

    // Send recent turns so follow-ups ("only the older ones") work.
    const history = turns.flatMap((t) =>
      t.answer
        ? [
            { role: "user" as const, content: t.question },
            { role: "assistant" as const, content: t.answer },
          ]
        : [],
    );
    const id = addTurn(question);

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question, history }),
      });
      const data = await res.json();
      updateTurn(id, res.ok ? data : { error: data.error ?? "Request failed" });
    } catch {
      updateTurn(id, { error: "Network error" });
    } finally {
      setLoading(false);
    }
  }

  async function moreLikeThis(movie: Movie) {
    if (loading) return;
    setLoading(true);
    const id = addTurn(`More like ${movie.title}`);
    try {
      const res = await fetch(`/api/similar?id=${movie.id}`);
      const data = await res.json();
      updateTurn(
        id,
        res.ok
          ? { answer: `Closest matches to ${movie.title} by meaning:`, movies: data.movies, route: "vector" }
          : { error: data.error ?? "Request failed" },
      );
    } catch {
      updateTurn(id, { error: "Network error" });
    } finally {
      setLoading(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void ask(input);
  }

  return (
    <main>
      <h1>ReelSense</h1>
      <p className="subtitle">Ask for movies in plain English. Answers come only from the database.</p>

      {turns.length === 0 && (
        <div className="examples">
          {EXAMPLES.map((q) => (
            <button key={q} type="button" onClick={() => void ask(q)}>
              {q}
            </button>
          ))}
        </div>
      )}

      {turns.map((turn) => (
        <section
          key={turn.id}
          className="turn"
          ref={(el) => {
            if (el) turnRefs.current.set(turn.id, el);
            else turnRefs.current.delete(turn.id);
          }}
        >
          <div className="question">{turn.question}</div>
          {turn.error && <p className="error">{turn.error}</p>}
          {!turn.error && !turn.answer && <p className="meta">Searching…</p>}
          {turn.answer && <div className="answer">{linkTitles(turn.answer)}</div>}
          {turn.route && (
            <p className="meta">
              {turn.route === "vector" ? "Hybrid search (filters + meaning)" : "SQL search (facts only)"} ·{" "}
              {turn.movies?.length ?? 0} sources
            </p>
          )}
          {turn.movies && turn.movies.length > 0 && (
            <div className="cards">
              {turn.movies.map((m) => (
                <MovieCard key={m.id} movie={m} disabled={loading} onMore={() => void moreLikeThis(m)} />
              ))}
            </div>
          )}
        </section>
      ))}
      <div ref={endRef} className="scroll-end" aria-hidden="true" />

      <form className="ask" onSubmit={onSubmit}>
        <div className="row">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="e.g. 90s sci-fi about memory, under 2 hours"
            aria-label="Ask about movies"
          />
          <button type="submit" disabled={loading || !input.trim()}>
            Ask
          </button>
        </div>
      </form>
    </main>
  );
}

function MovieCard({ movie, disabled, onMore }: { movie: Movie; disabled: boolean; onMore: () => void }) {
  const src = posterUrl(movie.poster_path, "w185");
  return (
    <div className="card">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={`${movie.title} poster`} loading="lazy" />
      ) : (
        <div className="noposter">No poster</div>
      )}
      <div className="info">
        <a
          className="title"
          href={googleSearchUrl(`${movie.title}${movie.year ? ` ${movie.year}` : ""}`)}
          target="_blank"
          rel="noopener noreferrer"
          title="Search on Google"
        >
          {movie.title} {movie.year ? `(${movie.year})` : ""}
        </a>
        <span className="meta">
          {[movie.rating !== null ? `★ ${movie.rating}` : null, movie.runtime ? `${movie.runtime}m` : null]
            .filter(Boolean)
            .join(" · ")}
        </span>
        <button type="button" onClick={onMore} disabled={disabled}>
          More like this →
        </button>
      </div>
    </div>
  );
}

function googleSearchUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(`${query} film`)}`;
}

/**
 * The answer model writes movies in bold, e.g. **Dark City (1998)**. Turn each bold
 * span into a Google search link; everything else stays plain text (no HTML injection).
 */
function linkTitles(answer: string): React.ReactNode[] {
  return answer.split(/\*\*(.+?)\*\*/g).map((part, i) => {
    if (i % 2 === 0) return part; // text outside **...**
    const query = part.replace(/\((\d{4})\)/, "$1").trim(); // "Dark City (1998)" -> "Dark City 1998"
    return (
      <a key={i} href={googleSearchUrl(query)} target="_blank" rel="noopener noreferrer" title="Search on Google">
        {part}
      </a>
    );
  });
}
