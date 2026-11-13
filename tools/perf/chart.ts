// Draws the HTTP read latency figure from .codex-build/perf/http-reads.json (written by http-reads.ts).
// The chart is inline SVG, rendered to PNG with the Playwright already in the repo; no new dependency.
// Run: npx tsx tools/perf/chart.ts   (writes docs/testing/figures/perf-http-latency.png)
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

interface Row {
  readonly route: string;
  readonly concurrency: number;
  readonly statuses: Record<string, number>;
  readonly summary: { readonly p50: number; readonly p95: number; readonly p95_ci95: readonly [number, number] };
}
interface Point {
  readonly label: string;
  readonly p50: number;
  readonly p95: number;
  readonly lo: number;
  readonly hi: number;
}

const input = JSON.parse(readFileSync(fileURLToPath(new URL("../../.codex-build/perf/http-reads.json", import.meta.url)), "utf8")) as {
  readonly datasetSize: number;
  readonly mode: string;
  readonly rows: readonly Row[];
};
const LABELS: Record<string, string> = {
  "/api/v1/context": "context",
  "/api/v1/events": "list",
  "/api/v1/events/{id}": "detail",
  "/api/v1/events/{id}/history": "history",
  "/api/v1/events.geojson": "GeoJSON",
};
function routeKey(route: string): string {
  return route.replace(/\/api\/v1\/events\/[^/]+/, "/api/v1/events/{id}");
}
function pointsFor(concurrency: number): Point[] {
  const out: Point[] = [];
  for (const [route, label] of Object.entries(LABELS)) {
    const row = input.rows.find((r) => routeKey(r.route) === route && r.concurrency === concurrency);
    if (!row || Object.keys(row.statuses).some((code) => code !== "200")) continue;
    out.push({ label, p50: row.summary.p50, p95: row.summary.p95, lo: row.summary.p95_ci95[0], hi: row.summary.p95_ci95[1] });
  }
  return out;
}
function niceStep(max: number): number {
  if (max <= 6) return 1;
  if (max <= 12) return 2;
  if (max <= 30) return 5;
  if (max <= 60) return 10;
  return 20;
}

function panel(x0: number, title: string, points: readonly Point[]): string {
  const W = 560, top = 110, left = 58, plotW = W - left - 16, plotH = 300;
  const maxHi = Math.max(...points.map((p) => p.hi), 1);
  const step = niceStep(maxHi);
  const yMax = Math.ceil((maxHi * 1.12) / step) * step;
  const y = (v: number) => top + plotH - (v / yMax) * plotH;
  const groupW = plotW / points.length;
  const barW = 24;
  let g = `<g transform="translate(${x0},0)">`;
  g += `<text x="${left}" y="92" font-size="18" font-weight="600" fill="#18323A">${title}</text>`;
  for (let v = 0; v <= yMax; v += step) {
    g += `<line x1="${left}" x2="${left + plotW}" y1="${y(v)}" y2="${y(v)}" stroke="#E7F3F1" stroke-width="1"/>`;
    g += `<text x="${left - 8}" y="${y(v) + 4}" font-size="12" text-anchor="end" fill="#33494F">${v}</text>`;
  }
  g += `<line x1="${left}" x2="${left + plotW}" y1="${top + plotH}" y2="${top + plotH}" stroke="#A9BBB8" stroke-width="1"/>`;
  g += `<text transform="rotate(-90)" x="${-(top + plotH / 2)}" y="16" font-size="12" text-anchor="middle" fill="#33494F">milliseconds</text>`;
  points.forEach((p, i) => {
    const cx = left + groupW * i + groupW / 2;
    const x50 = cx - barW - 3, x95 = cx + 3, xm = x95 + barW / 2;
    g += `<rect x="${x50}" y="${y(p.p50)}" width="${barW}" height="${top + plotH - y(p.p50)}" fill="#A9BBB8"/>`;
    g += `<rect x="${x95}" y="${y(p.p95)}" width="${barW}" height="${top + plotH - y(p.p95)}" fill="#087B75"/>`;
    g += `<line x1="${xm}" x2="${xm}" y1="${y(p.lo)}" y2="${y(p.hi)}" stroke="#18323A" stroke-width="1.5"/>`;
    g += `<line x1="${xm - 5}" x2="${xm + 5}" y1="${y(p.lo)}" y2="${y(p.lo)}" stroke="#18323A" stroke-width="1.5"/>`;
    g += `<line x1="${xm - 5}" x2="${xm + 5}" y1="${y(p.hi)}" y2="${y(p.hi)}" stroke="#18323A" stroke-width="1.5"/>`;
    g += `<text x="${xm}" y="${y(p.hi) - 6}" font-size="12" text-anchor="middle" fill="#18323A">${p.p95.toFixed(1)}</text>`;
    g += `<text x="${cx}" y="${top + plotH + 20}" font-size="13" text-anchor="middle" fill="#18323A">${p.label}</text>`;
  });
  g += "</g>";
  return g;
}

const left = pointsFor(1);
const right = pointsFor(25);
const W = 1160, H = 500;
const legend = `<g transform="translate(60,62)">
  <rect x="0" y="-11" width="12" height="12" fill="#A9BBB8"/><text x="18" y="0" font-size="12" fill="#33494F">p50</text>
  <rect x="60" y="-11" width="12" height="12" fill="#087B75"/><text x="78" y="0" font-size="12" fill="#33494F">p95, whisker = 95% bootstrap interval</text>
</g>`;
const footer = `<text x="60" y="${H - 14}" font-size="12" fill="#33494F">Local live app, ${input.datasetSize} published events, ${input.mode} mode, 200 requests per route per panel. Routes that returned any status other than 200 are left out (updates returned 503).</text>`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Arial, Helvetica, sans-serif">
  <rect width="${W}" height="${H}" fill="#FFFFFF"/>
  <text x="60" y="32" font-size="20" font-weight="700" fill="#18323A">HTTP read latency of the public routes</text>
  ${legend}
  ${panel(40, "1 client", left)}
  ${panel(600, "25 clients", right)}
  ${footer}
</svg>`;

async function render(): Promise<void> {
  const out = fileURLToPath(new URL("../../docs/testing/figures/perf-http-latency.png", import.meta.url));
  mkdirSync(dirname(out), { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
    await page.setContent(`<!doctype html><html><body style="margin:0;background:#fff">${svg}</body></html>`);
    await page.locator("svg").screenshot({ path: out });
  } finally {
    await browser.close();
  }
  console.log(`wrote ${out} (left ${left.length} routes, right ${right.length} routes)`);
}

render().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
