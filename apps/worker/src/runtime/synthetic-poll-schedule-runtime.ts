import {
  SqlAcquisitionJobRepository,
} from "../../../db/src/queue.js";
import {
  SqlSourcePollScheduler,
  type SourcePollScheduleSummary,
} from "../../../db/src/source-poll-scheduler.js";
import { withPostgresSqlExecutor } from "../../../db/src/postgres-sql-executor.js";
import type { SqlExecutor } from "../../../db/src/sql.js";
import { isValidHyperdriveConnectionString } from "./public-event-list-runtime.js";

const syntheticDatasetKind = "synthetic" as const;
const triggerKind = "scheduled_synthetic_source_poll";
const maxScheduledCandidateCount = 100;

export interface SyntheticPollScheduleRuntimeConfiguration {
  readonly datasetMode?: string;
  readonly schedulerEnabled?: string;
  readonly l1ConnectionString?: string;
}

export type SyntheticPollScheduleSqlExecutorRunner = <Result>(
  connectionString: string,
  operation: (executor: SqlExecutor) => Promise<Result>,
) => Promise<Result>;

export interface SyntheticPollScheduleRuntimeDependencies {
  /** Test seam; production uses one request-scoped PostgreSQL client. */
  readonly withSqlExecutor?: SyntheticPollScheduleSqlExecutorRunner;
}

export interface SyntheticPollScheduleRuntime {
  schedule(scheduledTime: number): Promise<SourcePollScheduleSummary>;
}

export type SyntheticPollScheduleRuntimeErrorCode =
  | "INVALID_SCHEDULED_TIME"
  | "SCHEDULE_FAILED";

/** Fixed messages keep driver, connection, and source details out of failures. */
export class SyntheticPollScheduleRuntimeError extends Error {
  constructor(readonly code: SyntheticPollScheduleRuntimeErrorCode) {
    super(code === "INVALID_SCHEDULED_TIME"
      ? "The scheduled poll timestamp is invalid."
      : "The synthetic scheduled poll could not be completed.");
    this.name = "SyntheticPollScheduleRuntimeError";
  }
}

/**
 * Builds the opt-in demo scheduler. No SQL client is created until schedule()
 * receives a valid platform timestamp.
 */
export function createSyntheticPollScheduleRuntime(
  configuration: SyntheticPollScheduleRuntimeConfiguration,
  dependencies: SyntheticPollScheduleRuntimeDependencies = {},
): SyntheticPollScheduleRuntime | undefined {
  if (configuration.datasetMode !== "demo"
    || configuration.schedulerEnabled !== "true"
    || !isValidHyperdriveConnectionString(configuration.l1ConnectionString)) {
    return undefined;
  }

  const connectionString = configuration.l1ConnectionString;
  const withSqlExecutor = dependencies.withSqlExecutor ?? withPostgresSqlExecutor;
  return {
    async schedule(scheduledTime) {
      const now = formatScheduledInstant(scheduledTime);
      try {
        return await withSqlExecutor(connectionString, async (executor) => {
          try {
            await executor.execute("BEGIN");
            await executor.execute("SET LOCAL ROLE waspada_l1_pipeline");

            const namespace = await executor.query<{ dataset_kind: string }>(
              "SELECT dataset_kind FROM waspada.dataset_namespace_config",
            );
            if (!Array.isArray(namespace.rows)
              || namespace.rows.length !== 1
              || namespace.rows[0]?.dataset_kind !== syntheticDatasetKind) {
              throw new Error("namespace check failed");
            }

            const traceId = globalThis.crypto.randomUUID();
            const initialMetadata = JSON.stringify({ trigger_kind: triggerKind });
            const createdTrace = await executor.query<{ trace_id: string }>(
              [
                "INSERT INTO waspada.traces",
                "  (trace_id, dataset_kind, started_at, outcome, metadata)",
                "VALUES ($1, 'synthetic', $2, 'open', $3::jsonb)",
                "RETURNING trace_id",
              ].join("\n"),
              [traceId, now, initialMetadata],
            );
            if (createdTrace.rows.length !== 1 || createdTrace.rows[0]?.trace_id !== traceId) {
              throw new Error("trace creation failed");
            }

            const acquisitionJobs = new SqlAcquisitionJobRepository(executor);
            const scheduler = new SqlSourcePollScheduler(executor, acquisitionJobs);
            const summary = validateScheduleSummary(await scheduler.scheduleDueSourcePolls({
              datasetKind: syntheticDatasetKind,
              traceId,
              now,
            }));
            const finalMetadata = JSON.stringify({
              trigger_kind: triggerKind,
              candidate_count: summary.candidateCount,
              enqueued_count: summary.enqueuedCount,
              existing_count: summary.existingCount,
              not_schedulable_count: summary.notSchedulableCount,
            });
            const completedTrace = await executor.query<{ trace_id: string }>(
              [
                "UPDATE waspada.traces",
                "SET ended_at = $2, outcome = 'succeeded', metadata = $3::jsonb",
                "WHERE trace_id = $1",
                "  AND dataset_kind = 'synthetic'",
                "  AND outcome = 'open'",
                "  AND ended_at IS NULL",
                "RETURNING trace_id",
              ].join("\n"),
              [traceId, now, finalMetadata],
            );
            if (completedTrace.rows.length !== 1 || completedTrace.rows[0]?.trace_id !== traceId) {
              throw new Error("trace completion failed");
            }

            await executor.execute("COMMIT");
            return summary;
          } catch {
            try {
              await executor.execute("ROLLBACK");
            } catch {
              // Keep rollback diagnostics out of the runtime error.
            }
            throw new SyntheticPollScheduleRuntimeError("SCHEDULE_FAILED");
          }
        });
      } catch (error) {
        if (error instanceof SyntheticPollScheduleRuntimeError) throw error;
        throw new SyntheticPollScheduleRuntimeError("SCHEDULE_FAILED");
      }
    },
  };
}

function formatScheduledInstant(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)
    || !Number.isSafeInteger(value) || value < 0) {
    throw new SyntheticPollScheduleRuntimeError("INVALID_SCHEDULED_TIME");
  }

  try {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() > 9999) {
      throw new Error("invalid platform timestamp");
    }
    const instant = date.toISOString();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(instant)) {
      throw new Error("invalid platform timestamp");
    }
    return instant;
  } catch {
    throw new SyntheticPollScheduleRuntimeError("INVALID_SCHEDULED_TIME");
  }
}

function validateScheduleSummary(value: unknown): SourcePollScheduleSummary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("schedule summary is invalid");
  }
  const summary = value as Record<string, unknown>;
  const expectedKeys = [
    "candidateCount",
    "enqueuedCount",
    "existingCount",
    "notSchedulableCount",
  ].sort();
  const actualKeys = Object.keys(summary).sort();
  if (actualKeys.length !== expectedKeys.length
    || !actualKeys.every((key, index) => key === expectedKeys[index])) {
    throw new Error("schedule summary is invalid");
  }

  const candidateCount = summary.candidateCount;
  const enqueuedCount = summary.enqueuedCount;
  const existingCount = summary.existingCount;
  const notSchedulableCount = summary.notSchedulableCount;
  if (!isBoundedCount(candidateCount, maxScheduledCandidateCount)
    || !isBoundedCount(enqueuedCount, candidateCount)
    || !isBoundedCount(existingCount, candidateCount)
    || !isBoundedCount(notSchedulableCount, candidateCount)
    || enqueuedCount + existingCount + notSchedulableCount !== candidateCount) {
    throw new Error("schedule summary is invalid");
  }

  return { candidateCount, enqueuedCount, existingCount, notSchedulableCount };
}

function isBoundedCount(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value)
    && value >= 0 && value <= maximum;
}
