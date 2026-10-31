import type { IncomingHttpHeaders } from "node:http";
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  metrics,
  propagation,
  trace,
  type Attributes,
} from "@opentelemetry/api";
import { VERSION } from "../version.js";
import type { TokenUsage } from "./openai-adapter.js";

/**
 * OpenTelemetry for chat calls, following the GenAI semantic conventions.
 *
 * Only the API is used here: with no SDK registered (the default, see
 * telemetry-sdk.ts) every call is a no-op. A client that sends `traceparent`
 * gets this span as a child of its own trace, so one trace shows both what the
 * project did and what the model call cost.
 */

const SCOPE = "cursor-proxy";

export interface ChatCallInfo {
  project: string;
  /** The model name the client asked for, alias included. */
  model: string;
  /** The model actually requested upstream after alias resolution. */
  upstreamModel: string;
  stream: boolean;
}

export interface ChatCall {
  succeed(usage: TokenUsage): void;
  /** `status` is the upstream HTTP status when there was one. */
  fail(error: unknown, status?: number): void;
}

export function startChatCall(headers: IncomingHttpHeaders, info: ChatCallInfo): ChatCall {
  const parent = propagation.extract(ROOT_CONTEXT, headers);
  const startedAt = performance.now();
  const common: Attributes = {
    "gen_ai.operation.name": "chat",
    "gen_ai.provider.name": "anthropic",
    "gen_ai.request.model": info.model,
    "cpx.project": info.project,
  };
  const span = trace.getTracer(SCOPE, VERSION).startSpan(
    `chat ${info.model}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        ...common,
        "gen_ai.response.model": info.upstreamModel,
        "cpx.stream": info.stream,
      },
    },
    parent,
  );

  // The meter is looked up per call: one taken before the SDK starts stays a no-op.
  const meter = metrics.getMeter(SCOPE, VERSION);
  const duration = meter.createHistogram("gen_ai.client.operation.duration", {
    unit: "s",
    description: "Duration of a chat call through the proxy",
  });
  const recordDuration = (extra: Attributes = {}) =>
    duration.record((performance.now() - startedAt) / 1000, { ...common, ...extra });

  return {
    succeed(usage) {
      span.setAttributes({
        // Per the conventions input_tokens includes cached input; the cache parts
        // are reported separately as well.
        "gen_ai.usage.input_tokens": usage.input + usage.cacheRead + usage.cacheWrite,
        "gen_ai.usage.output_tokens": usage.output,
        "gen_ai.usage.cache_read.input_tokens": usage.cacheRead,
        "gen_ai.usage.cache_creation.input_tokens": usage.cacheWrite,
      });
      span.end();
      const tokens = meter.createHistogram("gen_ai.client.token.usage", {
        unit: "{token}",
        description: "Tokens per chat call through the proxy",
      });
      tokens.record(usage.input + usage.cacheRead + usage.cacheWrite, {
        ...common,
        "gen_ai.token.type": "input",
      });
      tokens.record(usage.output, { ...common, "gen_ai.token.type": "output" });
      recordDuration();
    },
    fail(error, status) {
      const type = status ? String(status) : error instanceof Error ? error.name : "error";
      span.setAttribute("error.type", type);
      if (status) span.setAttribute("http.response.status_code", status);
      if (error instanceof Error) span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
      recordDuration({ "error.type": type });
    },
  };
}
