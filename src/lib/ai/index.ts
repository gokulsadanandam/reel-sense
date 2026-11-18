import { env } from "../env";
import { claudeChat } from "./anthropic";
import { ollamaChat, ollamaEmbeddings } from "./ollama";
import { replicateChat, replicateEmbeddings } from "./replicate";
import { EMBEDDING_DIM, type ChatProvider, type EmbedKind, type EmbeddingProvider } from "./types";
import { voyageEmbeddings } from "./voyage";

/** Chat provider chosen by AI_PROVIDER. Swap providers without touching the RAG code. */
export function getChat(): ChatProvider {
  const provider = env("AI_PROVIDER", "replicate");
  switch (provider) {
    case "ollama":
      return ollamaChat();
    case "replicate":
      return replicateChat();
    case "anthropic":
      return claudeChat();
    default:
      throw new Error(`Unknown AI_PROVIDER "${provider}" (use ollama | replicate | anthropic)`);
  }
}

/** Embedding provider chosen by EMBED_PROVIDER. */
export function getEmbeddings(): EmbeddingProvider {
  const provider = env("EMBED_PROVIDER", "replicate");
  switch (provider) {
    case "ollama":
      return ollamaEmbeddings();
    case "replicate":
      return replicateEmbeddings();
    case "voyage":
      return voyageEmbeddings();
    default:
      throw new Error(`Unknown EMBED_PROVIDER "${provider}" (use ollama | replicate | voyage)`);
  }
}

/** Embeds and checks every vector fits the database column, with a clear error if not. */
export async function embed(
  provider: EmbeddingProvider,
  texts: string[],
  kind: EmbedKind,
): Promise<number[][]> {
  const vectors = await provider.embed(texts, kind);
  if (vectors.length !== texts.length) {
    throw new Error(`${provider.name} returned ${vectors.length} vectors for ${texts.length} texts`);
  }
  for (const v of vectors) {
    if (v.length !== EMBEDDING_DIM) {
      throw new Error(
        `${provider.name} returned ${v.length}-dim vectors but the database expects ${EMBEDDING_DIM}. ` +
          `Pick a ${EMBEDDING_DIM}-dim model or change vector(${EMBEDDING_DIM}) in the migration.`,
      );
    }
  }
  return vectors;
}

export type { ChatProvider, EmbeddingProvider, EmbedKind } from "./types";
