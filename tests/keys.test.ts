import { describe, expect, it } from "vitest";
import {
  generateProxyKey,
  hashProxyKey,
  verifyProxyKey,
} from "../src/keys.js";

describe("generateProxyKey", () => {
  it("prefixes keys so they are recognizable in a config field", () => {
    expect(generateProxyKey().startsWith("cpx_")).toBe(true);
  });

  it("produces a distinct key on every call", () => {
    const keys = new Set(Array.from({ length: 100 }, generateProxyKey));
    expect(keys.size).toBe(100);
  });

  it("carries 32 bytes of entropy in a URL-safe encoding", () => {
    const body = generateProxyKey().slice("cpx_".length);
    expect(body).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(body, "base64url").length).toBe(32);
  });
});

describe("hashProxyKey", () => {
  it("returns a 64-character hex digest", () => {
    expect(hashProxyKey("cpx_example")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across calls", () => {
    expect(hashProxyKey("cpx_example")).toBe(hashProxyKey("cpx_example"));
  });

  it("does not embed the key it hashed", () => {
    const key = generateProxyKey();
    expect(hashProxyKey(key)).not.toContain(key.slice(4, 16));
  });
});

describe("verifyProxyKey", () => {
  it("accepts the key that produced the stored hash", () => {
    const key = generateProxyKey();
    expect(verifyProxyKey(key, hashProxyKey(key))).toBe(true);
  });

  it("rejects a different key", () => {
    expect(verifyProxyKey(generateProxyKey(), hashProxyKey(generateProxyKey()))).toBe(
      false,
    );
  });

  it("rejects a key differing by one character", () => {
    const key = generateProxyKey();
    const tampered = key.slice(0, -1) + (key.endsWith("A") ? "B" : "A");
    expect(verifyProxyKey(tampered, hashProxyKey(key))).toBe(false);
  });

  it("treats a missing credential as a wrong credential, without throwing", () => {
    const hash = hashProxyKey(generateProxyKey());
    expect(verifyProxyKey(undefined, hash)).toBe(false);
    expect(verifyProxyKey(null, hash)).toBe(false);
    expect(verifyProxyKey("", hash)).toBe(false);
  });

  it("rejects rather than throws when no hash is configured", () => {
    expect(verifyProxyKey(generateProxyKey(), null)).toBe(false);
    expect(verifyProxyKey(generateProxyKey(), undefined)).toBe(false);
  });

  it("rejects rather than throws on a malformed stored hash", () => {
    // A truncated hash would make a naive timingSafeEqual call throw on
    // length mismatch, turning a config problem into a 500.
    expect(verifyProxyKey(generateProxyKey(), "deadbeef")).toBe(false);
    expect(verifyProxyKey(generateProxyKey(), "not-hex-at-all")).toBe(false);
  });
});
