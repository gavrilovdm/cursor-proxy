import type { ServerResponse } from "node:http";
import type { UsageStore } from "../ports.js";
import { summarize } from "./aggregate.js";
import { DASHBOARD_HTML } from "./page.js";

/**
 * The usage dashboard.
 *
 * The page itself holds no data and is served without a key, so a browser can
 * open it; it asks for the proxy key and sends it with every API call. The API
 * sits behind the same key check as the proxy, since the proxy is often public
 * through ngrok.
 */

const DAY = 86_400_000;
const RANGES: Record<string, number> = { "24h": DAY, "7d": 7 * DAY, "30d": 30 * DAY };

export function isDashboardPage(pathname: string): boolean {
  return pathname === "/dashboard" || pathname === "/dashboard/";
}

export function isDashboardApi(pathname: string): boolean {
  return pathname === "/dashboard/api/usage";
}

export function writeDashboardPage(response: ServerResponse): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    // Everything is inline; nothing may load from elsewhere or frame the page.
    "content-security-policy":
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
  });
  response.end(DASHBOARD_HTML);
}

export async function writeUsageSummary(
  response: ServerResponse,
  store: UsageStore,
  url: URL,
  now = Date.now(),
): Promise<void> {
  const span = RANGES[url.searchParams.get("range") ?? "24h"] ?? DAY;
  const from = now - span;
  const summary = summarize(await store.since(from), from, now);
  const body = JSON.stringify(summary);
  response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(body);
}
