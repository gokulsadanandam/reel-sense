import { createHash, timingSafeEqual } from "node:crypto";
import { groqChat } from "./groq";
import { replicateChat, replicateEmbeddings } from "./replicate";
import type { ChatProvider, EmbeddingProvider } from "./types";

// Who pays for a question. The browser picks a mode and sends credentials in headers:
//
//   free   Groq's free tier on the server's free account (no card, so no bill) + keyword search
//          (no embedding model: there's no free host for the e5 model the movies use)
//   byok   the visitor's own Replicate token (x-replicate-token), used for this request only,
//          never stored or logged
//   owner  the server's REPLICATE_API_TOKEN, unlocked by x-access-code == OWNER_ACCESS_CODE
//
// The server's Replicate token is NEVER used without the access code.

export type AccessMode = "free" | "byok" | "owner";

export interface AiAccess {
  mode: AccessMode;
  chat: ChatProvider;
  /** null: no embedding model, so topics use keyword search (the free tier). */
  embeddings: EmbeddingProvider | null;
  /** Separate planning model, if any (see AskProviders). */
  planner?: ChatProvider;
  /** Shorter sources in the answer prompt (see AskProviders). */
  compactSources?: boolean;
}

export class AccessError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403 | 503,
  ) {
    super(message);
  }
}

/** Owner codes shorter than this are ignored, so a weak code can't be guessed quickly. */
export const MIN_ACCESS_CODE_LENGTH = 12;

/** Which modes this deployment can serve (shown in the UI). */
export function availableModes(env: NodeJS.ProcessEnv = process.env): Record<AccessMode, boolean> {
  return {
    free: Boolean(env.GROQ_API_KEY),
    byok: true,
    owner: Boolean(env.REPLICATE_API_TOKEN && (env.OWNER_ACCESS_CODE ?? "").length >= MIN_ACCESS_CODE_LENGTH),
  };
}

/** Replicate API tokens start with "r8_". Reject anything else before calling out. */
export function looksLikeReplicateToken(token: string): boolean {
  return /^r8_[A-Za-z0-9]{20,}$/.test(token);
}

/** Constant-time comparison, so response timing doesn't leak how much of a guess was right. */
export function accessCodeMatches(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function resolveAccess(headers: Headers, env: NodeJS.ProcessEnv = process.env): AiAccess {
  const mode = (headers.get("x-reelsense-mode") ?? "free") as AccessMode;
  const available = availableModes(env);

  switch (mode) {
    case "free":
      if (!available.free) {
        throw new AccessError("The free tier isn't set up on this site. Use your own Replicate token.", 503);
      }
      // Plan and answer on different models: Groq's free token budget is per model.
      return {
        mode,
        chat: groqChat(),
        planner: groqChat({ model: env.GROQ_PLAN_MODEL || "openai/gpt-oss-20b" }),
        embeddings: null,
        compactSources: true,
      };

    case "byok": {
      const token = headers.get("x-replicate-token")?.trim() ?? "";
      if (!looksLikeReplicateToken(token)) {
        throw new AccessError("Enter a valid Replicate API token (it starts with r8_).", 401);
      }
      return { mode, chat: replicateChat({ token }), embeddings: replicateEmbeddings({ token }) };
    }

    case "owner": {
      const code = headers.get("x-access-code") ?? "";
      if (!available.owner || !accessCodeMatches(code, env.OWNER_ACCESS_CODE ?? "")) {
        throw new AccessError("Wrong access code.", 403);
      }
      return { mode, chat: replicateChat(), embeddings: replicateEmbeddings() };
    }

    default:
      throw new AccessError("Unknown access mode.", 401);
  }
}
