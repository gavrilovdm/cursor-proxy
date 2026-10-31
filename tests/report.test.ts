import { describe, expect, it } from "vitest";
import { aggregate, type Observation } from "../src/report/aggregate.js";
import { buildReport } from "../src/report/report.js";

const NOW = new Date("2026-11-01T00:00:00Z");
const DAY = 86_400_000;

function obs(daysAgo: number, project: string | null, extra: Partial<Observation> = {}, ms = 1000): Observation {
  const start = new Date(NOW.getTime() - daysAgo * DAY);
  return {
    id: `o${Math.random()}`,
    traceId: `t-${project}-${daysAgo}`,
    name: "chat cpxhaiku",
    startTime: start.toISOString(),
    endTime: new Date(start.getTime() + ms).toISOString(),
    usageDetails: { input: 100, output: 10 },
    calculatedTotalCost: 0.001,
    metadata: project
      ? { attributes: { "cpx.project": project, "gen_ai.request.model": "cpxhaiku" } }
      : { attributes: {} },
    ...extra,
  };
}

describe("aggregate", () => {
  it("counts only proxy spans, per project, with errors and percentiles", () => {
    const list = [
      obs(1, "site", {}, 1000),
      obs(2, "site", {}, 3000),
      obs(3, "site", { level: "ERROR", metadata: { attributes: { "cpx.project": "site", "error.type": "429" } } }),
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

  it("reads flat metadata too", () => {
    const o = obs(1, null, { metadata: { "cpx.project": "flat" } });
    expect(aggregate([o], new Date(0), NOW).byProject[0]?.project).toBe("flat");
  });
});

describe("buildReport", () => {
  it("pages through Langfuse, never sends prompts to the LLM", async () => {
    const pages = [
      [{ ...obs(1, "site"), input: "secret prompt", output: "secret answer" }],
      [obs(10, "site")],
    ];
    let llmBody = "";
    const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
      const u = new URL(url);
      if (u.pathname === "/api/public/observations") {
        const page = Number(u.searchParams.get("page"));
        return Response.json({ data: pages[page - 1], meta: { totalPages: 2 } });
      }
      llmBody = String(init?.body);
      return Response.json({ choices: [{ message: { content: "## Главное\n- ok" } }] });
    }) as typeof fetch;

    const md = await buildReport({
      source: { host: "http://lf", publicKey: "pk", secretKey: "sk" },
      days: 7,
      now: NOW,
      llm: { url: "http://proxy", key: "k", model: "cpxsonnet" },
      fetchImpl,
    });
    expect(md).toContain("## Главное");
    expect(md).toContain("| site / cpxhaiku | 1 |");
    expect(llmBody).not.toContain("secret");
    expect(llmBody).not.toContain('"system"');
  });
});
