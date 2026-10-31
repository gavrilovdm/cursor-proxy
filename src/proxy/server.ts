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
import { VERSION } from "../version.js";
import {
  formatTokenUsage,
  MODEL_ALIASES,
  toAnthropicMessagesRequest,
  toOpenAiChatCompletion,
  toTokenUsage,
  writeOpenAiStream,
  type AnthropicMessageResponse,
  type OpenAiChatCompletionRequest,
  type TokenUsage,
} from "./openai-adapter.js";

/**
 * The localhost proxy.
 *
 * Accepts Anthropic-shaped requests authenticated with a locally-minted proxy
 * key, and replays them upstream with the account's Anthropic OAuth token. Bodies
 * are streamed in both directions and never buffered — a buffering proxy would
 * turn token-by-token SSE into one long pause followed by a wall of text.
 *
 * Two independent gates guard the forwarding path: the proxy key proves the
 * caller is the local client we minted it for, and the OAuth session supplies
 * the upstream Anthropic credential. The session is checked per request rather
 * than once at startup, so refresh and revocation behavior is visible on a
 * long-running proxy instead of at its next restart.
 */

export interface ProxyServerOptions {
  /** Supplies the Anthropic OAuth access token forwarded upstream. */
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
    logAccess(request, response, options.logger);
    handle(request, response, options, http).catch((error: unknown) => {
      options.logger.error(describe(error));
      writeError(response, 502, "api_error", "Upstream request failed.");
    });
  });
}

/**
 * One line per request.
 *
 * This is the only signal that distinguishes a client actually routed through
 * the proxy from one that silently kept talking to its own provider, so it logs
 * before authentication rather than only on the forwarding path.
 */
function logAccess(
  request: IncomingMessage,
  response: ServerResponse,
  logger: Logger,
): void {
  const startedAt = Date.now();
  const method = request.method ?? "GET";
  const path = (request.url ?? "/").split("?")[0];
  response.on("finish", () => {
    logger.info(
      `${method} ${path} -> ${response.statusCode} ${Date.now() - startedAt}ms`,
    );
  });
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  options: ProxyServerOptions,
  http: HttpClient,
): Promise<void> {
  if (request.url === "/healthz") {
    writeJson(response, 200, { status: "ok", version: VERSION });
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

  if (method.toUpperCase() === "POST" && isOpenAiChatCompletionsPath(url.pathname)) {
    await forwardOpenAiChatCompletion(request, response, options, http, accessToken);
    return;
  }

  if (method.toUpperCase() === "GET" && isOpenAiModelsPath(url.pathname)) {
    await forwardModelList(request, response, options, http, accessToken);
    return;
  }

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

function isOpenAiChatCompletionsPath(pathname: string): boolean {
  return pathname === "/v1/chat/completions" || pathname === "/chat/completions";
}

function isOpenAiModelsPath(pathname: string): boolean {
  return pathname === "/v1/models" || pathname === "/models";
}

async function forwardOpenAiChatCompletion(
  request: IncomingMessage,
  response: ServerResponse,
  options: ProxyServerOptions,
  http: HttpClient,
  accessToken: string,
): Promise<void> {
  const openAiRequest = (await readJson(request)) as OpenAiChatCompletionRequest;
  // Clients that rewrite model names before sending them are indistinguishable
  // from a misconfigured model list without seeing the name we actually got.
  options.logger.info(
    `chat model=${openAiRequest.model} stream=${openAiRequest.stream === true}`,
  );
  const anthropicRequest = toAnthropicMessagesRequest(openAiRequest);
  const headers = buildUpstreamHeaders(request.headers, accessToken);
  headers.set("content-type", "application/json");

  const upstreamResponse = await http.send(
    new Request(new URL("/v1/messages", options.upstream), {
      method: "POST",
      headers,
      body: JSON.stringify(anthropicRequest),
    }),
  );

  if (!upstreamResponse.ok || !upstreamResponse.body) {
    await pipeUpstream(response, upstreamResponse);
    return;
  }

  let usage: TokenUsage;
  if (openAiRequest.stream) {
    usage = await writeOpenAiStream(response, upstreamResponse, openAiRequest.model);
  } else {
    const anthropic = (await upstreamResponse.json()) as AnthropicMessageResponse;
    writeJson(response, 200, toOpenAiChatCompletion(anthropic, openAiRequest.model));
    usage = toTokenUsage(anthropic.usage);
  }
  // Per-request spend, so every project on this proxy can be costed from the log.
  options.logger.info(`usage model=${openAiRequest.model} ${formatTokenUsage(usage)}`);
}

/**
 * The upstream model list plus our aliases.
 *
 * Without the aliases here, a client that validates the requested model against
 * this list rejects them before sending a single request.
 */
async function forwardModelList(
  request: IncomingMessage,
  response: ServerResponse,
  options: ProxyServerOptions,
  http: HttpClient,
  accessToken: string,
): Promise<void> {
  const upstreamResponse = await http.send(
    new Request(new URL("/v1/models", options.upstream), {
      method: "GET",
      headers: buildUpstreamHeaders(request.headers, accessToken),
    }),
  );

  if (!upstreamResponse.ok) {
    await pipeUpstream(response, upstreamResponse);
    return;
  }

  const body = (await upstreamResponse.json()) as { data?: unknown[] };
  const aliases = Object.entries(MODEL_ALIASES).map(([alias, target]) => ({
    id: alias,
    object: "model",
    owned_by: "anthropic",
    display_name: target,
  }));
  writeJson(response, 200, {
    ...body,
    data: [...(body.data ?? []), ...aliases],
  });
}

async function pipeUpstream(
  response: ServerResponse,
  upstreamResponse: Response,
): Promise<void> {
  response.writeHead(
    upstreamResponse.status,
    buildDownstreamHeaders(upstreamResponse.headers),
  );
  if (!upstreamResponse.body) {
    response.end();
    return;
  }
  await pipeline(
    Readable.fromWeb(
      upstreamResponse.body as import("node:stream/web").ReadableStream,
    ),
    response,
  );
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
  if (!(error instanceof Error)) return String(error);
  const cause =
    typeof error.cause === "object" &&
    error.cause !== null &&
    "message" in error.cause
      ? `: ${(error.cause as { message: string }).message}`
      : "";
  return `${error.message}${cause}`;
}
