#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { ConfigError, OAuthError } from "./errors.js";
import { FileConfigStore, requireClientId } from "./config.js";
import { generateProxyKey, hashProxyKey } from "./keys.js";
import { FileCredentialStore } from "./auth/credentials.js";
import { login, logout } from "./auth/login.js";
import { resolveEndpoints } from "./auth/oauth.js";
import {
  RefreshingTokenProvider,
  systemClock,
} from "./auth/token-provider.js";
import { startProxyServer } from "./proxy/server.js";
import { consoleLogger, fetchHttpClient, systemBrowser } from "./adapters.js";
import type { Config } from "./ports.js";

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
    "Local proxy that lets API-key clients use an Anthropic OAuth session.",
  )
  .version("0.1.0");

program
  .command("login")
  .description("Authorize with your Anthropic account in a browser.")
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
      `Logged in. Access token expires ${new Date(credentials.expiresAt).toLocaleString()}.`,
    );
  });

program
  .command("logout")
  .description("Delete the stored tokens from this machine.")
  .action(async () => {
    await logout(credentialStore);
    consoleLogger.info("Stored credentials deleted.");
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
  .command("status")
  .description("Report what is configured and whether a session is stored.")
  .option("--json", "machine-readable output on stdout")
  .action(async (options: { json?: boolean }) => {
    const config = await configStore.load();
    const credentials = await credentialStore.load();

    const report = {
      configDir: BASE_DIR,
      clientIdConfigured: config.oauth.clientId !== null,
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
    tokenEndpoint: endpoints.tokenEndpoint,
  });

  // Fail at startup rather than on the first request: a proxy that accepts a
  // connection and only then reports "not logged in" is much harder to debug.
  await tokens.getAccessToken();

  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost") {
    consoleLogger.warn(
      `Binding ${host}: anyone who can reach this port can spend your Anthropic session.`,
    );
  }

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

  consoleLogger.info(`Listening on http://${host}:${running.port}`);
  consoleLogger.info(`Forwarding to ${config.upstream}`);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void running.close().then(() => process.exit(0));
    });
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
