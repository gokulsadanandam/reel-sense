/** Every embedding model used here must output vectors of this size (see the migration). */
export const EMBEDDING_DIM = 1024;

/** Some models embed documents and search queries differently. */
export type EmbedKind = "document" | "query";

export interface EmbeddingProvider {
  name: string;
  embed(texts: string[], kind: EmbedKind): Promise<number[][]>;
}

export interface CompleteOptions {
  system: string;
  prompt: string;
  /** When set, the provider should return JSON matching this JSON Schema. */
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
}

export interface ChatProvider {
  name: string;
  complete(options: CompleteOptions): Promise<string>;
}
