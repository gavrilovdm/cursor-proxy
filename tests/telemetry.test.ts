import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { SpanStatusCode, metrics, propagation, trace } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { startProxyServer, type RunningProxy } from "../src/proxy/server.js";
import { generateProxyKey, hashProxyKey } from "../src/keys.js";
import type { Logger } from "../src/ports.js";
import { stubHttp } from "./support/stubs.js";

const KEY = generateProxyKey();
const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };
const spans = new InMemorySpanExporter();
const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const metricReader = new PeriodicExportingMetricReader({
  exporter: metricExporter,
  exportIntervalMillis: 60_000,
});

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const CLIENT_SPAN_ID = "00f067aa0ba902b7";

const tracerProvider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter: spans })] });

let running: RunningProxy | null = null;

/** Spans are exported asynchronously even by the simple processor. */
async function finishedSpans() {
  await tracerProvider.forceFlush();
  return spans.getFinishedSpans();
}

beforeAll(() => {
  // What the SDK does at startup; without it the proxy's telemetry is a no-op.
  trace.setGlobalTracerProvider(tracerProvider);
  metrics.setGlobalMeterProvider(new MeterProvider({ readers: [metricReader] }));
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
});

afterEach(async () => {
  await running?.close();
  running = null;
  spans.reset();
});

async function start(handler: (request: Request) => Response | Promise<Response>) {
  const http = stubHttp(handler);
  running = await startProxyServer(
    {
      tokens: { getAccessToken: async () => "anthropic-oauth-token" },
      proxyKeyHash: hashProxyKey(KEY),
      upstream: "https://api.anthropic.com",
      logger: silentLogger,
      http,
    },
    0,
  );
  return { http, url: `http://127.0.0.1:${running.port}` };
}

function chat(url: string) {
  return fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "x-api-key": KEY,
      "content-type": "application/json",
      "x-cpx-project": "gavrisalive",
      traceparent: `00-${TRACE_ID}-${CLIENT_SPAN_ID}-01`,
    },
    body: JSON.stringify({ model: "cpxhaiku", messages: [{ role: "user", content: "ping" }] }),
  });
}

const completion = () =>
  Response.json({
    id: "msg_otel",
    content: [{ type: "text", text: "pong" }],
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 30 },
  });

describe("chat telemetry", () => {
  it("continues the client's trace with a GenAI span", async () => {
    const { url } = await start(completion);
    await (await chat(url)).json();

    const [span] = await finishedSpans();
    expect(span.name).toBe("chat cpxhaiku");
    expect(span.spanContext().traceId).toBe(TRACE_ID);
    expect(span.parentSpanContext?.spanId).toBe(CLIENT_SPAN_ID);
    expect(span.attributes).toMatchObject({
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "anthropic",
      "gen_ai.request.model": "cpxhaiku",
      "gen_ai.response.model": "claude-haiku-5-5",
      "gen_ai.usage.input_tokens": 130,
      "gen_ai.usage.output_tokens": 20,
      "gen_ai.usage.cache_read.input_tokens": 30,
      "cpx.project": "gavrisalive",
    });
  });

  it("keeps the client's trace context away from Anthropic", async () => {
    const { url, http } = await start(completion);
    await (await chat(url)).json();

    expect(http.requests[0].headers.has("traceparent")).toBe(false);
  });

  it("marks the span failed when Anthropic refuses the call", async () => {
    const { url } = await start(() =>
      Response.json({ type: "error", error: { type: "rate_limit_error" } }, { status: 429 }),
    );
    await (await chat(url)).text();

    const [span] = await finishedSpans();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes["error.type"]).toBe("429");
  });

  it("counts input and output tokens per project and model", async () => {
    const { url } = await start(completion);
    await (await chat(url)).json();
    await metricReader.forceFlush();

    const exported = metricExporter.getMetrics().at(-1)!;
    const usage = exported.scopeMetrics
      .flatMap((scope) => scope.metrics)
      .find((metric) => metric.descriptor.name === "gen_ai.client.token.usage")!;
    const output = usage.dataPoints.find(
      (point) => point.attributes["gen_ai.token.type"] === "output",
    )!;
    expect(output.attributes).toMatchObject({
      "gen_ai.request.model": "cpxhaiku",
      "cpx.project": "gavrisalive",
    });
    expect((output.value as { sum: number }).sum).toBeGreaterThanOrEqual(20);
  });

  it("leaves prompts and answers out of spans by default", async () => {
    const { url } = await start(completion);
    await (await chat(url)).json();

    const [span] = await finishedSpans();
    expect(span.attributes["langfuse.observation.input"]).toBeUndefined();
    expect(span.attributes["gen_ai.output.messages"]).toBeUndefined();
  });

  it("records prompts and answers when content capture is on", async () => {
    process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = "true";
    try {
      const { url } = await start(completion);
      await (await chat(url)).json();

      const [span] = await finishedSpans();
      expect(JSON.parse(String(span.attributes["langfuse.observation.input"]))).toEqual([
        { role: "user", content: "ping" },
      ]);
      expect(span.attributes["langfuse.observation.output"]).toBe("pong");
      expect(span.attributes["gen_ai.output.messages"]).toBeDefined();
    } finally {
      delete process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
    }
  });

  it("records a streamed answer when content capture is on", async () => {
    process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = "true";
    try {
      const events = [
        { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "po" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ng" } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
        { type: "message_stop" },
      ];
      const { url } = await start(
        () =>
          new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
            headers: { "content-type": "text/event-stream" },
          }),
      );
      const response = await fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "x-api-key": KEY, "content-type": "application/json" },
        body: JSON.stringify({ model: "cpxsonnet", stream: true, messages: [{ role: "user", content: "ping" }] }),
      });
      await response.text();

      const [span] = await finishedSpans();
      expect(span.attributes["langfuse.observation.output"]).toBe("pong");
    } finally {
      delete process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
    }
  });
});
