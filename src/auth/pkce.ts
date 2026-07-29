import { createHash, randomBytes } from "node:crypto";

/**
 * PKCE (RFC 7636) and the CSRF `state` parameter.
 *
 * Pure, like {@link ../keys.js}: these values are the entire defence against an
 * intercepted authorization code, so they are kept free of I/O and tested
 * directly.
 */

/** RFC 7636 allows 43–128 characters; 32 random bytes base64url-encode to 43. */
const VERIFIER_BYTES = 32;
const STATE_BYTES = 16;

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: "S256";
}

/**
 * A verifier is raw entropy, not a hash of anything guessable.
 *
 * base64url is used rather than hex because the encoding is already in the
 * unreserved character set, so the value survives a URL round-trip unescaped.
 */
export function generateVerifier(): string {
  return randomBytes(VERIFIER_BYTES).toString("base64url");
}

/** S256 challenge: base64url(sha256(verifier)), no padding. */
export function deriveChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function generatePkcePair(): PkcePair {
  const verifier = generateVerifier();
  return { verifier, challenge: deriveChallenge(verifier), method: "S256" };
}

/**
 * Opaque CSRF token echoed back by the authorization server.
 *
 * Without it, any page the user visits during login could hit the loopback
 * redirect with an attacker's code and bind the proxy to the attacker's account.
 */
export function generateState(): string {
  return randomBytes(STATE_BYTES).toString("base64url");
}
