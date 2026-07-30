import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  deriveChallenge,
  generatePkcePair,
  generateState,
  generateVerifier,
} from "../src/auth/pkce.js";

describe("generateVerifier", () => {
  it("stays inside RFC 7636's length window", () => {
    const verifier = generateVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
  });

  it("uses only unreserved characters, so no URL escaping is needed", () => {
    expect(generateVerifier()).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("is different every time", () => {
    const seen = new Set(Array.from({ length: 100 }, generateVerifier));
    expect(seen.size).toBe(100);
  });
});

describe("deriveChallenge", () => {
  it("matches the RFC 7636 appendix B test vector", () => {
    // The one published example; if our encoding drifts, this catches it.
    expect(deriveChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("is base64url of the sha256 digest, unpadded", () => {
    const verifier = generateVerifier();
    const expected = createHash("sha256")
      .update(verifier, "ascii")
      .digest("base64url");
    expect(deriveChallenge(verifier)).toBe(expected);
    expect(deriveChallenge(verifier)).not.toContain("=");
  });

  it("does not leak the verifier it hashed", () => {
    const verifier = generateVerifier();
    expect(deriveChallenge(verifier)).not.toBe(verifier);
  });
});

describe("generatePkcePair", () => {
  it("pairs a verifier with its own challenge", () => {
    const pair = generatePkcePair();
    expect(pair.challenge).toBe(deriveChallenge(pair.verifier));
    expect(pair.method).toBe("S256");
  });
});

describe("generateState", () => {
  it("uses 32 bytes of entropy, matching Claude Code's accepted state length", () => {
    expect(generateState()).toHaveLength(43);
  });

  it("produces distinct URL-safe tokens", () => {
    const seen = new Set(Array.from({ length: 100 }, generateState));
    expect(seen.size).toBe(100);
    expect(generateState()).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
