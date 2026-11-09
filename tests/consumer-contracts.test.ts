/**
 * Consumer-driven contracts for cursor-proxy.
 *
 * Each describe block is one consumer repo. The requests and the fields read
 * from the responses are copied from that consumer's code, not invented:
 *   vacancy-parser  packages/llm/src/vp_llm/client.py, apps/runtime/.../health.py
 *   job-agent       src/job_agent/llm.py, src/job_agent/bot.py
 *   ai-agent-layer  src/ai_agent_layer/llm.py
 *   gavrisalive     server/services.ts
 * The upstream (Anthropic) is a stub, so nothing leaves the machine.
 */
import { afterEach, describe, expect, it } from "vitest";
import { startProxyServer, type RunningProxy } from "../src/proxy/server.js";
import { generateProxyKey, hashProxyKey } from "../src/keys.js";
import type { Logger } from "../src/ports.js";
import { stubHttp } from "./support/stubs.js";

const KEY = generateProxyKey();
let running: RunningProxy | null = null;
const logLines: string[] = [];

afterEach(async () => {
  await running?.close();
  running = null;
  logLines.length = 0;
});

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

function sse(events: unknown[]): Response {
  const text = events
    .map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("");
  return new Response(text, { headers: { "content-type": "text/event-stream" } });
}

/** A fake Anthropic that answers like the real one for the shapes consumers use. */
async function fakeAnthropic(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/v1/models") {
    return json({ data: [{ id: "claude-opus-5", type: "model" }] });
  }
  const body = (await request.json()) as {
    stream?: boolean;
    tools?: { name: string }[];
  };
  const usage = { input_tokens: 10, output_tokens: 5 };
  if (body.stream) {
    return sse([
      { type: "message_start", message: { id: "m1", model: "claude-opus-5", usage } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ]);
  }
  if (body.tools?.length) {
    const tool = body.tools[0]!;
    return json({
      id: "m2",
      model: "claude-opus-5",
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "t1", name: tool.name, input: { score: 7 } }],
      usage,
    });
  }
  return json({ id: "m3", model: "claude-opus-5", stop_reason: "end_turn", content: [{ type: "text", text: "pong" }], usage });
}

async function start() {
  const logger: Logger = {
    info: (m: string) => logLines.push(m),
    warn: () => {},
    error: () => {},
  };
  running = await startProxyServer(
    {
      tokens: { getAccessToken: async () => "oauth" },
      proxyKeyHash: hashProxyKey(KEY),
      upstream: "https://api.anthropic.com",
      logger,
      http: stubHttp(fakeAnthropic),
    },
    0,
  );
  return `http://127.0.0.1:${running.port}`;
}

function post(base: string, path: string, body: unknown, project?: string) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
      ...(project ? { "x-cpx-project": project } : {}),
    },
    body: JSON.stringify(body),
  });
}

const forcedTool = (name: string) => ({
  model: "claude-opus-5",
  max_tokens: 2048,
  messages: [{ role: "user", content: "score this" }],
  tools: [{ type: "function", function: { name, description: "d", parameters: { type: "object" } } }],
  tool_choice: { type: "function", function: { name } },
});

/** What the three Python consumers read: choices[0].message.tool_calls[0].function.arguments as a str. */
async function expectToolArgumentsString(response: Response) {
  expect(response.status).toBe(200);
  const payload = (await response.json()) as any;
  const args = payload.choices[0].message.tool_calls[0].function.arguments;
  expect(typeof args).toBe("string");
  expect(JSON.parse(args)).toEqual({ score: 7 });
}

describe("contract: vacancy-parser", () => {
  it("health: GET /healthz without a key answers 200", async () => {
    const base = await start();
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  it("health: GET /v1/models with bearer answers 200", async () => {
    const base = await start();
    const r = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${KEY}` } });
    expect(r.status).toBe(200);
  });

  it("tools without tool_choice → tool_calls[0].function.arguments is a string", async () => {
    const base = await start();
    const { tool_choice: _, ...body } = forcedTool("extract");
    await expectToolArgumentsString(await post(base, "/v1/chat/completions", body, "vacancy-parser"));
  });

  it("x-cpx-project lands in the usage log line", async () => {
    const base = await start();
    await post(base, "/v1/chat/completions", forcedTool("extract"), "vacancy-parser");
    expect(logLines.some((l) => l.includes("usage project=vacancy-parser"))).toBe(true);
  });
});

describe("contract: job-agent", () => {
  it("forced tool_choice → arguments string", async () => {
    const base = await start();
    await expectToolArgumentsString(await post(base, "/v1/chat/completions", forcedTool("score"), "job-agent"));
  });

  it("x-cpx-project lands in the usage log line", async () => {
    const base = await start();
    await post(base, "/v1/chat/completions", forcedTool("score"), "job-agent");
    expect(logLines.some((l) => l.includes("usage project=job-agent"))).toBe(true);
  });
});

describe("contract: ai-agent-layer", () => {
  it("forced tool_choice, no project header → arguments string", async () => {
    const base = await start();
    await expectToolArgumentsString(await post(base, "/v1/chat/completions", forcedTool("answer")));
  });
});

describe("contract: gavrisalive", () => {
  it("stream: delta.content chunks and a finish_reason", async () => {
    const base = await start();
    const r = await post(
      base,
      "/v1/chat/completions",
      { model: "claude-opus-5", max_tokens: 100, stream: true, messages: [{ role: "system", content: "s" }, { role: "user", content: "hi" }] },
      "gavrisalive",
    );
    const text = await r.text();
    const chunks = text
      .split("\n")
      .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
      .map((l) => JSON.parse(l.slice(6)));
    expect(chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("")).toBe("hello");
    expect(chunks.some((c) => c.choices[0]?.finish_reason)).toBe(true);
  });

  it("x-cpx-project lands in the usage log line", async () => {
    const base = await start();
    await post(base, "/v1/chat/completions", { model: "claude-opus-5", messages: [{ role: "user", content: "hi" }] }, "gavrisalive");
    expect(logLines.some((l) => l.includes("usage project=gavrisalive"))).toBe(true);
  });
});
