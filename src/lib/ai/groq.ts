import { env, requireEnv } from "../env";
import type { ChatProvider } from "./types";

// Groq: OpenAI-compatible API with a free tier (no card needed), so it can't run up a bill.
// Free limits are per account and per model (about 8,000 tokens/minute and 1,000
// requests/day each), shared by every visitor. So the free tier plans with one model and
// answers with another (two separate token budgets), waits briefly when throttled, and
// only then surfaces "free tier is busy".
// Models change over time: check console.groq.com/docs/models.

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

/** Longest we wait for Groq's per-minute token budget to refill (the web request has 60 s in total). */
const MAX_THROTTLE_WAIT_MS = 20_000;

interface GroqResponse {
  choices: { message: { content: string | null } }[];
}

export class FreeTierBusyError extends Error {}

const BUSY_MESSAGE = "The free tier is busy right now. Try again in a minute, or use your own Replicate token.";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How long Groq says to wait, from retry-after (seconds) or x-ratelimit-reset-tokens ("7.66s", "1m2s"). */
export function groqRetryDelayMs(headers: Headers): number | null {
  const retryAfter = Number(headers.get("retry-after"));
  if (retryAfter > 0) return retryAfter * 1000;
  const reset = headers.get("x-ratelimit-reset-tokens");
  const m = reset ? /^(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(reset) : null;
  if (!m || (!m[1] && !m[2])) return null;
  return (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 1000;
}

/** Answering model by default; pass `model` for the planner (GROQ_PLAN_MODEL). */
export function groqChat({ model = env("GROQ_CHAT_MODEL", "openai/gpt-oss-120b") }: { model?: string } = {}): ChatProvider {
  return {
    name: `groq:${model}`,
    async complete({ system, prompt, jsonSchema, maxTokens }) {
      const fullPrompt = jsonSchema
        ? `${prompt}\n\nRespond with ONLY a JSON object matching this JSON Schema, no prose:\n${JSON.stringify(jsonSchema)}`
        : prompt;
      const body = JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: fullPrompt },
        ],
        max_tokens: maxTokens ?? 1024,
        temperature: 0.2,
        // gpt-oss models think before answering; "low" keeps answers fast and within free token limits.
        ...(/gpt-oss/.test(model) ? { reasoning_effort: "low" } : {}),
        // JSON mode guarantees a parseable object; the schema itself is in the prompt.
        ...(jsonSchema ? { response_format: { type: "json_object" } } : {}),
      });

      let waited = 0;
      for (;;) {
        const res = await fetch(GROQ_URL, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${requireEnv("GROQ_API_KEY")}` },
          body,
        });
        if (res.status === 429) {
          // Per-minute budgets refill within seconds; the daily one doesn't, so give up on long waits.
          const delay = groqRetryDelayMs(res.headers);
          if (delay === null || waited + delay > MAX_THROTTLE_WAIT_MS) throw new FreeTierBusyError(BUSY_MESSAGE);
          waited += delay + 250;
          await sleep(delay + 250);
          continue;
        }
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`Groq request failed: ${res.status} ${text.slice(0, 300)}`);
        }
        const data = (await res.json()) as GroqResponse;
        return data.choices[0]?.message.content ?? "";
      }
    },
  };
}
