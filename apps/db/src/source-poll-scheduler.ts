import { createHash } from 'node:crypto';
import type { DatasetKind } from './ports.js';
import type { AcquisitionJobRepository } from './queue.js';
import type { SqlExecutor } from './sql.js';

export interface ScheduleDueSourcePollsInput {
  readonly datasetKind: DatasetKind;
  readonly traceId: string;
  /** The caller supplies the evaluation instant; the scheduler never reads a clock. */
  readonly now: string;
}

export interface SourcePollScheduleSummary {
  readonly candidateCount: number;
  readonly enqueuedCount: number;
  readonly existingCount: number;
  readonly notSchedulableCount: number;
}

export interface SourcePollScheduler {
  scheduleDueSourcePolls(input: ScheduleDueSourcePollsInput): Promise<SourcePollScheduleSummary>;
}

export interface SourcePollSlotKeyInput {
  readonly datasetKind: DatasetKind;
  readonly sourceId: string;
  readonly pollingIntervalSeconds: number;
  readonly now: string;
}

interface DueSourcePollRow {
  source_id: string;
  polling_interval_seconds: number;
}

const MAX_SOURCE_POLL_BATCH_SIZE = 100;
const RFC3339_WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/;

export class SqlSourcePollScheduler implements SourcePollScheduler {
  constructor(
    private readonly executor: SqlExecutor,
    private readonly acquisitionJobs: AcquisitionJobRepository,
  ) {}

  async scheduleDueSourcePolls(input: ScheduleDueSourcePollsInput): Promise<SourcePollScheduleSummary> {
    validateDatasetKind(input.datasetKind);
    validateOpaqueText(input.traceId, 'trace ID', 200);
    validateExplicitTimestamp(input.now, 'now');

    const trace = await this.executor.query<{ found: boolean }>(
      [
        "SELECT EXISTS (",
        "  SELECT 1 FROM waspada.traces",
        "  WHERE trace_id = $1 AND dataset_kind = $2",
        ") AS found",
      ].join("\n"),
      [input.traceId, input.datasetKind],
    );
    if (trace.rows[0]?.found !== true) {
      throw new Error('Source poll scheduling requires a persisted trace in the selected dataset');
    }

    const dueSources = await this.executor.query<DueSourcePollRow>(
      [
        "SELECT source.source_id, source.polling_interval_seconds",
        "FROM waspada.source_registry AS source",
        "WHERE source.registry_status = 'active'",
        "  AND source.approval_status = 'approved'",
        "  AND source.auto_acquisition_enabled",
        "  AND source.polling_interval_seconds IS NOT NULL",
        "  AND (",
        "    source.last_checked_at IS NULL",
        "    OR source.last_checked_at <= $1::timestamptz",
        "      - source.polling_interval_seconds * INTERVAL '1 second'",
        "  )",
        "  AND NOT EXISTS (",
        "    SELECT 1",
        "    FROM waspada.acquisition_jobs AS job",
        "    WHERE job.dataset_kind = $2",
        "      AND job.job_kind = 'source_poll'",
        "      AND job.source_id = source.source_id",
        "      AND job.status IN ('pending', 'leased', 'retry')",
        "  )",
        'ORDER BY source.source_id COLLATE "C" ASC',
        "LIMIT $3",
      ].join("\n"),
      [input.now, input.datasetKind, MAX_SOURCE_POLL_BATCH_SIZE],
    );

    let enqueuedCount = 0;
    let existingCount = 0;
    let notSchedulableCount = 0;
    for (const source of dueSources.rows) {
      const result = await this.acquisitionJobs.enqueueSourcePoll({
        datasetKind: input.datasetKind,
        idempotencyKey: createSourcePollIdempotencyKey({
          datasetKind: input.datasetKind,
          sourceId: source.source_id,
          pollingIntervalSeconds: source.polling_interval_seconds,
          now: input.now,
        }),
        traceId: input.traceId,
        sourceId: source.source_id,
        requestedAt: input.now,
      });
      if (result.outcome === 'enqueued') enqueuedCount += 1;
      else if (result.outcome === 'existing') existingCount += 1;
      else notSchedulableCount += 1;
    }

    return {
      candidateCount: dueSources.rows.length,
      enqueuedCount,
      existingCount,
      notSchedulableCount,
    };
  }
}

export function createSourcePollIdempotencyKey(input: SourcePollSlotKeyInput): string {
  validateDatasetKind(input.datasetKind);
  validateOpaqueText(input.sourceId, 'source ID', 200);
  validateIntervalSeconds(input.pollingIntervalSeconds);
  const nowMs = validateExplicitTimestamp(input.now, 'now');
  const intervalMs = input.pollingIntervalSeconds * 1_000;
  const slotStartMs = Math.floor(nowMs / intervalMs) * intervalMs;
  const slotStart = new Date(slotStartMs).toISOString();
  const identity = JSON.stringify([
    'source_poll',
    1,
    input.datasetKind,
    input.sourceId,
    input.pollingIntervalSeconds,
    slotStart,
  ]);
  const digest = createHash('sha256').update(identity, 'utf8').digest('hex');
  return 'source-poll:v1:' + digest;
}

function validateDatasetKind(value: string): asserts value is DatasetKind {
  if (value !== 'live' && value !== 'historical' && value !== 'synthetic') {
    throw new Error('datasetKind must be live, historical or synthetic');
  }
}

function validateOpaqueText(value: string, label: string, maxLength: number): void {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength
    || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(label + ' must be non-empty, bounded and contain no control characters');
  }
}

function validateExplicitTimestamp(value: string, label: string): number {
  if (typeof value !== 'string' || value.trim() !== value
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(label + ' must be an RFC 3339 timestamp with an explicit offset');
  }
  const match = RFC3339_WITH_OFFSET.exec(value);
  if (!match) {
    throw new Error(label + ' must be an RFC 3339 timestamp with an explicit offset');
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
  const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31, leapYear ? 29 : 28, 31, 30, 31, 30,
    31, 31, 30, 31, 30, 31,
  ][month - 1];
  if (daysInMonth === undefined || day < 1 || day > daysInMonth
    || hour > 23 || minute > 59 || second > 59
    || offsetHour > 23 || offsetMinute > 59) {
    throw new Error(label + ' must be a valid timestamp');
  }

  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(label + ' must be a valid timestamp');
  }
  return milliseconds;
}

function validateIntervalSeconds(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new Error('pollingIntervalSeconds must be a positive PostgreSQL integer');
  }
}
