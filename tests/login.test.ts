import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { login } from "../src/auth/login.js";
import { MemoryCredentialStore } from "../src/auth/credentials.js";
import { fakeClock, jsonResponse, stubHttp } from "./support/stubs.js";
import type { Browser, Logger, Prompt } from "../src/ports.js";

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

describe("login", () => {
  it("supports Claude-style fixed redirects and JSON token exchange", async () => {
    const config = defaultConfig();
    config.oauth.clientId = "client-123";
    config.oauth.authorizationEndpoint = "https://claude.ai/oauth/authorize";
    config.oauth.tokenEndpoint = "https://platform.claude.com/v1/oauth/token";
    config.oauth.redirectUri = "https://platform.claude.com/oauth/code/callback";
    config.oauth.scope = "user:profile user:inference";
    config.oauth.authParams = { code: "true" };
    config.oauth.tokenRequestFormat = "json";

    let authorizationUrl: string | null = null;
    const browser: Browser = {
      open: async (url) => {
        authorizationUrl = url;
      },
    };
    const prompt: Prompt = {
      readLine: async () => {
        const state = new URL(authorizationUrl!).searchParams.get("state");
        return `auth-code#${state}`;
      },
    };
    const credentials = new MemoryCredentialStore();
    const http = stubHttp(async (request) => {
      expect(request.url).toBe("https://platform.claude.com/v1/oauth/token");
      expect(request.headers.get("content-type")).toBe("application/json");
      const body = await request.json();
      expect(body).toMatchObject({
        grant_type: "authorization_code",
        client_id: "client-123",
        code: "auth-code",
        redirect_uri: "https://platform.claude.com/oauth/code/callback",
      });
      expect(body.state).toBe(new URL(authorizationUrl!).searchParams.get("state"));
      expect(body.code_verifier).toEqual(expect.any(String));
      return jsonResponse({
        access_token: "at",
        refresh_token: "rt",
        expires_in: 3600,
      });
    });

    await expect(
      login(config, {
        http,
        clock: fakeClock(1_000),
        browser,
        prompt,
        logger: silentLogger,
        credentials,
      }),
    ).resolves.toEqual({
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: 3_601_000,
    });

    const params = new URL(authorizationUrl!).searchParams;
    expect(params.get("code")).toBe("true");
    expect(params.get("redirect_uri")).toBe(
      "https://platform.claude.com/oauth/code/callback",
    );
    expect(params.get("scope")).toBe("user:profile user:inference");
    expect(await credentials.load()).toMatchObject({ accessToken: "at" });
  });
});
