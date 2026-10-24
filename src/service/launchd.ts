import { execFile } from "node:child_process";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

/**
 * The proxy as a macOS launch agent: started at login, restarted when it dies.
 *
 * This used to live in each project that needed the proxy (vacancy-parser had
 * its own plist and a refresh job), so two projects meant two competing agents
 * for one port. One agent, owned by the proxy, serves every project.
 */

export const LABEL = "com.cursor-proxy";

const run = promisify(execFile);

export interface ServicePaths {
  /** Absolute path of the node binary that runs the proxy. */
  node: string;
  /** Absolute path of dist/cli.js. */
  cli: string;
  /** Where stdout and stderr go. */
  log: string;
}

export function plistPath(home = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
}

export function renderPlist(paths: ServicePaths): string {
  const args = [paths.node, paths.cli, "start"].map((arg) => `    <string>${xml(arg)}</string>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.join("\n")}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <!-- A proxy failing at startup (no session yet) would otherwise respawn in a tight loop. -->
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${xml(paths.log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(paths.log)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <!-- launchd starts with a bare PATH; the Keychain sync needs /usr/bin/security. -->
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function domain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

async function launchctl(...args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run("launchctl", args);
    return { ok: true, stdout, stderr };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string };
    return { ok: false, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

export async function isInstalled(): Promise<boolean> {
  return (await launchctl("print", `${domain()}/${LABEL}`)).ok;
}

/**
 * `bootout` returns before the process exits, and an immediate `bootstrap`
 * then fails with "5: Input/output error" — seen when reinstalling.
 */
async function unload(): Promise<void> {
  await launchctl("bootout", `${domain()}/${LABEL}`);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && (await isInstalled())) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

export async function install(paths: ServicePaths): Promise<void> {
  requireMac();
  const path = plistPath();
  await mkdir(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  await mkdir(join(paths.log, ".."), { recursive: true });
  await unload();
  await writeFile(path, renderPlist(paths));
  const result = await launchctl("bootstrap", domain(), path);
  if (!result.ok) throw new Error(`launchctl bootstrap failed: ${result.stderr.trim()}`);
}

export async function uninstall(): Promise<void> {
  requireMac();
  await unload();
  await unlink(plistPath()).catch(() => undefined);
}

/** Restart the running agent so it picks up a new build. */
export async function restart(): Promise<boolean> {
  return (await launchctl("kickstart", "-k", `${domain()}/${LABEL}`)).ok;
}

function requireMac(): void {
  if (process.platform !== "darwin") {
    throw new Error("The service commands use launchd and only work on macOS.");
  }
}
