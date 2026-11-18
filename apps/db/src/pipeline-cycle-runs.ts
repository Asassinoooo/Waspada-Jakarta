/**
 * HOSTED-30: the one row a hosted `--once` ingest run writes to `waspada.pipeline_cycle_runs` (migration 057).
 *
 * Counts, timings and an exit code only. No title, URL, prompt, model output or error text is accepted. Every count is
 * checked before any SQL is sent, so a bad value throws a RangeError whose message names the field, never the value.
 * The caller treats a throw as a best-effort failure: the ingest run goes on and logs a fixed code.
 */
import type { SqlExecutor } from "./sql.js";
import type { DatasetKind } from "./ports.js";

export const PIPELINE_CYCLE_RUN_RECORD_KEYS = ["new_items_cap", "new_items_used", "feeds_not_fetched", "poll_errors"] as const;
export type PipelineCycleRunRecordKey = (typeof PIPELINE_CYCLE_RUN_RECORD_KEYS)[number];

const INT4_MAX = 2_147_483_647;

export interface PipelineCycleRunInput {
  readonly datasetKind: DatasetKind;
  /** Opaque and unique within the dataset, for example `once-<uuid>`. Never derived from source text. */
  readonly runId: string;
  /** ISO instants. The finish must not be earlier than the start. */
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly elapsedMs: number;
  readonly feedsOk: number;
  readonly feedsFailed: number;
  readonly itemsNew: number;
  readonly aiCompleted: number;
  readonly aiNotCompleted: number;
  readonly published: number;
  readonly held: number;
  readonly exitCode: number;
  /** Optional numeric counts. Keys outside PIPELINE_CYCLE_RUN_RECORD_KEYS are dropped, never stored. */
  readonly record?: Partial<Record<PipelineCycleRunRecordKey, number | null>>;
}

function assertCount(field: string, value: number, max = INT4_MAX): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new RangeError(`pipeline cycle run: ${field} must be a whole number from 0 to ${max}`);
  }
}

function assertInstant(field: string, value: string): void {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new RangeError(`pipeline cycle run: ${field} must be an ISO instant`);
  }
}

/** Only the allowed keys, and only whole numbers, reach record_json. A null or missing key is left out. */
export function pipelineCycleRunRecordJson(record: PipelineCycleRunInput["record"]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of PIPELINE_CYCLE_RUN_RECORD_KEYS) {
    const value = record?.[key];
    if (value === null || value === undefined) continue;
    assertCount(`record.${key}`, value);
    out[key] = value;
  }
  return out;
}

/** Writes the run row. One INSERT, no read, no update. Validation runs first, so an invalid run never reaches SQL. */
export async function insertPipelineCycleRun(
  executor: Pick<SqlExecutor, "query">,
  input: PipelineCycleRunInput,
): Promise<void> {
  if (typeof input.runId !== "string" || input.runId.length < 1 || input.runId.length > 200) {
    throw new RangeError("pipeline cycle run: run_id must be 1 to 200 characters");
  }
  assertInstant("started_at", input.startedAt);
  assertInstant("finished_at", input.finishedAt);
  if (Date.parse(input.finishedAt) < Date.parse(input.startedAt)) {
    throw new RangeError("pipeline cycle run: finished_at must not be earlier than started_at");
  }
  assertCount("elapsed_ms", input.elapsedMs);
  assertCount("feeds_ok", input.feedsOk);
  assertCount("feeds_failed", input.feedsFailed);
  assertCount("items_new", input.itemsNew);
  assertCount("ai_completed", input.aiCompleted);
  assertCount("ai_not_completed", input.aiNotCompleted);
  assertCount("published", input.published);
  assertCount("held", input.held);
  assertCount("exit_code", input.exitCode, 255);
  const recordJson = pipelineCycleRunRecordJson(input.record);

  await executor.query(
    `INSERT INTO waspada.pipeline_cycle_runs (
       dataset_kind, run_id, started_at, finished_at, elapsed_ms, feeds_ok, feeds_failed, items_new,
       ai_completed, ai_not_completed, published, held, exit_code, record_json)
     VALUES ($1, $2, $3::timestamptz, $4::timestamptz, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)`,
    [
      input.datasetKind,
      input.runId,
      new Date(input.startedAt).toISOString(),
      new Date(input.finishedAt).toISOString(),
      input.elapsedMs,
      input.feedsOk,
      input.feedsFailed,
      input.itemsNew,
      input.aiCompleted,
      input.aiNotCompleted,
      input.published,
      input.held,
      input.exitCode,
      JSON.stringify(recordJson),
    ],
  );
}
