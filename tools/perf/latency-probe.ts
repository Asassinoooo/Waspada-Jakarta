// PERF-08: latency probe for the hosted public reads. It sends plain GET requests with no cookies, no credentials and no
// secrets, and prints one markdown table, so CI can append it to the job summary.
// Run: node --import tsx tools/perf/latency-probe.ts [--base <url>] [--rounds <1-20>]
// Defaults: the hosted Worker and 3 rounds. TTFB is the time to the response headers. Total is the time to the last body
// byte. Each request has a timeout. A failed request is a row with its error name, not a crash.
import { performance } from "node:perf_hooks";

const DEFAULT_BASE = "https://waspada-jakarta.waspada-worker.workers.dev";
const DEFAULT_ROUNDS = 3;
const MAX_ROUNDS = 20;
const REQUEST_TIMEOUT_MS = 20_000;
const ROUTES: readonly string[] = [
  "/",
  "/api/v1/context",
  "/api/v1/events?limit=100",
  "/api/v1/events",
  "/api/v1/events.geojson",
  "/api/v1/updates",
];
const USAGE = "usage: node --import tsx tools/perf/latency-probe.ts [--base <url>] [--rounds <1-20>]";

interface ProbeOptions {
  readonly base: string;
  readonly rounds: number;
}

interface ProbeRow {
  readonly route: string;
  readonly round: number;
  readonly status: string;
  readonly ttfbMs: number | null;
  readonly totalMs: number | null;
  readonly bytes: number | null;
  readonly snap: string;
}

class UsageError extends Error {}

function parseOptions(argv: readonly string[]): ProbeOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg : arg.slice(0, equals);
    if (name !== "--base" && name !== "--rounds") throw new UsageError(`unknown argument ${name}\n${USAGE}`);
    const value = equals === -1 ? argv[++index] : arg.slice(equals + 1);
    if (value === undefined || value === "") throw new UsageError(`${name} needs a value\n${USAGE}`);
    values.set(name, value);
  }

  const baseValue = values.get("--base") ?? DEFAULT_BASE;
  let base: URL;
  try {
    base = new URL(baseValue);
  } catch {
    throw new UsageError(`--base is not a URL\n${USAGE}`);
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") throw new UsageError(`--base must be http or https\n${USAGE}`);

  const roundsValue = values.get("--rounds") ?? String(DEFAULT_ROUNDS);
  const rounds = Number(roundsValue);
  if (!/^\d+$/u.test(roundsValue) || rounds < 1 || rounds > MAX_ROUNDS) {
    throw new UsageError(`--rounds must be a whole number from 1 to ${MAX_ROUNDS}\n${USAGE}`);
  }
  return { base: base.href.replace(/\/$/u, ""), rounds };
}

/** The `desc` of the snap metric, for example "kv". Anything else prints as "-". */
function snapDescription(serverTiming: string | null): string {
  return serverTiming?.match(/snap;desc="([a-z]+)"/u)?.[1] ?? "-";
}

function errorName(error: unknown): string {
  if (typeof error === "object" && error !== null && "name" in error && typeof error.name === "string") return error.name;
  return "error";
}

async function probeOnce(base: string, route: string, round: number): Promise<ProbeRow> {
  const started = performance.now();
  try {
    const response = await fetch(`${base}${route}`, {
      headers: { accept: "*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const ttfbMs = performance.now() - started;
    const body = await response.arrayBuffer();
    const totalMs = performance.now() - started;
    return {
      route,
      round,
      status: String(response.status),
      ttfbMs,
      totalMs,
      bytes: body.byteLength,
      snap: snapDescription(response.headers.get("server-timing")),
    };
  } catch (error) {
    return { route, round, status: errorName(error), ttfbMs: null, totalMs: null, bytes: null, snap: "-" };
  }
}

function formatMs(value: number | null): string {
  return value === null ? "-" : value.toFixed(1);
}

function renderTable(options: ProbeOptions, rows: readonly ProbeRow[]): string {
  return [
    "## Latency probe (PERF-08)",
    "",
    `Base \`${options.base}\`, ${options.rounds} round(s), run ${new Date().toISOString()}. Plain GET requests. TTFB is the time to the response headers, total is the time to the last body byte.`,
    "",
    "| Route | Round | Status | TTFB ms | Total ms | Bytes | Server-Timing snap |",
    "| --- | ---: | --- | ---: | ---: | ---: | --- |",
    ...rows.map((row) => `| \`${row.route}\` | ${row.round} | ${row.status} | ${formatMs(row.ttfbMs)} | ${formatMs(row.totalMs)} | ${row.bytes ?? "-"} | ${row.snap} |`),
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  let options: ProbeOptions;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof UsageError ? error.message : USAGE);
    process.exitCode = 2;
    return;
  }

  const rows: ProbeRow[] = [];
  for (let round = 1; round <= options.rounds; round += 1) {
    for (const route of ROUTES) rows.push(await probeOnce(options.base, route, round));
  }
  console.log(renderTable(options, rows));
  // Every request failed (the site is down or unreachable): report it as a failed run. A non-200 is still a result.
  if (rows.every((row) => row.ttfbMs === null)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(errorName(error));
  process.exitCode = 1;
});
