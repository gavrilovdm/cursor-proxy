import type {
  Clock,
  CredentialStore,
  Credentials,
  HttpClient,
  OAuthConfig,
  TokenProvider,
} from "../ports.js";
import { OAuthError } from "../errors.js";
import { refreshTokens } from "./oauth.js";

/**
 * Hands the forwarding path a valid access token, refreshing when needed.
 *
 * Refreshes are single-flighted: a proxy under load can have dozens of requests
 * discover an expired token in the same millisecond, and firing dozens of
 * refreshes would burn the refresh token on providers that rotate it, logging
 * the user out mid-session.
 */

/** Refresh this far ahead of expiry, so a token cannot die in flight. */
export const EXPIRY_SKEW_MS = 60_000;

export interface RefreshingTokenProviderOptions {
  store: CredentialStore;
  http: HttpClient;
  clock: Clock;
  clientId: string;
  clientSecret?: string | null;
  tokenEndpoint: string;
  tokenRequestFormat: OAuthConfig["tokenRequestFormat"];
  /**
   * Another holder of the same session (Claude Code's Keychain entry). Checked
   * before every refresh and after a rejected one: the two share one rotating
   * refresh token, so whoever refreshes second is logged out. Adopting the
   * other side's fresher token avoids burning the shared one twice.
   */
  external?: () => Promise<Credentials | null>;
}

export class RefreshingTokenProvider implements TokenProvider {
  private cached: Credentials | null = null;
  private inFlight: Promise<Credentials> | null = null;

  constructor(private readonly options: RefreshingTokenProviderOptions) {}

  async getAccessToken(): Promise<string> {
    const current = await this.current();

    if (!isExpiring(current, this.options.clock)) {
      return current.accessToken;
    }

    const adopted = await this.adoptExternal(current);
    if (adopted) return adopted.accessToken;

    const refreshed = await this.refresh(current);
    return refreshed.accessToken;
  }

  /** Take the external session if it outlives ours; null when it doesn't. */
  private async adoptExternal(current: Credentials | null): Promise<Credentials | null> {
    if (!this.options.external) return null;
    let external: Credentials | null;
    try {
      external = await this.options.external();
    } catch {
      return null; // Keychain locked or Claude Code absent: fall back to our own refresh.
    }
    if (!external || isExpiring(external, this.options.clock)) return null;
    if (current && external.expiresAt <= current.expiresAt) return null;
    this.cached = external;
    await this.options.store.save(external);
    return external;
  }

  /** Load from the store on first use, then serve from memory. */
  private async current(): Promise<Credentials> {
    if (this.cached) return this.cached;

    const loaded = await this.options.store.load();
    if (!loaded) {
      throw new OAuthError(
        "Not logged in. Run `cursor-proxy import-claude-code` or `cursor-proxy login` first.",
        "login_required",
      );
    }
    this.cached = loaded;
    return loaded;
  }

  private async refresh(current: Credentials): Promise<Credentials> {
    if (this.inFlight) return this.inFlight;

    if (!current.refreshToken) {
      throw new OAuthError(
        "Access token expired and no refresh token is available. Run `cursor-proxy import-claude-code` or `cursor-proxy login` again.",
        "login_required",
      );
    }

    const attempt = this.performRefresh(current.refreshToken);
    this.inFlight = attempt;
    try {
      return await attempt;
    } finally {
      this.inFlight = null;
    }
  }

  private async performRefresh(refreshToken: string): Promise<Credentials> {
    let next: Credentials;
    try {
      next = await refreshTokens(
        {
          tokenEndpoint: this.options.tokenEndpoint,
          clientId: this.options.clientId,
          clientSecret: this.options.clientSecret ?? null,
          refreshToken,
          tokenRequestFormat: this.options.tokenRequestFormat,
        },
        this.options.http,
        this.options.clock,
      );
    } catch (error) {
      // A rejected grant means the stored credentials are dead, not merely
      // stale — drop them so the next call says "log in" instead of retrying a
      // token the provider has already revoked.
      if (error instanceof OAuthError && error.code === "invalid_grant") {
        // Claude Code most likely rotated the shared refresh token first.
        const adopted = await this.adoptExternal(null);
        if (adopted) return adopted;
        this.cached = null;
        await this.options.store.clear();
        throw new OAuthError(
          "Session expired. Run `cursor-proxy import-claude-code` or `cursor-proxy login` again.",
          "login_required",
        );
      }
      throw error;
    }

    this.cached = next;
    await this.options.store.save(next);
    return next;
  }
}

function isExpiring(credentials: Credentials, clock: Clock): boolean {
  return credentials.expiresAt - EXPIRY_SKEW_MS <= clock.now();
}

/** The system clock. The only implementation that reads real time. */
export const systemClock: Clock = { now: () => Date.now() };
