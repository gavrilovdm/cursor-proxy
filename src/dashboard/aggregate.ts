import type { UsageRecord } from "../ports.js";

/** What the dashboard page draws; computed here so the page stays a view. */
export interface UsageSummary {
  from: number;
  to: number;
  bucketMs: number;
  totals: Totals;
  /** One row per project + model, busiest first. */
  breakdown: (Totals & { project: string; model: string })[];
  /** Token totals per time bucket and project, for the chart. */
  buckets: { start: number; byProject: Record<string, { input: number; output: number; calls: number }> }[];
  projects: string[];
  recent: UsageRecord[];
}

export interface Totals {
  calls: number;
  errors: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  p50Ms: number;
  p95Ms: number;
}

const HOUR = 3_600_000;
const RECENT = 20;

export function summarize(records: UsageRecord[], from: number, to: number): UsageSummary {
  const inRange = records.filter((r) => r.at >= from && r.at <= to);
  // Hours for a day or two, days beyond that: keeps the chart at 24–90 bars.
  const bucketMs = to - from <= 2 * 24 * HOUR ? HOUR : 24 * HOUR;
  const first = Math.floor(from / bucketMs) * bucketMs;

  const buckets: UsageSummary["buckets"] = [];
  for (let start = first; start < to; start += bucketMs) buckets.push({ start, byProject: {} });
  for (const r of inRange) {
    // A call at exactly `to` belongs to the last bucket, not a new one.
    const bucket = buckets[Math.min(buckets.length - 1, Math.floor((r.at - first) / bucketMs))];
    if (!bucket) continue;
    const cell = (bucket.byProject[r.project] ??= { input: 0, output: 0, calls: 0 });
    cell.input += r.input + r.cacheRead + r.cacheWrite;
    cell.output += r.output;
    cell.calls += 1;
  }

  const groups = new Map<string, { project: string; model: string; rows: UsageRecord[] }>();
  for (const r of inRange) {
    const key = JSON.stringify([r.project, r.model]);
    const group = groups.get(key) ?? { project: r.project, model: r.model, rows: [] };
    group.rows.push(r);
    groups.set(key, group);
  }
  const breakdown = [...groups.values()]
    .map(({ project, model, rows }) => ({ project, model, ...totals(rows) }))
    .sort((a, b) => b.input + b.output - (a.input + a.output));

  const projectTokens = new Map<string, number>();
  for (const row of breakdown) {
    projectTokens.set(row.project, (projectTokens.get(row.project) ?? 0) + row.input + row.output);
  }

  return {
    from,
    to,
    bucketMs,
    totals: totals(inRange),
    breakdown,
    buckets,
    projects: [...projectTokens.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p),
    recent: inRange.slice(-RECENT).reverse(),
  };
}

function totals(rows: UsageRecord[]): Totals {
  const ok = rows.filter((r) => r.ok).map((r) => r.durationMs).sort((a, b) => a - b);
  return {
    calls: rows.length,
    errors: rows.filter((r) => !r.ok).length,
    input: sum(rows, (r) => r.input),
    output: sum(rows, (r) => r.output),
    cacheRead: sum(rows, (r) => r.cacheRead),
    cacheWrite: sum(rows, (r) => r.cacheWrite),
    p50Ms: percentile(ok, 0.5),
    p95Ms: percentile(ok, 0.95),
  };
}

function sum(rows: UsageRecord[], pick: (r: UsageRecord) => number): number {
  return rows.reduce((n, r) => n + pick(r), 0);
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? 0;
}
