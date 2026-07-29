import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import type { Config, ConfigStore } from "./ports.js";
import { ConfigError } from "./errors.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export const DEFAULT_PORT = 8787;
export const DEFAULT_UPSTREAM = "https://api.anthropic.com";

export function defaultConfig(): Config {
  return {
    oauth: {
      issuer: null,
      authorizationEndpoint: null,
      tokenEndpoint: null,
      clientId: null,
      scope: null,
    },
    proxyKeyHash: null,
    port: DEFAULT_PORT,
    upstream: DEFAULT_UPSTREAM,
  };
}

/** Maps each overridable setting to its environment variable. */
export const ENV_VARS = {
  clientId: "CURSOR_PROXY_CLIENT_ID",
  issuer: "CURSOR_PROXY_ISSUER",
  authorizationEndpoint: "CURSOR_PROXY_AUTH_ENDPOINT",
  tokenEndpoint: "CURSOR_PROXY_TOKEN_ENDPOINT",
  scope: "CURSOR_PROXY_SCOPE",
  port: "CURSOR_PROXY_PORT",
  upstream: "CURSOR_PROXY_UPSTREAM",
} as const;

/**
 * Layer environment variables over a loaded config. Environment wins.
 *
 * Pure by design: precedence rules are the kind of thing that quietly breaks,
 * and testing them should not require a filesystem.
 */
export function applyEnvOverrides(
  config: Config,
  env: Record<string, string | undefined>,
): Config {
  const pick = (name: string, current: string | null): string | null => {
    const value = env[name];
    return value !== undefined && value !== "" ? value : current;
  };

  const port = parsePort(env[ENV_VARS.port], config.port);

  return {
    oauth: {
      issuer: pick(ENV_VARS.issuer, config.oauth.issuer),
      authorizationEndpoint: pick(
        ENV_VARS.authorizationEndpoint,
        config.oauth.authorizationEndpoint,
      ),
      tokenEndpoint: pick(ENV_VARS.tokenEndpoint, config.oauth.tokenEndpoint),
      clientId: pick(ENV_VARS.clientId, config.oauth.clientId),
      scope: pick(ENV_VARS.scope, config.oauth.scope),
    },
    proxyKeyHash: config.proxyKeyHash,
    port,
    upstream: pick(ENV_VARS.upstream, config.upstream) ?? DEFAULT_UPSTREAM,
  };
}

function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new ConfigError(
      `Invalid port "${raw}" — expected an integer between 1 and 65535.`,
      "port",
      ENV_VARS.port,
    );
  }
  return parsed;
}

/**
 * Reads the OAuth client id, or explains precisely what is missing.
 *
 * This package ships no client id. Guessing one — or silently falling back to
 * a known public identifier — would send the user's credentials somewhere they
 * did not choose, so absence is a hard error.
 */
export function requireClientId(config: Config): string {
  if (!config.oauth.clientId) {
    throw new ConfigError(
      "No OAuth client id configured.",
      "oauth.clientId",
      ENV_VARS.clientId,
    );
  }
  return config.oauth.clientId;
}

/** Filesystem-backed config. Base directory is injected so tests can use a temp dir. */
export class FileConfigStore implements ConfigStore {
  private readonly path: string;

  constructor(
    private readonly baseDir: string = join(homedir(), ".cursor-proxy"),
    private readonly env: Record<string, string | undefined> = process.env,
  ) {
    this.path = join(baseDir, "config.json");
  }

  async load(): Promise<Config> {
    const onDisk = await this.readFileOrDefault();
    return applyEnvOverrides(onDisk, this.env);
  }

  async save(config: Config): Promise<void> {
    await ensureDir(this.baseDir);
    await writeFileAtomic(this.path, JSON.stringify(config, null, 2) + "\n");
  }

  private async readFileOrDefault(): Promise<Config> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if (isNotFound(error)) return defaultConfig();
      throw error;
    }
    // A corrupt config should not be silently replaced with defaults — that
    // would discard the user's proxy key hash without telling them.
    const parsed: unknown = JSON.parse(raw);
    return mergeWithDefaults(parsed);
  }
}

/**
 * Merge parsed JSON over defaults, so a config file written by an older
 * version (missing newer keys) still loads.
 */
function mergeWithDefaults(parsed: unknown): Config {
  const base = defaultConfig();
  if (typeof parsed !== "object" || parsed === null) return base;

  const source = parsed as Partial<Config>;
  const oauth = source.oauth ?? {};

  return {
    oauth: { ...base.oauth, ...oauth },
    proxyKeyHash: source.proxyKeyHash ?? base.proxyKeyHash,
    port: typeof source.port === "number" ? source.port : base.port,
    upstream: source.upstream ?? base.upstream,
  };
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  // mkdir's mode is masked by umask; set it explicitly so permissions are
  // deterministic regardless of the user's shell configuration.
  await chmod(dir, DIR_MODE);
}

/**
 * Write via temp file + rename, with the restrictive mode applied at open()
 * time.
 *
 * The mode is passed to writeFile rather than chmod'ed afterward: a
 * create-then-chmod sequence leaves a window in which a secret sits on disk
 * world-readable. rename() preserves the temp file's mode, so the destination
 * is never briefly permissive either.
 */
export async function writeFileAtomic(
  path: string,
  contents: string,
): Promise<void> {
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, contents, { mode: FILE_MODE, encoding: "utf8" });
  await rename(tmp, path);
}

export function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
