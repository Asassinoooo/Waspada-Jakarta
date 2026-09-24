import { randomUUID } from 'node:crypto';
import type { DatasetKind } from './ports.js';
import type { SqlExecutor } from './sql.js';

export type AcquisitionJobKind = 'source_poll' | 'moderator_submission';
export type AcquisitionJobStatus = 'pending' | 'leased' | 'retry' | 'completed' | 'terminal';

export interface EnqueueSourcePollInput {
  readonly datasetKind: DatasetKind;
  /** The scheduler supplies one stable key per source and configured polling slot. */
  readonly idempotencyKey: string;
  readonly traceId: string;
  readonly sourceId: string;
  readonly requestedAt: string;
}

export interface EnqueueModeratorSubmissionInput {
  readonly datasetKind: DatasetKind;
  readonly idempotencyKey: string;
  readonly traceId: string;
  /** The caller must already have passed MOD-01 authorization. */
  readonly requestedBy: string;
  readonly submittedUrl: string;
  readonly requestedAt: string;
}

export interface AcquisitionJobRecord {
  readonly jobId: string;
  readonly datasetKind: DatasetKind;
  readonly idempotencyKey: string;
  readonly jobKind: AcquisitionJobKind;
  readonly traceId: string;
  readonly sourceId: string | null;
  readonly submittedUrl: string | null;
  readonly requestedBy: string | null;
  readonly status: AcquisitionJobStatus;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly availableAt: string;
  readonly leaseToken: string | null;
  readonly leaseStartedAt: string | null;
  readonly leaseExpiresAt: string | null;
  readonly lastFailureCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
}

export type EnqueueResult =
  | { readonly outcome: 'enqueued' | 'existing'; readonly job: AcquisitionJobRecord }
  | { readonly outcome: 'source_not_schedulable' };

export type LeaseTransitionResult =
  | { readonly outcome: 'updated'; readonly job: AcquisitionJobRecord }
  | { readonly outcome: 'not_owned' };

export interface FailJobInput {
  readonly failureCode: string;
  readonly disposition: 'retryable' | 'permanent';
  readonly now: string;
}

export interface AcquisitionJobRepository {
  enqueueSourcePoll(input: EnqueueSourcePollInput): Promise<EnqueueResult>;
  enqueueModeratorSubmission(input: EnqueueModeratorSubmissionInput): Promise<EnqueueResult>;
  findById(datasetKind: DatasetKind, jobId: string): Promise<AcquisitionJobRecord | null>;
  claimDueJob(now: string, leaseDurationMs?: number): Promise<AcquisitionJobRecord | null>;
  renewLease(
    datasetKind: DatasetKind,
    jobId: string,
    leaseToken: string,
    now: string,
    leaseDurationMs?: number,
  ): Promise<LeaseTransitionResult>;
  complete(
    datasetKind: DatasetKind,
    jobId: string,
    leaseToken: string,
    now: string,
  ): Promise<LeaseTransitionResult>;
  fail(
    datasetKind: DatasetKind,
    jobId: string,
    leaseToken: string,
    input: FailJobInput,
  ): Promise<LeaseTransitionResult>;
  recoverExpiredLeases(now: string, limit?: number): Promise<number>;
}

export const JOB_QUEUE_POLICY = Object.freeze({
  maxAttempts: 5,
  defaultLeaseDurationMs: 60_000,
  maxLeaseDurationMs: 5 * 60_000,
  minLeaseDurationMs: 1_000,
  baseRetryDelayMs: 30_000,
  maxRetryDelayMs: 2 * 60_000,
  maxRecoveryBatchSize: 500,
});

interface AcquisitionJobRow {
  job_id: string;
  dataset_kind: DatasetKind;
  idempotency_key: string;
  job_kind: AcquisitionJobKind;
  trace_id: string;
  source_id: string | null;
  submitted_url: string | null;
  requested_by: string | null;
  status: AcquisitionJobStatus;
  attempt_count: number;
  max_attempts: number;
  available_at: string;
  lease_token: string | null;
  lease_started_at: string | null;
  lease_expires_at: string | null;
  last_failure_code: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

const RETURNING_JOB_COLUMNS = `
  job_id, dataset_kind, idempotency_key, job_kind, trace_id, source_id,
  submitted_url, requested_by, status, attempt_count, max_attempts,
  available_at::text AS available_at, lease_token,
  lease_started_at::text AS lease_started_at,
  lease_expires_at::text AS lease_expires_at, last_failure_code,
  created_at::text AS created_at, updated_at::text AS updated_at,
  finished_at::text AS finished_at`;

function qualifiedReturningJobColumns(alias: string): string {
  return `
    ${alias}.job_id, ${alias}.dataset_kind, ${alias}.idempotency_key,
    ${alias}.job_kind, ${alias}.trace_id, ${alias}.source_id,
    ${alias}.submitted_url, ${alias}.requested_by, ${alias}.status,
    ${alias}.attempt_count, ${alias}.max_attempts,
    ${alias}.available_at::text AS available_at, ${alias}.lease_token,
    ${alias}.lease_started_at::text AS lease_started_at,
    ${alias}.lease_expires_at::text AS lease_expires_at, ${alias}.last_failure_code,
    ${alias}.created_at::text AS created_at, ${alias}.updated_at::text AS updated_at,
    ${alias}.finished_at::text AS finished_at`;
}

export class SqlAcquisitionJobRepository implements AcquisitionJobRepository {
  constructor(private readonly executor: SqlExecutor) {}

  async enqueueSourcePoll(input: EnqueueSourcePollInput): Promise<EnqueueResult> {
    validateDatasetKind(input.datasetKind);
    validateOpaqueText(input.idempotencyKey, 'idempotency key', 256);
    validateOpaqueText(input.traceId, 'trace ID', 200);
    validateOpaqueText(input.sourceId, 'source ID', 200);
    const requestedAt = normalizeTimestamp(input.requestedAt, 'requestedAt');

    const existing = await this.findByIdempotencyKey(input.datasetKind, input.idempotencyKey);
    if (existing) return existingSourcePollResult(existing, input.sourceId);

    const inserted = await this.executor.query<AcquisitionJobRow>(
      `INSERT INTO waspada.acquisition_jobs
         (job_id, dataset_kind, idempotency_key, job_kind, trace_id, source_id,
          status, attempt_count, max_attempts, available_at, created_at, updated_at)
       SELECT $1, $2, $3, 'source_poll', $4, source.source_id,
              'pending', 0, $6, $5, $5, $5
       FROM waspada.source_registry AS source
       WHERE source.source_id = $7
         AND source.registry_status = 'active'
         AND source.approval_status = 'approved'
         AND source.auto_acquisition_enabled
         AND source.polling_interval_seconds IS NOT NULL
       ON CONFLICT (dataset_kind, idempotency_key) DO NOTHING
       RETURNING ${RETURNING_JOB_COLUMNS}`,
      [randomUUID(), input.datasetKind, input.idempotencyKey, input.traceId,
        requestedAt, JOB_QUEUE_POLICY.maxAttempts, input.sourceId],
    );
    const insertedRow = inserted.rows[0];
    if (insertedRow) return { outcome: 'enqueued', job: mapAcquisitionJob(insertedRow) };

    // A concurrent enqueue can win after the first lookup. Resolve that race
    // through the same key and reject accidental reuse for another source.
    const raced = await this.findByIdempotencyKey(input.datasetKind, input.idempotencyKey);
    if (raced) return existingSourcePollResult(raced, input.sourceId);
    return { outcome: 'source_not_schedulable' };
  }

  async enqueueModeratorSubmission(input: EnqueueModeratorSubmissionInput): Promise<EnqueueResult> {
    validateDatasetKind(input.datasetKind);
    validateOpaqueText(input.idempotencyKey, 'idempotency key', 256);
    validateOpaqueText(input.traceId, 'trace ID', 200);
    const requestedBy = validateActorId(input.requestedBy);
    const submittedUrl = validateSubmittedUrl(input.submittedUrl);
    const requestedAt = normalizeTimestamp(input.requestedAt, 'requestedAt');

    const existing = await this.findByIdempotencyKey(input.datasetKind, input.idempotencyKey);
    if (existing) return existingModeratorSubmissionResult(existing, submittedUrl, requestedBy);

    const inserted = await this.executor.query<AcquisitionJobRow>(
      `INSERT INTO waspada.acquisition_jobs
         (job_id, dataset_kind, idempotency_key, job_kind, trace_id,
          submitted_url, requested_by, status, attempt_count, max_attempts,
          available_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'moderator_submission', $4, $5, $6,
               'pending', 0, $7, $8, $8, $8)
       ON CONFLICT (dataset_kind, idempotency_key) DO NOTHING
       RETURNING ${RETURNING_JOB_COLUMNS}`,
      [randomUUID(), input.datasetKind, input.idempotencyKey, input.traceId,
        submittedUrl, requestedBy, JOB_QUEUE_POLICY.maxAttempts, requestedAt],
    );
    const insertedRow = inserted.rows[0];
    if (insertedRow) return { outcome: 'enqueued', job: mapAcquisitionJob(insertedRow) };

    const raced = await this.findByIdempotencyKey(input.datasetKind, input.idempotencyKey);
    if (raced) return existingModeratorSubmissionResult(raced, submittedUrl, requestedBy);
    throw new Error('The moderator submission could not be enqueued');
  }

  async findById(datasetKind: DatasetKind, jobId: string): Promise<AcquisitionJobRecord | null> {
    validateDatasetKind(datasetKind);
    validateOpaqueText(jobId, 'job ID', 128);
    const result = await this.executor.query<AcquisitionJobRow>(
      `SELECT ${RETURNING_JOB_COLUMNS}
       FROM waspada.acquisition_jobs
       WHERE dataset_kind = $1 AND job_id = $2`,
      [datasetKind, jobId],
    );
    const row = result.rows[0];
    return row ? mapAcquisitionJob(row) : null;
  }

  async claimDueJob(
    nowInput: string,
    leaseDurationMs = JOB_QUEUE_POLICY.defaultLeaseDurationMs,
  ): Promise<AcquisitionJobRecord | null> {
    const now = normalizeTimestamp(nowInput, 'now');
    validateLeaseDuration(leaseDurationMs);
    const leaseExpiresAt = addMilliseconds(now, leaseDurationMs);
    const result = await this.executor.query<AcquisitionJobRow>(
      `WITH due_job AS (
         SELECT job.job_id
         FROM waspada.acquisition_jobs AS job
         LEFT JOIN waspada.source_registry AS source ON source.source_id = job.source_id
         WHERE job.status IN ('pending', 'retry')
           AND job.available_at <= $1::timestamptz
           AND (job.job_kind = 'moderator_submission' OR (
             source.registry_status = 'active'
             AND source.approval_status = 'approved'
             AND source.auto_acquisition_enabled
             AND source.polling_interval_seconds IS NOT NULL
           ))
         ORDER BY job.available_at, job.created_at, job.job_id
         FOR UPDATE OF job SKIP LOCKED
         LIMIT 1
       )
       UPDATE waspada.acquisition_jobs AS job
       SET status = 'leased', attempt_count = job.attempt_count + 1,
           lease_token = $2, lease_started_at = $1::timestamptz,
           lease_expires_at = $3::timestamptz, updated_at = $1::timestamptz
       FROM due_job
       WHERE job.job_id = due_job.job_id
       RETURNING ${qualifiedReturningJobColumns('job')}`,
      [now, randomUUID(), leaseExpiresAt],
    );
    const row = result.rows[0];
    return row ? mapAcquisitionJob(row) : null;
  }

  async renewLease(
    datasetKind: DatasetKind,
    jobId: string,
    leaseToken: string,
    nowInput: string,
    leaseDurationMs = JOB_QUEUE_POLICY.defaultLeaseDurationMs,
  ): Promise<LeaseTransitionResult> {
    validateDatasetKind(datasetKind);
    validateOpaqueText(jobId, 'job ID', 128);
    validateLeaseToken(leaseToken);
    const now = normalizeTimestamp(nowInput, 'now');
    validateLeaseDuration(leaseDurationMs);
    const leaseExpiresAt = addMilliseconds(now, leaseDurationMs);
    const result = await this.executor.query<AcquisitionJobRow>(
      `UPDATE waspada.acquisition_jobs
       SET lease_expires_at = GREATEST(lease_expires_at, $5::timestamptz),
           updated_at = $4::timestamptz
       WHERE dataset_kind = $1 AND job_id = $2 AND status = 'leased'
         AND lease_token = $3 AND lease_started_at <= $4::timestamptz
         AND lease_expires_at > $4::timestamptz
       RETURNING ${RETURNING_JOB_COLUMNS}`,
      [datasetKind, jobId, leaseToken, now, leaseExpiresAt],
    );
    return transitionResult(result.rows[0]);
  }

  async complete(
    datasetKind: DatasetKind,
    jobId: string,
    leaseToken: string,
    nowInput: string,
  ): Promise<LeaseTransitionResult> {
    validateDatasetKind(datasetKind);
    validateOpaqueText(jobId, 'job ID', 128);
    validateLeaseToken(leaseToken);
    const now = normalizeTimestamp(nowInput, 'now');
    const result = await this.executor.query<AcquisitionJobRow>(
      `WITH completed AS (
         UPDATE waspada.acquisition_jobs
         SET status = 'completed', lease_token = NULL, lease_started_at = NULL,
             lease_expires_at = NULL, updated_at = $4::timestamptz,
             finished_at = $4::timestamptz
         WHERE dataset_kind = $1 AND job_id = $2 AND status = 'leased'
           AND lease_token = $3 AND lease_started_at <= $4::timestamptz
           AND lease_expires_at > $4::timestamptz
         RETURNING *
       ), health_update AS (
         UPDATE waspada.source_registry AS source
         SET health_status = 'healthy', last_checked_at = $4::timestamptz,
             last_success_at = $4::timestamptz
         FROM completed
         WHERE completed.job_kind = 'source_poll'
           AND source.source_id = completed.source_id
           AND (source.last_checked_at IS NULL OR source.last_checked_at <= $4::timestamptz)
         RETURNING source.source_id
       )
       SELECT ${qualifiedReturningJobColumns('completed')}
       FROM completed
       LEFT JOIN health_update ON health_update.source_id = completed.source_id`,
      [datasetKind, jobId, leaseToken, now],
    );
    return transitionResult(result.rows[0]);
  }

  async fail(
    datasetKind: DatasetKind,
    jobId: string,
    leaseToken: string,
    input: FailJobInput,
  ): Promise<LeaseTransitionResult> {
    validateDatasetKind(datasetKind);
    validateOpaqueText(jobId, 'job ID', 128);
    validateLeaseToken(leaseToken);
    const now = normalizeTimestamp(input.now, 'now');
    const failureCode = validateFailureCode(input.failureCode);
    const result = await this.executor.query<AcquisitionJobRow>(
      `WITH failed AS (
         UPDATE waspada.acquisition_jobs
         SET status = CASE
               WHEN $5 = 'retryable' AND attempt_count < max_attempts THEN 'retry'
               ELSE 'terminal'
             END,
             available_at = CASE
               WHEN $5 = 'retryable' AND attempt_count < max_attempts
                 THEN $4::timestamptz + LEAST(
                   $6::numeric * power(2::numeric, GREATEST(attempt_count::integer - 1, 0)),
                   $7::numeric
                 ) * interval '1 millisecond'
               ELSE available_at
             END,
             last_failure_code = $8,
             lease_token = NULL, lease_started_at = NULL, lease_expires_at = NULL,
             updated_at = $4::timestamptz,
             finished_at = CASE
               WHEN $5 = 'retryable' AND attempt_count < max_attempts THEN NULL
               ELSE $4::timestamptz
             END
         WHERE dataset_kind = $1 AND job_id = $2 AND status = 'leased'
           AND lease_token = $3 AND lease_started_at <= $4::timestamptz
           AND lease_expires_at > $4::timestamptz
         RETURNING *
       ), health_update AS (
         UPDATE waspada.source_registry AS source
         SET health_status = CASE WHEN failed.status = 'terminal' THEN 'unavailable' ELSE 'degraded' END,
             last_checked_at = $4::timestamptz
         FROM failed
         WHERE failed.job_kind = 'source_poll'
           AND source.source_id = failed.source_id
           AND (source.last_checked_at IS NULL OR source.last_checked_at <= $4::timestamptz)
         RETURNING source.source_id
       )
       SELECT ${qualifiedReturningJobColumns('failed')}
       FROM failed
       LEFT JOIN health_update ON health_update.source_id = failed.source_id`,
      [datasetKind, jobId, leaseToken, now, input.disposition,
        JOB_QUEUE_POLICY.baseRetryDelayMs, JOB_QUEUE_POLICY.maxRetryDelayMs, failureCode],
    );
    return transitionResult(result.rows[0]);
  }

  async recoverExpiredLeases(nowInput: string, limit = JOB_QUEUE_POLICY.maxRecoveryBatchSize): Promise<number> {
    const now = normalizeTimestamp(nowInput, 'now');
    if (!Number.isInteger(limit) || limit < 1 || limit > JOB_QUEUE_POLICY.maxRecoveryBatchSize) {
      throw new Error(`Recovery limit must be between 1 and ${JOB_QUEUE_POLICY.maxRecoveryBatchSize}`);
    }
    const result = await this.executor.query<{ recovered_count: number }>(
      `WITH expired AS (
         SELECT job_id
         FROM waspada.acquisition_jobs
         WHERE status = 'leased' AND lease_expires_at <= $1::timestamptz
         ORDER BY lease_expires_at, created_at, job_id
         FOR UPDATE SKIP LOCKED
         LIMIT $2
       ), recovered AS (
         UPDATE waspada.acquisition_jobs AS job
         SET status = CASE WHEN job.attempt_count >= job.max_attempts THEN 'terminal' ELSE 'retry' END,
             available_at = CASE
               WHEN job.attempt_count >= job.max_attempts THEN job.available_at
               ELSE $1::timestamptz + LEAST(
                 $3::numeric * power(2::numeric, GREATEST(job.attempt_count::integer - 1, 0)),
                 $4::numeric
               ) * interval '1 millisecond'
             END,
             last_failure_code = 'lease_expired',
             lease_token = NULL, lease_started_at = NULL, lease_expires_at = NULL,
             updated_at = $1::timestamptz,
             finished_at = CASE WHEN job.attempt_count >= job.max_attempts THEN $1::timestamptz ELSE NULL END
         FROM expired
         WHERE job.job_id = expired.job_id
         RETURNING job.dataset_kind, job.source_id, job.job_kind, job.status
       ), health_rollup AS (
         SELECT source_id, bool_or(status = 'terminal') AS terminal
         FROM recovered
         WHERE job_kind = 'source_poll'
         GROUP BY source_id
       ), health_update AS (
         UPDATE waspada.source_registry AS source
         SET health_status = CASE WHEN health_rollup.terminal THEN 'unavailable' ELSE 'degraded' END,
             last_checked_at = $1::timestamptz
         FROM health_rollup
         WHERE source.source_id = health_rollup.source_id
           AND (source.last_checked_at IS NULL OR source.last_checked_at <= $1::timestamptz)
         RETURNING source.source_id
       )
       SELECT count(*)::integer AS recovered_count FROM recovered`,
      [now, limit, JOB_QUEUE_POLICY.baseRetryDelayMs, JOB_QUEUE_POLICY.maxRetryDelayMs],
    );
    return result.rows[0]?.recovered_count ?? 0;
  }

  private async findByIdempotencyKey(datasetKind: DatasetKind, idempotencyKey: string): Promise<AcquisitionJobRecord | null> {
    const result = await this.executor.query<AcquisitionJobRow>(
      `SELECT ${RETURNING_JOB_COLUMNS}
       FROM waspada.acquisition_jobs
       WHERE dataset_kind = $1 AND idempotency_key = $2`,
      [datasetKind, idempotencyKey],
    );
    const row = result.rows[0];
    return row ? mapAcquisitionJob(row) : null;
  }
}

function existingSourcePollResult(job: AcquisitionJobRecord, sourceId: string): EnqueueResult {
  if (job.jobKind !== 'source_poll' || job.sourceId !== sourceId) {
    throw new Error('Idempotency key is already used for a different acquisition request');
  }
  return { outcome: 'existing', job };
}

function existingModeratorSubmissionResult(
  job: AcquisitionJobRecord,
  submittedUrl: string,
  requestedBy: string,
): EnqueueResult {
  if (job.jobKind !== 'moderator_submission'
    || job.submittedUrl !== submittedUrl || job.requestedBy !== requestedBy) {
    throw new Error('Idempotency key is already used for a different acquisition request');
  }
  return { outcome: 'existing', job };
}

function transitionResult(row: AcquisitionJobRow | undefined): LeaseTransitionResult {
  return row ? { outcome: 'updated', job: mapAcquisitionJob(row) } : { outcome: 'not_owned' };
}

function mapAcquisitionJob(row: AcquisitionJobRow): AcquisitionJobRecord {
  return {
    jobId: row.job_id,
    datasetKind: row.dataset_kind,
    idempotencyKey: row.idempotency_key,
    jobKind: row.job_kind,
    traceId: row.trace_id,
    sourceId: row.source_id,
    submittedUrl: row.submitted_url,
    requestedBy: row.requested_by,
    status: row.status,
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    availableAt: timestampAsIso(row.available_at),
    leaseToken: row.lease_token,
    leaseStartedAt: row.lease_started_at === null ? null : timestampAsIso(row.lease_started_at),
    leaseExpiresAt: row.lease_expires_at === null ? null : timestampAsIso(row.lease_expires_at),
    lastFailureCode: row.last_failure_code,
    createdAt: timestampAsIso(row.created_at),
    updatedAt: timestampAsIso(row.updated_at),
    finishedAt: row.finished_at === null ? null : timestampAsIso(row.finished_at),
  };
}

function validateDatasetKind(value: string): asserts value is DatasetKind {
  if (value !== 'live' && value !== 'historical' && value !== 'synthetic') {
    throw new Error('datasetKind must be live, historical or synthetic');
  }
}

function validateOpaqueText(value: string, label: string, maxLength: number): void {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength
    || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must be non-empty, bounded and contain no control characters`);
  }
}

function validateActorId(value: string): string {
  validateOpaqueText(value, 'actor ID', 200);
  if (/\s/.test(value)) throw new Error('actor ID cannot contain whitespace');
  return value;
}

function validateSubmittedUrl(value: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048
    || value.trim() !== value || /[\u0000-\u0020\u007f]/.test(value)) {
    throw new Error('Submitted URL must be bounded and contain no whitespace or control characters');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Submitted URL must be a valid HTTPS URL');
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) {
    throw new Error('Submitted URL must use HTTPS and omit userinfo and fragments');
  }
  for (const key of url.searchParams.keys()) {
    if (/(token|secret|password|passwd|credential|auth|api[_-]?key|access[_-]?key|(^|[_-])key($|[_-])|session|cookie|signature|(^|[_-])sig($|[_-])|jwt)/i.test(key)) {
      throw new Error('Submitted URL cannot include credential-like query parameters');
    }
  }
  const normalized = url.toString();
  if (normalized.length > 2048) throw new Error('Normalized submitted URL exceeds 2048 characters');
  return normalized;
}

function validateFailureCode(value: string): string {
  if (!/^[a-z0-9][a-z0-9_.-]{0,79}$/.test(value)) {
    throw new Error('Failure code must be a bounded lowercase operational code');
  }
  return value;
}

function validateLeaseToken(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('Lease token must be a UUID v4 token');
  }
}

function validateLeaseDuration(milliseconds: number): void {
  if (!Number.isInteger(milliseconds)
    || milliseconds < JOB_QUEUE_POLICY.minLeaseDurationMs
    || milliseconds > JOB_QUEUE_POLICY.maxLeaseDurationMs) {
    throw new Error(`Lease duration must be between ${JOB_QUEUE_POLICY.minLeaseDurationMs} and ${JOB_QUEUE_POLICY.maxLeaseDurationMs} milliseconds`);
  }
}

function normalizeTimestamp(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must be a valid timestamp`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} must be a valid timestamp`);
  return new Date(milliseconds).toISOString();
}

function timestampAsIso(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error('Database returned an invalid queue timestamp');
  return new Date(milliseconds).toISOString();
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}
