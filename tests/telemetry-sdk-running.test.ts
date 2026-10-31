// Separate file: the SDK registers global providers once per process, so this
// case needs a process of its own (vitest isolates files, not tests).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { trace } from "@opentelemetry/api";
import { startTelemetry } from "../src/telemetry-sdk.js";
import type { Logger } from "../src/ports.js";

let collector: Server | null = null;
afterEach(() => {
  collector?.close();
  collector = null;
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
});

describe("startTelemetry while running", () => {
  it("logs a refused export while running, not only at shutdown", async () => {
    collector = createServer((_request, response) => {
      response.writeHead(403);
      response.end();
    });
    await new Promise<void>((resolve) => collector!.listen(0, "127.0.0.1", resolve));
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${(collector.address() as AddressInfo).port}`;
    process.env.OTEL_BSP_SCHEDULE_DELAY = "50";

    const lines: string[] = [];
    const stop = startTelemetry("/nonexistent/otel.env", {
      info: () => {},
      warn: (line) => lines.push(line),
      error: (line) => lines.push(line),
    })!;
    trace.getTracer("test").startSpan("probe").end();
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(lines.some((line) => /OpenTelemetry export failed.*403/.test(line))).toBe(true);
    await stop();
    delete process.env.OTEL_BSP_SCHEDULE_DELAY;
  });
});
