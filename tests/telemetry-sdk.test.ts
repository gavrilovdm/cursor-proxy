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

describe("startTelemetry", () => {
  it("logs a refused export instead of dropping the spans silently", async () => {
    // A backend that rejects the credentials, like Langfuse with a wrong key.
    collector = createServer((_request, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end('{"message":"Invalid credentials"}');
    });
    await new Promise<void>((resolve) => collector!.listen(0, "127.0.0.1", resolve));
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${(collector.address() as AddressInfo).port}`;

    const lines: string[] = [];
    const logger: Logger = {
      info: (line) => lines.push(`info ${line}`),
      warn: (line) => lines.push(`warn ${line}`),
      error: (line) => lines.push(`error ${line}`),
    };
    const stop = startTelemetry("/nonexistent/otel.env", logger)!;
    trace.getTracer("test").startSpan("probe").end();
    await stop();

    expect(lines.some((line) => /^(warn|error) OpenTelemetry export failed.*401/.test(line))).toBe(true);
  });

  it("stays off without an endpoint", () => {
    expect(startTelemetry("/nonexistent/otel.env", { info() {}, warn() {}, error() {} })).toBeNull();
  });
});
