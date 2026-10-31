import { existsSync } from "node:fs";
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
  return () => sdk.shutdown();
}
