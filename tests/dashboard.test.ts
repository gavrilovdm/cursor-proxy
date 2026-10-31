import { afterEach, describe, expect, it } from "vitest";
import { startProxyServer, type RunningProxy } from "../src/proxy/server.js";
import { generateProxyKey, hashProxyKey } from "../src/keys.js";
import { summarize } from "../src/dashboard/aggregate.js";
import { MemoryUsageStore } from "../src/dashboard/usage-file.js";
import type { Logger, UsageRecord } from "../src/ports.js";
import { stubHttp } from "./support/stubs.js";

const KEY = generateProxyKey();
const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };
const HOUR = 3_600_000;

let running: RunningProxy | null = null;
afterEach(async () => {
  await running?.close();
  running = null;
});

async function start(handler: () => Response) {
  const usage = new MemoryUsageStore();
  running = await startProxyServer(
    {
      tokens: { getAccessToken: async () => "token" },
      proxyKeyHash: hashProxyKey(KEY),
      upstream: "https://api.anthropic.com",
      logger: silentLogger,
      http: stubHttp(handler),
      usage,
    },
    0,
  );
  return { usage, url: `http://127.0.0.1:${running.port}` };
}

function chat(url: string, project: string) {
  return fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "x-api-key": KEY, "content-type": "application/json", "x-cpx-project": project },
    body: JSON.stringify({ model: "cpxhaiku", messages: [{ role: "user", content: "ping" }] }),
  });
}

const completion = () =>
  Response.json({
    id: "msg",
    content: [{ type: "text", text: "pong" }],
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 },
  });

function record(overrides: Partial<UsageRecord>): UsageRecord {
  return {
    at: 0, project: "a", model: "cpxhaiku", stream: false, ok: true, durationMs: 100,
    input: 10, output: 1, cacheRead: 0, cacheWrite: 0, ...overrides,
  };
}

describe("dashboard", () => {
  it("serves the page without a key, since it holds no data", async () => {
    const { url } = await start(completion);
    const response = await fetch(`${url}/dashboard`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
  });

  it("keeps the usage API behind the proxy key", async () => {
    const { url } = await start(completion);
    const response = await fetch(`${url}/dashboard/api/usage`);

    expect(response.status).toBe(401);
  });

  it("records each chat call with its project, tokens and outcome", async () => {
    let status = 200;
    const { url, usage } = await start(() =>
      status === 200 ? completion() : Response.json({ type: "error" }, { status }),
    );
    await (await chat(url, "gavrisalive")).json();
    status = 429;
    await (await chat(url, "vacancy-parser")).text();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(usage.records).toMatchObject([
      { project: "gavrisalive", model: "cpxhaiku", ok: true, input: 100, output: 20, cacheRead: 5 },
      { project: "vacancy-parser", ok: false, error: "429", input: 0 },
    ]);
  });

  it("returns a summary of the recorded calls", async () => {
    const { url } = await start(completion);
    await (await chat(url, "gavrisalive")).json();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const response = await fetch(`${url}/dashboard/api/usage?range=7d`, {
      headers: { authorization: `Bearer ${KEY}` },
    });
    const summary = await response.json();
    expect(summary.totals).toMatchObject({ calls: 1, input: 100, output: 20, cacheRead: 5 });
    expect(summary.projects).toEqual(["gavrisalive"]);
  });
});

describe("summarize", () => {
  const now = 100 * HOUR;

  it("groups by project and model, busiest first", () => {
    const summary = summarize(
      [
        record({ at: now - HOUR, project: "a", input: 10 }),
        record({ at: now - HOUR, project: "b", input: 500 }),
        record({ at: now - 2 * HOUR, project: "a", input: 10 }),
      ],
      now - 24 * HOUR,
      now,
    );

    expect(summary.breakdown.map((row) => [row.project, row.calls])).toEqual([
      ["b", 1],
      ["a", 2],
    ]);
    expect(summary.projects).toEqual(["b", "a"]);
  });

  it("uses hourly buckets for a day and daily ones for longer ranges", () => {
    expect(summarize([], now - 24 * HOUR, now).bucketMs).toBe(HOUR);
    expect(summarize([], now - 7 * 24 * HOUR, now).bucketMs).toBe(24 * HOUR);
  });

  it("counts cached input into the chart and keeps failures out of latency", () => {
    const summary = summarize(
      [
        record({ at: now - 10, input: 10, cacheRead: 90, durationMs: 200 }),
        record({ at: now - 5, ok: false, error: "529", durationMs: 30_000 }),
      ],
      now - 24 * HOUR,
      now,
    );

    expect(summary.totals).toMatchObject({ calls: 2, errors: 1, p95Ms: 200 });
    const last = summary.buckets.at(-1)!;
    expect(last.byProject.a?.input).toBe(110);
  });

  it("leaves out records outside the range", () => {
    const summary = summarize([record({ at: now - 48 * HOUR })], now - 24 * HOUR, now);
    expect(summary.totals.calls).toBe(0);
  });
});
