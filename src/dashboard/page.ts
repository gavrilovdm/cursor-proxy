/**
 * The dashboard page: one self-contained HTML document, no external requests.
 * It reads /dashboard/api/usage with the proxy key the user pastes once
 * (kept in this browser's localStorage) and draws everything client-side.
 */
export const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cursor-proxy usage</title>
<style>
:root {
  color-scheme: light;
  --bg: #f4f3f0; --surface: #fcfcfb; --border: #e3e1dc;
  --text: #0b0b0b; --text-2: #52514e; --text-3: #6d6c68;
  --grid: #e9e7e2; --accent: #2a78d6;
  --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a; --other: #a3a19b;
  --bad: #c9372c;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) {
    color-scheme: dark;
    --bg: #111110; --surface: #1a1a19; --border: #2c2b29;
    --text: #f0efec; --text-2: #c3c2b7; --text-3: #9a9890;
    --grid: #2a2927; --accent: #3987e5;
    --s1: #3987e5; --s2: #d95926; --s3: #199e70; --other: #6f6d68;
    --bad: #e66767;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 var(--sans); }
main { max-width: 1120px; margin: 0 auto; padding: 24px 16px 48px; }
header { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 20px; margin-bottom: 20px; }
h1 { font: 600 18px var(--mono); margin: 0; letter-spacing: -0.01em; }
h1 span { color: var(--text-3); font-weight: 400; }
h2 { font-size: 13px; font-weight: 600; color: var(--text-2); margin: 0 0 12px; text-transform: uppercase; letter-spacing: 0.06em; }
.spacer { flex: 1; }
.seg { display: inline-flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--surface); }
.seg button { border: 0; background: none; color: var(--text-2); font: 500 13px var(--sans); padding: 7px 12px; min-height: 34px; cursor: pointer; }
.seg button + button { border-left: 1px solid var(--border); }
.seg button[aria-pressed="true"] { background: var(--accent); color: #fff; }
.updated { color: var(--text-3); font-size: 12px; font-family: var(--mono); }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 16px; }
.tile .label { color: var(--text-2); font-size: 12px; }
.tile .value { font: 600 26px/1.2 var(--mono); margin-top: 4px; font-variant-numeric: tabular-nums; }
.tile .sub { color: var(--text-3); font-size: 12px; margin-top: 2px; font-family: var(--mono); }
.tile .value.bad { color: var(--bad); }
.chart-head { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-bottom: 8px; }
.chart-head h2 { margin: 0; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 12px; color: var(--text-2); }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }
.chart { position: relative; }
svg { display: block; width: 100%; height: 260px; overflow: visible; }
.axis text { fill: var(--text-3); font: 11px var(--mono); }
.grid line { stroke: var(--grid); }
.tip { position: absolute; pointer-events: none; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; font-size: 12px; box-shadow: 0 4px 16px rgb(0 0 0 / 0.12); min-width: 160px; display: none; }
.tip b { display: block; margin-bottom: 4px; font-family: var(--mono); }
.tip div { display: flex; justify-content: space-between; gap: 12px; font-family: var(--mono); }
.grid2 { display: grid; gap: 16px; margin-top: 16px; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; font-weight: 500; color: var(--text-3); font-size: 12px; padding: 6px 10px; border-bottom: 1px solid var(--border); white-space: nowrap; }
td { padding: 7px 10px; border-bottom: 1px solid var(--grid); white-space: nowrap; font-variant-numeric: tabular-nums; }
td.num, th.num { text-align: right; font-family: var(--mono); }
td .dot { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 8px; }
.err { color: var(--bad); font-family: var(--mono); }
.empty { color: var(--text-3); padding: 32px 0; text-align: center; }
.key-form { max-width: 440px; margin: 12vh auto; }
.key-form p { color: var(--text-2); }
.key-form input { width: 100%; padding: 10px 12px; font: 14px var(--mono); border-radius: 8px; border: 1px solid var(--border); background: var(--surface); color: var(--text); }
.key-form button { margin-top: 12px; padding: 9px 16px; min-height: 40px; border-radius: 8px; border: 0; background: var(--accent); color: #fff; font: 600 14px var(--sans); cursor: pointer; }
.key-form .error { color: var(--bad); font-size: 13px; min-height: 18px; margin-top: 8px; }
.linkbtn { background: none; border: 0; color: var(--text-3); font: 12px var(--sans); cursor: pointer; text-decoration: underline; padding: 6px; }
</style>
</head>
<body>
<main id="app"></main>
<script>
(() => {
  const KEY = "cpx-dashboard-key";
  const RANGE = "cpx-dashboard-range";
  const app = document.getElementById("app");
  const fmt = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
  const full = new Intl.NumberFormat("en");
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
  };
  let range = store.get(RANGE) || "24h";
  let metric = "input";
  let data = null;
  let timer = null;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const ms = (v) => (v >= 1000 ? (v / 1000).toFixed(1) + "s" : Math.round(v) + "ms");

  function askKey(message) {
    clearInterval(timer);
    app.innerHTML =
      '<form class="key-form card"><h1>cursor-proxy <span>usage</span></h1>' +
      "<p>Paste the proxy key (cpx_…). It stays in this browser and is sent only to this proxy.</p>" +
      '<input name="key" type="password" autocomplete="off" placeholder="cpx_…" aria-label="Proxy key" required>' +
      '<button type="submit">Open dashboard</button><div class="error" role="alert">' + esc(message || "") + "</div></form>";
    const form = app.querySelector("form");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      store.set(KEY, form.key.value.trim());
      load();
    });
    form.key.focus();
  }

  async function load() {
    const key = store.get(KEY);
    if (!key) return askKey();
    let response;
    try {
      response = await fetch("/dashboard/api/usage?range=" + range, { headers: { authorization: "Bearer " + key } });
    } catch {
      return renderError("The proxy did not answer.");
    }
    if (response.status === 401) {
      store.set(KEY, null);
      return askKey("That key was not accepted.");
    }
    if (!response.ok) return renderError("The proxy answered " + response.status + ".");
    data = await response.json();
    render();
    clearInterval(timer);
    timer = setInterval(load, 30000);
  }

  function renderError(message) {
    app.innerHTML = '<div class="card empty">' + esc(message) + "</div>";
  }

  // A project keeps its colour across ranges and reloads: slots are handed out
  // once, in the order projects first appear, and remembered in this browser.
  const SLOTS = "cpx-dashboard-colors";
  let slots = {};
  try { slots = JSON.parse(store.get(SLOTS) || "{}"); } catch {}

  function slotOf(project) {
    if (!(project in slots)) {
      const used = Object.values(slots);
      const free = [1, 2, 3].find((n) => !used.includes(n));
      slots[project] = free || 0;
      store.set(SLOTS, JSON.stringify(slots));
    }
    return slots[project];
  }

  function colorOf(project) {
    const slot = slotOf(project);
    return slot ? "var(--s" + slot + ")" : "var(--other)";
  }

  // Projects with a colour slot get their own series, ordered by slot; the rest fold into Other.
  function seriesOf() {
    const named = data.projects.filter((p) => slotOf(p)).sort((a, b) => slotOf(a) - slotOf(b));
    const rest = data.projects.filter((p) => !slotOf(p));
    const series = named.map((p) => ({ name: p, color: colorOf(p), pick: (b) => b.byProject[p] }));
    if (rest.length) {
      series.push({
        name: "Other", color: "var(--other)",
        pick: (b) => rest.reduce((acc, p) => {
          const c = b.byProject[p];
          if (c) { acc.input += c.input; acc.output += c.output; acc.calls += c.calls; }
          return acc;
        }, { input: 0, output: 0, calls: 0 }),
      });
    }
    return series;
  }

  function render() {
    const t = data.totals;
    const errorShare = t.calls ? Math.round((t.errors / t.calls) * 100) : 0;
    app.innerHTML =
      "<header><h1>cursor-proxy <span>usage</span></h1>" +
      '<div class="seg" role="group" aria-label="Time range">' +
      ["24h", "7d", "30d"].map((r) => '<button type="button" data-range="' + r + '" aria-pressed="' + (r === range) + '">' + r + "</button>").join("") +
      '</div><div class="spacer"></div><span class="updated">updated ' + new Date().toLocaleTimeString() + "</span>" +
      '<button type="button" class="linkbtn" data-forget>forget key</button></header>' +
      '<section class="tiles" aria-label="Totals">' +
      tile("Calls", full.format(t.calls), t.errors ? t.errors + " failed · " + errorShare + "%" : "no failures", false) +
      tile("Input tokens", fmt.format(t.input + t.cacheRead + t.cacheWrite), "uncached " + fmt.format(t.input), false) +
      tile("Output tokens", fmt.format(t.output), t.calls ? "≈" + fmt.format(Math.round(t.output / t.calls)) + " per call" : "—", false) +
      tile("Cache read", fmt.format(t.cacheRead), "written " + fmt.format(t.cacheWrite), false) +
      tile("Latency p50", t.calls ? ms(t.p50Ms) : "—", "p95 " + (t.calls ? ms(t.p95Ms) : "—"), false) +
      tile("Errors", full.format(t.errors), errorShare + "% of calls", t.errors > 0) +
      "</section>" +
      '<section class="card"><div class="chart-head"><h2>Tokens over time</h2>' +
      '<div class="seg" role="group" aria-label="Metric">' +
      [["input", "Input"], ["output", "Output"], ["calls", "Calls"]].map(([m, l]) => '<button type="button" data-metric="' + m + '" aria-pressed="' + (m === metric) + '">' + l + "</button>").join("") +
      '</div><div class="spacer"></div><div class="legend" aria-label="Projects">' +
      seriesOf().map((s) => '<span><i style="background:' + s.color + '"></i>' + esc(s.name) + "</span>").join("") +
      '</div></div><div class="chart" id="chart"></div></section>' +
      '<div class="grid2"><section class="card"><h2>By project and model</h2><div class="table-wrap">' + breakdownTable() + "</div></section>" +
      '<section class="card"><h2>Recent calls</h2><div class="table-wrap">' + recentTable() + "</div></section></div>";

    app.querySelectorAll("[data-range]").forEach((b) => b.addEventListener("click", () => { range = b.dataset.range; store.set(RANGE, range); load(); }));
    app.querySelectorAll("[data-metric]").forEach((b) => b.addEventListener("click", () => { metric = b.dataset.metric; render(); }));
    app.querySelector("[data-forget]").addEventListener("click", () => { store.set(KEY, null); askKey(); });
    drawChart(document.getElementById("chart"));
  }

  function tile(label, value, sub, bad) {
    return '<div class="card tile"><div class="label">' + label + '</div><div class="value' + (bad ? " bad" : "") + '">' + value + '</div><div class="sub">' + sub + "</div></div>";
  }

  function drawChart(el) {
    const series = seriesOf();
    const buckets = data.buckets;
    if (!data.totals.calls) { el.innerHTML = '<div class="empty">No calls in this range yet.</div>'; return; }
    const width = el.clientWidth || 800, height = 260, left = 48, bottom = 24, top = 8;
    const plotW = width - left, plotH = height - bottom - top;
    const totals = buckets.map((b) => series.reduce((n, s) => n + ((s.pick(b) || {})[metric] || 0), 0));
    const max = niceMax(Math.max(1, ...totals));
    const slot = plotW / buckets.length;
    const barW = Math.max(2, Math.min(28, slot - 2));
    const y = (v) => top + plotH - (v / max) * plotH;
    let svg = '<svg viewBox="0 0 ' + width + " " + height + '" role="img" aria-label="' + metric + ' per ' + (data.bucketMs === 3600000 ? "hour" : "day") + ' by project">';
    svg += '<g class="grid">';
    for (let i = 0; i <= 4; i++) svg += '<line x1="' + left + '" x2="' + width + '" y1="' + y((max / 4) * i) + '" y2="' + y((max / 4) * i) + '"/>';
    svg += '</g><g class="axis">';
    for (let i = 0; i <= 4; i++) svg += '<text x="' + (left - 8) + '" y="' + (y((max / 4) * i) + 4) + '" text-anchor="end">' + fmt.format((max / 4) * i) + "</text>";
    const every = Math.ceil(buckets.length / 8);
    buckets.forEach((b, i) => {
      if (i % every) return;
      svg += '<text x="' + (left + i * slot + slot / 2) + '" y="' + (height - 6) + '" text-anchor="middle">' + label(b.start) + "</text>";
    });
    svg += "</g>";
    buckets.forEach((b, i) => {
      const x = left + i * slot + (slot - barW) / 2;
      let base = 0;
      const parts = series.map((s) => ({ s, v: (s.pick(b) || {})[metric] || 0 })).filter((p) => p.v > 0);
      parts.forEach((p, j) => {
        const y0 = y(base), y1 = y(base + p.v);
        // 2px surface gap between stacked segments; only the top segment is rounded.
        const h = Math.max(1, y0 - y1 - (j > 0 ? 2 : 0));
        const r = j === parts.length - 1 ? Math.min(4, barW / 2, h) : 0;
        svg += '<path fill="' + p.s.color + '" d="' + roundedTop(x, y0 - (j > 0 ? 2 : 0) - h, barW, h, r) + '"/>';
        base += p.v;
      });
      svg += '<rect class="hit" data-i="' + i + '" x="' + (left + i * slot) + '" y="' + top + '" width="' + slot + '" height="' + plotH + '" fill="transparent"/>';
    });
    svg += "</svg>";
    el.innerHTML = svg + '<div class="tip" role="tooltip"></div>';
    const tip = el.querySelector(".tip");
    el.querySelectorAll(".hit").forEach((hit) => {
      hit.addEventListener("mouseenter", () => {
        const b = buckets[+hit.dataset.i];
        const rows = series.map((s) => { const c = s.pick(b) || {}; return '<div><span><i style="display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px;background:' + s.color + '"></i>' + esc(s.name) + "</span><span>" + full.format(c[metric] || 0) + "</span></div>"; }).join("");
        tip.innerHTML = "<b>" + label(b.start, true) + "</b>" + rows;
        tip.style.display = "block";
        const box = hit.getBoundingClientRect(), host = el.getBoundingClientRect();
        const x = box.left - host.left + box.width / 2;
        tip.style.left = Math.min(Math.max(0, x - tip.offsetWidth / 2), host.width - tip.offsetWidth) + "px";
        tip.style.top = "0px";
      });
      hit.addEventListener("mouseleave", () => { tip.style.display = "none"; });
    });
  }

  function roundedTop(x, y, w, h, r) {
    return "M" + x + "," + (y + h) + "V" + (y + r) + "Q" + x + "," + y + " " + (x + r) + "," + y + "H" + (x + w - r) + "Q" + (x + w) + "," + y + " " + (x + w) + "," + (y + r) + "V" + (y + h) + "Z";
  }

  function niceMax(v) {
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
  }

  function label(start, long) {
    const d = new Date(start);
    if (data.bucketMs === 3600000) return (long ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " : "") + String(d.getHours()).padStart(2, "0") + ":00";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function breakdownTable() {
    if (!data.breakdown.length) return '<div class="empty">No calls in this range yet.</div>';
    return "<table><thead><tr><th>Project</th><th>Model</th><th class=num>Calls</th><th class=num>Input</th><th class=num>Output</th><th class=num>Cache read</th><th class=num>p50</th><th class=num>Errors</th></tr></thead><tbody>" +
      data.breakdown.map((r) => "<tr><td><span class=dot style=\"background:" + colorOf(r.project) + "\"></span>" + esc(r.project) + "</td><td>" + esc(r.model) + "</td><td class=num>" + full.format(r.calls) + "</td><td class=num>" + full.format(r.input + r.cacheRead + r.cacheWrite) + "</td><td class=num>" + full.format(r.output) + "</td><td class=num>" + full.format(r.cacheRead) + "</td><td class=num>" + (r.calls - r.errors ? ms(r.p50Ms) : "—") + "</td><td class=num>" + (r.errors ? '<span class="err">' + r.errors + "</span>" : "0") + "</td></tr>").join("") +
      "</tbody></table>";
  }

  function recentTable() {
    if (!data.recent.length) return '<div class="empty">No calls in this range yet.</div>';
    return "<table><thead><tr><th>Time</th><th>Project</th><th>Model</th><th class=num>Input</th><th class=num>Output</th><th class=num>Duration</th><th>Status</th></tr></thead><tbody>" +
      data.recent.map((r) => "<tr><td>" + new Date(r.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) + "</td><td>" + esc(r.project) + "</td><td>" + esc(r.model) + (r.stream ? " · stream" : "") + "</td><td class=num>" + full.format(r.input + r.cacheRead + r.cacheWrite) + "</td><td class=num>" + full.format(r.output) + "</td><td class=num>" + ms(r.durationMs) + "</td><td>" + (r.ok ? "ok" : '<span class="err">✕ ' + esc(r.error || "error") + "</span>") + "</td></tr>").join("") +
      "</tbody></table>";
  }

  addEventListener("resize", () => { if (data) drawChart(document.getElementById("chart")); });
  load();
})();
</script>
</body>
</html>`;
