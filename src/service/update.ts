import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Bring this checkout to the latest main and rebuild it.
 *
 * Projects never vendor the proxy; they all talk to this one install, so
 * updating it is the only step that upgrades every project. A merged fix that
 * was never pulled and rebuilt changes nothing, which is easy to forget.
 */
export async function updateCheckout(dir: string, log: (line: string) => void): Promise<void> {
  const status = await run("git", ["status", "--porcelain"], { cwd: dir });
  if (status.stdout.trim()) {
    throw new Error(`${dir} has local changes; commit or stash them before updating.`);
  }
  for (const [command, args] of [
    ["git", ["pull", "--ff-only"]],
    ["npm", ["ci"]],
    ["npm", ["run", "build"]],
  ] as const) {
    log(`$ ${command} ${args.join(" ")}`);
    await run(command, [...args], { cwd: dir, maxBuffer: 16 * 1024 * 1024 });
  }
}
