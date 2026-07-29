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
  /** No default ships with this package. Supplied by the user at runtime. */
  clientId: string | null;
  scope: string | null;
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

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}
