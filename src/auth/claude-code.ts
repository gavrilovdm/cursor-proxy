import { execFile } from "node:child_process";
import type { Credentials } from "../ports.js";
import { OAuthError } from "../errors.js";

export const CLAUDE_CODE_KEYCHAIN_SERVICE = "Claude Code-credentials";

export async function loadClaudeCodeCredentialsFromKeychain(
  service = CLAUDE_CODE_KEYCHAIN_SERVICE,
): Promise<Credentials> {
  const raw = await readKeychainPassword(service);
  return parseClaudeCodeCredentials(raw);
}

export function parseClaudeCodeCredentials(raw: string): Credentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OAuthError(
      "Claude Code credentials are not valid JSON.",
      "invalid_claude_code_credentials",
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new OAuthError(
      "Claude Code credentials are not an object.",
      "invalid_claude_code_credentials",
    );
  }

  const root = parsed as Record<string, unknown>;
  const source =
    typeof root.claudeAiOauth === "object" && root.claudeAiOauth !== null
      ? (root.claudeAiOauth as Record<string, unknown>)
      : root;

  const accessToken = pickString(source, "accessToken", "access_token");
  if (!accessToken) {
    throw new OAuthError(
      "Claude Code credentials contain no access token.",
      "invalid_claude_code_credentials",
    );
  }

  return {
    accessToken,
    refreshToken: pickString(source, "refreshToken", "refresh_token"),
    expiresAt: parseExpiresAt(
      source.expiresAt ?? source.expires_at ?? source.expirationDate,
    ),
  };
}

function readKeychainPassword(service: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "security",
      ["find-generic-password", "-s", service, "-w"],
      { maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(
            new OAuthError(
              `Could not read Claude Code credentials from macOS Keychain service "${service}".`,
              "claude_code_credentials_unavailable",
            ),
          );
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

function pickString(
  source: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

function parseExpiresAt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  // Claude Code tokens normally carry an expiry. If a future version stops
  // doing that, use a short lifetime so refresh happens soon rather than after
  // an unknown stale period.
  return Date.now() + 60 * 60 * 1000;
}
