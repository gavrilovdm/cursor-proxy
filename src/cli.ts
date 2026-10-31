#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { ConfigError, OAuthError } from "./errors.js";
import {
  applyClaudeCodePreset,
  FileConfigStore,
  requireClientId,
} from "./config.js";
import { generateProxyKey, hashProxyKey } from "./keys.js";
import { loadClaudeCodeCredentialsFromKeychain } from "./auth/claude-code.js";
import { FileCredentialStore } from "./auth/credentials.js";
import { login, logout } from "./auth/login.js";
import { resolveEndpoints } from "./auth/oauth.js";
import {
  RefreshingTokenProvider,
  systemClock,
} from "./auth/token-provider.js";
import { startProxyServer } from "./proxy/server.js";
import { startTelemetry } from "./telemetry-sdk.js";
import {
  consoleLogger,
  fetchHttpClient,
  systemBrowser,
  systemPrompt,
} from "./adapters.js";
import type { Config, Credentials } from "./ports.js";
import { INSTALL_DIR, VERSION } from "./version.js";
import * as service from "./service/launchd.js";
import { updateCheckout } from "./service/update.js";

/**
 * Command line entry point.
 *
 * Every command follows the same shape: load config, do one thing, exit with a
 * message a user can act on. All diagnostics go to stderr; stdout carries only
 * values meant to be piped (the proxy key, `status --json`).
 */

const BASE_DIR = process.env.CURSOR_PROXY_HOME ?? join(homedir(), ".cursor-proxy");

const configStore = new FileConfigStore(BASE_DIR);
const credentialStore = new FileCredentialStore(BASE_DIR);

const program = new Command();

program
  .name("cursor-proxy")
  .description(
    "Local Anthropic proxy backed by an OAuth session.",
  )
  .version(VERSION);

program
  .command("login")
  .description("Sign in to the configured OAuth provider in a browser.")
  .option("--port <number>", "fixed loopback port for the redirect URI", toPort)
  .option("--timeout <seconds>", "how long to wait for the browser", toPositive)
  .action(async (options: { port?: number; timeout?: number }) => {
    const config = await configStore.load();
    const credentials = await login(
      config,
      {
        http: fetchHttpClient,
        clock: systemClock,
        browser: systemBrowser,
        prompt: systemPrompt,
        logger: consoleLogger,
        credentials: credentialStore,
      },
      {
        ...(options.port !== undefined ? { port: options.port } : {}),
        ...(options.timeout !== undefined
          ? { timeoutMs: options.timeout * 1000 }
          : {}),
      },
    );
    consoleLogger.info(
      `Signed in. Session expires ${new Date(credentials.expiresAt).toLocaleString()}.`,
    );
    if (!credentials.refreshToken) {
      consoleLogger.warn(
        "The provider returned no refresh token. The proxy will require another browser login when this access token expires.",
      );
    }
  });

program
  .command("logout")
  .description("Delete the stored OAuth session from this machine.")
  .action(async () => {
    await logout(credentialStore);
    consoleLogger.info("Stored credentials deleted.");
  });

program
  .command("configure")
  .description("Write a provider preset to the local config.")
  .argument("<provider>", "currently supported: claude-code")
  .option("--manual", "use Claude's copy/paste code flow instead of localhost callback")
  .action(async (provider: string, options: { manual?: boolean }) => {
    if (provider !== "claude-code") {
      throw new ConfigError(
        `Unknown provider preset "${provider}". Use "claude-code".`,
        "oauth",
        "—",
      );
    }

    const config = await configStore.load();
    await configStore.save(
      applyClaudeCodePreset(config, { manual: options.manual ?? false }),
    );
    consoleLogger.info(
      `Claude Code OAuth preset written to ${BASE_DIR}/config.json.`,
    );
    if (options.manual) {
      consoleLogger.info(
        "Run `cursor-proxy login` again; the authorize URL should include code=true and the platform callback redirect.",
      );
    } else {
      consoleLogger.info(
        "Run `cursor-proxy login` again; the authorize URL should use a localhost callback and no code=true parameter.",
      );
    }
  });

program
  .command("import-claude-code")
  .description("Import the signed-in Claude Code OAuth session from macOS Keychain.")
  .option(
    "--service <name>",
    "Keychain service name",
    "Claude Code-credentials",
  )
  .action(async (options: { service: string }) => {
    const credentials = await loadClaudeCodeCredentialsFromKeychain(
      options.service,
    );
    const config = await configStore.load();
    await configStore.save(applyClaudeCodePreset(config));
    await credentialStore.save(credentials);
    consoleLogger.info(
      `Imported Claude Code OAuth credentials into ${BASE_DIR}/credentials.json.`,
    );
    consoleLogger.info(
      `Session expires ${new Date(credentials.expiresAt).toLocaleString()}.`,
    );
  });

program
  .command("key")
  .description("Mint a new proxy key. Printed once; only its hash is stored.")
  .action(async () => {
    const config = await configStore.load();
    const key = generateProxyKey();
    await configStore.save({ ...config, proxyKeyHash: hashProxyKey(key) });

    if (config.proxyKeyHash) {
      consoleLogger.warn("Previous proxy key revoked.");
    }
    consoleLogger.info("Give this to your client as its API key (shown once):");
    process.stdout.write(`${key}\n`);
  });

program
  .command("start")
  .description("Run the proxy.")
  .option("--port <number>", "port to listen on", toPort)
  .option(
    "--host <address>",
    "bind address; anything but 127.0.0.1 exposes your session",
  )
  .action(async (options: { port?: number; host?: string }) => {
    const config = await configStore.load();
    await runProxy(config, options);
  });

program
  .command("install-service")
  .description("Run the proxy as a macOS launch agent: starts at login, restarts if it dies.")
  .action(async () => {
    const log = join(BASE_DIR, "logs", "proxy.log");
    await service.install({
      node: process.execPath,
      cli: join(INSTALL_DIR, "dist", "cli.js"),
      log,
    });
    consoleLogger.info(`Installed ${service.LABEL}. Log: ${log}`);
  });

program
  .command("uninstall-service")
  .description("Stop the launch agent and remove it.")
  .action(async () => {
    await service.uninstall();
    consoleLogger.info(`Removed ${service.LABEL}.`);
  });

program
  .command("update")
  .description("Pull the latest main, rebuild, and restart the launch agent if installed.")
  .action(async () => {
    const before = VERSION;
    await updateCheckout(INSTALL_DIR, (line) => consoleLogger.info(line));
    const version = (
      JSON.parse(readFileSync(join(INSTALL_DIR, "package.json"), "utf8")) as { version: string }
    ).version;
    if (process.platform === "darwin" && (await service.isInstalled())) {
      await service.restart();
      consoleLogger.info("Launch agent restarted.");
    } else {
      consoleLogger.info("Restart the proxy to load the new build.");
    }
    consoleLogger.info(`cursor-proxy ${before} -> ${version}`);
  });

program
  .command("status")
  .description("Report what is configured and whether a session is stored.")
  .option("--json", "machine-readable output on stdout")
  .action(async (options: { json?: boolean }) => {
    const config = await configStore.load();
    const credentials = await credentialStore.load();

    const report = {
      version: VERSION,
      configDir: BASE_DIR,
      clientIdConfigured: config.oauth.clientId !== null,
      clientSecretConfigured: config.oauth.clientSecret !== null,
      authorizationEndpoint: config.oauth.authorizationEndpoint,
      tokenEndpoint: config.oauth.tokenEndpoint,
      redirectUri: config.oauth.redirectUri,
      scope: config.oauth.scope,
      tokenRequestFormat: config.oauth.tokenRequestFormat,
      authParams: config.oauth.authParams,
      proxyKeyConfigured: config.proxyKeyHash !== null,
      loggedIn: credentials !== null,
      accessTokenExpiresAt: credentials
        ? new Date(credentials.expiresAt).toISOString()
        : null,
      port: config.port,
      upstream: config.upstream,
    };

    if (options.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      return;
    }

    for (const [key, value] of Object.entries(report)) {
      consoleLogger.info(`${key.padEnd(22)} ${String(value)}`);
    }
  });

async function runProxy(
  config: Config,
  options: { port?: number; host?: string },
): Promise<void> {
  if (!config.proxyKeyHash) {
    throw new ConfigError(
      "No proxy key configured. Run `cursor-proxy key` first.",
      "proxyKeyHash",
      "—",
    );
  }

  const clientId = requireClientId(config);
  const endpoints = await resolveEndpoints(config.oauth, fetchHttpClient);

  const tokens = new RefreshingTokenProvider({
    store: credentialStore,
    http: fetchHttpClient,
    clock: systemClock,
    clientId,
    clientSecret: config.oauth.clientSecret,
    tokenEndpoint: endpoints.tokenEndpoint,
    tokenRequestFormat: config.oauth.tokenRequestFormat,
    ...(process.platform === "darwin" ? { external: readClaudeCodeSession } : {}),
  });

  // Fail at startup rather than on the first request: a proxy that accepts a
  // connection and only then reports "not signed in" is much harder to debug.
  await tokens.getAccessToken();

  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost") {
    consoleLogger.warn(
      `Binding ${host}: anyone who can reach this port and holds the proxy key can use your Anthropic OAuth session.`,
    );
  }

  const stopTelemetry = startTelemetry(join(BASE_DIR, "otel.env"), consoleLogger);

  const running = await startProxyServer(
    {
      tokens,
      proxyKeyHash: config.proxyKeyHash,
      upstream: config.upstream,
      logger: consoleLogger,
    },
    options.port ?? config.port,
    host,
  );

  consoleLogger.info(`cursor-proxy ${VERSION} listening on http://${host}:${running.port}`);
  consoleLogger.info(`Forwarding to ${config.upstream}`);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void running
        .close()
        .then(() => stopTelemetry?.())
        .then(() => process.exit(0));
    });
  }
}

/** Claude Code's current session; null when Keychain has none. */
async function readClaudeCodeSession(): Promise<Credentials | null> {
  try {
    return await loadClaudeCodeCredentialsFromKeychain();
  } catch {
    return null;
  }
}

function toPort(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`Invalid port "${raw}".`);
  }
  return value;
}

function toPositive(raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Expected a positive number, got "${raw}".`);
  }
  return value;
}

/** One place that turns our typed errors into guidance instead of a stack trace. */
export function reportFatal(error: unknown): number {
  if (error instanceof ConfigError) {
    consoleLogger.error(error.toGuidance());
    return 78; // EX_CONFIG
  }
  if (error instanceof OAuthError) {
    consoleLogger.error(error.message);
    return 77; // EX_NOPERM
  }
  consoleLogger.error(error instanceof Error ? error.message : String(error));
  return 1;
}

program.parseAsync(process.argv).catch((error: unknown) => {
  process.exitCode = reportFatal(error);
});
