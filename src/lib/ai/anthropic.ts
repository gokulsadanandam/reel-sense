import Anthropic from "@anthropic-ai/sdk";
import { env } from "../env";
import type { ChatProvider } from "./types";

// Claude via the official SDK. Reads ANTHROPIC_API_KEY from the environment.
// Pay per token; set ANTHROPIC_MODEL=claude-haiku-5-5 for the cheapest option.

export function claudeChat(): ChatProvider {
  const client = new Anthropic();
  const model = env("ANTHROPIC_MODEL", "claude-opus-5-5");
  // Server-side refusal fallback is supported on the Opus/Sonnet/Fable tiers, not Haiku.
  const useFallback = !model.includes("haiku");

  return {
    name: `anthropic:${model}`,
    async complete({ system, prompt, jsonSchema, maxTokens }) {
      const response = await client.beta.messages.create({
        model,
        max_tokens: maxTokens ?? 16000,
        ...(useFallback
          ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
          : {}),
        system,
        messages: [{ role: "user", content: prompt }],
        output_config: {
          // Search planning is simple; answers get a little more thought.
          effort: jsonSchema ? "low" : "medium",
          ...(jsonSchema ? { format: { type: "json_schema" as const, schema: jsonSchema } } : {}),
        },
      });

      if (response.stop_reason === "refusal") {
        throw new Error("Claude declined to answer this request.");
      }
      return response.content
        .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");
    },
  };
}
