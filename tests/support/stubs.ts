import type { Clock, HttpClient } from "../../src/ports.js";

/** A clock the test moves by hand, so expiry logic never waits on real time. */
export function fakeClock(start = 1_700_000_000_000): Clock & {
  advance(ms: number): void;
  set(ms: number): void;
} {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
    set: (ms) => {
      current = ms;
    },
  };
}

export interface StubHttpClient extends HttpClient {
  /** Every request the code under test sent, in order. */
  requests: Request[];
}

/**
 * An HttpClient that replays queued responses.
 *
 * Requests are recorded so tests can assert on the exact form of the token
 * request — grant type, PKCE verifier, absence of a client secret.
 */
export function stubHttp(
  handler: (request: Request) => Response | Promise<Response>,
): StubHttpClient {
  const requests: Request[] = [];
  return {
    requests,
    send: async (request) => {
      requests.push(request.clone());
      return handler(request);
    },
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
