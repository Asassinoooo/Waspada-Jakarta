import { createHash, randomUUID } from 'node:crypto';
import type {
  AcquisitionJobRecord,
  AcquisitionJobStatus,
  LeaseTransitionResult,
} from '../../apps/db/src/queue.js';
import { JOB_QUEUE_POLICY, SqlAcquisitionJobRepository } from '../../apps/db/src/queue.js';
import type { SqlExecutor, TransactionalSqlExecutor } from '../../apps/db/src/sql.js';
import {
  LOCAL_LIMITS,
  LOCAL_PIPELINE_SCHEMA,
  LOCAL_SOURCE_ID,
  type AiJob,
  type AiStage,
  type AuthoredFeed,
  type AuthoredReport,
  type FailureTransition,
  type LocalPipelineStore,
  type PipelineSummary,
  type ReportSnapshot,
  type SafeFailure,
} from './contracts.js';

const AI_STAGES: readonly AiStage[] = ['extraction', 'embedding', 'grounding', 'reasoning', 'proposal'];
const SAFE_FAILURES: readonly SafeFailure[] = [
  'l1_failed', 'prerequisite_pending', 'model_timeout', 'model_failed',
  'invalid_output', 'context_insufficient', 'persistence_failed', 'lease_expired',
];
const EXPLICIT_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_RECEIPT_BYTES = 262_144;
const MAX_RECEIPT_DEPTH = 32;
const MAX_RECEIPT_NODES = 20_000;

interface LocalJobRow {
  job_id: string;
  dataset_kind: 'synthetic';
  idempotency_key: string;
  job_kind: 'source_poll';
  trace_id: string;
  source_id: string | null;
  submitted_url: string | null;
  requested_by: string | null;
  status: AcquisitionJobStatus;
  attempt_count: number | string;
  max_attempts: number | string;
  available_at: string;
  lease_token: string | null;
  lease_started_at: string | null;
  lease_expires_at: string | null;
  last_failure_code: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

interface SnapshotRow {
  snapshot_id: string;
  stable_report_id: string;
  version: number | string;
  content_hash: string;
  title: string;
  report_text: string;
  published_at_text: string | null;
  observed_at_text: string | null;
  source_id: string;
  canonical_url: string;
  source_revision_key: string;
  report_revision_id: string;
  candidate_id: string;
  trace_id: string;
  supersedes_id: string | null;
  captured_at_text: string;
}

interface AiJobRow {
  job_id: string;
  snapshot_id: string;
  status: AcquisitionJobStatus;
  attempt_count: number | string;
  lease_token: string | null;
  lease_expires_at: string | null;
}

const JOB_COLUMNS = `
  job.job_id, job.dataset_kind, job.idempotency_key, job.job_kind, job.trace_id,
  job.source_id, job.submitted_url, job.requested_by, job.status, job.attempt_count,
  job.max_attempts, job.available_at::text AS available_at, job.lease_token,
  job.lease_started_at::text AS lease_started_at,
  job.lease_expires_at::text AS lease_expires_at, job.last_failure_code,
  job.created_at::text AS created_at, job.updated_at::text AS updated_at,
  job.finished_at::text AS finished_at`;

const SNAPSHOT_COLUMNS = `
  snapshot.snapshot_id, snapshot.stable_report_id, snapshot.version, snapshot.content_hash,
  snapshot.title, snapshot.report_text, snapshot.published_at_text, snapshot.observed_at_text,
  snapshot.source_id, snapshot.canonical_url, snapshot.source_revision_key,
  snapshot.report_revision_id, snapshot.candidate_id, snapshot.trace_id,
  snapshot.supersedes_id, snapshot.captured_at_text`;

export class SqlLocalPipelineStore implements LocalPipelineStore {
  constructor(private readonly executor: TransactionalSqlExecutor) {}

  async capture(feed: AuthoredFeed, nowInput: string): Promise<{ captured: number; unchanged: number }> {
    validateFeed(feed);
    const now = normalizeExplicitTimestamp(nowInput, 'now');
    return this.executor.transaction(async (transaction) => {
      const tx = transactionExecutor(transaction);
      let captured = 0;
      let unchanged = 0;
      for (const report of feed.reports) {
        await tx.query(
          `INSERT INTO waspada.local_report_heads
             (source_id, stable_report_id, latest_version, latest_content_hash,
              latest_report_revision_id, updated_at)
           VALUES ($1, $2, 0, NULL, NULL, $3)
           ON CONFLICT (source_id, stable_report_id) DO NOTHING`,
          [LOCAL_SOURCE_ID, report.id, now],
        );
        const headResult = await tx.query<{
          latest_version: number | string;
          latest_content_hash: string | null;
          latest_report_revision_id: string | null;
        }>(
          `SELECT latest_version, latest_content_hash, latest_report_revision_id
           FROM waspada.local_report_heads
           WHERE source_id = $1 AND stable_report_id = $2
           FOR UPDATE`,
          [LOCAL_SOURCE_ID, report.id],
        );
        const head = headResult.rows[0];
        if (!head) throw new Error('Local report head could not be locked');

        const contentHash = canonicalContentHash(report);
        if (head.latest_content_hash === contentHash) {
          unchanged += 1;
          continue;
        }

        const version = Number(head.latest_version) + 1;
        const identityHash = sha256(JSON.stringify([LOCAL_SOURCE_ID, report.id, version, contentHash]));
        const snapshot: ReportSnapshot = {
          ...report,
          sourceId: LOCAL_SOURCE_ID,
          datasetKind: 'synthetic',
          version,
          contentHash,
          canonicalUrl: `https://synthetic.invalid/local-authored-api/${encodeURIComponent(report.id)}`,
          sourceRevisionKey: `local-v1:${sha256(JSON.stringify([report.id, version]))}`,
          reportRevisionId: `local-revision:${identityHash}`,
          candidateId: `local-candidate:${identityHash}`,
          traceId: randomUUID(),
          supersedesId: head.latest_report_revision_id,
          capturedAt: now,
        };
        const snapshotId = randomUUID();
        await tx.query(
          `INSERT INTO waspada.traces
             (trace_id, dataset_kind, started_at, ended_at, outcome, metadata)
           VALUES ($1, 'synthetic', $2, NULL, 'open', $3::jsonb)`,
          [snapshot.traceId, now, JSON.stringify({
            purpose: 'local_synthetic_report_capture',
            source_id: LOCAL_SOURCE_ID,
            stable_report_id: report.id,
            version,
            content_hash: contentHash,
            pipeline_schema: LOCAL_PIPELINE_SCHEMA,
          })],
        );
        await tx.query(
          `INSERT INTO waspada.local_report_snapshots
             (snapshot_id, dataset_kind, source_id, stable_report_id, version, content_hash,
              title, report_text, published_at_text, observed_at_text, canonical_url,
              source_revision_key, report_revision_id, candidate_id, trace_id,
              supersedes_id, captured_at_text)
           VALUES ($1, 'synthetic', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                   $13, $14, $15, $16)`,
          [snapshotId, LOCAL_SOURCE_ID, report.id, version, contentHash, report.title,
            report.text, report.publishedAt, report.observedAt, snapshot.canonicalUrl,
            snapshot.sourceRevisionKey, snapshot.reportRevisionId, snapshot.candidateId,
            snapshot.traceId, snapshot.supersedesId, snapshot.capturedAt],
        );

        const enqueue = await new SqlAcquisitionJobRepository(tx).enqueueSourcePoll({
          datasetKind: 'synthetic',
          idempotencyKey: `local-report:v1:${identityHash}`,
          traceId: snapshot.traceId,
          sourceId: LOCAL_SOURCE_ID,
          requestedAt: now,
        });
        if (enqueue.outcome === 'source_not_schedulable') {
          throw new Error('The local authored synthetic source is not schedulable');
        }
        await tx.query(
          `INSERT INTO waspada.local_report_inbox
             (source_poll_job_id, dataset_kind, source_id, snapshot_id, created_at)
           VALUES ($1, 'synthetic', $2, $3, $4)`,
          [enqueue.job.jobId, LOCAL_SOURCE_ID, snapshotId, now],
        );
        await tx.query(
          `UPDATE waspada.local_report_heads
           SET latest_version = $3, latest_content_hash = $4,
               latest_report_revision_id = $5, updated_at = $6
           WHERE source_id = $1 AND stable_report_id = $2`,
          [LOCAL_SOURCE_ID, report.id, version, contentHash, snapshot.reportRevisionId, now],
        );
        captured += 1;
      }
      return { captured, unchanged };
    });
  }

  async claimIngestion(nowInput: string): Promise<AcquisitionJobRecord | null> {
    const now = normalizeExplicitTimestamp(nowInput, 'now');
    const leaseExpiresAt = addMilliseconds(now, JOB_QUEUE_POLICY.defaultLeaseDurationMs);
    return this.executor.transaction(async (transaction) => {
      const result = await transaction.query<LocalJobRow>(
        `WITH due_job AS (
           SELECT job.job_id
           FROM waspada.acquisition_jobs AS job
           JOIN waspada.local_report_inbox AS inbox ON inbox.source_poll_job_id = job.job_id
           JOIN waspada.local_report_snapshots AS snapshot ON snapshot.snapshot_id = inbox.snapshot_id
           JOIN waspada.source_registry AS source ON source.source_id = job.source_id
           WHERE job.dataset_kind = 'synthetic' AND job.job_kind = 'source_poll'
             AND job.source_id = $2 AND job.status IN ('pending', 'retry')
             AND job.available_at <= $1::timestamptz
             AND source.registry_status = 'active' AND source.approval_status = 'approved'
             AND source.auto_acquisition_enabled AND source.polling_interval_seconds IS NOT NULL
             AND NOT EXISTS (
               SELECT 1
               FROM waspada.local_report_snapshots AS prior_snapshot
               JOIN waspada.local_report_inbox AS prior_inbox
                 ON prior_inbox.snapshot_id = prior_snapshot.snapshot_id
               JOIN waspada.acquisition_jobs AS prior_job
                 ON prior_job.job_id = prior_inbox.source_poll_job_id
               WHERE prior_snapshot.source_id = snapshot.source_id
                 AND prior_snapshot.stable_report_id = snapshot.stable_report_id
                 AND prior_snapshot.version < snapshot.version
                 AND prior_job.status <> 'completed'
             )
           ORDER BY job.available_at, job.created_at, job.job_id
           FOR UPDATE OF job SKIP LOCKED
           LIMIT 1
         )
         UPDATE waspada.acquisition_jobs AS job
         SET status = 'leased', attempt_count = job.attempt_count + 1,
             lease_token = $3, lease_started_at = $1::timestamptz,
             lease_expires_at = $4::timestamptz, updated_at = $1::timestamptz
         FROM due_job
         WHERE job.job_id = due_job.job_id
         RETURNING ${JOB_COLUMNS}`,
        [now, LOCAL_SOURCE_ID, randomUUID(), leaseExpiresAt],
      );
      const row = result.rows[0];
      return row ? mapQueueJob(row) : null;
    });
  }

  async ingestionSnapshot(jobId: string): Promise<ReportSnapshot | null> {
    validateId(jobId, 'jobId');
    const result = await this.executor.query<SnapshotRow>(
      `SELECT ${SNAPSHOT_COLUMNS}
       FROM waspada.local_report_inbox AS inbox
       JOIN waspada.acquisition_jobs AS job ON job.job_id = inbox.source_poll_job_id
       JOIN waspada.local_report_snapshots AS snapshot ON snapshot.snapshot_id = inbox.snapshot_id
       WHERE inbox.source_poll_job_id = $1 AND inbox.dataset_kind = 'synthetic'
         AND inbox.source_id = $2 AND job.dataset_kind = 'synthetic'
         AND job.job_kind = 'source_poll' AND job.source_id = $2`,
      [jobId, LOCAL_SOURCE_ID],
    );
    const row = result.rows[0];
    return row ? mapSnapshot(row) : null;
  }

  async finishIngestion(
    job: AcquisitionJobRecord,
    nowInput: string,
    write: (tx: TransactionalSqlExecutor, snapshot: ReportSnapshot) => Promise<void>,
  ): Promise<boolean> {
    const now = normalizeExplicitTimestamp(nowInput, 'now');
    validateIngestionJob(job);
    if (typeof write !== 'function') throw new Error('Ingestion callback must be a function');
    return this.executor.transaction(async (transaction) => {
      const tx = transactionExecutor(transaction);
      const owned = await tx.query<SnapshotRow>(
        `SELECT ${SNAPSHOT_COLUMNS}
         FROM waspada.acquisition_jobs AS job
         JOIN waspada.local_report_inbox AS inbox ON inbox.source_poll_job_id = job.job_id
         JOIN waspada.local_report_snapshots AS snapshot ON snapshot.snapshot_id = inbox.snapshot_id
         WHERE job.dataset_kind = 'synthetic' AND job.job_id = $1
           AND job.job_kind = 'source_poll' AND job.source_id = $2
           AND inbox.dataset_kind = 'synthetic' AND inbox.source_id = $2
           AND job.status = 'leased' AND job.lease_token = $3
           AND job.lease_started_at <= $4::timestamptz
           AND job.lease_expires_at > $4::timestamptz
         FOR UPDATE OF job`,
        [job.jobId, LOCAL_SOURCE_ID, job.leaseToken, now],
      );
      const row = owned.rows[0];
      if (!row) return false;
      const snapshot = mapSnapshot(row);
      await write(tx, snapshot);

      const aiJobId = randomUUID();
      await tx.query(
        `INSERT INTO waspada.local_ai_jobs
           (job_id, snapshot_id, status, attempt_count, max_attempts,
            available_at, created_at, updated_at)
         SELECT $1, $2, 'pending', 0, $4, $3::timestamptz, $3::timestamptz, $3::timestamptz
         WHERE NOT EXISTS (
           SELECT 1 FROM waspada.local_ai_jobs WHERE snapshot_id = $2
         )`,
        [aiJobId, row.snapshot_id, now, JOB_QUEUE_POLICY.maxAttempts],
      );
      const ai = await tx.query<{ job_id: string }>(
        'SELECT job_id FROM waspada.local_ai_jobs WHERE snapshot_id = $1', [row.snapshot_id],
      );
      if (!ai.rows[0]) throw new Error('Local AI job could not be enqueued for the captured report');

      const completed = await new SqlAcquisitionJobRepository(tx).complete(
        'synthetic', job.jobId, job.leaseToken as string, now,
      );
      if (completed.outcome !== 'updated') {
        throw new Error('Local source-poll lease changed while its transaction was locked');
      }
      return true;
    });
  }

  async failIngestion(job: AcquisitionJobRecord, nowInput: string, code: SafeFailure): Promise<FailureTransition> {
    const now = normalizeExplicitTimestamp(nowInput, 'now');
    validateIngestionJob(job);
    validateSafeFailure(code);
    return this.executor.transaction(async (transaction) => {
      const tx = transactionExecutor(transaction);
      const local = await isLocalIngestionJob(tx, job.jobId);
      if (!local) return 'lost_lease';
      const transition = await new SqlAcquisitionJobRepository(tx).fail(
        'synthetic', job.jobId, job.leaseToken as string,
        { failureCode: code, disposition: 'retryable', now },
      );
      return mapFailureTransition(transition);
    });
  }

  async claimAi(nowInput: string, leaseDurationMs: number = JOB_QUEUE_POLICY.defaultLeaseDurationMs): Promise<AiJob | null> {
    const now = normalizeExplicitTimestamp(nowInput, 'now');
    validateLeaseDuration(leaseDurationMs);
    const leaseExpiresAt = addMilliseconds(now, leaseDurationMs);
    return this.executor.transaction(async (transaction) => {
      const claimed = await transaction.query<AiJobRow>(
        `WITH due_job AS (
           SELECT job.job_id
           FROM waspada.local_ai_jobs AS job
           WHERE job.status IN ('pending', 'retry') AND job.available_at <= $1::timestamptz
           ORDER BY job.available_at, job.created_at, job.job_id
           FOR UPDATE OF job SKIP LOCKED
           LIMIT 1
         )
         UPDATE waspada.local_ai_jobs AS job
         SET status = 'leased', attempt_count = job.attempt_count + 1,
             lease_token = $2, lease_started_at = $1::timestamptz,
             lease_expires_at = $3::timestamptz, updated_at = $1::timestamptz
         FROM due_job
         WHERE job.job_id = due_job.job_id
         RETURNING job.job_id, job.snapshot_id, job.status, job.attempt_count,
                   job.lease_token, job.lease_expires_at::text AS lease_expires_at`,
        [now, randomUUID(), leaseExpiresAt],
      );
      const row = claimed.rows[0];
      if (!row) return null;
      const snapshotResult = await transaction.query<SnapshotRow>(
        `SELECT ${SNAPSHOT_COLUMNS}
         FROM waspada.local_report_snapshots AS snapshot
         WHERE snapshot.snapshot_id = $1`,
        [row.snapshot_id],
      );
      const snapshot = snapshotResult.rows[0];
      if (!snapshot) throw new Error('Claimed local AI job has no immutable report snapshot');
      return {
        jobId: row.job_id,
        status: row.status,
        attemptCount: Number(row.attempt_count),
        leaseToken: row.lease_token,
        leaseExpiresAt: row.lease_expires_at === null ? null : timestampAsIso(row.lease_expires_at),
        snapshot: mapSnapshot(snapshot),
      };
    });
  }

  async renewAi(
    job: AiJob,
    nowInput: string,
    leaseDurationMs: number = JOB_QUEUE_POLICY.maxLeaseDurationMs,
  ): Promise<boolean> {
    const now = normalizeExplicitTimestamp(nowInput, 'now');
    validateAiJob(job);
    validateLeaseDuration(leaseDurationMs);
    const requestedExpiry = addMilliseconds(now, leaseDurationMs);
    const result = await this.executor.query<{ job_id: string }>(
      `UPDATE waspada.local_ai_jobs AS job
       SET lease_expires_at = GREATEST(job.lease_expires_at, $3::timestamptz),
           updated_at = $2::timestamptz
       FROM waspada.local_report_snapshots AS snapshot
       WHERE job.job_id = $1 AND job.snapshot_id = snapshot.snapshot_id
         AND snapshot.dataset_kind = 'synthetic' AND snapshot.source_id = $5
         AND snapshot.report_revision_id = $4
         AND EXISTS (
           SELECT 1
           FROM waspada.local_report_inbox AS inbox
           JOIN waspada.acquisition_jobs AS source_job
             ON source_job.job_id = inbox.source_poll_job_id
           WHERE inbox.snapshot_id = snapshot.snapshot_id
             AND inbox.dataset_kind = 'synthetic' AND inbox.source_id = $5
             AND source_job.dataset_kind = 'synthetic'
             AND source_job.job_kind = 'source_poll' AND source_job.source_id = $5
         )
         AND job.status = 'leased' AND job.lease_token = $6
         AND job.lease_started_at <= $2::timestamptz
         AND job.lease_expires_at > $2::timestamptz
         AND job.updated_at <= $2::timestamptz
       RETURNING job.job_id`,
      [job.jobId, now, requestedExpiry, job.snapshot.reportRevisionId, LOCAL_SOURCE_ID, job.leaseToken],
    );
    return result.rows.length === 1;
  }

  async readReceipt(jobId: string, stage: AiStage): Promise<unknown | null> {
    validateId(jobId, 'jobId');
    validateStage(stage);
    const result = await this.executor.query<{ receipt_json: unknown }>(
      `SELECT receipt_json FROM waspada.local_ai_receipts
       WHERE job_id = $1 AND stage = $2`,
      [jobId, stage],
    );
    const row = result.rows[0];
    return row ? decodeReceipt(row.receipt_json) : null;
  }

  async checkpoint(
    job: AiJob,
    nowInput: string,
    stage: AiStage,
    value: unknown,
    write?: (tx: TransactionalSqlExecutor) => Promise<void>,
  ): Promise<boolean> {
    const now = normalizeExplicitTimestamp(nowInput, 'now');
    validateAiJob(job);
    validateStage(stage);
    if (write !== undefined && typeof write !== 'function') throw new Error('Checkpoint callback must be a function');
    const receiptJson = safeReceiptJson(value);
    const receiptHash = sha256(receiptJson);
    return this.executor.transaction(async (transaction) => {
      const tx = transactionExecutor(transaction);
      const owned = await tx.query<{ job_id: string }>(
        `SELECT job.job_id
         FROM waspada.local_ai_jobs AS job
         JOIN waspada.local_report_snapshots AS snapshot ON snapshot.snapshot_id = job.snapshot_id
         WHERE job.job_id = $1 AND job.status = 'leased' AND job.lease_token = $2
           AND job.lease_started_at <= $3::timestamptz AND job.lease_expires_at > $3::timestamptz
           AND snapshot.report_revision_id = $4
         FOR UPDATE OF job`,
        [job.jobId, job.leaseToken, now, job.snapshot.reportRevisionId],
      );
      if (!owned.rows[0]) return false;

      const existing = await tx.query<{ receipt_sha256: string }>(
        `SELECT receipt_sha256 FROM waspada.local_ai_receipts
         WHERE job_id = $1 AND stage = $2`,
        [job.jobId, stage],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].receipt_sha256 !== receiptHash) {
          throw new Error('A local AI stage receipt is immutable and already has different content');
        }
        return true;
      }

      const stageIndex = AI_STAGES.indexOf(stage);
      if (stageIndex > 0) {
        const prerequisite = AI_STAGES[stageIndex - 1];
        const found = await tx.query<{ present: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM waspada.local_ai_receipts WHERE job_id = $1 AND stage = $2
           ) AS present`,
          [job.jobId, prerequisite],
        );
        if (found.rows[0]?.present !== true) {
          throw new Error(`Local AI stage ${stage} requires the ${prerequisite} receipt`);
        }
      }
      if (write) await write(tx);
      await tx.query(
        `INSERT INTO waspada.local_ai_receipts
           (job_id, stage, receipt_json, receipt_sha256, recorded_at)
         VALUES ($1, $2, $3::jsonb, $4, $5::timestamptz)`,
        [job.jobId, stage, receiptJson, receiptHash, now],
      );
      return true;
    });
  }

  async completeAi(job: AiJob, nowInput: string): Promise<boolean> {
    const now = normalizeExplicitTimestamp(nowInput, 'now');
    validateAiJob(job);
    const result = await this.executor.query<{ job_id: string }>(
      `UPDATE waspada.local_ai_jobs AS job
       SET status = 'completed', lease_token = NULL, lease_started_at = NULL,
           lease_expires_at = NULL, updated_at = $3::timestamptz, finished_at = $3::timestamptz
       FROM waspada.local_report_snapshots AS snapshot
       WHERE job.job_id = $1 AND job.snapshot_id = snapshot.snapshot_id
         AND snapshot.report_revision_id = $4
         AND job.status = 'leased' AND job.lease_token = $2
         AND job.lease_started_at <= $3::timestamptz AND job.lease_expires_at > $3::timestamptz
         AND (SELECT count(*) FROM waspada.local_ai_receipts WHERE job_id = job.job_id) = $5
       RETURNING job.job_id`,
      [job.jobId, job.leaseToken, now, job.snapshot.reportRevisionId, AI_STAGES.length],
    );
    return result.rows.length === 1;
  }

  async failAi(job: AiJob, nowInput: string, code: SafeFailure): Promise<FailureTransition> {
    const now = normalizeExplicitTimestamp(nowInput, 'now');
    validateAiJob(job);
    validateSafeFailure(code);
    const transition = await this.executor.query<{ status: AcquisitionJobStatus }>(
      `UPDATE waspada.local_ai_jobs AS job
       SET status = CASE
             WHEN job.attempt_count < job.max_attempts THEN 'retry'
             ELSE 'terminal'
           END,
           available_at = CASE
             WHEN job.attempt_count < job.max_attempts THEN $3::timestamptz + LEAST(
               $4::numeric * power(2::numeric, GREATEST(job.attempt_count::integer - 1, 0)),
               $5::numeric
             ) * interval '1 millisecond'
             ELSE job.available_at
           END,
           last_failure_code = $6,
           lease_token = NULL, lease_started_at = NULL, lease_expires_at = NULL,
           updated_at = $3::timestamptz,
           finished_at = CASE WHEN job.attempt_count < job.max_attempts THEN NULL ELSE $3::timestamptz END
       FROM waspada.local_report_snapshots AS snapshot
       WHERE job.job_id = $1 AND job.snapshot_id = snapshot.snapshot_id
         AND snapshot.report_revision_id = $7
         AND job.status = 'leased' AND job.lease_token = $2
         AND job.lease_started_at <= $3::timestamptz AND job.lease_expires_at > $3::timestamptz
       RETURNING job.status`,
      [job.jobId, job.leaseToken, now, JOB_QUEUE_POLICY.baseRetryDelayMs,
        JOB_QUEUE_POLICY.maxRetryDelayMs, code, job.snapshot.reportRevisionId],
    );
    const status = transition.rows[0]?.status;
    return status === 'retry' ? 'retry' : status === 'terminal' ? 'terminal' : 'lost_lease';
  }

  async recover(nowInput: string): Promise<{ ingestion: number; ai: number }> {
    const now = normalizeExplicitTimestamp(nowInput, 'now');
    return this.executor.transaction(async (transaction) => {
      const ingestion = await recoverLocalIngestionLeases(transaction, now);
      const ai = await recoverLocalAiLeases(transaction, now);
      return { ingestion, ai };
    });
  }

  async summary(): Promise<PipelineSummary> {
    const [snapshotResult, ingestionResult, aiResult, proposalResult] = await Promise.all([
      this.executor.query<{ count: number | string }>(
        'SELECT count(*)::integer AS count FROM waspada.local_report_snapshots',
      ),
      this.executor.query<{ status: AcquisitionJobStatus; count: number | string }>(
        `SELECT job.status, count(*)::integer AS count
         FROM waspada.local_report_inbox AS inbox
         JOIN waspada.acquisition_jobs AS job ON job.job_id = inbox.source_poll_job_id
         WHERE inbox.dataset_kind = 'synthetic' AND inbox.source_id = $1
         GROUP BY job.status`,
        [LOCAL_SOURCE_ID],
      ),
      this.executor.query<{ status: AcquisitionJobStatus; count: number | string }>(
        `SELECT status, count(*)::integer AS count
         FROM waspada.local_ai_jobs GROUP BY status`,
      ),
      this.executor.query<{ count: number | string }>(
        `SELECT count(*)::integer AS count
         FROM waspada.event_proposals AS proposal
         JOIN waspada.local_report_snapshots AS snapshot
           ON snapshot.candidate_id = proposal.candidate_id
         WHERE proposal.dataset_kind = 'synthetic'`,
      ),
    ]);
    return {
      snapshots: Number(snapshotResult.rows[0]?.count ?? 0),
      ingestion: countStatuses(ingestionResult.rows),
      ai: countStatuses(aiResult.rows),
      proposals: Number(proposalResult.rows[0]?.count ?? 0),
    };
  }
}

export function createLocalPipelineStore(executor: TransactionalSqlExecutor): LocalPipelineStore {
  return new SqlLocalPipelineStore(executor);
}

async function recoverLocalIngestionLeases(executor: SqlExecutor, now: string): Promise<number> {
  const result = await executor.query<{ recovered_count: number | string }>(
    `WITH expired AS (
       SELECT job.job_id
       FROM waspada.acquisition_jobs AS job
       JOIN waspada.local_report_inbox AS inbox ON inbox.source_poll_job_id = job.job_id
       WHERE job.dataset_kind = 'synthetic' AND job.job_kind = 'source_poll'
         AND job.source_id = $2 AND job.status = 'leased' AND job.lease_expires_at <= $1::timestamptz
       ORDER BY job.lease_expires_at, job.created_at, job.job_id
       FOR UPDATE OF job SKIP LOCKED
       LIMIT $3
     ), recovered AS (
       UPDATE waspada.acquisition_jobs AS job
       SET status = CASE WHEN job.attempt_count >= job.max_attempts THEN 'terminal' ELSE 'retry' END,
           available_at = CASE
             WHEN job.attempt_count >= job.max_attempts THEN job.available_at
             ELSE $1::timestamptz + LEAST(
               $4::numeric * power(2::numeric, GREATEST(job.attempt_count::integer - 1, 0)),
               $5::numeric
             ) * interval '1 millisecond'
           END,
           last_failure_code = 'lease_expired', lease_token = NULL,
           lease_started_at = NULL, lease_expires_at = NULL, updated_at = $1::timestamptz,
           finished_at = CASE WHEN job.attempt_count >= job.max_attempts THEN $1::timestamptz ELSE NULL END
       FROM expired WHERE job.job_id = expired.job_id
       RETURNING job.source_id, job.status, job.job_kind
     ), health_rollup AS (
       SELECT source_id, bool_or(status = 'terminal') AS terminal
       FROM recovered WHERE job_kind = 'source_poll' GROUP BY source_id
     ), health_update AS (
       UPDATE waspada.source_registry AS source
       SET health_status = CASE WHEN health_rollup.terminal THEN 'unavailable' ELSE 'degraded' END,
           last_checked_at = $1::timestamptz
       FROM health_rollup
       WHERE source.source_id = health_rollup.source_id
         AND source.source_id = $2
         AND (source.last_checked_at IS NULL OR source.last_checked_at <= $1::timestamptz)
       RETURNING source.source_id
     )
     SELECT count(*)::integer AS recovered_count FROM recovered`,
    [now, LOCAL_SOURCE_ID, JOB_QUEUE_POLICY.maxRecoveryBatchSize,
      JOB_QUEUE_POLICY.baseRetryDelayMs, JOB_QUEUE_POLICY.maxRetryDelayMs],
  );
  return Number(result.rows[0]?.recovered_count ?? 0);
}

async function recoverLocalAiLeases(executor: SqlExecutor, now: string): Promise<number> {
  const result = await executor.query<{ recovered_count: number | string }>(
    `WITH expired AS (
       SELECT job_id FROM waspada.local_ai_jobs
       WHERE status = 'leased' AND lease_expires_at <= $1::timestamptz
       ORDER BY lease_expires_at, created_at, job_id
       FOR UPDATE SKIP LOCKED LIMIT $2
     ), recovered AS (
       UPDATE waspada.local_ai_jobs AS job
       SET status = CASE WHEN job.attempt_count >= job.max_attempts THEN 'terminal' ELSE 'retry' END,
           available_at = CASE
             WHEN job.attempt_count >= job.max_attempts THEN job.available_at
             ELSE $1::timestamptz + LEAST(
               $3::numeric * power(2::numeric, GREATEST(job.attempt_count::integer - 1, 0)),
               $4::numeric
             ) * interval '1 millisecond'
           END,
           last_failure_code = 'lease_expired', lease_token = NULL,
           lease_started_at = NULL, lease_expires_at = NULL, updated_at = $1::timestamptz,
           finished_at = CASE WHEN job.attempt_count >= job.max_attempts THEN $1::timestamptz ELSE NULL END
       FROM expired WHERE job.job_id = expired.job_id
       RETURNING job.job_id
     )
     SELECT count(*)::integer AS recovered_count FROM recovered`,
    [now, JOB_QUEUE_POLICY.maxRecoveryBatchSize,
      JOB_QUEUE_POLICY.baseRetryDelayMs, JOB_QUEUE_POLICY.maxRetryDelayMs],
  );
  return Number(result.rows[0]?.recovered_count ?? 0);
}

async function isLocalIngestionJob(executor: SqlExecutor, jobId: string): Promise<boolean> {
  const result = await executor.query<{ local: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM waspada.local_report_inbox AS inbox
       JOIN waspada.acquisition_jobs AS job ON job.job_id = inbox.source_poll_job_id
       WHERE job.job_id = $1 AND job.dataset_kind = 'synthetic'
         AND job.job_kind = 'source_poll' AND job.source_id = $2
         AND inbox.dataset_kind = 'synthetic' AND inbox.source_id = $2
     ) AS local`,
    [jobId, LOCAL_SOURCE_ID],
  );
  return result.rows[0]?.local === true;
}

function mapFailureTransition(result: LeaseTransitionResult): FailureTransition {
  if (result.outcome === 'not_owned') return 'lost_lease';
  return result.job.status === 'retry' ? 'retry' : 'terminal';
}

function mapQueueJob(row: LocalJobRow): AcquisitionJobRecord {
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

function mapSnapshot(row: SnapshotRow): ReportSnapshot {
  return {
    id: row.stable_report_id,
    title: row.title,
    text: row.report_text,
    publishedAt: row.published_at_text,
    observedAt: row.observed_at_text,
    sourceId: row.source_id as typeof LOCAL_SOURCE_ID,
    datasetKind: 'synthetic',
    version: Number(row.version),
    contentHash: row.content_hash,
    canonicalUrl: row.canonical_url,
    sourceRevisionKey: row.source_revision_key,
    reportRevisionId: row.report_revision_id,
    candidateId: row.candidate_id,
    traceId: row.trace_id,
    supersedesId: row.supersedes_id,
    capturedAt: row.captured_at_text,
  };
}

function validateFeed(feed: AuthoredFeed): void {
  if (!feed || feed.schemaVersion !== 'local-synthetic-api-v1' || feed.datasetKind !== 'synthetic'
    || feed.sourceId !== LOCAL_SOURCE_ID || !Array.isArray(feed.reports)
    || feed.reports.length > LOCAL_LIMITS.maxReports) {
    throw new Error('Local capture accepts only the bounded authored synthetic feed contract');
  }
  const ids = new Set<string>();
  for (const report of feed.reports) {
    validateReport(report);
    if (ids.has(report.id)) throw new Error('An authored feed cannot repeat a stable report ID');
    ids.add(report.id);
  }
  const bytes = Buffer.byteLength(JSON.stringify(feed), 'utf8');
  if (bytes > LOCAL_LIMITS.maxFeedBytes) throw new Error('Authored feed exceeds the local capture byte limit');
}

function validateReport(report: AuthoredReport): void {
  if (!report || typeof report !== 'object') throw new Error('Authored report must be an object');
  validateOpaqueText(report.id, 'report id', 200);
  if (typeof report.title !== 'string' || Array.from(report.title).length < 1
    || Array.from(report.title).length > 4_000 || report.title.trim() !== report.title || report.title.includes('\0')) {
    throw new Error('Authored report title must be bounded, non-empty text');
  }
  if (typeof report.text !== 'string' || Array.from(report.text).length < 1
    || Array.from(report.text).length > LOCAL_LIMITS.maxTextCodePoints || report.text.includes('\0')) {
    throw new Error(`Authored report text must contain 1 to ${LOCAL_LIMITS.maxTextCodePoints} Unicode code points`);
  }
  if (report.publishedAt !== null) normalizeExplicitTimestamp(report.publishedAt, 'publishedAt');
  if (report.observedAt !== null) normalizeExplicitTimestamp(report.observedAt, 'observedAt');
}

function canonicalContentHash(report: AuthoredReport): string {
  return sha256(JSON.stringify([
    report.id,
    report.title,
    report.text,
    report.publishedAt,
    report.observedAt,
  ]));
}

function safeReceiptJson(value: unknown): string {
  let nodes = 0;
  const ancestors = new Set<object>();
  const normalize = (current: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_RECEIPT_NODES || depth > MAX_RECEIPT_DEPTH) {
      throw new Error('AI stage receipt exceeds the local JSON complexity bound');
    }
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return current;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new Error('AI stage receipt numbers must be finite');
      return current;
    }
    if (Array.isArray(current)) {
      if (ancestors.has(current)) throw new Error('AI stage receipt cannot contain a cycle');
      ancestors.add(current);
      const output = current.map((entry) => normalize(entry, depth + 1));
      ancestors.delete(current);
      return output;
    }
    if (typeof current === 'object') {
      const object = current as Record<string, unknown>;
      if (Object.getPrototypeOf(object) !== Object.prototype && Object.getPrototypeOf(object) !== null) {
        throw new Error('AI stage receipt must contain only plain JSON objects');
      }
      if (ancestors.has(object)) throw new Error('AI stage receipt cannot contain a cycle');
      ancestors.add(object);
      const output: Record<string, unknown> = {};
      for (const key of Object.keys(object).sort()) {
        const entry = object[key];
        if (entry === undefined) throw new Error('AI stage receipt cannot contain undefined values');
        output[key] = normalize(entry, depth + 1);
      }
      ancestors.delete(object);
      return output;
    }
    throw new Error('AI stage receipt must contain only JSON-safe values');
  };
  const json = JSON.stringify(normalize(value, 0));
  if (json === undefined || Buffer.byteLength(json, 'utf8') > MAX_RECEIPT_BYTES) {
    throw new Error('AI stage receipt exceeds the local byte limit');
  }
  return json;
}

function decodeReceipt(value: unknown): unknown {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  return JSON.parse(safeReceiptJson(parsed)) as unknown;
}

function transactionExecutor(executor: SqlExecutor): TransactionalSqlExecutor {
  return {
    query: <Row extends object>(statement: string, parameters?: readonly unknown[]) =>
      executor.query<Row>(statement, parameters),
    execute: (statement: string) => executor.execute(statement),
    transaction: async <Result>(work: (transaction: SqlExecutor) => Promise<Result>) => {
      return work(executor);
    },
  };
}

function countStatuses(rows: readonly { status: AcquisitionJobStatus; count: number | string }[]):
  Record<AcquisitionJobStatus, number> {
  const counts: Record<AcquisitionJobStatus, number> = {
    pending: 0, leased: 0, retry: 0, completed: 0, terminal: 0,
  };
  for (const row of rows) counts[row.status] = Number(row.count);
  return counts;
}

function validateIngestionJob(job: AcquisitionJobRecord): void {
  if (!job || job.datasetKind !== 'synthetic' || job.jobKind !== 'source_poll'
    || job.sourceId !== LOCAL_SOURCE_ID || typeof job.jobId !== 'string'
    || typeof job.leaseToken !== 'string') {
    throw new Error('Operation requires a leased local synthetic source-poll job');
  }
}

function validateAiJob(job: AiJob): void {
  if (!job || typeof job.jobId !== 'string' || !IDENTIFIER.test(job.jobId)
    || !job.snapshot || job.snapshot.datasetKind !== 'synthetic'
    || job.snapshot.sourceId !== LOCAL_SOURCE_ID
    || !IDENTIFIER.test(job.snapshot.reportRevisionId)
    || typeof job.leaseToken !== 'string') {
    throw new Error('Operation requires a leased local synthetic AI job');
  }
}

function validateSafeFailure(value: SafeFailure): void {
  if (!SAFE_FAILURES.includes(value)) throw new Error('Failure code is outside the local safe failure vocabulary');
}

function validateStage(value: AiStage): void {
  if (!AI_STAGES.includes(value)) throw new Error('Unknown local AI stage');
}

function validateOpaqueText(value: string, label: string, maxLength: number): void {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength
    || value.trim() !== value || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must be bounded non-empty text without control characters`);
  }
}

function validateId(value: string, label: string): void {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new Error(`${label} must be a valid local identifier`);
}

function normalizeExplicitTimestamp(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim() !== value || !EXPLICIT_TIMESTAMP.test(value)
    || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a valid RFC 3339 timestamp with an explicit offset`);
  }
  return new Date(Date.parse(value)).toISOString();
}

function timestampAsIso(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error('Database returned an invalid local pipeline timestamp');
  return new Date(milliseconds).toISOString();
}

function addMilliseconds(timestamp: string, durationMs: number): string {
  return new Date(Date.parse(timestamp) + durationMs).toISOString();
}

function validateLeaseDuration(milliseconds: number): void {
  if (!Number.isInteger(milliseconds) || milliseconds < JOB_QUEUE_POLICY.minLeaseDurationMs
    || milliseconds > JOB_QUEUE_POLICY.maxLeaseDurationMs) {
    throw new Error(`Lease duration must be between ${JOB_QUEUE_POLICY.minLeaseDurationMs} and ${JOB_QUEUE_POLICY.maxLeaseDurationMs} milliseconds`);
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
