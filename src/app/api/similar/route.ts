import { NextResponse } from "next/server";
import { similarMovies } from "@/lib/rag";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const id = Number(new URL(request.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  try {
    const movies = await similarMovies(id);
    return NextResponse.json({ movies: movies.map(({ doc: _doc, ...m }) => m) });
  } catch (err) {
    console.error("similar failed", err);
    return NextResponse.json({ error: "Could not load similar movies" }, { status: 500 });
  }
}
