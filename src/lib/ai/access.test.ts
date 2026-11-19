import { beforeAll, describe, expect, it, vi } from "vitest";
import { AccessError, accessCodeMatches, availableModes, looksLikeReplicateToken, resolveAccess } from "./access";

const ENV = {
  GROQ_API_KEY: "gsk_test",
  HF_TOKEN: "hf_test",
  REPLICATE_API_TOKEN: "r8_ownertoken0000000000000000",
  OWNER_ACCESS_CODE: "correct-horse-battery",
} as unknown as NodeJS.ProcessEnv; // Next types make NODE_ENV required

// The Replicate providers read their model name from the real environment.
beforeAll(() => vi.stubEnv("REPLICATE_EMBED_MODEL", "owner/e5-test:abc"));

const headers = (h: Record<string, string>) => new Headers(h);
const VISITOR_TOKEN = "r8_visitor00000000000000000000";

function expectAccessError(fn: () => unknown, status: number) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AccessError);
    expect((err as AccessError).status).toBe(status);
    return;
  }
  throw new Error("expected an AccessError");
}

describe("resolveAccess", () => {
  it("defaults to the free tier", () => {
    expect(resolveAccess(headers({}), ENV).mode).toBe("free");
  });

  it("uses Groq and keyword search (no embeddings), not Replicate, in free mode", () => {
    const a = resolveAccess(headers({ "x-reelsense-mode": "free" }), ENV);
    expect(a.chat.name).toMatch(/^groq:/);
    expect(a.embeddings).toBeNull();
  });

  it("refuses free mode when the free keys aren't configured", () => {
    expectAccessError(() => resolveAccess(headers({ "x-reelsense-mode": "free" }), { ...ENV, GROQ_API_KEY: "" }), 503);
  });

  it("requires a well-formed visitor token in byok mode", () => {
    expectAccessError(() => resolveAccess(headers({ "x-reelsense-mode": "byok" }), ENV), 401);
    expectAccessError(() => resolveAccess(headers({ "x-reelsense-mode": "byok", "x-replicate-token": "nope" }), ENV), 401);
    const a = resolveAccess(headers({ "x-reelsense-mode": "byok", "x-replicate-token": VISITOR_TOKEN }), ENV);
    expect(a.chat.name).toMatch(/^replicate:/);
    expect(a.embeddings?.name).toMatch(/^replicate:/);
  });

  it("never unlocks the owner's token without the right code", () => {
    expectAccessError(() => resolveAccess(headers({ "x-reelsense-mode": "owner" }), ENV), 403);
    expectAccessError(() => resolveAccess(headers({ "x-reelsense-mode": "owner", "x-access-code": "guess" }), ENV), 403);
    const a = resolveAccess(headers({ "x-reelsense-mode": "owner", "x-access-code": "correct-horse-battery" }), ENV);
    expect(a.mode).toBe("owner");
  });

  it("disables owner mode when the configured code is too short", () => {
    const weak = { ...ENV, OWNER_ACCESS_CODE: "1234" };
    expect(availableModes(weak).owner).toBe(false);
    expectAccessError(() => resolveAccess(headers({ "x-reelsense-mode": "owner", "x-access-code": "1234" }), weak), 403);
  });

  it("rejects unknown modes", () => {
    expectAccessError(() => resolveAccess(headers({ "x-reelsense-mode": "admin" }), ENV), 401);
  });
});

describe("helpers", () => {
  it("recognises Replicate tokens", () => {
    expect(looksLikeReplicateToken(VISITOR_TOKEN)).toBe(true);
    expect(looksLikeReplicateToken("sk-ant-123")).toBe(false);
  });

  it("compares access codes exactly", () => {
    expect(accessCodeMatches("abc", "abc")).toBe(true);
    expect(accessCodeMatches("abc", "abcd")).toBe(false);
  });

});
