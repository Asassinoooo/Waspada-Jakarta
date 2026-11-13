// HTTP public read performance (NFR-04). Read-only GET requests against a running Worker or dev proxy.
// Run: npx tsx tools/perf/http-reads.ts [baseUrl]   (default http://127.0.0.1:8787)
// Writes docs/testing/PERFORMANCE.md and .codex-build/perf/http-reads.json. Routes that do not return 200
// are reported with their status, not counted as successful reads.
import { mkdirSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { summarize, type LatencySummary } from "./stats.js";

const BASE = process.argv[2] ?? "http://127.0.0.1:8787";
const WARMUP = 20;
const SAMPLES = 200;
const CONCURRENCY = [1, 10, 25] as const;

interface Sample {
  readonly ms: number;
  readonly status: number;
}

interface Row {
  readonly route: string;
  readonly concurrency: number;
  readonly statuses: Record<string, number>;
  readonly throughput_rps: number;
  readonly summary: LatencySummary;
}

async function get(path: string): Promise<Sample & { body: unknown }> {
  const t0 = performance.now();
  const response = await fetch(`${BASE}${path}`, { headers: { accept: "application/json" } });
  const text = await response.text();
  const ms = performance.now() - t0;
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { ms, status: response.status, body };
}

async function runLoad(path: string, total: number, concurrency: number): Promise<{ samples: Sample[]; wallMs: number }> {
  const samples: Sample[] = [];
  let issued = 0;
  const wall0 = performance.now();
  const lane = async (): Promise<void> => {
    while (issued < total) {
      issued += 1;
      const { ms, status } = await get(path);
      samples.push({ ms, status });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, lane));
  return { samples, wallMs: performance.now() - wall0 };
}

function listItems(body: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(body)) return body as Record<string, unknown>[];
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    for (const key of ["data", "events", "items"]) {
      if (Array.isArray(record[key])) return record[key] as Record<string, unknown>[];
    }
  }
  return [];
}

function fmt(x: number): string {
  return Number.isFinite(x) ? x.toFixed(2) : "n/a";
}

async function main(): Promise<void> {
  const context = await get("/api/v1/context");
  const contextBody = (context.body ?? {}) as Record<string, unknown>;
  const mode = typeof contextBody.dataset_mode === "string" ? contextBody.dataset_mode : "unknown";
  const list = await get("/api/v1/events");
  const items = listItems(list.body);
  const datasetSize = items.length;
  const firstId = typeof items[0]?.event_id === "string" ? (items[0].event_id as string) : null;
  if (!firstId) throw new Error(`No published event found at ${BASE}; cannot run the detail and history routes.`);

  const routes = [
    "/api/v1/context",
    "/api/v1/events",
    `/api/v1/events/${encodeURIComponent(firstId)}`,
    `/api/v1/events/${encodeURIComponent(firstId)}/history`,
    "/api/v1/events.geojson",
    "/api/v1/updates",
  ];

  const rows: Row[] = [];
  for (const route of routes) {
    for (let i = 0; i < WARMUP; i++) await get(route);
    for (const concurrency of CONCURRENCY) {
      const { samples, wallMs } = await runLoad(route, SAMPLES, concurrency);
      const statuses: Record<string, number> = {};
      for (const s of samples) statuses[String(s.status)] = (statuses[String(s.status)] ?? 0) + 1;
      const row: Row = {
        route,
        concurrency,
        statuses,
        throughput_rps: samples.length / (wallMs / 1000),
        summary: summarize(samples.map((s) => s.ms)),
      };
      rows.push(row);
      console.log(`${route} c=${concurrency} p50=${fmt(row.summary.p50)} p95=${fmt(row.summary.p95)} ms rps=${fmt(row.throughput_rps)} status=${JSON.stringify(statuses)}`);
    }
  }

  const outDir = fileURLToPath(new URL("../../.codex-build/perf/", import.meta.url));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}http-reads.json`, JSON.stringify({ base: BASE, mode, datasetSize, node: process.version, rows }, null, 2));

  const lines = [
    "# Performance results",
    "",
    "Status: first HTTP run, 13 November 2026. This is a baseline. No target has been set (SDP section 4).",
    "",
    "## Method",
    "",
    `- Target: \`${BASE}\`, dataset_mode \`${mode}\`, ${datasetSize} published event(s) in the list at run time. The dataset is small, so these results do not show how latency grows with more events.`,
    "- Calls: read-only GET requests over HTTP. Each sample includes reading the full response body.",
    `- Samples: ${WARMUP} warm-up requests per route, then ${SAMPLES} measured requests per route at concurrency ${CONCURRENCY.join(", ")}.`,
    "- Statistics: nearest-rank percentiles, as in `tools/evaluation/model-benchmark.ts`. The 95% interval for p95 is a seeded bootstrap with 10,000 resamples (`tools/perf/stats.ts`). Throughput is requests divided by wall time.",
    `- Client: Node ${process.version}, on the WSL host, same machine as the server.`,
    "",
    "## Results (milliseconds)",
    "",
    "| Route | Concurrency | n | Status | Mean | SD | p50 | p95 | p95 95% CI | p99 | Max | Requests/s |",
    "| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |",
    ...rows.map((r) => {
      const s = r.summary;
      const status = Object.entries(r.statuses).map(([code, count]) => `${code} x${count}`).join(", ");
      const route = r.route.replace(/\/api\/v1\/events\/[^/]+/, "/api/v1/events/{id}");
      return `| \`${route}\` | ${r.concurrency} | ${s.n} | ${status} | ${fmt(s.mean)} | ${fmt(s.sd)} | ${fmt(s.p50)} | ${fmt(s.p95)} | ${fmt(s.p95_ci95[0])} to ${fmt(s.p95_ci95[1])} | ${fmt(s.p99)} | ${fmt(s.max)} | ${fmt(r.throughput_rps)} |`;
    }),
    "",
    "## Not in this run",
    "",
    "- The web first load on desktop and phone (ST-P-03).",
    "- Cold start (first request after a restart), and reads while polling and inference run (ST-P-04).",
    "- Datasets of 50, 500 and 5,000 events. The live server holds only the events it has published, so a larger dataset needs more data loaded into it.",
    "- Any route that does not return 200 is reported with its status in the table, and is not a successful read.",
    "",
  ];
  writeFileSync(fileURLToPath(new URL("../../docs/testing/PERFORMANCE.md", import.meta.url)), lines.join("\n"));
  console.log(`wrote docs/testing/PERFORMANCE.md (${rows.length} rows, dataset ${datasetSize}, mode ${mode})`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
