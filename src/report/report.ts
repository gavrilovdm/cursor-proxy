import { aggregate, type Period, type Row } from "./aggregate.js";
import { fetchObservations, type LangfuseSource } from "./langfuse.js";

/**
 * Weekly report: numbers are counted by code, the model only comments on them.
 *
 * The model sees two compact periods (this one and the one before), a few
 * kilobytes of JSON, never traces or prompt text.
 */

export interface ReportOptions {
  source: LangfuseSource;
  days: number;
  now?: Date;
  /** Omit to get the numbers only, with no model call. */
  llm?: { url: string; key: string; model: string };
  fetchImpl?: typeof fetch;
}

const DAY = 86_400_000;

export async function buildReport(options: ReportOptions): Promise<string> {
  const f = options.fetchImpl ?? fetch;
  const to = options.now ?? new Date();
  const from = new Date(to.getTime() - options.days * DAY);
  const before = new Date(from.getTime() - options.days * DAY);

  const observations = await fetchObservations(options.source, before, to, f);
  const current = aggregate(observations, from, to);
  const previous = aggregate(observations, before, from);

  // Without this guard a change in how Langfuse stores attributes looks like a quiet week.
  const unread = observations.length > 0 && current.totals.calls + previous.totals.calls === 0;
  const warning = unread ? `> Langfuse returned ${n(observations.length)} observations, but no span carries \`cpx.project\`.\n\n` : "";
  const tables = `${warning}${renderTables(current, previous)}`;
  if (!options.llm) return tables;
  return `${await analysisOrNote(current, previous, options.llm, f)}\n\n---\n\n${tables}`;
}

/** The numbers are the point of the report: a failed analysis must not lose them. */
async function analysisOrNote(
  current: Period,
  previous: Period,
  llm: NonNullable<ReportOptions["llm"]>,
  f: typeof fetch,
): Promise<string> {
  try {
    const { text, truncated } = await analyze(current, previous, llm, f);
    return truncated ? `${text.trim()}\n\n> Analysis cut off by the token limit.` : text.trim();
  } catch (error) {
    return `> Analysis unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function n(value: number): string {
  return value.toLocaleString("en-US");
}

function delta(now: number, was: number): string {
  if (was === 0) return now === 0 ? "" : " (new)";
  const pct = Math.round(((now - was) / was) * 100);
  return pct === 0 ? "" : ` (${pct > 0 ? "+" : ""}${pct}%)`;
}

function totalsLine(label: string, now: Row, was: Row): string {
  return `| ${label} | ${n(now.calls)}${delta(now.calls, was.calls)} | ${n(now.errors)} | ${n(now.input)}${delta(now.input, was.input)} | ${n(now.output)}${delta(now.output, was.output)} | ${n(now.cacheRead)} | ${now.costUsd} | ${n(now.p50Ms)} | ${n(now.p95Ms)}${delta(now.p95Ms, was.p95Ms)} |`;
}

const EMPTY: Row = { calls: 0, errors: 0, input: 0, output: 0, cacheRead: 0, costUsd: 0, p50Ms: 0, p95Ms: 0 };

export function renderTables(current: Period, previous: Period): string {
  const head =
    "| | calls | errors | input | output | cache read | cost $ | p50 ms | p95 ms |\n|---|---|---|---|---|---|---|---|---|";
  const lines = [
    `# cursor-proxy: ${current.from.slice(0, 10)} — ${current.to.slice(0, 10)}`,
    "",
    "Change in brackets — against the previous period of the same length.",
    "",
    head,
    totalsLine("**total**", current.totals, previous.totals),
    ...current.byProject.map((r) => {
      const was = previous.byProject.find((p) => p.project === r.project && p.model === r.model) ?? EMPTY;
      return totalsLine(`${r.project} / ${r.model}`, r, was);
    }),
  ];
  const gone = previous.byProject.filter(
    (p) => !current.byProject.some((r) => r.project === p.project && r.model === p.model),
  );
  if (gone.length > 0) {
    lines.push("", `No calls this period (were active before): ${gone.map((g) => `${g.project} / ${g.model}`).join(", ")}`);
  }
  if (current.errors.length > 0) {
    lines.push("", "## Errors", "", ...current.errors.map((e) => `- ${e.project}: ${e.type} × ${e.count}`));
  }
  if (current.slowest.length > 0) {
    lines.push("", "## Slowest calls", "", ...current.slowest.map((s) => `- ${n(s.ms)} ms — ${s.project} / ${s.model}, trace \`${s.traceId}\``));
  }
  return `${lines.join("\n")}\n`;
}

const PROMPT = `You review weekly LLM usage of a personal OpenAI-compatible proxy.
Below is JSON with two periods of equal length: "current" and "previous".
Numbers per project and model: calls, errors, tokens (input includes cache reads), cost in USD, latency p50/p95 in ms.

Write a short report in Russian, plain markdown, at most 15 lines:
1. Главное — 2–3 пункта: what changed noticeably and why it may matter.
2. Аномалии — growth of tokens or latency over 30%, new error kinds, projects that appeared or went silent. Skip the section if there are none.
3. Что проверить — 1–3 concrete actions; reference trace ids from "slowest" when relevant.
Use only the numbers given; do not invent causes you cannot see, say "possible" instead.`;

async function analyze(
  current: Period,
  previous: Period,
  llm: NonNullable<ReportOptions["llm"]>,
  f: typeof fetch,
): Promise<{ text: string; truncated: boolean }> {
  const response = await f(new URL("/v1/chat/completions", llm.url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${llm.key}`,
      "x-cpx-project": "cursor-proxy-report",
    },
    body: JSON.stringify({
      model: llm.model,
      max_tokens: 1500,
      // No system role: everything goes in one user message.
      messages: [{ role: "user", content: `${PROMPT}\n\n${JSON.stringify({ current, previous })}` }],
    }),
  });
  if (!response.ok) {
    throw new Error(`LLM answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const body = (await response.json()) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
  };
  const choice = body.choices?.[0];
  const text = choice?.message?.content;
  if (!text) throw new Error("LLM returned an empty answer");
  return { text, truncated: choice?.finish_reason === "length" };
}
