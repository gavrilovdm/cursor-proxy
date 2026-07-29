/**
 * Raised when required configuration is absent.
 *
 * Carries the config key and env var so the CLI can tell the user exactly what
 * to set, rather than failing with a generic message. This package
 * deliberately ships no OAuth defaults, which makes a precise error the only
 * thing standing between the user and a dead end.
 */
export class ConfigError extends Error {
  constructor(
    message: string,
    readonly configKey: string,
    readonly envVar: string,
  ) {
    super(message);
    this.name = "ConfigError";
  }

  /** Actionable, multi-line guidance for the CLI to print. */
  toGuidance(): string {
    return [
      this.message,
      `  Set it in ~/.cursor-proxy/config.json under "${this.configKey}",`,
      `  or export ${this.envVar}.`,
    ].join("\n");
  }
}

/** Raised when the OAuth provider rejects an exchange or refresh. */
export class OAuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}
