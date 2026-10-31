import type { IncomingHttpHeaders } from "node:http";

/**
 * Header rewriting between the local client and Anthropic.
 *
 * Pure functions over plain header bags: this is where a credential leaks if it
 * leaks at all, so it is kept free of sockets and exhaustively testable.
 */

/**
 * Applied only when the caller sends no `anthropic-version`.
 *
 * The Anthropic API rejects a request without it, and some OpenAI-compatible
 * clients pointed at this proxy never send one.
 */
export const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
export const OAUTH_BETA_HEADER = "oauth-2025-04-20";

/**
 * Headers that describe *this* hop and must never be forwarded (RFC 9110 §7.6.1),
 * plus the ones `fetch` computes for itself.
 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

/**
 * Client credentials, dropped before forwarding.
 *
 * The inbound key authenticates the caller *to this proxy*; sending it upstream
 * would leak a local secret to Anthropic and could overwrite the real upstream
 * OAuth credential.
 */
const CLIENT_CREDENTIALS = new Set(["x-api-key", "authorization", "cookie"]);

/**
 * Names the calling project in the usage log and telemetry.
 *
 * Every project shares one proxy key, so without it a log line says which model
 * was used but not by whom. It describes the caller to this proxy only.
 */
export const PROJECT_HEADER = "x-cpx-project";

/** Short names only: the value lands in a log line and must not forge another. */
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function extractProject(headers: IncomingHttpHeaders): string {
  const value = first(headers[PROJECT_HEADER])?.trim();
  return value && PROJECT_NAME.test(value) ? value : "unknown";
}

/**
 * Read the proxy key the caller presented.
 *
 * Both spellings are accepted because SDKs differ: the Anthropic SDKs send
 * `x-api-key`, while OpenAI-compatible clients pointed at this proxy send
 * `Authorization: Bearer`.
 */
export function extractProxyKey(headers: IncomingHttpHeaders): string | null {
  const apiKey = first(headers["x-api-key"]);
  if (apiKey) return apiKey;

  const authorization = first(headers.authorization);
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match?.[1]) return match[1];
  }

  return null;
}

/**
 * Build the header set for the upstream request.
 *
 * Order matters: client credentials are dropped first, then ours is set, so no
 * inbound header can overwrite the OAuth bearer token.
 */
export function buildUpstreamHeaders(
  inbound: IncomingHttpHeaders,
  accessToken: string,
): Headers {
  const headers = new Headers();

  for (const [name, value] of Object.entries(inbound)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || CLIENT_CREDENTIALS.has(lower)) continue;
    if (lower === PROJECT_HEADER) continue;
    if (value === undefined) continue;

    for (const item of Array.isArray(value) ? value : [value]) {
      headers.append(lower, item);
    }
  }

  headers.set("authorization", `Bearer ${accessToken}`);
  if (!headers.has("anthropic-version")) {
    headers.set("anthropic-version", DEFAULT_ANTHROPIC_VERSION);
  }
  headers.set(
    "anthropic-beta",
    mergeAnthropicBeta(headers.get("anthropic-beta")),
  );

  return headers;
}

/**
 * Headers copied from the upstream response back to the client.
 *
 * Content-encoding and content-length are dropped: `fetch` has already decoded
 * the body, so echoing them would describe bytes the client is not receiving.
 */
const RESPONSE_STRIP = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
]);

export function buildDownstreamHeaders(
  upstream: Headers,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of upstream) {
    if (RESPONSE_STRIP.has(name.toLowerCase())) continue;
    result[name] = value;
  }
  return result;
}

function first(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function mergeAnthropicBeta(existing: string | null): string {
  const values = new Set(
    (existing ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  values.add(OAUTH_BETA_HEADER);
  return [...values].join(",");
}
