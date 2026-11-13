// T8 / FR-13: local live freshness and expiry timer for serve:live. It runs the same audited
// due-target evaluator as the Worker's freshness schedule, because wrangler.toml has no cron trigger.
// Freshness is not lifecycle: a passed review_due_at becomes needs_update, and only the issuer's
// validity end becomes expired. A missed tick is never backfilled, and no missing update resolves anything.
import type { SqlExecutor, TransactionalSqlExecutor } from "../apps/db/src/sql.js";
import {
  createFreshnessDueScheduleRuntime,
  FreshnessDueScheduleRuntimeError,
  runFreshnessPassInOneTransaction,
  type FreshnessDueScheduleRuntime,
  type FreshnessDueScheduleRuntimeDependencies,
} from "../apps/worker/src/runtime/freshness-due-schedule-runtime.js";
import { PublicReadModel } from "../apps/worker/src/layers/l4-application-integration/public-read-model.js";
import type { FreshnessStatus } from "../apps/worker/src/contracts/public-api.js";
import {
  FRESHNESS_DUE_SCHEDULE_EVENT_NAME,
  type TelemetrySink,
} from "../apps/worker/src/layers/l5-evaluation-monitoring/telemetry.js";

export const LIVE_FRESHNESS_DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const MIN_INTERVAL_MS = 10 * 1000;
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LIVE_DATASET_KIND = "live";
const FRESHNESS_STATUSES: ReadonlySet<string> = new Set(["current", "needs_update", "expired"]);
// Accepted only by the Worker's Hyperdrive shape check. The runner below ignores the connection,
// so nothing ever connects to this host.
const LOCAL_PGLITE_TARGET = "postgresql://local-pglite-freshness:local-placeholder@local-pglite.invalid/waspada?sslmode=require";

export interface LiveFreshnessIntervalResolution {
  readonly intervalMs: number;
  readonly invalid: boolean;
}

/** Reads LIVE_FRESHNESS_INTERVAL_MS. An invalid value falls back to the default and is never echoed. */
export function resolveLiveFreshnessIntervalMs(raw: string | undefined): LiveFreshnessIntervalResolution {
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "") return { intervalMs: LIVE_FRESHNESS_DEFAULT_INTERVAL_MS, invalid: false };
  const value = /^\d+$/u.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < MIN_INTERVAL_MS || value > MAX_INTERVAL_MS) {
    return { intervalMs: LIVE_FRESHNESS_DEFAULT_INTERVAL_MS, invalid: true };
  }
  return { intervalMs: value, invalid: false };
}

/** Builds the Worker runtime for the live dataset. Dependencies are test seams only. */
export function createLiveFreshnessRuntime(
  executor: TransactionalSqlExecutor,
  telemetry: TelemetrySink,
  dependencies: Partial<FreshnessDueScheduleRuntimeDependencies> = {},
): FreshnessDueScheduleRuntime {
  const runtime = createFreshnessDueScheduleRuntime(
    { datasetMode: "live", schedulerEnabled: "true", freshnessWriterConnectionString: LOCAL_PGLITE_TARGET },
    {
      ...dependencies,
      withTransactionalSqlExecutor: dependencies.withTransactionalSqlExecutor
        ?? runFreshnessPassInOneTransaction(executor),
      telemetry,
    },
  );
  if (runtime === undefined) throw new Error("the live freshness runtime is not configured");
  return runtime;
}

function freshnessTelemetryLog(log: (line: string) => void): TelemetrySink {
  return {
    record(record) {
      if (record.eventName !== FRESHNESS_DUE_SCHEDULE_EVENT_NAME) return;
      const counts = "counts" in record ? record.counts : undefined;
      const summary = counts === undefined
        ? ""
        : ` written=${counts.written} replayed=${counts.replayed} noChange=${counts.noChange}`
          + ` conflicts=${counts.conflicts} failures=${counts.failures}`;
      log(`[Freshness] run ${record.outcome} (${record.durationMs} ms)${summary}`);
    },
  };
}

interface LatestClaimRow {
  readonly event_id: string;
  readonly event_version: number;
  readonly resulting_status: string;
  readonly evaluated_at: string;
}

/**
 * Projects the latest claim-set transition onto the in-memory public read model, so the live
 * server's public views match the ledger. Only exact published versions are touched. Live proposals
 * carry no impacts in this model, so the claim-set status is the event status. Returns how many
 * events changed.
 */
export async function refreshPublishedFreshness(
  executor: SqlExecutor,
  datasetKind: string = LIVE_DATASET_KIND,
): Promise<number> {
  const published = [...PublicReadModel.getPublishedEvents()];
  if (published.length === 0) return 0;
  const eventIds = [...new Set(published.map((event) => event.event_id))];
  const result = await executor.query<LatestClaimRow>(
    `SELECT DISTINCT ON (transition.event_id, transition.event_version)
            transition.event_id, transition.event_version,
            transition.resulting_status, transition.evaluated_at
     FROM waspada.freshness_transitions AS transition
     WHERE transition.dataset_kind = $1
       AND transition.target_kind = 'event_claim_set'
       AND transition.event_id = ANY($2::text[])
     ORDER BY transition.event_id, transition.event_version, transition.transition_sequence DESC`,
    [datasetKind, eventIds],
  );

  const latest = new Map<string, LatestClaimRow>();
  for (const row of result.rows) latest.set(`${row.event_id}\u0000${row.event_version}`, row);

  let changed = 0;
  for (const detail of published) {
    const row = latest.get(`${detail.event_id}\u0000${detail.version}`);
    if (row === undefined || !FRESHNESS_STATUSES.has(row.resulting_status)) continue;
    const status = row.resulting_status as FreshnessStatus;
    if (detail.freshness.status === status && detail.freshness.evaluated_at === row.evaluated_at) continue;
    PublicReadModel.publish({
      ...detail,
      freshness: { ...detail.freshness, status, evaluated_at: row.evaluated_at },
    });
    changed += 1;
  }
  return changed;
}

export interface LiveFreshnessTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export type LiveFreshnessTickOutcome = "completed" | "failed" | "skipped";

export interface LiveFreshnessDeps {
  /** Seams for the Worker runtime. Production leaves this empty. */
  readonly runtimeDependencies?: Partial<FreshnessDueScheduleRuntimeDependencies>;
  readonly refreshPublicView?: (executor: SqlExecutor) => Promise<number>;
  readonly now?: () => number;
  readonly timers?: LiveFreshnessTimers;
  readonly log?: (line: string) => void;
}

export interface LiveFreshnessSchedule {
  readonly intervalMs: number;
  /** Settles with the outcome of the run started at startup. */
  readonly startup: Promise<LiveFreshnessTickOutcome>;
  tick(): Promise<LiveFreshnessTickOutcome>;
  stop(): void;
}

function errorLabel(error: unknown): string {
  if (error instanceof FreshnessDueScheduleRuntimeError) return error.code;
  return error instanceof Error ? error.name : "unknown error";
}

/**
 * Composition for serve:live. It runs once at startup, then on LIVE_FRESHNESS_INTERVAL_MS. A tick
 * that arrives during a run is skipped. Errors are logged by code or error name, never by message.
 * After every pass the in-memory public read model is refreshed from the ledger.
 */
export function startLiveFreshness(options: {
  readonly executor: TransactionalSqlExecutor;
  readonly env: { readonly LIVE_FRESHNESS_INTERVAL_MS?: string };
  readonly deps?: LiveFreshnessDeps;
}): LiveFreshnessSchedule {
  const deps = options.deps ?? {};
  const log = deps.log ?? ((line: string) => console.log(line));
  const timers: LiveFreshnessTimers = deps.timers ?? {
    setInterval: (callback, ms) => setInterval(callback, ms),
    clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
  };
  const now = deps.now ?? Date.now;
  const refreshPublicView = deps.refreshPublicView ?? ((executor: SqlExecutor) => refreshPublishedFreshness(executor));

  const resolution = resolveLiveFreshnessIntervalMs(options.env.LIVE_FRESHNESS_INTERVAL_MS);
  if (resolution.invalid) {
    log(`[Freshness] LIVE_FRESHNESS_INTERVAL_MS must be an integer from ${MIN_INTERVAL_MS} to ${MAX_INTERVAL_MS} ms; using ${LIVE_FRESHNESS_DEFAULT_INTERVAL_MS} ms.`);
  }

  const runtime = createLiveFreshnessRuntime(
    options.executor,
    freshnessTelemetryLog(log),
    deps.runtimeDependencies ?? {},
  );

  let running = false;
  let stopped = false;

  async function tick(): Promise<LiveFreshnessTickOutcome> {
    if (stopped) return "skipped";
    if (running) {
      log("  [Freshness] Previous freshness run still running, skipping.");
      return "skipped";
    }
    running = true;
    let outcome: LiveFreshnessTickOutcome = "completed";
    try {
      await runtime.schedule(now());
    } catch (error) {
      outcome = "failed";
      log(`[Freshness] run error (${errorLabel(error)}).`);
    }
    try {
      const changed = await refreshPublicView(options.executor);
      if (changed > 0) log(`[Freshness] public read model refreshed for ${changed} event(s).`);
    } catch (error) {
      log(`[Freshness] public read refresh failed (${errorLabel(error)}).`);
    } finally {
      running = false;
    }
    return outcome;
  }

  const startup = tick();
  const interval = timers.setInterval(() => {
    void tick();
  }, resolution.intervalMs);

  return {
    intervalMs: resolution.intervalMs,
    startup,
    tick,
    stop(): void {
      stopped = true;
      timers.clearInterval(interval);
    },
  };
}
