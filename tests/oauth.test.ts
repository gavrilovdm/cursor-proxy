import { describe, expect, it } from "vitest";
import {
  buildAuthorizationUrl,
  exchangeCode,
  refreshTokens,
  resolveEndpoints,
} from "../src/auth/oauth.js";
import { OAuthError } from "../src/errors.js";
import { fakeClock, jsonResponse, stubHttp } from "./support/stubs.js";

const endpoints = {
  authorizationEndpoint: "https://auth.example/authorize",
  tokenEndpoint: "https://auth.example/token",
};

describe("buildAuthorizationUrl", () => {
  const request = {
    ...endpoints,
    clientId: "client-123",
    redirectUri: "http://127.0.0.1:54321/callback",
    scope: "org:create_api_key user:profile",
    state: "state-abc",
    codeChallenge: "challenge-xyz",
  };

  it("carries every parameter the provider needs", () => {
    const params = new URL(buildAuthorizationUrl(request)).searchParams;
    expect(params.get("response_type")).toBe("code");
    expect(params.get("client_id")).toBe("client-123");
    expect(params.get("state")).toBe("state-abc");
    expect(params.get("code_challenge")).toBe("challenge-xyz");
    expect(params.get("code_challenge_method")).toBe("S256");
  });

  it("percent-encodes the redirect URI and scope", () => {
    const url = buildAuthorizationUrl(request);
    expect(url).toContain("redirect_uri=http%3A%2F%2F127.0.0.1%3A54321%2Fcallback");
    expect(new URL(url).searchParams.get("scope")).toBe(
      "org:create_api_key user:profile",
    );
  });

  it("omits scope entirely when none is configured", () => {
    const url = buildAuthorizationUrl({ ...request, scope: null });
    expect(new URL(url).searchParams.has("scope")).toBe(false);
  });

  it("never sends the verifier, only its challenge", () => {
    expect(buildAuthorizationUrl(request)).not.toContain("code_verifier");
  });

  it("keeps protocol parameters while adding provider-specific extras", () => {
    const url = buildAuthorizationUrl({
      ...request,
      extraParams: {
        code: "true",
        client_id: "attacker",
        redirect_uri: "https://attacker.example/callback",
      },
    });
    const params = new URL(url).searchParams;
    expect(params.get("code")).toBe("true");
    expect(params.get("client_id")).toBe("client-123");
    expect(params.get("redirect_uri")).toBe(request.redirectUri);
  });
});

describe("resolveEndpoints", () => {
  it("uses explicit config without touching the network", async () => {
    const http = stubHttp(() => {
      throw new Error("should not be called");
    });
    await expect(
      resolveEndpoints(
        { ...endpoints, issuer: null, clientId: "c", scope: null },
        http,
      ),
    ).resolves.toEqual(endpoints);
    expect(http.requests).toHaveLength(0);
  });

  it("discovers endpoints from the issuer when they are absent", async () => {
    const http = stubHttp(() =>
      jsonResponse({
        authorization_endpoint: endpoints.authorizationEndpoint,
        token_endpoint: endpoints.tokenEndpoint,
      }),
    );

    const resolved = await resolveEndpoints(
      {
        issuer: "https://auth.example",
        authorizationEndpoint: null,
        tokenEndpoint: null,
        clientId: "c",
        scope: null,
      },
      http,
    );

    expect(resolved).toEqual(endpoints);
    expect(http.requests[0]?.url).toBe(
      "https://auth.example/.well-known/oauth-authorization-server",
    );
  });

  it("explains itself when there is nothing to resolve from", async () => {
    const http = stubHttp(() => jsonResponse({}));
    await expect(
      resolveEndpoints(
        {
          issuer: null,
          authorizationEndpoint: null,
          tokenEndpoint: null,
          clientId: "c",
          scope: null,
        },
        http,
      ),
    ).rejects.toThrow(OAuthError);
  });

  it("fails loudly when discovery is incomplete", async () => {
    const http = stubHttp(() =>
      jsonResponse({ authorization_endpoint: endpoints.authorizationEndpoint }),
    );
    await expect(
      resolveEndpoints(
        {
          issuer: "https://auth.example",
          authorizationEndpoint: null,
          tokenEndpoint: null,
          clientId: "c",
          scope: null,
        },
        http,
      ),
    ).rejects.toThrow(/did not advertise/);
  });
});

describe("exchangeCode", () => {
  const request = {
    tokenEndpoint: endpoints.tokenEndpoint,
    clientId: "client-123",
    code: "auth-code",
    codeVerifier: "verifier-abc",
    redirectUri: "http://127.0.0.1:54321/callback",
  };

  it("posts the PKCE verifier as form-encoded data", async () => {
    const http = stubHttp(() =>
      jsonResponse({
        access_token: "at",
        refresh_token: "rt",
        expires_in: 3600,
      }),
    );

    await exchangeCode(request, http, fakeClock());

    const sent = http.requests[0]!;
    expect(sent.method).toBe("POST");
    expect(sent.headers.get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );

    const body = new URLSearchParams(await sent.text());
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code_verifier")).toBe("verifier-abc");
    expect(body.get("redirect_uri")).toBe(request.redirectUri);
    // PKCE exists so that a public client needs no secret; sending one would
    // mean we were storing a secret we have no safe place for.
    expect(body.has("client_secret")).toBe(false);
  });

  it("can post the authorization code as JSON for Claude-style providers", async () => {
    const http = stubHttp(() =>
      jsonResponse({
        access_token: "at",
        refresh_token: "rt",
        expires_in: 3600,
      }),
    );

    await exchangeCode(
      {
        ...request,
        state: "state-abc",
        tokenRequestFormat: "json",
      },
      http,
      fakeClock(),
    );

    const sent = http.requests[0]!;
    expect(sent.headers.get("content-type")).toBe("application/json");
    expect(await sent.json()).toEqual({
      grant_type: "authorization_code",
      client_id: "client-123",
      code: "auth-code",
      code_verifier: "verifier-abc",
      redirect_uri: request.redirectUri,
      state: "state-abc",
    });
  });

  it("converts expires_in into an absolute deadline on our clock", async () => {
    const clock = fakeClock(1_000_000);
    const http = stubHttp(() =>
      jsonResponse({ access_token: "at", expires_in: 900 }),
    );

    const credentials = await exchangeCode(request, http, clock);
    expect(credentials.expiresAt).toBe(1_000_000 + 900_000);
  });

  it("falls back to a short lifetime when expires_in is missing", async () => {
    const clock = fakeClock(0);
    const http = stubHttp(() => jsonResponse({ access_token: "at" }));

    const credentials = await exchangeCode(request, http, clock);
    expect(credentials.expiresAt).toBe(3600 * 1000);
  });

  it("preserves the provider's error code for the caller to branch on", async () => {
    const http = stubHttp(() =>
      jsonResponse(
        { error: "invalid_grant", error_description: "code already used" },
        400,
      ),
    );

    await expect(exchangeCode(request, http, fakeClock())).rejects.toMatchObject({
      code: "invalid_grant",
      message: expect.stringContaining("code already used"),
    });
  });

  it("rejects a 200 that carries no access token", async () => {
    const http = stubHttp(() => jsonResponse({ token_type: "bearer" }));
    await expect(exchangeCode(request, http, fakeClock())).rejects.toThrow(
      /no access_token/,
    );
  });

  it("does not choke on a non-JSON error page", async () => {
    const http = stubHttp(() => new Response("<html>502</html>", { status: 502 }));
    await expect(exchangeCode(request, http, fakeClock())).rejects.toMatchObject({
      code: "http_502",
    });
  });
});

describe("refreshTokens", () => {
  const options = {
    tokenEndpoint: endpoints.tokenEndpoint,
    clientId: "client-123",
    refreshToken: "rt-old",
  };

  it("sends the refresh grant", async () => {
    const http = stubHttp(() =>
      jsonResponse({ access_token: "at-new", expires_in: 60 }),
    );
    await refreshTokens(options, http, fakeClock());

    const body = new URLSearchParams(await http.requests[0]!.text());
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt-old");
  });

  it("can refresh with a JSON body", async () => {
    const http = stubHttp(() =>
      jsonResponse({ access_token: "at-new", expires_in: 60 }),
    );
    await refreshTokens(
      { ...options, tokenRequestFormat: "json" },
      http,
      fakeClock(),
    );

    expect(http.requests[0]!.headers.get("content-type")).toBe(
      "application/json",
    );
    expect(await http.requests[0]!.json()).toEqual({
      grant_type: "refresh_token",
      client_id: "client-123",
      refresh_token: "rt-old",
    });
  });

  it("keeps the old refresh token when the provider does not rotate it", async () => {
    const http = stubHttp(() =>
      jsonResponse({ access_token: "at-new", expires_in: 60 }),
    );
    const credentials = await refreshTokens(options, http, fakeClock());
    expect(credentials.refreshToken).toBe("rt-old");
  });

  it("adopts the rotated refresh token when one is returned", async () => {
    const http = stubHttp(() =>
      jsonResponse({ access_token: "at-new", refresh_token: "rt-new" }),
    );
    const credentials = await refreshTokens(options, http, fakeClock());
    expect(credentials.refreshToken).toBe("rt-new");
  });
});
