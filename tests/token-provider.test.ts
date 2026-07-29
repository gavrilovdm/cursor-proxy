import { describe, expect, it } from "vitest";
import { MemoryCredentialStore } from "../src/auth/credentials.js";
import {
  EXPIRY_SKEW_MS,
  RefreshingTokenProvider,
} from "../src/auth/token-provider.js";
import type { Credentials } from "../src/ports.js";
import { fakeClock, jsonResponse, stubHttp } from "./support/stubs.js";

const NOW = 1_700_000_000_000;

function credentials(overrides: Partial<Credentials> = {}): Credentials {
  return {
    accessToken: "at-current",
    refreshToken: "rt-current",
    expiresAt: NOW + 3_600_000,
    ...overrides,
  };
}

function provider(
  stored: Credentials | null,
  handler: (request: Request) => Response | Promise<Response>,
) {
  const clock = fakeClock(NOW);
  const store = new MemoryCredentialStore(stored);
  const http = stubHttp(handler);
  const tokens = new RefreshingTokenProvider({
    store,
    http,
    clock,
    clientId: "client-123",
    tokenEndpoint: "https://auth.example/token",
  });
  return { tokens, clock, store, http };
}

const refreshed = () =>
  jsonResponse({ access_token: "at-fresh", expires_in: 3600 });

describe("RefreshingTokenProvider", () => {
  it("serves a valid stored token without contacting the provider", async () => {
    const { tokens, http } = provider(credentials(), refreshed);
    await expect(tokens.getAccessToken()).resolves.toBe("at-current");
    expect(http.requests).toHaveLength(0);
  });

  it("reads the store once and then serves from memory", async () => {
    const { tokens, store } = provider(credentials(), refreshed);
    let loads = 0;
    const original = store.load.bind(store);
    store.load = async () => {
      loads += 1;
      return original();
    };

    await tokens.getAccessToken();
    await tokens.getAccessToken();
    expect(loads).toBeLessThanOrEqual(1);
  });

  it("refreshes before expiry, not after — a token must not die in flight", async () => {
    const { tokens, clock, http } = provider(credentials(), refreshed);

    // One millisecond inside the skew window is enough to trigger a refresh.
    clock.set(NOW + 3_600_000 - EXPIRY_SKEW_MS);
    await expect(tokens.getAccessToken()).resolves.toBe("at-fresh");
    expect(http.requests).toHaveLength(1);
  });

  it("does not refresh while the token is comfortably valid", async () => {
    const { tokens, clock, http } = provider(credentials(), refreshed);
    clock.set(NOW + 3_600_000 - EXPIRY_SKEW_MS - 1);
    await expect(tokens.getAccessToken()).resolves.toBe("at-current");
    expect(http.requests).toHaveLength(0);
  });

  it("persists the refreshed credentials", async () => {
    const { tokens, clock, store } = provider(credentials(), refreshed);
    clock.set(NOW + 3_600_000);
    await tokens.getAccessToken();

    const saved = await store.load();
    expect(saved?.accessToken).toBe("at-fresh");
    // The provider returned no new refresh token, so the old one must survive.
    expect(saved?.refreshToken).toBe("rt-current");
  });

  it("single-flights concurrent refreshes", async () => {
    let resolveRefresh: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    });

    const { tokens, clock, http } = provider(credentials(), async () => {
      await gate;
      return jsonResponse({ access_token: "at-fresh", expires_in: 3600 });
    });
    clock.set(NOW + 3_600_000);

    const all = Promise.all([
      tokens.getAccessToken(),
      tokens.getAccessToken(),
      tokens.getAccessToken(),
    ]);
    resolveRefresh!();

    // A refresh per caller would burn a rotating refresh token twice over.
    expect(await all).toEqual(["at-fresh", "at-fresh", "at-fresh"]);
    expect(http.requests).toHaveLength(1);
  });

  it("asks for a login when nothing is stored", async () => {
    const { tokens } = provider(null, refreshed);
    await expect(tokens.getAccessToken()).rejects.toMatchObject({
      code: "login_required",
    });
  });

  it("asks for a login when the token is expired and unrefreshable", async () => {
    const { tokens, clock } = provider(
      credentials({ refreshToken: null }),
      refreshed,
    );
    clock.set(NOW + 3_600_000);
    await expect(tokens.getAccessToken()).rejects.toMatchObject({
      code: "login_required",
    });
  });

  it("discards revoked credentials instead of retrying them", async () => {
    const { tokens, clock, store } = provider(credentials(), () =>
      jsonResponse({ error: "invalid_grant" }, 400),
    );
    clock.set(NOW + 3_600_000);

    await expect(tokens.getAccessToken()).rejects.toMatchObject({
      code: "login_required",
    });
    expect(await store.load()).toBeNull();
  });

  it("keeps credentials when the failure is transient", async () => {
    const { tokens, clock, store } = provider(credentials(), () =>
      jsonResponse({ error: "temporarily_unavailable" }, 503),
    );
    clock.set(NOW + 3_600_000);

    await expect(tokens.getAccessToken()).rejects.toMatchObject({
      code: "temporarily_unavailable",
    });
    // A provider outage must not log the user out.
    expect(await store.load()).not.toBeNull();
  });

  it("recovers on a later call after a transient failure", async () => {
    let attempts = 0;
    const { tokens, clock } = provider(credentials(), () => {
      attempts += 1;
      return attempts === 1
        ? jsonResponse({ error: "server_error" }, 500)
        : jsonResponse({ access_token: "at-fresh", expires_in: 3600 });
    });
    clock.set(NOW + 3_600_000);

    await expect(tokens.getAccessToken()).rejects.toBeTruthy();
    await expect(tokens.getAccessToken()).resolves.toBe("at-fresh");
  });
});
