import { existsSync, lstatSync, renameSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where the proxy keeps its state, and how state from the old name carries over.
 *
 * The project was called cursor-proxy: state lived in `~/.cursor-proxy` and the
 * environment used `CURSOR_PROXY_*`. Installs from that time keep working: the
 * directory moves on first start and the old variables are read as a fallback.
 */

const HOME_DIR_NAME = ".llm-proxy";
const LEGACY_HOME_DIR_NAME = ".cursor-proxy";
const ENV_PREFIX = "LLM_PROXY_";
const LEGACY_ENV_PREFIX = "CURSOR_PROXY_";

/** Default state directory: `~/.llm-proxy`. */
export function defaultBaseDir(home: string = homedir()): string {
  return join(home, HOME_DIR_NAME);
}

/**
 * Copy every `CURSOR_PROXY_*` variable to its `LLM_PROXY_*` name unless the new
 * name is already set. Pure: returns a new object.
 */
export function withLegacyEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const result = { ...env };
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(LEGACY_ENV_PREFIX)) continue;
    const modern = ENV_PREFIX + name.slice(LEGACY_ENV_PREFIX.length);
    if (result[modern] === undefined || result[modern] === "") result[modern] = value;
  }
  return result;
}

/**
 * Move `~/.cursor-proxy` to `~/.llm-proxy` when only the old one exists, and
 * leave a symlink behind so anything still pointing at the old path (an old
 * checkout, a hand-written plist) reads the same files.
 *
 * Returns true when it moved something.
 */
export function migrateLegacyHome(home: string = homedir()): boolean {
  const legacy = join(home, LEGACY_HOME_DIR_NAME);
  const current = join(home, HOME_DIR_NAME);
  if (existsSync(current) || !existsSync(legacy)) return false;
  if (lstatSync(legacy).isSymbolicLink()) return false;
  renameSync(legacy, current);
  symlinkSync(current, legacy);
  return true;
}

/**
 * State directory for this process: `LLM_PROXY_HOME` (or the legacy
 * `CURSOR_PROXY_HOME`), else `~/.llm-proxy`, migrating the old directory first.
 */
export function resolveBaseDir(
  env: Record<string, string | undefined>,
  home: string = homedir(),
): string {
  const explicit = withLegacyEnv(env)[`${ENV_PREFIX}HOME`];
  if (explicit) return explicit;
  migrateLegacyHome(home);
  return defaultBaseDir(home);
}
