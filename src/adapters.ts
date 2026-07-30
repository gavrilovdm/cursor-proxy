import openUrl from "open";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { Browser, HttpClient, Logger, Prompt } from "./ports.js";

/**
 * The concrete edges of the system: real network, real browser, real stderr.
 *
 * Everything else in `src/` talks to the interfaces in {@link ./ports.js}.
 * This file is the one place that touches the outside world directly, and it
 * holds no logic worth testing.
 */

export const fetchHttpClient: HttpClient = {
  send: (request) => fetch(request),
};

export const systemBrowser: Browser = {
  open: async (url) => {
    await openUrl(url);
  },
};

export const systemPrompt: Prompt = {
  readLine: async (message) => {
    const rl = createInterface({ input, output });
    try {
      return await rl.question(message);
    } finally {
      rl.close();
    }
  },
};

/**
 * Logs to stderr, never stdout.
 *
 * stdout is reserved for machine-readable output (the generated proxy key,
 * `status --json`), so a user can pipe it without filtering out chatter.
 */
export const consoleLogger: Logger = {
  info: (message) => process.stderr.write(`${message}\n`),
  warn: (message) => process.stderr.write(`warn: ${message}\n`),
  error: (message) => process.stderr.write(`error: ${message}\n`),
};
