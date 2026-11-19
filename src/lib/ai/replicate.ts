import Replicate from "replicate";
import { env, requireEnv } from "../env";
import type { ChatProvider, EmbedKind, EmbeddingProvider } from "./types";

// Replicate: pay per use. Official models (e.g. meta/*) stay warm. Community
// models can cold-start and need a version hash: "owner/name:version".

type ModelRef = `${string}/${string}` | `${string}/${string}:${string}`;

/** A Replicate client for `token` (a visitor's own key) or, if omitted, the server's REPLICATE_API_TOKEN. */
const client = (token?: string) => new Replicate({ auth: token ?? requireEnv("REPLICATE_API_TOKEN") });

export interface ReplicateOptions {
  /** Per-request API token. Omit to use the server's REPLICATE_API_TOKEN. */
  token?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Seconds to wait if `err` is a Replicate 429 (rate limit), otherwise null. */
export function throttleDelaySeconds(err: unknown): number | null {
  const status = (err as { response?: { status?: number } })?.response?.status;
  const message = err instanceof Error ? err.message : String(err);
  if (status !== 429 && !/\b429\b/.test(message)) return null;
  const match = /"retry_after":\s*(\d+(?:\.\d+)?)/.exec(message);
  return match ? Number(match[1]) : 10;
}

/**
 * Replicate throttles accounts with under $5 credit to 6 predictions/minute, burst 1.
 * The SDK's own retries give up quickly, so keep waiting (up to `maxWaitMs` in total).
 */
async function runWithThrottleRetry<T>(fn: () => Promise<T>, maxWaitMs: number): Promise<T> {
  let waited = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const seconds = throttleDelaySeconds(err);
      const delay = seconds === null ? 0 : (seconds + 1) * 1000;
      if (seconds === null || waited + delay > maxWaitMs) throw err;
      waited += delay;
      await sleep(delay);
    }
  }
}

// The web request has a 60 s limit (3 calls per question), so wait less there than in the ingest.
const maxWaitMs = () => Number(env("REPLICATE_MAX_THROTTLE_WAIT_MS", "15000")) || 15000;

export function replicateChat({ token }: ReplicateOptions = {}): ChatProvider {
  const model = env("REPLICATE_CHAT_MODEL", "meta/meta-llama-3-70b-instruct") as ModelRef;
  return {
    name: `replicate:${model}`,
    async complete({ system, prompt, jsonSchema, maxTokens }) {
      // Replicate LLMs have no JSON mode, so the schema goes into the prompt and
      // the caller extracts and validates the JSON from the reply.
      const fullPrompt = jsonSchema
        ? `${prompt}\n\nRespond with ONLY a JSON object matching this JSON Schema, no prose:\n${JSON.stringify(jsonSchema)}`
        : prompt;
      const output = await runWithThrottleRetry(() => client(token).run(model, {
        input: isLlama3(model)
          ? {
              // Replicate's Llama 3 models have no system_prompt input (it would be
              // silently ignored), so we build the chat format ourselves and pass it raw.
              prompt: llama3ChatPrompt(system, fullPrompt),
              prompt_template: "{prompt}",
              max_tokens: maxTokens ?? 1024,
              temperature: 0.2,
              // Defaults (1.15 / 0.2) penalise repeating tokens, which hurts JSON output.
              presence_penalty: 0,
              frequency_penalty: 0,
            }
          : {
              system_prompt: system,
              prompt: fullPrompt,
              max_tokens: maxTokens ?? 1024,
              temperature: 0.2,
            },
      }), maxWaitMs());
      // Language models on Replicate return their output as an array of text pieces.
      return Array.isArray(output) ? output.join("") : String(output);
    },
  };
}

export function replicateEmbeddings({ token }: ReplicateOptions = {}): EmbeddingProvider {
  const model = requireEnv("REPLICATE_EMBED_MODEL") as ModelRef;
  return {
    name: `replicate:${model}`,
    async embed(texts, kind) {
      // Common input shape for bge/e5 embedding models on Replicate: a JSON-encoded
      // list of strings. Check your model's page and adjust if its inputs differ.
      const output = await runWithThrottleRetry(
        () => client(token).run(model, { input: { texts: JSON.stringify(withE5Prefix(model, texts, kind)) } }),
        maxWaitMs(),
      );
      return normaliseEmbeddingOutput(output);
    },
  };
}

export function isLlama3(model: string): boolean {
  return /llama-3/i.test(model);
}

/** Llama 3 instruct chat format, with the system message included. */
export function llama3ChatPrompt(system: string, user: string): string {
  return (
    "<|begin_of_text|>" +
    `<|start_header_id|>system<|end_header_id|>\n\n${system}<|eot_id|>` +
    `<|start_header_id|>user<|end_header_id|>\n\n${user}<|eot_id|>` +
    "<|start_header_id|>assistant<|end_header_id|>\n\n"
  );
}

/**
 * E5 models are trained with "query: " / "passage: " prefixes. Without them,
 * retrieval quality drops noticeably. Other models get the texts unchanged.
 */
export function withE5Prefix(model: string, texts: string[], kind: EmbedKind): string[] {
  if (!/(^|[/-])e5[-_]/i.test(model)) return texts;
  const prefix = kind === "query" ? "query: " : "passage: ";
  return texts.map((t) => prefix + t);
}

/** Accepts `number[][]` or `[{ embedding: number[] }]`, the two common output shapes. */
export function normaliseEmbeddingOutput(output: unknown): number[][] {
  if (!Array.isArray(output)) {
    throw new Error("Unexpected embedding output from Replicate: not an array");
  }
  return output.map((item) => {
    if (Array.isArray(item)) return item as number[];
    if (item && typeof item === "object" && Array.isArray((item as { embedding?: unknown }).embedding)) {
      return (item as { embedding: number[] }).embedding;
    }
    throw new Error("Unexpected embedding output item from Replicate");
  });
}
