import { createFreshnessDueTargetReader } from "../../../db/src/freshness-due-target-reader.js";
import { createSqlFreshnessTransitionLedger } from "../../../db/src/freshness-transition-ledger.js";
import { withPostgresTransactionalSqlExecutor } from "../../../db/src/postgres-sql-executor.js";
import type { TransactionalSqlExecutor } from "../../../db/src/sql.js";
import {
  createFreshnessDueEvaluator,
  type FreshnessDueEvaluator,
  type FreshnessDueEvaluatorCounts,
  type FreshnessDueEvaluatorResult,
} from "../layers/l4-application-integration/freshness-due-evaluator.js";
import { createFreshnessTransitionRecorder } from "../layers/l4-application-integration/freshness-transition-recorder.js";
import { isValidHyperdriveConnectionString } from "./public-event-list-runtime.js";

const maxPageSize = 100;
const countKeys = ["written", "replayed", "noChange", "conflicts", "failures"] as const;
const traceRole = "waspada_l4_freshness_writer";

export interface FreshnessDueScheduleRuntimeConfiguration {
  readonly datasetMode?: string;
  readonly schedulerEnabled?: string;
  readonly freshnessWriterConnectionString?: string;
}

export type FreshnessDueScheduleTransactionalSqlExecutorRunner = <Result>(
  connectionString: string,
  operation: (executor: TransactionalSqlExecutor) => Promise<Result>,
) => Promise<Result>;

export type FreshnessDueScheduleEvaluatorFactory = (
  executor: TransactionalSqlExecutor,
) => FreshnessDueEvaluator;

export interface FreshnessDueScheduleRuntimeDependencies {
  /** Test seams; production uses one request-scoped PostgreSQL client and the accepted composition. */
  readonly withTransactionalSqlExecutor?: FreshnessDueScheduleTransactionalSqlExecutorRunner;
  readonly createEvaluator?: FreshnessDueScheduleEvaluatorFactory;
  readonly clock?: () => number;
}

export interface FreshnessDueScheduleRuntime {
  schedule(scheduledTime: number): Promise<void>;
}

export type FreshnessDueScheduleRuntimeErrorCode = "INVALID_SCHEDULED_TIME" | "SCHEDULE_FAILED";

export class FreshnessDueScheduleRuntimeError extends Error {
  constructor(readonly code: FreshnessDueScheduleRuntimeErrorCode) {
    super(code === "INVALID_SCHEDULED_TIME"
      ? "The scheduled freshness timestamp is invalid."
      : "The scheduled freshness evaluation could not be completed.");
    this.name = "FreshnessDueScheduleRuntimeError";
  }
}

/** Builds the live-only freshness scheduler without opening a client during configuration. */
export function createFreshnessDueScheduleRuntime(
  configuration: FreshnessDueScheduleRuntimeConfiguration,
  dependencies: FreshnessDueScheduleRuntimeDependencies = {},
): FreshnessDueScheduleRuntime | undefined {
  if (configuration.datasetMode !== "live"
    || configuration.schedulerEnabled !== "true"
    || !isValidHyperdriveConnectionString(configuration.freshnessWriterConnectionString)) {
    return undefined;
  }

  const connectionString = configuration.freshnessWriterConnectionString;
  const withTransactionalSqlExecutor = dependencies.withTransactionalSqlExecutor
    ?? withPostgresTransactionalSqlExecutor;
  const evaluatorFactory = dependencies.createEvaluator ?? createSqlEvaluator;
  const clock = dependencies.clock ?? Date.now;

  return {
    async schedule(scheduledTime): Promise<void> {
      const scheduledInstant = formatScheduledInstant(scheduledTime);
      const runId = "freshness-due:" + scheduledTime;

      try {
        await withTransactionalSqlExecutor(connectionString, (executor) =>
          withFreshnessWriterRole(executor, async () => {
            const beginStatus = await beginRun(executor, runId, scheduledInstant);
            if (beginStatus === "succeeded" || beginStatus === "failed") return;
            if (beginStatus !== "open") throw new Error("unexpected freshness run status");

            let outcome: "succeeded" | "failed" = "failed";
            let counts = failedCounts();
            try {
              const evaluator = evaluatorFactory(executor);
              const evaluation = await evaluator.evaluate({
                datasetKind: "live",
                now: scheduledInstant,
                limit: maxPageSize,
                cursor: null,
                traceId: runId,
                evaluationRunId: runId,
              });
              const validated = validateEvaluationResult(evaluation);
              counts = validated.counts;
              outcome = validated.outcome;
            } catch {
              // A fixed count summary lets an opened run be closed without exposing diagnostics.
              counts = failedCounts();
              outcome = "failed";
            }

            const finishedAt = formatFinishedInstant(scheduledTime, scheduledInstant, clock());
            await finalizeRun(executor, runId, scheduledInstant, finishedAt, outcome, counts);
          }));
      } catch {
        throw new FreshnessDueScheduleRuntimeError("SCHEDULE_FAILED");
      }
    },
  };
}

function createSqlEvaluator(executor: TransactionalSqlExecutor): FreshnessDueEvaluator {
  const reader = createFreshnessDueTargetReader(executor);
  const ledger = createSqlFreshnessTransitionLedger(executor);
  const recorder = createFreshnessTransitionRecorder(ledger);
  return createFreshnessDueEvaluator({ reader, recorder });
}

async function withFreshnessWriterRole<Result>(
  executor: TransactionalSqlExecutor,
  operation: () => Promise<Result>,
): Promise<Result> {
  let primaryFailure: { readonly error: unknown } | undefined;
  let result: Result | undefined;
  let completed = false;

  try {
    await executor.execute("SET ROLE " + traceRole);
    result = await operation();
    completed = true;
  } catch (error) {
    primaryFailure = { error };
  } finally {
    try {
      await executor.execute("RESET ROLE");
    } catch (error) {
      if (primaryFailure === undefined) primaryFailure = { error };
    }
  }

  if (primaryFailure !== undefined) throw primaryFailure.error;
  if (!completed) throw new Error("freshness role operation did not complete");
  return result as Result;
}

async function beginRun(
  executor: TransactionalSqlExecutor,
  runId: string,
  startedAt: string,
): Promise<string> {
  const result = await executor.query<{ readonly run_status: unknown }>(
    "SELECT waspada.begin_freshness_due_evaluation_run($1, $2::timestamptz) AS run_status",
    [runId, startedAt],
  );
  if (result.rows.length !== 1) throw new Error("freshness run could not be started");
  const status = result.rows[0]?.run_status;
  if (status !== "open" && status !== "succeeded" && status !== "failed") {
    throw new Error("freshness run status is invalid");
  }
  return status;
}

async function finalizeRun(
  executor: TransactionalSqlExecutor,
  runId: string,
  startedAt: string,
  finishedAt: string,
  outcome: "succeeded" | "failed",
  counts: FreshnessDueEvaluatorCounts,
): Promise<void> {
  const result = await executor.query<{ readonly run_status: unknown }>(
    "SELECT waspada.finalize_freshness_due_evaluation_run($1, $2::timestamptz, $3::timestamptz, $4, $5::jsonb) AS run_status",
    [runId, startedAt, finishedAt, outcome, JSON.stringify(counts)],
  );
  if (result.rows.length !== 1 || result.rows[0]?.run_status !== outcome) {
    throw new Error("freshness run could not be finalized");
  }
}

function validateEvaluationResult(value: FreshnessDueEvaluatorResult): {
  readonly outcome: "succeeded" | "failed";
  readonly counts: FreshnessDueEvaluatorCounts;
} {
  if (value.outcome === "completed") {
    if (!hasExactKeys(value, ["outcome", "counts", "nextCursor"])) throw new Error();
    return { outcome: "succeeded", counts: validateCounts(value.counts) };
  }
  if (value.outcome === "retry") {
    if (!hasExactKeys(value, ["outcome", "counts", "resumeCursor"])) throw new Error();
    return { outcome: "failed", counts: validateCounts(value.counts) };
  }
  throw new Error();
}

function validateCounts(value: unknown): FreshnessDueEvaluatorCounts {
  if (!isObject(value) || !hasExactKeys(value, countKeys)) throw new Error();
  const counts = {} as Record<(typeof countKeys)[number], number>;
  let total = 0;
  for (const key of countKeys) {
    const count = value[key];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || count > maxPageSize) {
      throw new Error();
    }
    counts[key] = count;
    total += count;
  }
  if (total > maxPageSize) throw new Error();
  return counts;
}

function failedCounts(): FreshnessDueEvaluatorCounts {
  return { written: 0, replayed: 0, noChange: 0, conflicts: 0, failures: 1 };
}

function formatScheduledInstant(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)
    || !Number.isSafeInteger(value) || value < 0) {
    throw new FreshnessDueScheduleRuntimeError("INVALID_SCHEDULED_TIME");
  }

  try {
    const instant = new Date(value).toISOString();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(instant)) {
      throw new Error();
    }
    return instant;
  } catch {
    throw new FreshnessDueScheduleRuntimeError("INVALID_SCHEDULED_TIME");
  }
}

function formatFinishedInstant(scheduledTime: number, scheduledInstant: string, clockValue: number): string {
  if (!Number.isSafeInteger(clockValue) || clockValue < 0) return scheduledInstant;
  const candidate = Math.max(scheduledTime, clockValue);
  try {
    return formatScheduledInstant(candidate);
  } catch {
    return scheduledInstant;
  }
}

function hasExactKeys(value: object, expectedKeys: readonly string[]): boolean {
  const expected = new Set(expectedKeys);
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
