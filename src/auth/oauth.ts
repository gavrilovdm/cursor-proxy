import type { Clock, Credentials, HttpClient, OAuthConfig } from "../ports.js";
import { OAuthError } from "../errors.js";

/**
 * The OAuth 2.0 authorization-code + PKCE exchange.
 *
 * Network access is reached only through the injected {@link HttpClient}, and
 * time only through {@link Clock}, so every branch here — including expiry
 * arithmetic and error mapping — is testable without a server or a wait.
 */

/** Applied when the provider omits `expires_in`. Deliberately short. */
const FALLBACK_LIFETIME_SECONDS = 3600;

export interface AuthorizationRequest {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scope: string | null;
  state: string;
  codeChallenge: string;
  /** Provider-specific extras, e.g. Google's `access_type=offline`. */
  extraParams?: Record<string, string>;
}

export type TokenRequestFormat = OAuthConfig["tokenRequestFormat"];

/**
 * Build the URL the user's browser is sent to.
 *
 * `URL`/`searchParams` does the encoding: hand-assembling this string is how
 * redirect URIs end up subtly mangled and rejected by the provider.
 */
export function buildAuthorizationUrl(request: AuthorizationRequest): string {
  const url = new URL(request.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", request.clientId);
  url.searchParams.set("redirect_uri", request.redirectUri);
  url.searchParams.set("state", request.state);
  url.searchParams.set("code_challenge", request.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (request.scope) url.searchParams.set("scope", request.scope);

  // Set last, but the protocol parameters above are never overwritten: an
  // extra named `state` or `redirect_uri` would silently break the flow.
  for (const [name, value] of Object.entries(request.extraParams ?? {})) {
    if (!url.searchParams.has(name)) url.searchParams.set(name, value);
  }

  return url.toString();
}

/**
 * Endpoints, resolved from explicit config first and discovery second.
 *
 * Explicit config wins so a user pointing at a staging provider is never
 * silently redirected to whatever the issuer's metadata advertises.
 */
export async function resolveEndpoints(
  config: OAuthConfig,
  http: HttpClient,
): Promise<{ authorizationEndpoint: string; tokenEndpoint: string }> {
  if (config.authorizationEndpoint && config.tokenEndpoint) {
    return {
      authorizationEndpoint: config.authorizationEndpoint,
      tokenEndpoint: config.tokenEndpoint,
    };
  }

  if (!config.issuer) {
    throw new OAuthError(
      "No OAuth endpoints configured and no issuer to discover them from.",
      "endpoints_unavailable",
    );
  }

  const metadata = await discover(config.issuer, http);
  const authorizationEndpoint =
    config.authorizationEndpoint ?? metadata.authorization_endpoint;
  const tokenEndpoint = config.tokenEndpoint ?? metadata.token_endpoint;

  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new OAuthError(
      `Issuer ${config.issuer} did not advertise both an authorization and a token endpoint.`,
      "endpoints_unavailable",
    );
  }

  return { authorizationEndpoint, tokenEndpoint };
}

interface DiscoveryDocument {
  authorization_endpoint?: string;
  token_endpoint?: string;
}

/**
 * Where metadata lives, in the order we try.
 *
 * RFC 8414's path comes first, but plain OpenID providers — Google among them —
 * publish only the OIDC path, so trying just the first would fail against the
 * most common issuers.
 */
const DISCOVERY_PATHS = [
  ".well-known/oauth-authorization-server",
  ".well-known/openid-configuration",
] as const;

async function discover(
  issuer: string,
  http: HttpClient,
): Promise<DiscoveryDocument> {
  const base = issuer.endsWith("/") ? issuer : `${issuer}/`;
  const failures: string[] = [];

  for (const path of DISCOVERY_PATHS) {
    const url = new URL(path, base);
    const response = await http.send(
      new Request(url, { headers: { accept: "application/json" } }),
    );

    if (!response.ok) {
      failures.push(`${url.toString()} → HTTP ${response.status}`);
      continue;
    }

    try {
      return (await response.json()) as DiscoveryDocument;
    } catch {
      failures.push(`${url.toString()} → not valid JSON`);
    }
  }

  throw new OAuthError(
    `Discovery failed for ${issuer}: ${failures.join("; ")}.`,
    "discovery_failed",
  );
}

export interface ExchangeRequest {
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string | null;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  state?: string | null;
  tokenRequestFormat?: TokenRequestFormat;
}

/** Trade an authorization code for tokens. */
export async function exchangeCode(
  request: ExchangeRequest,
  http: HttpClient,
  clock: Clock,
): Promise<Credentials> {
  const body = {
    grant_type: "authorization_code",
    client_id: request.clientId,
    code: request.code,
    code_verifier: request.codeVerifier,
    redirect_uri: request.redirectUri,
    ...(request.state ? { state: request.state } : {}),
    ...(request.clientSecret ? { client_secret: request.clientSecret } : {}),
  };
  return postToken(
    request.tokenEndpoint,
    body,
    request.tokenRequestFormat ?? "form",
    http,
    clock,
    null,
  );
}

/**
 * Exchange a refresh token for a fresh access token.
 *
 * `previousRefreshToken` is carried forward when the response omits a new one:
 * providers that do not rotate refresh tokens simply leave the field out, and
 * dropping it would log the user out on the next expiry.
 */
export async function refreshTokens(
  options: {
    tokenEndpoint: string;
    clientId: string;
    clientSecret?: string | null;
    refreshToken: string;
    tokenRequestFormat?: TokenRequestFormat;
  },
  http: HttpClient,
  clock: Clock,
): Promise<Credentials> {
  const body = {
    grant_type: "refresh_token",
    client_id: options.clientId,
    refresh_token: options.refreshToken,
    ...(options.clientSecret ? { client_secret: options.clientSecret } : {}),
  };
  return postToken(
    options.tokenEndpoint,
    body,
    options.tokenRequestFormat ?? "form",
    http,
    clock,
    options.refreshToken,
  );
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function postToken(
  tokenEndpoint: string,
  body: Record<string, string>,
  format: TokenRequestFormat,
  http: HttpClient,
  clock: Clock,
  previousRefreshToken: string | null,
): Promise<Credentials> {
  const requestBody =
    format === "json" ? JSON.stringify(body) : new URLSearchParams(body).toString();
  const contentType =
    format === "json"
      ? "application/json"
      : "application/x-www-form-urlencoded";

  const response = await http.send(
    new Request(tokenEndpoint, {
      method: "POST",
      headers: {
        "content-type": contentType,
        accept: "application/json",
      },
      body: requestBody,
    }),
  );

  const payload = await readTokenResponse(response);

  if (!response.ok || payload.error) {
    // The provider's own error code is preserved: callers distinguish
    // `invalid_grant` (re-login required) from transient failures.
    throw new OAuthError(
      describeTokenError(response.status, payload),
      payload.error ?? `http_${response.status}`,
    );
  }

  if (!payload.access_token) {
    throw new OAuthError(
      "Token response contained no access_token.",
      "invalid_token_response",
    );
  }

  const lifetime =
    typeof payload.expires_in === "number" && payload.expires_in > 0
      ? payload.expires_in
      : FALLBACK_LIFETIME_SECONDS;

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? previousRefreshToken,
    expiresAt: clock.now() + lifetime * 1000,
  };
}

async function readTokenResponse(response: Response): Promise<TokenResponse> {
  try {
    return (await response.json()) as TokenResponse;
  } catch {
    return {};
  }
}

function describeTokenError(status: number, payload: TokenResponse): string {
  const detail = payload.error_description ?? payload.error;
  return detail
    ? `Token request rejected (HTTP ${status}): ${detail}`
    : `Token request rejected (HTTP ${status}).`;
}
