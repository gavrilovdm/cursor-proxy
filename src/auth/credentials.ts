import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, unlink } from "node:fs/promises";
import type { CredentialStore, Credentials } from "../ports.js";
import { ensureDir, isNotFound, writeFileAtomic } from "../config.js";

/**
 * OAuth tokens on disk.
 *
 * Kept in a file separate from config.json for one reason: config is the file a
 * user is invited to open, edit, and paste into a bug report. Tokens must never
 * ride along with it.
 */

const FILE_NAME = "credentials.json";

/** In-memory store, for tests and for `--no-persist` runs. */
export class MemoryCredentialStore implements CredentialStore {
  private credentials: Credentials | null = null;

  constructor(initial: Credentials | null = null) {
    this.credentials = initial;
  }

  async load(): Promise<Credentials | null> {
    return this.credentials;
  }

  async save(credentials: Credentials): Promise<void> {
    this.credentials = credentials;
  }

  async clear(): Promise<void> {
    this.credentials = null;
  }
}

/** Filesystem-backed tokens. Base directory is injected so tests use a temp dir. */
export class FileCredentialStore implements CredentialStore {
  private readonly path: string;

  constructor(
    private readonly baseDir: string = join(homedir(), ".cursor-proxy"),
  ) {
    this.path = join(baseDir, FILE_NAME);
  }

  async load(): Promise<Credentials | null> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }

    try {
      return parseCredentials(JSON.parse(raw));
    } catch {
      // A corrupt credentials file is not worth failing the process over: the
      // fix is the same as for absent credentials — log in again.
      return null;
    }
  }

  async save(credentials: Credentials): Promise<void> {
    await ensureDir(this.baseDir);
    await writeFileAtomic(
      this.path,
      JSON.stringify(credentials, null, 2) + "\n",
    );
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.path);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}

/**
 * Accept only a fully-formed record.
 *
 * A half-written file that yields `accessToken: undefined` would otherwise be
 * forwarded upstream as the string "undefined" and fail with a confusing 401.
 */
function parseCredentials(parsed: unknown): Credentials | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const source = parsed as Record<string, unknown>;

  if (typeof source.accessToken !== "string" || source.accessToken === "") {
    return null;
  }
  if (typeof source.expiresAt !== "number") return null;

  return {
    accessToken: source.accessToken,
    refreshToken:
      typeof source.refreshToken === "string" ? source.refreshToken : null,
    expiresAt: source.expiresAt,
  };
}
