import { env } from "../env";
import { postJson } from "./http";
import type { ChatProvider, EmbeddingProvider } from "./types";

// Free, local models: https://ollama.com
// ollama pull llama3.1:8b && ollama pull mxbai-embed-large

const baseUrl = () => env("OLLAMA_URL", "http://127.0.0.1:11434");

// mxbai-embed-large is trained to expect this prefix on search queries.
const MXBAI_QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

export function ollamaEmbeddings(): EmbeddingProvider {
  const model = env("OLLAMA_EMBED_MODEL", "mxbai-embed-large");
  return {
    name: `ollama:${model}`,
    async embed(texts, kind) {
      const input =
        kind === "query" && model.includes("mxbai")
          ? texts.map((t) => MXBAI_QUERY_PREFIX + t)
          : texts;
      const res = await postJson<{ embeddings: number[][] }>(`${baseUrl()}/api/embed`, {
        model,
        input,
      });
      return res.embeddings;
    },
  };
}

export function ollamaChat(): ChatProvider {
  const model = env("OLLAMA_CHAT_MODEL", "llama3.1:8b");
  return {
    name: `ollama:${model}`,
    async complete({ system, prompt, jsonSchema }) {
      const res = await postJson<{ message: { content: string } }>(`${baseUrl()}/api/chat`, {
        model,
        stream: false,
        // Ollama can constrain output to a JSON Schema.
        ...(jsonSchema ? { format: jsonSchema } : {}),
        options: { temperature: 0.2 },
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
      });
      return res.message.content;
    },
  };
}
