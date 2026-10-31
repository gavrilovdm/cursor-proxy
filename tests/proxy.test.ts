import { afterEach, describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";
import { startProxyServer, type RunningProxy } from "../src/proxy/server.js";
import { generateProxyKey, hashProxyKey } from "../src/keys.js";
import { OAuthError } from "../src/errors.js";
import type { Logger, TokenProvider } from "../src/ports.js";
import { stubHttp } from "./support/stubs.js";

const KEY = generateProxyKey();
const KEY_HASH = hashProxyKey(KEY);

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

const staticTokens: TokenProvider = {
  getAccessToken: async () => "anthropic-oauth-token",
};

let running: RunningProxy | null = null;

afterEach(async () => {
  await running?.close();
  running = null;
});

async function start(options: {
  handler?: (request: Request) => Response | Promise<Response>;
  tokens?: TokenProvider;
  proxyKeyHash?: string | null;
  logger?: Logger;
}) {
  const http = stubHttp(
    options.handler ?? (() => new Response("ok", { status: 200 })),
  );

  running = await startProxyServer(
    {
      tokens: options.tokens ?? staticTokens,
      proxyKeyHash:
        options.proxyKeyHash === undefined ? KEY_HASH : options.proxyKeyHash,
      upstream: "https://api.anthropic.com",
      logger: options.logger ?? silentLogger,
      http,
    },
    0,
  );

  return { http, url: `http://127.0.0.1:${running.port}` };
}

describe("proxy authentication", () => {
  it("refuses an unauthenticated request", async () => {
    const { url, http } = await start({});
    const response = await fetch(`${url}/v1/messages`, { method: "POST" });

    expect(response.status).toBe(401);
    // Nothing reaches Anthropic before the caller proves who they are.
    expect(http.requests).toHaveLength(0);
  });

  it("refuses a wrong key with the same message as a missing one", async () => {
    const { url } = await start({});
    const missing = await fetch(`${url}/v1/messages`, { method: "POST" });
    const wrong = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": generateProxyKey() },
    });

    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual(await missing.json());
  });

  it("shapes rejections like an Anthropic error, so SDKs parse them", async () => {
    const { url } = await start({});
    const response = await fetch(`${url}/v1/messages`, { method: "POST" });

    expect(await response.json()).toEqual({
      type: "error",
      error: { type: "authentication_error", message: "Invalid proxy key." },
    });
  });

  it("accepts the key as a bearer token too", async () => {
    const { url } = await start({});
    const response = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(response.status).toBe(200);
  });

  it("refuses everything when no key has been minted", async () => {
    const { url } = await start({ proxyKeyHash: null });
    const response = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": KEY },
    });

    expect(response.status).toBe(401);
    expect((await response.json()).error.message).toMatch(/cursor-proxy key/);
  });

  it("answers /healthz without a key", async () => {
    const { url } = await start({});
    const response = await fetch(`${url}/healthz`);
    expect(response.status).toBe(200);
    // The version tells clients which upstream quirks this proxy absorbs for them.
    expect(await response.json()).toEqual({ status: "ok", version: VERSION });
  });
});

describe("proxy forwarding", () => {
  it("preserves method, path and query against the upstream base", async () => {
    const { url, http } = await start({});
    await fetch(`${url}/v1/messages?beta=true`, {
      method: "POST",
      headers: { "x-api-key": KEY, "content-type": "application/json" },
      body: "{}",
    });

    const sent = http.requests[0]!;
    expect(sent.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
    expect(sent.method).toBe("POST");
  });

  it("swaps the local proxy key for the Anthropic OAuth token", async () => {
    const { url, http } = await start({});
    await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": KEY },
      body: "{}",
    });

    const sent = http.requests[0]!;
    expect(sent.headers.get("x-api-key")).toBeNull();
    expect(sent.headers.get("authorization")).toBe(
      "Bearer anthropic-oauth-token",
    );
  });

  it("sends only the upstream OAuth token, not the local proxy key", async () => {
    const { url, http } = await start({});
    await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": KEY },
      body: "{}",
    });

    const sent = http.requests[0]!;
    expect([...sent.headers.values()].join(" ")).not.toContain(KEY);
    expect(sent.headers.get("authorization")).toBe(
      "Bearer anthropic-oauth-token",
    );
  });

  it("forwards the request body", async () => {
    const { url, http } = await start({});
    await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": KEY, "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-5" }),
    });

    expect(await http.requests[0]!.json()).toEqual({ model: "claude-opus-5" });
  });

  it("returns the upstream status and body unchanged", async () => {
    const { url } = await start({
      handler: () =>
        new Response(JSON.stringify({ type: "error" }), {
          status: 429,
          headers: {
            "content-type": "application/json",
            "anthropic-ratelimit-requests-remaining": "0",
          },
        }),
    });

    const response = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": KEY },
      body: "{}",
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("anthropic-ratelimit-requests-remaining")).toBe(
      "0",
    );
  });

  it("streams SSE chunks as they arrive instead of buffering the response", async () => {
    let push: ((chunk: string) => void) | null = null;
    let finish: (() => void) | null = null;

    const { url } = await start({
      handler: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const encoder = new TextEncoder();
              push = (chunk) => controller.enqueue(encoder.encode(chunk));
              finish = () => controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });

    const response = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": KEY },
      body: "{}",
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    push!("event: message_start\n\n");
    const firstRead = await reader.read();
    // The first event is readable while the upstream stream is still open — a
    // buffering proxy would block here until close().
    expect(decoder.decode(firstRead.value)).toContain("message_start");

    push!("event: message_stop\n\n");
    const secondRead = await reader.read();
    expect(decoder.decode(secondRead.value)).toContain("message_stop");

    finish!();
    expect((await reader.read()).done).toBe(true);
  });

  it("reports a login requirement as 401, not 502", async () => {
    const { url } = await start({
      tokens: {
        getAccessToken: async () => {
          throw new OAuthError("Not logged in.", "login_required");
        },
      },
    });

    const response = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": KEY },
      body: "{}",
    });

    expect(response.status).toBe(401);
    expect((await response.json()).error.message).toBe("Not logged in.");
  });

  it("reports an upstream transport failure as 502", async () => {
    const { url } = await start({
      handler: () => {
        throw new Error("ECONNREFUSED");
      },
    });

    const response = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": KEY },
      body: "{}",
    });

    expect(response.status).toBe(502);
    // The upstream failure detail stays in the log, not in the client response.
    expect(JSON.stringify(await response.json())).not.toContain("ECONNREFUSED");
  });

  it("adapts OpenAI chat completions to Anthropic messages", async () => {
    const { url, http } = await start({
      handler: async (request) => {
        expect(request.url).toBe("https://api.anthropic.com/v1/messages");
        expect(request.headers.get("authorization")).toBe(
          "Bearer anthropic-oauth-token",
        );
        expect(request.headers.get("x-api-key")).toBeNull();
        expect(await request.json()).toMatchObject({
          model: "claude-opus-5",
          max_tokens: 32,
          system:
            "x-anthropic-billing-header: cc_version=2.1.220.5bd; cc_entrypoint=sdk-cli;",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "You are concise." },
                { type: "text", text: "ping" },
              ],
            },
          ],
        });
        return new Response(
          JSON.stringify({
            id: "msg_123",
            model: "claude-opus-5",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "pong" }],
            usage: { input_tokens: 3, output_tokens: 2 },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });

    const response = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "x-api-key": KEY, "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-5",
        max_tokens: 32,
        messages: [
          { role: "system", content: "You are concise." },
          { role: "user", content: "ping" },
        ],
      }),
    });

    expect(http.requests).toHaveLength(1);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      object: "chat.completion",
      model: "claude-opus-5",
      choices: [
        {
          message: { role: "assistant", content: "pong" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
  });

  it("accepts OpenAI chat completions without the /v1 prefix", async () => {
    const { url, http } = await start({
      handler: async (request) => {
        expect(request.url).toBe("https://api.anthropic.com/v1/messages");
        return new Response(
          JSON.stringify({
            id: "msg_bare_path",
            content: [{ type: "text", text: "pong" }],
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });

    const response = await fetch(`${url}/chat/completions`, {
      method: "POST",
      headers: { "x-api-key": KEY, "content-type": "application/json" },
      body: JSON.stringify({
        model: "cpxopus",
        messages: [{ role: "user", content: "ping" }],
      }),
    });

    expect(http.requests).toHaveLength(1);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      model: "cpxopus",
      choices: [{ message: { content: "pong" } }],
    });
  });

  it("resolves a model alias upstream but echoes the requested name", async () => {
    const { url } = await start({
      handler: async (request) => {
        expect(await request.json()).toMatchObject({
          model: "claude-haiku-4-5-20251001",
        });
        return new Response(
          JSON.stringify({
            id: "msg_alias",
            model: "claude-haiku-4-5-20251001",
            content: [{ type: "text", text: "pong" }],
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });

    const response = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "x-api-key": KEY, "content-type": "application/json" },
      body: JSON.stringify({
        model: "cpxhaiku",
        messages: [{ role: "user", content: "ping" }],
      }),
    });

    // A client that routes on the model name must not see a Claude-shaped id.
    await expect(response.json()).resolves.toMatchObject({ model: "cpxhaiku" });
  });

  it("advertises aliases alongside the upstream model list", async () => {
    const { url } = await start({
      handler: () =>
        new Response(
          JSON.stringify({
            data: [{ type: "model", id: "claude-opus-5" }],
            has_more: false,
          }),
          { headers: { "content-type": "application/json" } },
        ),
    });

    const response = await fetch(`${url}/v1/models`, {
      headers: { "x-api-key": KEY },
    });
    const body = (await response.json()) as {
      data: Array<{ id: string }>;
      has_more: boolean;
    };
    const ids = body.data.map((model) => model.id);

    expect(ids).toContain("claude-opus-5");
    expect(ids).toContain("cpxhaiku");
    expect(body.has_more).toBe(false);
  });

  it("accepts the model list without the /v1 prefix", async () => {
    const { url } = await start({
      handler: (request) => {
        expect(request.url).toBe("https://api.anthropic.com/v1/models");
        return new Response(JSON.stringify({ data: [] }), {
          headers: { "content-type": "application/json" },
        });
      },
    });

    const response = await fetch(`${url}/models`, {
      headers: { "x-api-key": KEY },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((model) => model.id)).toContain("cpxopus");
  });

  it("binds loopback only", async () => {
    const { url } = await start({});
    expect(url).toContain("127.0.0.1");
  });
});

describe("token usage log", () => {
  function recordingLogger(): Logger & { lines: string[] } {
    const lines: string[] = [];
    return { lines, info: (line) => lines.push(line), warn: () => {}, error: () => {} };
  }

  function chat(url: string, body: object, headers: Record<string, string> = {}) {
    return fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "x-api-key": KEY, "content-type": "application/json", ...headers },
      body: JSON.stringify({ messages: [{ role: "user", content: "ping" }], ...body }),
    });
  }

  it("logs the tokens of a completion, including the prompt cache", async () => {
    const logger = recordingLogger();
    const { url } = await start({
      logger,
      handler: () =>
        Response.json({
          id: "msg_usage",
          content: [{ type: "text", text: "pong" }],
          usage: {
            input_tokens: 120,
            output_tokens: 15,
            cache_read_input_tokens: 900,
            cache_creation_input_tokens: 40,
          },
        }),
    });

    await (await chat(url, { model: "cpxhaiku" }, { "x-cpx-project": "gavrisalive" })).json();

    expect(logger.lines).toContain(
      "usage project=gavrisalive model=cpxhaiku in=120 out=15 cache_read=900 cache_write=40",
    );
  });

  it("logs the tokens of a stream once it ends", async () => {
    const logger = recordingLogger();
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 50, output_tokens: 1, cache_read_input_tokens: 7 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "pong" } },
      // output_tokens in message_delta is the running total, not an increment.
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } },
      { type: "message_stop" },
    ];
    const { url } = await start({
      logger,
      handler: () =>
        new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
          headers: { "content-type": "text/event-stream" },
        }),
    });

    await (await chat(url, { model: "cpxsonnet", stream: true })).text();

    // Without the header the line still appears, attributed to an unknown project.
    expect(logger.lines).toContain(
      "usage project=unknown model=cpxsonnet in=50 out=9 cache_read=7 cache_write=0",
    );
  });
});
