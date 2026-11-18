import { NextResponse } from "next/server";
import { z } from "zod";
import { ask } from "@/lib/rag";

export const runtime = "nodejs";
// Two LLM calls + one embedding; hosted models can take a while on a cold start.
export const maxDuration = 60;

const Body = z.object({
  question: z.string().trim().min(1).max(500),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(4000) }))
    .max(12)
    .default([]),
});

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    const result = await ask(parsed.data.question, parsed.data.history);
    // `doc` is the embedded text: useful for debugging, too big to send to the browser.
    return NextResponse.json({
      ...result,
      movies: result.movies.map(({ doc: _doc, ...m }) => m),
    });
  } catch (err) {
    console.error("ask failed", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Something went wrong" },
      { status: 500 },
    );
  }
}
