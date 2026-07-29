import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { OAuthError } from "../errors.js";

/**
 * The loopback redirect endpoint (RFC 8252 §7.3).
 *
 * Binds 127.0.0.1 explicitly rather than the wildcard: the redirect carries an
 * authorization code, and a wildcard bind would accept it from anyone on the
 * local network.
 */

const CALLBACK_PATH = "/callback";

export interface LoopbackReceiver {
  /** e.g. `http://127.0.0.1:54321/callback` — known only after binding. */
  redirectUri: string;
  /** Resolves with the authorization code, or rejects on error/timeout. */
  waitForCode(): Promise<string>;
  close(): Promise<void>;
}

export interface LoopbackOptions {
  /** State to require in the callback. A mismatch is a rejected login. */
  expectedState: string;
  /** 0 asks the OS for a free port. */
  port?: number;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export async function startLoopbackReceiver(
  options: LoopbackOptions,
): Promise<LoopbackReceiver> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let settle: ((code: string) => void) | null = null;
  let fail: ((error: Error) => void) | null = null;
  const received = new Promise<string>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  // Nothing awaits `received` until waitForCode() is called, and a rejection
  // before then would be an unhandled rejection.
  received.catch(() => {});

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (url.pathname !== CALLBACK_PATH) {
      respond(response, 404, "Not found.");
      return;
    }

    const error = url.searchParams.get("error");
    if (error) {
      const description =
        url.searchParams.get("error_description") ?? "no description given";
      respond(response, 400, "Login failed. You can close this tab.");
      fail?.(
        new OAuthError(
          `Authorization server returned "${error}": ${description}`,
          error,
        ),
      );
      return;
    }

    // Compared before the code is even read: a callback with the wrong state is
    // not our login, and its code must not be touched.
    if (url.searchParams.get("state") !== options.expectedState) {
      respond(response, 400, "Login failed. You can close this tab.");
      fail?.(
        new OAuthError(
          "Authorization callback carried an unexpected state parameter.",
          "state_mismatch",
        ),
      );
      return;
    }

    const code = url.searchParams.get("code");
    if (!code) {
      respond(response, 400, "Login failed. You can close this tab.");
      fail?.(
        new OAuthError(
          "Authorization callback carried no code.",
          "missing_code",
        ),
      );
      return;
    }

    respond(response, 200, "Logged in. You can close this tab.");
    settle?.(code);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;
  const close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Browsers keep the redirect connection alive; without this the close
      // callback waits for a socket nobody will use again.
      server.closeAllConnections();
    });

  return {
    redirectUri: `http://127.0.0.1:${address.port}${CALLBACK_PATH}`,
    waitForCode: async () => {
      const timer = setTimeout(() => {
        fail?.(
          new OAuthError(
            `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the browser to complete login.`,
            "login_timeout",
          ),
        );
      }, timeoutMs);
      try {
        return await received;
      } finally {
        clearTimeout(timer);
      }
    },
    close,
  };
}

function respond(
  response: import("node:http").ServerResponse,
  status: number,
  message: string,
): void {
  const body = `<!doctype html><meta charset="utf-8"><title>cursor-proxy</title><p style="font:16px system-ui;padding:2rem">${message}</p>`;
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}
