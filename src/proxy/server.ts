import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AddressInfo } from "node:net";
import type { HttpClient, Logger, TokenProvider } from "../ports.js";
import { OAuthError } from "../errors.js";
import { verifyProxyKey } from "../keys.js";
import {
  buildDownstreamHeaders,
  buildUpstreamHeaders,
  extractProxyKey,
} from "./headers.js";
import { fetchHttpClient } from "../adapters.js";

/**
 * The localhost proxy.
 *
 * Accepts Anthropic-shaped requests authenticated with a locally-minted proxy
 * key, and replays them upstream with the user's OAuth bearer token. Bodies are
 * streamed in both directions and never buffered — a buffering proxy would turn
 * token-by-token SSE into one long pause followed by a wall of text.
 */

export interface ProxyServerOptions {
  tokens: TokenProvider;
  /** sha256 of the proxy key. Requests are refused outright when absent. */
  proxyKeyHash: string | null;
  upstream: string;
  logger: Logger;
  /** Injected so tests can point at a stub instead of the network. */
  http?: HttpClient;
}

/** Methods RFC 9110 defines as having no body worth forwarding. */
const BODYLESS = new Set(["GET", "HEAD", "DELETE", "OPTIONS"]);

export function createProxyServer(options: ProxyServerOptions): Server {
  const http = options.http ?? fetchHttpClient;

  return createServer((request, response) => {
    handle(request, response, options, http).catch((error: unknown) => {
      options.logger.error(describe(error));
      writeError(response, 502, "api_error", "Upstream request failed.");
    });
  });
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  options: ProxyServerOptions,
  http: HttpClient,
): Promise<void> {
  if (request.url === "/healthz") {
    writeJson(response, 200, { status: "ok" });
    return;
  }

  if (!options.proxyKeyHash) {
    writeError(
      response,
      401,
      "authentication_error",
      "No proxy key configured. Run `cursor-proxy key` to mint one.",
    );
    return;
  }

  if (!verifyProxyKey(extractProxyKey(request.headers), options.proxyKeyHash)) {
    // Same message for absent and wrong keys: distinguishing them tells a
    // prober which half of the problem to work on.
    writeError(response, 401, "authentication_error", "Invalid proxy key.");
    return;
  }

  let accessToken: string;
  try {
    accessToken = await options.tokens.getAccessToken();
  } catch (error) {
    if (error instanceof OAuthError && error.code === "login_required") {
      writeError(response, 401, "authentication_error", error.message);
      return;
    }
    throw error;
  }

  await forward(request, response, options, http, accessToken);
}

async function forward(
  request: IncomingMessage,
  response: ServerResponse,
  options: ProxyServerOptions,
  http: HttpClient,
  accessToken: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", options.upstream);
  const method = request.method ?? "GET";

  // If the client hangs up mid-stream, stop paying for the upstream generation.
  const controller = new AbortController();
  response.on("close", () => {
    if (!response.writableEnded) controller.abort();
  });

  const hasBody = !BODYLESS.has(method.toUpperCase());
  const upstreamRequest = new Request(url, {
    method,
    headers: buildUpstreamHeaders(request.headers, accessToken),
    signal: controller.signal,
    ...(hasBody
      ? {
          body: Readable.toWeb(request) as ReadableStream<Uint8Array>,
          // Required by undici whenever the body is a stream: it declares that
          // we finish sending before we start reading.
          duplex: "half",
        }
      : {}),
  } as RequestInit);

  const upstreamResponse = await http.send(upstreamRequest);

  response.writeHead(
    upstreamResponse.status,
    buildDownstreamHeaders(upstreamResponse.headers),
  );

  if (!upstreamResponse.body) {
    response.end();
    return;
  }

  // flushHeaders + pipeline keeps SSE chunks moving as they arrive rather than
  // collecting in Node's outgoing buffer.
  response.flushHeaders();
  try {
    await pipeline(
      Readable.fromWeb(upstreamResponse.body as import("node:stream/web").ReadableStream),
      response,
    );
  } catch (error) {
    // The client going away mid-stream is normal, not an incident.
    if (!controller.signal.aborted) throw error;
  }
}

export interface RunningProxy {
  port: number;
  close(): Promise<void>;
}

/**
 * Bind the proxy.
 *
 * Defaults to 127.0.0.1. Binding the wildcard would expose an endpoint that
 * spends the user's Anthropic session to everyone on their network, so the
 * caller has to ask for that explicitly.
 */
export async function startProxyServer(
  options: ProxyServerOptions,
  port: number,
  host = "127.0.0.1",
): Promise<RunningProxy> {
  const server = createProxyServer(options);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  const address = server.address() as AddressInfo;
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** Anthropic's error envelope, so client SDKs parse our failures natively. */
export function writeError(
  response: ServerResponse,
  status: number,
  type: string,
  message: string,
): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  writeJson(response, status, { type: "error", error: { type, message } });
}

function writeJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
