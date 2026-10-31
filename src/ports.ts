/**
 * Ports: the interfaces the core depends on.
 *
 * Every concrete adapter (filesystem, network, browser, system clock) is
 * reached through one of these. Nothing in the core imports `node:fs`,
 * `node:http`, or `fetch` directly, so the whole of it can be exercised with
 * in-memory substitutes and no I/O.
 */

/** Wall-clock time. Injected so token-expiry logic is testable without waiting. */
export interface Clock {
  now(): number;
}

export interface OAuthConfig {
  /** Issuer base URL. When set, endpoints may be resolved via discovery. */
  issuer: string | null;
  authorizationEndpoint: string | null;
  tokenEndpoint: string | null;
  /**
   * Redirect URI sent to the authorization server.
   *
   * When null, login uses a temporary localhost loopback receiver. Providers
   * such as Claude Code use a fixed web callback that displays a code to paste
   * back into the CLI instead.
   */
  redirectUri: string | null;
  /** No default ships with this package. Supplied by the user at runtime. */
  clientId: string | null;
  /**
   * Sent to the token endpoint when present.
   *
   * PKCE makes this unnecessary in principle, but some OAuth providers still
   * require a client secret during the token exchange.
   */
  clientSecret: string | null;
  scope: string | null;
  /**
   * Extra authorization-URL parameters, provider-specific.
   *
   * Some providers need an explicit offline-access parameter or they return no
   * refresh token, which turns every token expiry into a manual re-login.
   */
  authParams: Record<string, string>;
  /** Token endpoint payload shape. Standard OAuth uses form; Claude uses JSON. */
  tokenRequestFormat: "form" | "json";
}

export interface Config {
  oauth: OAuthConfig;
  /** sha256 of the proxy key, hex. The key itself is never persisted. */
  proxyKeyHash: string | null;
  port: number;
  upstream: string;
}

export interface Credentials {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch millis. */
  expiresAt: number;
}

export interface ConfigStore {
  load(): Promise<Config>;
  save(config: Config): Promise<void>;
}

export interface CredentialStore {
  load(): Promise<Credentials | null>;
  save(credentials: Credentials): Promise<void>;
  clear(): Promise<void>;
}

/**
 * Supplies a currently-valid access token, refreshing as needed.
 *
 * Deliberately a single method: the forwarding path must not be able to reach
 * login, logout, or the raw credential store.
 */
export interface TokenProvider {
  getAccessToken(): Promise<string>;
}

/** Narrow seam over `fetch`, so transport can be stubbed in tests. */
export interface HttpClient {
  send(request: Request): Promise<Response>;
}

export interface Browser {
  open(url: string): Promise<void>;
}

export interface Prompt {
  readLine(message: string): Promise<string>;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** One OpenAI-format chat call, as the dashboard sees it. */
export interface UsageRecord {
  /** Epoch millis when the call finished. */
  at: number;
  project: string;
  model: string;
  stream: boolean;
  ok: boolean;
  /** Upstream status or error name when `ok` is false. */
  error?: string;
  durationMs: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Where chat calls are kept for the dashboard. Never holds prompts or keys. */
export interface UsageStore {
  append(record: UsageRecord): Promise<void>;
  /** Records with `at >= since`, oldest first. */
  since(since: number): Promise<UsageRecord[]>;
}
