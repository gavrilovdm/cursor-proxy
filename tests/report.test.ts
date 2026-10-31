import { describe, expect, it } from "vitest";
import { aggregate, type Observation } from "../src/report/aggregate.js";
import { buildReport } from "../src/report/report.js";

const NOW = new Date("2026-11-01T00:00:00Z");
const DAY = 86_400_000;
const SOURCE = { host: "http://lf", publicKey: "pk", secretKey: "sk" };
const LLM = { url: "http://proxy", key: "k", model: "cpxsonnet" };

function obs(daysAgo: number, project: string | null, extra: Partial<Observation> = {}, ms = 1000): Observation {
  const start = new Date(NOW.getTime() - daysAgo * DAY);
  return {
    id: `o${Math.random()}`,
    traceId: `t-${project}-${daysAgo}`,
    name: "chat cpxhaiku",
    startTime: start.toISOString(),
    endTime: new Date(start.getTime() + ms).toISOString(),
    usageDetails: { input: 100, output: 10 },
    totalCost: 0.001,
    metadata: project
      ? { "attributes.cpx.project": project, "attributes.gen_ai.request.model": "cpxhaiku" }
      : {},
    ...extra,
  };
}

/** Langfuse v2 pages by cursor; anything else is the LLM. */
function fakeFetch(pages: unknown[][], llm: () => Response): { fetchImpl: typeof fetch; urls: URL[]; llmBodies: string[] } {
  const urls: URL[] = [];
  const llmBodies: string[] = [];
  const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
    const u = new URL(url);
    if (u.pathname !== "/api/public/v2/observations") {
      llmBodies.push(String(init?.body));
      return llm();
    }
    urls.push(u);
    const index = Number(u.searchParams.get("cursor") ?? 0);
    const next = index + 1 < pages.length ? { cursor: String(index + 1) } : {};
    return Response.json({ data: pages[index], meta: next });
  }) as typeof fetch;
  return { fetchImpl, urls, llmBodies };
}

const analysis = (finish_reason = "stop") => () =>
  Response.json({ choices: [{ message: { content: "## Главное\n- ok" }, finish_reason }] });

describe("aggregate", () => {
  it("counts only proxy spans, per project, with errors and percentiles", () => {
    const list = [
      obs(1, "site", {}, 1000),
      obs(2, "site", {}, 3000),
      obs(3, "site", { level: "ERROR", metadata: { "attributes.cpx.project": "site", "attributes.error.type": "429" } }),
      obs(1, "bot"),
      obs(1, null), // the caller's own span: skipped
      obs(9, "site"), // outside the period
    ];
    const p = aggregate(list, new Date(NOW.getTime() - 7 * DAY), NOW);
    expect(p.totals.calls).toBe(4);
    expect(p.totals.errors).toBe(1);
    expect(p.byProject[0]).toMatchObject({ project: "site", calls: 3, input: 300, p50Ms: 1000, p95Ms: 3000 });
    expect(p.errors).toEqual([{ project: "site", type: "429", count: 1 }]);
    expect(p.slowest[0]).toMatchObject({ project: "site", ms: 3000 });
  });

  it("takes input tokens with cache from the proxy's span, cost from totalCost", () => {
    const o = obs(1, "site", {
      totalCost: 0.5,
      metadata: {
        "attributes.cpx.project": "site",
        "attributes.gen_ai.usage.input_tokens": "1000",
        "attributes.gen_ai.usage.output_tokens": "20",
        "attributes.gen_ai.usage.cache_read.input_tokens": "900",
      },
    });
    expect(aggregate([o], new Date(0), NOW).totals).toMatchObject({ input: 1000, output: 20, cacheRead: 900, costUsd: 0.5 });
  });
});

describe("buildReport", () => {
  it("follows the cursor, asks for no text fields, never sends prompts to the LLM", async () => {
    const secret = { "attributes.cpx.project": "site", "attributes.gen_ai.input.messages": "secret prompt" };
    const { fetchImpl, urls, llmBodies } = fakeFetch(
      [[{ ...obs(1, "site"), metadata: secret, input: "secret", output: "secret" }], [obs(10, "site")]],
      analysis(),
    );

    const md = await buildReport({ source: SOURCE, days: 7, now: NOW, llm: LLM, fetchImpl });

    expect(urls).toHaveLength(2);
    expect(urls[0]!.searchParams.get("fields")).not.toContain("io");
    expect(md).toContain("## Главное");
    expect(md).toContain("| site / cpxhaiku | 1 |");
    expect(llmBodies[0]).not.toContain("secret");
    expect(llmBodies[0]).not.toContain('"system"');
  });

  it("keeps the tables when the analysis fails", async () => {
    const { fetchImpl } = fakeFetch([[obs(1, "site")]], () => new Response("down", { status: 502 }));

    const md = await buildReport({ source: SOURCE, days: 7, now: NOW, llm: LLM, fetchImpl });

    expect(md).toContain("Analysis unavailable: LLM answered 502");
    expect(md).toContain("| site / cpxhaiku | 1 (new) |");
  });

  it("marks an analysis cut off by the token limit", async () => {
    const { fetchImpl } = fakeFetch([[obs(1, "site")]], analysis("length"));

    const md = await buildReport({ source: SOURCE, days: 7, now: NOW, llm: LLM, fetchImpl });

    expect(md).toContain("## Главное");
    expect(md).toContain("Analysis cut off");
  });

  it("warns when Langfuse has data but no span carries cpx.project", async () => {
    const { fetchImpl } = fakeFetch([[obs(1, null)]], analysis());

    const md = await buildReport({ source: SOURCE, days: 7, now: NOW, fetchImpl });

    expect(md).toContain("no span carries `cpx.project`");
  });
});
