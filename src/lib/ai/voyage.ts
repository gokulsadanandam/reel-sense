import { env, requireEnv } from "../env";
import { postJson } from "./http";
import type { EmbeddingProvider } from "./types";

// Voyage AI embeddings: https://docs.voyageai.com
// voyage-3.5 outputs 1024-dim vectors by default.

export function voyageEmbeddings(): EmbeddingProvider {
  const model = env("VOYAGE_MODEL", "voyage-3.5");
  return {
    name: `voyage:${model}`,
    async embed(texts, kind) {
      const res = await postJson<{ data: { index: number; embedding: number[] }[] }>(
        "https://api.voyageai.com/v1/embeddings",
        { model, input: texts, input_type: kind },
        { authorization: `Bearer ${requireEnv("VOYAGE_API_KEY")}` },
      );
      return [...res.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    },
  };
}
