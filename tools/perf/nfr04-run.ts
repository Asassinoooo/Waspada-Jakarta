/**
 * NFR-04 hosted timing run (PERF-03 retest of F-50). Same structure as run 3 (20 Nov 2026):
 *   [B] warm sequential: 30 requests per route, 250 ms apart
 *   [C] 5 concurrent clients x 20 requests per route
 * Public GET/POST reads only; no account, no write. Usage:
 *   npx tsx tools/perf/nfr04-run.ts https://waspada-jakarta.waspada-worker.workers.dev "run 4 label"
 * Prints a plain-text table to stdout (save it as evidence).
 */
const BASE = process.argv[2] ?? "http://127.0.0.1:8787";
const LABEL = process.argv[3] ?? "NFR-04 run";

interface Route {
  readonly name: string;
  readonly path: string;
  readonly init?: RequestInit;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

async function timed(route: Route): Promise<{ ms: number; status: number; cache: string }> {
  const start = performance.now();
  try {
    const response = await fetch(`${BASE}${route.path}`, {
      ...route.init,
      headers: { accept: "application/json", ...(route.init?.headers ?? {}) },
    });
    await response.arrayBuffer();
    return { ms: Math.round(performance.now() - start), status: response.status, cache: response.headers.get("cache-control") ?? "" };
  } catch {
    return { ms: Math.round(performance.now() - start), status: 0, cache: "" };
  }
}

function summary(route: Route, results: readonly { ms: number; status: number }[]): string {
  const ok = results.filter((r) => r.status === 200 || r.status === 304);
  const times = ok.map((r) => r.ms).sort((a, b) => a - b);
  const failed = results.filter((r) => r.status !== 200 && r.status !== 304).map((r) => r.status);
  const p50 = percentile(times, 50);
  const p95 = percentile(times, 95);
  const max = times.length ? times[times.length - 1]! : NaN;
  return [
    route.name, results.length, ok.length, p50, p95, max,
    p50 < 500 ? "yes" : "NO", p95 < 1000 ? "yes" : "NO",
    failed.length ? `failed statuses ${failed.join(",")}` : "",
  ].join(" | ").replace(/ \| $/u, "");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const list = await fetch(`${BASE}/api/v1/events?limit=1`, { headers: { accept: "application/json" } });
  const first = ((await list.json()) as { data: { event_id: string; category: string }[] }).data[0];
  if (!first) throw new Error("no published event to time");
  const briefing = JSON.stringify({
    interests: { places: ["Jakarta Timur"], services: [], institutions: [], audiences: [], categories: [first.category] },
  });
  const routes: Route[] = [
    { name: "page /", path: "/" },
    { name: "GET /api/v1/events", path: "/api/v1/events" },
    { name: "GET /api/v1/events/:id", path: `/api/v1/events/${encodeURIComponent(first.event_id)}` },
    { name: "GET /api/v1/events/:id/history", path: `/api/v1/events/${encodeURIComponent(first.event_id)}/history` },
    { name: "GET /api/v1/events.geojson", path: "/api/v1/events.geojson" },
    { name: "GET /api/v1/updates", path: "/api/v1/updates" },
    { name: "GET /api/v1/context", path: "/api/v1/context" },
    {
      name: "POST /api/v1/briefings",
      path: "/api/v1/briefings",
      init: { method: "POST", headers: { "content-type": "application/json" }, body: briefing },
    },
  ];

  console.log(`${LABEL}, started ${new Date().toISOString()}, target p50<500 ms and p95<1000 ms, base ${BASE}`);
  console.log("");
  console.log("[B] Warm sequential, 30 requests per route, 250 ms apart");
  console.log("route | n | ok | p50 ms | p95 ms | max ms | p50<500 | p95<1000");
  for (const route of routes) {
    await timed(route); // warm-up, not counted
    const results = [];
    for (let i = 0; i < 30; i++) {
      results.push(await timed(route));
      await sleep(250);
    }
    console.log(summary(route, results));
  }

  console.log("");
  console.log("[C] 5 concurrent clients x 20 requests per route");
  console.log("route | n | ok | p50 ms | p95 ms | max ms | p50<500 | p95<1000");
  for (const route of routes) {
    const clients = Array.from({ length: 5 }, async () => {
      const results = [];
      for (let i = 0; i < 20; i++) results.push(await timed(route));
      return results;
    });
    const results = (await Promise.all(clients)).flat();
    console.log(summary(route, results));
  }

  const sample = await timed(routes[1]!);
  console.log("");
  console.log(`GET /api/v1/events cache-control: ${sample.cache || "(none)"}`);
  console.log(`finished ${new Date().toISOString()}`);
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
