import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Proxy-key generation and verification.
 *
 * Every function here is pure — no filesystem, no config, no clock. That is
 * deliberate: this is security-critical logic, and keeping it free of I/O means
 * it can be exhaustively tested with plain values.
 */

const KEY_PREFIX = "cpx_";
const KEY_BYTES = 32;

/**
 * Mint a new proxy key.
 *
 * The caller is responsible for showing this to the user exactly once and then
 * discarding it. Only {@link hashProxyKey} output is ever persisted.
 */
export function generateProxyKey(): string {
  return KEY_PREFIX + randomBytes(KEY_BYTES).toString("base64url");
}

/** SHA-256 of a proxy key, hex-encoded. This is the only form written to disk. */
export function hashProxyKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/**
 * Check a presented key against a stored hash in constant time.
 *
 * Hashing first guarantees both buffers are 32 bytes, so `timingSafeEqual`
 * never throws on a length mismatch — and, more importantly, the comparison
 * leaks nothing about the real key's length. A plain `===` here would leak the
 * key byte by byte to an attacker who can measure response times.
 *
 * Returns false rather than throwing for absent or malformed input, so callers
 * can treat "no credential" and "wrong credential" identically.
 */
export function verifyProxyKey(
  presented: string | undefined | null,
  storedHash: string | undefined | null,
): boolean {
  if (!presented || !storedHash) return false;

  const expected = Buffer.from(storedHash, "hex");
  // A malformed stored hash would produce a short buffer; reject rather than
  // let timingSafeEqual throw.
  if (expected.length !== 32) return false;

  const actual = createHash("sha256").update(presented, "utf8").digest();
  return timingSafeEqual(actual, expected);
}
