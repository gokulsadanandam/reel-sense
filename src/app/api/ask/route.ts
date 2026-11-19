import { NextResponse } from "next/server";
import { z } from "zod";
import { AccessError, resolveAccess } from "@/lib/ai/access";
import { FreeTierBusyError } from "@/lib/ai/groq";
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

  let access;
  try {
    // Credentials come from headers and are used for this request only: never stored or logged.
    access = resolveAccess(request.headers);
  } catch (err) {
    if (err instanceof AccessError) {
      // Slow down access-code guessing a little.
      if (err.status === 403) await new Promise((r) => setTimeout(r, 1000));
      return NextResponse.json({ error: err.message, needsAccess: true }, { status: err.status });
    }
    throw err;
  }

  try {
    const result = await ask(parsed.data.question, parsed.data.history, access);
    // `doc` is the embedded text: useful for debugging, too big to send to the browser.
    return NextResponse.json({
      ...result,
      mode: access.mode,
      movies: result.movies.map(({ doc: _doc, ...m }) => m),
    });
  } catch (err) {
    if (err instanceof FreeTierBusyError) {
      return NextResponse.json({ error: err.message }, { status: 429 });
    }
    const message = err instanceof Error ? err.message : String(err);
    if (access.mode === "byok" && /\b401\b|unauthenticated|invalid token/i.test(message)) {
      return NextResponse.json({ error: "Replicate rejected your token. Check it and try again.", needsAccess: true }, { status: 401 });
    }
    if (access.mode === "byok" && /\b402\b|insufficient credit|billing/i.test(message)) {
      return NextResponse.json({ error: "Your Replicate account needs credit (Replicate → Billing)." }, { status: 402 });
    }
    // Log the mode and message only; request headers (which hold tokens) are never logged.
    console.error(`ask failed (mode=${access.mode}):`, message);
    // Only the owner sees provider details; visitors get a generic message.
    const shown = access.mode === "owner" ? message : "Something went wrong answering that. Please try again.";
    return NextResponse.json({ error: shown }, { status: 500 });
  }
}
