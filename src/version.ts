import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Root of this checkout: the directory holding package.json. Same answer from
 * `src/` under tsx and from `dist/` after a build, since both sit one level down.
 */
export const INSTALL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Version from package.json, so `/healthz`, `--version` and the release tag
 * cannot drift apart. Clients check it to know which upstream quirks the proxy
 * already absorbs for them.
 */
export const VERSION: string = (
  JSON.parse(readFileSync(join(INSTALL_DIR, "package.json"), "utf8")) as {
    version: string;
  }
).version;
