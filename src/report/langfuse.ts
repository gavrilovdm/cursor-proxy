import { reportMetadata, type Observation } from "./aggregate.js";

/** Where to read observations from: Langfuse public API, basic auth. */
export interface LangfuseSource {
  host: string;
  publicKey: string;
  secretKey: string;
}

const PAGE = 1000;
// Everything but `io`: the report never needs prompt and answer text.
const FIELDS = "core,basic,time,metadata,model,usage,metrics";

/**
 * Downloads every observation started in [from, to), following the cursor.
 *
 * Span attributes can hold prompts too (`gen_ai.input.messages`), so metadata
 * is cut down to what the report reads as soon as a page arrives.
 */
export async function fetchObservations(
  source: LangfuseSource,
  from: Date,
  to: Date,
  fetchImpl: typeof fetch = fetch,
): Promise<Observation[]> {
  const auth = Buffer.from(`${source.publicKey}:${source.secretKey}`).toString("base64");
  const out: Observation[] = [];
  for (let cursor: string | undefined; ; ) {
    const url = new URL("/api/public/v2/observations", source.host);
    url.searchParams.set("fromStartTime", from.toISOString());
    url.searchParams.set("toStartTime", to.toISOString());
    url.searchParams.set("limit", String(PAGE));
    url.searchParams.set("fields", FIELDS);
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetchImpl(url, { headers: { authorization: `Basic ${auth}` } });
    if (!response.ok) {
      throw new Error(`Langfuse ${url.pathname} answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    const body = (await response.json()) as { data: Observation[]; meta?: { cursor?: string | null } };
    for (const o of body.data) out.push({ ...o, metadata: reportMetadata(o.metadata) });
    cursor = body.meta?.cursor ?? undefined;
    if (!cursor) return out;
  }
}
