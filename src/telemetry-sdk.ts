import { existsSync } from "node:fs";
import { diag, DiagLogLevel } from "@opentelemetry/api";
import { setGlobalErrorHandler } from "@opentelemetry/core";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import type { Logger } from "./ports.js";

/**
 * Starts OpenTelemetry export when it is configured, and only then.
 *
 * Settings are the standard OTEL_* variables (endpoint, headers, protocol).
 * A service started by launchd or systemd does not see the shell's
 * environment, so they may also live in `<base dir>/otel.env`.
 *
 * Returns a shutdown that flushes what is still buffered, or null when off.
 */
export function startTelemetry(
  envFile: string,
  logger: Logger,
): (() => Promise<void>) | null {
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const endpoint =
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (!endpoint) return null;

  reportExportFailures(logger);
  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? "cursor-proxy",
    traceExporter: new OTLPTraceExporter(),
    metricReaders: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() })],
    // Spans come from the proxy's own code; library auto-instrumentation would
    // add a span per outgoing fetch with nothing new in it.
    instrumentations: [],
  });
  sdk.start();
  logger.info(`OpenTelemetry export to ${endpoint}`);
  // shutdown flushes what is buffered; a refusal there arrives as a rejection.
  return () =>
    sdk.shutdown().catch((error: unknown) => logger.error(exportFailure("", [error])));
}

/**
 * A refused export (wrong key, wrong region, backend down) is otherwise silent:
 * the spans just never show up. Route the SDK's own errors into the proxy log.
 */
function reportExportFailures(logger: Logger): void {
  diag.setLogger(
    {
      error: (message, ...args) => logger.error(exportFailure(message, args)),
      warn: (message, ...args) => logger.warn(exportFailure(message, args)),
      info: () => {},
      debug: () => {},
      verbose: () => {},
    },
    DiagLogLevel.WARN,
  );
  setGlobalErrorHandler((error) => logger.error(exportFailure("", [error])));
}

function exportFailure(message: string, args: unknown[]): string {
  const detail = [message, ...args.map(describeError)].filter(Boolean).join(" ");
  return `OpenTelemetry export failed: ${detail}`;
}

function describeError(value: unknown): string {
  if (value instanceof Error) {
    const code = (value as { code?: unknown }).code;
    return `${value.message}${code !== undefined ? ` (${String(code)})` : ""}`;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}
