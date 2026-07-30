import { describe, expect, it } from "vitest";
import { parseClaudeCodeCredentials } from "../src/auth/claude-code.js";

describe("parseClaudeCodeCredentials", () => {
  it("extracts Claude Code OAuth credentials from the Keychain JSON shape", () => {
    const credentials = parseClaudeCodeCredentials(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "at",
          refreshToken: "rt",
          expiresAt: 1_700_000_000_000,
          scopes: ["user:profile"],
        },
        organizationUuid: "org",
      }),
    );

    expect(credentials).toEqual({
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: 1_700_000_000_000,
    });
  });

  it("accepts snake_case fields and second-based expiries", () => {
    const credentials = parseClaudeCodeCredentials(
      JSON.stringify({
        access_token: "at",
        refresh_token: "rt",
        expires_at: 1_700_000_000,
      }),
    );

    expect(credentials.expiresAt).toBe(1_700_000_000_000);
  });

  it("rejects records without an access token", () => {
    expect(() =>
      parseClaudeCodeCredentials(JSON.stringify({ claudeAiOauth: {} })),
    ).toThrow(/access token/);
  });
});
