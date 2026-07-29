import type { IncomingHttpHeaders } from "node:http";

/**
 * Header rewriting between the local client and Anthropic.
 *
 * Pure functions over plain header bags: this is where a credential leaks if it
 * leaks at all, so it is kept free of sockets and exhaustively testable.
 */

/** Beta required for OAuth-authenticated access. */
export const OAUTH_BETA = "oauth-2025-04-20";

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
 * would leak a local secret to Anthropic and, worse, `x-api-key` would take
 * precedence over our OAuth bearer and fail the request.
 */
const CLIENT_CREDENTIALS = new Set(["x-api-key", "authorization", "cookie"]);

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
 * inbound header can overwrite the bearer token.
 */
export function buildUpstreamHeaders(
  inbound: IncomingHttpHeaders,
  accessToken: string,
): Headers {
  const headers = new Headers();

  for (const [name, value] of Object.entries(inbound)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || CLIENT_CREDENTIALS.has(lower)) continue;
    if (value === undefined) continue;

    for (const item of Array.isArray(value) ? value : [value]) {
      headers.append(lower, item);
    }
  }

  headers.set("authorization", `Bearer ${accessToken}`);
  headers.set("anthropic-beta", mergeBeta(first(inbound["anthropic-beta"])));

  return headers;
}

/**
 * Add the OAuth beta to whatever betas the client asked for.
 *
 * Replacing the client's list instead of merging would silently disable
 * features the caller depends on.
 */
export function mergeBeta(inbound: string | undefined): string {
  const values = (inbound ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");

  if (!values.includes(OAUTH_BETA)) values.unshift(OAUTH_BETA);
  return values.join(",");
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
