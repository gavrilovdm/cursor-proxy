import type { Observation } from "./aggregate.js";

/** Where to read observations from: Langfuse public API, basic auth. */
export interface LangfuseSource {
  host: string;
  publicKey: string;
  secretKey: string;
}

const PAGE = 100;

/**
 * Downloads every observation started in [from, to), page by page.
 *
 * Prompt and answer text (`input`/`output`) is dropped as soon as a page
 * arrives: the report never needs it, and it may hold personal data.
 */
export async function fetchObservations(
  source: LangfuseSource,
  from: Date,
  to: Date,
  fetchImpl: typeof fetch = fetch,
): Promise<Observation[]> {
  const auth = Buffer.from(`${source.publicKey}:${source.secretKey}`).toString("base64");
  const out: Observation[] = [];
  for (let page = 1; ; page++) {
    const url = new URL("/api/public/observations", source.host);
    url.searchParams.set("fromStartTime", from.toISOString());
    url.searchParams.set("toStartTime", to.toISOString());
    url.searchParams.set("limit", String(PAGE));
    url.searchParams.set("page", String(page));
    const response = await fetchImpl(url, { headers: { authorization: `Basic ${auth}` } });
    if (!response.ok) {
      throw new Error(`Langfuse ${url.pathname} answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    const body = (await response.json()) as {
      data: (Observation & { input?: unknown; output?: unknown })[];
      meta?: { totalPages?: number };
    };
    for (const { input: _input, output: _output, ...rest } of body.data) out.push(rest);
    const totalPages = body.meta?.totalPages ?? (body.data.length < PAGE ? page : page + 1);
    if (page >= totalPages || body.data.length === 0) return out;
  }
}
