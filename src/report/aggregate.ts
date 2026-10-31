/**
 * Weekly report numbers, computed from raw Langfuse observations.
 *
 * Langfuse's Metrics API groups only by its own fields (name, model, tags…),
 * not by span attributes, so per-project numbers (`cpx.project`) are counted
 * here. Only the proxy's own spans count: they are the ones carrying
 * `cpx.project`; the callers' spans in the same traces are skipped.
 */

/** The subset of a Langfuse observation the report reads. */
export interface Observation {
  id: string;
  traceId?: string | null;
  name?: string | null;
  startTime: string;
  endTime?: string | null;
  level?: string | null;
  statusMessage?: string | null;
  usageDetails?: Record<string, number> | null;
  usage?: { input?: number | null; output?: number | null } | null;
  calculatedTotalCost?: number | null;
  metadata?: unknown;
}

export interface Row {
  calls: number;
  errors: number;
  input: number;
  output: number;
  cacheRead: number;
  costUsd: number;
  p50Ms: number;
  p95Ms: number;
}

export interface ProjectRow extends Row {
  project: string;
  model: string;
}

export interface Period {
  from: string;
  to: string;
  totals: Row;
  /** Busiest first. */
  byProject: ProjectRow[];
  /** Slowest successful calls: ids only, never prompt text. */
  slowest: { traceId: string; project: string; model: string; ms: number }[];
  /** Most frequent error kinds. */
  errors: { project: string; type: string; count: number }[];
}

/** Reads a span attribute wherever Langfuse put it: flat or under `attributes`. */
export function attribute(metadata: unknown, key: string): unknown {
  if (metadata === null || typeof metadata !== "object") return undefined;
  const m = metadata as Record<string, unknown>;
  if (key in m) return m[key];
  const attrs = m.attributes;
  if (attrs !== null && typeof attrs === "object" && key in attrs) {
    return (attrs as Record<string, unknown>)[key];
  }
  return undefined;
}

function num(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[Math.max(0, i)]!);
}

interface Call {
  traceId: string;
  project: string;
  model: string;
  ms: number | null;
  error: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cost: number;
}

function toCall(o: Observation): Call | null {
  const project = attribute(o.metadata, "cpx.project");
  if (typeof project !== "string" || project === "") return null;
  const model = attribute(o.metadata, "gen_ai.request.model");
  const start = Date.parse(o.startTime);
  const end = o.endTime ? Date.parse(o.endTime) : NaN;
  const errorType = attribute(o.metadata, "error.type");
  const error =
    o.level === "ERROR" || errorType !== undefined
      ? String(errorType ?? o.statusMessage ?? "error")
      : null;
  return {
    traceId: o.traceId ?? o.id,
    project,
    model: typeof model === "string" ? model : (o.name ?? "?").replace(/^chat /, ""),
    ms: Number.isFinite(end - start) ? end - start : null,
    error,
    input: num(o.usageDetails?.input ?? o.usage?.input ?? attribute(o.metadata, "gen_ai.usage.input_tokens")),
    output: num(o.usageDetails?.output ?? o.usage?.output ?? attribute(o.metadata, "gen_ai.usage.output_tokens")),
    cacheRead: num(attribute(o.metadata, "gen_ai.usage.cache_read.input_tokens")),
    cost: num(o.calculatedTotalCost),
  };
}

function row(calls: Call[]): Row {
  const ms = calls
    .filter((c) => c.error === null && c.ms !== null)
    .map((c) => c.ms!)
    .sort((a, b) => a - b);
  return {
    calls: calls.length,
    errors: calls.filter((c) => c.error !== null).length,
    input: calls.reduce((s, c) => s + c.input, 0),
    output: calls.reduce((s, c) => s + c.output, 0),
    cacheRead: calls.reduce((s, c) => s + c.cacheRead, 0),
    costUsd: Math.round(calls.reduce((s, c) => s + c.cost, 0) * 10_000) / 10_000,
    p50Ms: percentile(ms, 50),
    p95Ms: percentile(ms, 95),
  };
}

export function aggregate(observations: Observation[], from: Date, to: Date, top = 5): Period {
  const calls = observations
    .filter((o) => {
      const t = Date.parse(o.startTime);
      return t >= from.getTime() && t < to.getTime();
    })
    .map(toCall)
    .filter((c): c is Call => c !== null);

  const groups = new Map<string, Call[]>();
  const errors = new Map<string, { project: string; type: string; count: number }>();
  for (const c of calls) {
    const key = `${c.project}\u0000${c.model}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
    if (c.error !== null) {
      const ek = `${c.project}\u0000${c.error}`;
      const e = errors.get(ek) ?? { project: c.project, type: c.error, count: 0 };
      e.count += 1;
      errors.set(ek, e);
    }
  }

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    totals: row(calls),
    byProject: [...groups.values()]
      .map((g) => ({ project: g[0]!.project, model: g[0]!.model, ...row(g) }))
      .sort((a, b) => b.calls - a.calls),
    slowest: calls
      .filter((c) => c.error === null && c.ms !== null)
      .sort((a, b) => b.ms! - a.ms!)
      .slice(0, top)
      .map((c) => ({ traceId: c.traceId, project: c.project, model: c.model, ms: c.ms! })),
    errors: [...errors.values()].sort((a, b) => b.count - a.count).slice(0, top),
  };
}
