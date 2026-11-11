import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import {
  createSqlIncidentRepository,
  requeueStrandedAiJobs,
  StaleLeaseError,
} from '../src/incident-repository.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

describe('AI-RATE-01 ai_jobs repository: defer, checkpoints, re-drive (046)', () => {
  let db: TestDatabase;

  before(async () => {
    db = await createTestDatabase();
    const migrations = await readMigrations(new URL('../migrations/', import.meta.url));
    await applyMigrations(db.executor, migrations);
  });

  after(async () => {
    await db?.close();
  });

  // Jobs live on the historical dataset so claimAiJob({ datasetKind: 'historical' })
  // sees only the rows this file seeds. Other jobs are pushed out of the way first.
  const DATASET = 'historical' as const;

  async function claimOnly(jobId: string) {
    await db.executor.query(
      `UPDATE waspada.ai_jobs SET available_at = now() + interval '1 day'
       WHERE dataset_kind = $1 AND job_id <> $2 AND status IN ('pending', 'retry')`,
      [DATASET, jobId],
    );
    const repo = createSqlIncidentRepository(db.executor);
    const claim = await repo.claimAiJob({ datasetKind: DATASET });
    assert.ok(claim, 'a job is claimable');
    assert.equal(claim.job.jobId, jobId, 'the claimed job is the one under test');
    return claim;
  }

  async function seedJob(jobId: string, key: string): Promise<void> {
    const traceId = `trace-ajrl-${key}`;
    const sourceId = `source-ajrl-${key}`;
    const revisionId = `rev-ajrl-${key}`;
    const hash = '4'.repeat(64);
    await db.executor.query(
      `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
       VALUES ($1, 'historical', now(), 'succeeded', '{}'::jsonb)
       ON CONFLICT (trace_id, dataset_kind) DO NOTHING`,
      [traceId],
    );
    await db.executor.query(
      `INSERT INTO waspada.source_registry
         (source_id, trace_id, registry_version, display_name, source_kind, remit,
          access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
          approval_status, health_status, auto_acquisition_enabled, auto_publication_policy)
       VALUES ($1, $2, 1, 'Sumber Repo', 'other', ARRAY['system'], 'manual_fixture',
               ARRAY[]::text[], ARRAY[]::text[], ARRAY['public'], 'active', 'approved', 'healthy', false, 'never')
       ON CONFLICT (source_id) DO NOTHING`,
      [sourceId, traceId],
    );
    await db.executor.query(
      `INSERT INTO waspada.report_revisions
         (dataset_kind, report_revision_id, trace_id, source_id, canonical_url, content_hash, permitted_text,
          permitted_text_hash, normalization_version, retrieved_at, revision_status, record_json)
       VALUES ('historical', $1, $2, $3, $4, $5, 'Laporan uji repositori.', $5, 'v1', now(), 'unreviewed', '{}'::jsonb)
       ON CONFLICT (dataset_kind, report_revision_id) DO NOTHING`,
      [revisionId, traceId, sourceId, `https://synthetic.invalid/${revisionId}`, hash],
    );
    await createSqlIncidentRepository(db.executor).enqueueAiJob({
      jobId,
      datasetKind: DATASET,
      reportRevisionId: revisionId,
      traceId,
    });
  }

  async function row(jobId: string) {
    const result = await db.executor.query<{
      status: string;
      attempt_count: number | string;
      last_failure_code: string | null;
      lease_token: string | null;
      checkpoint_json: unknown;
    }>(
      `SELECT status, attempt_count, last_failure_code, lease_token, checkpoint_json
       FROM waspada.ai_jobs WHERE job_id = $1`,
      [jobId],
    );
    const record = result.rows[0];
    assert.ok(record);
    return { ...record, attempt_count: Number(record.attempt_count) };
  }

  it('defers a leased job: attempt given back, lease cleared, available_at set, lease checked', async () => {
    await seedJob('ajrl-defer-1', 'defer-1');
    const repo = createSqlIncidentRepository(db.executor);
    const claim = await claimOnly('ajrl-defer-1');
    assert.equal(claim.job.attemptCount, 1);

    await assert.rejects(
      repo.deferAiJob({
        jobId: 'ajrl-defer-1',
        leaseToken: '00000000-0000-4000-8000-000000000000',
        availableAt: '2026-11-11T10:00:07.000Z',
        failureCode: 'rate_limited',
      }),
      StaleLeaseError,
      'a wrong lease token cannot defer the job',
    );
    assert.equal((await row('ajrl-defer-1')).status, 'leased', 'a rejected defer changes nothing');

    const deferred = await repo.deferAiJob({
      jobId: 'ajrl-defer-1',
      leaseToken: claim.leaseToken,
      availableAt: '2026-11-11T10:00:07.000Z',
      failureCode: 'rate_limited',
    });
    assert.deepEqual(deferred, { status: 'retry', attemptCount: 0 });
    const stored = await repo.getAiJob('ajrl-defer-1');
    assert.ok(stored);
    assert.equal(stored.status, 'retry');
    assert.equal(stored.attemptCount, 0);
    assert.equal(stored.lastFailureCode, 'rate_limited');
    assert.equal(stored.leaseToken, null);
    assert.equal(stored.availableAt, '2026-11-11T10:00:07.000Z');

    await assert.rejects(
      repo.deferAiJob({ jobId: 'ajrl-defer-1', leaseToken: claim.leaseToken, availableAt: '2026-11-11T10:00:09.000Z', failureCode: 'rate_limited' }),
      StaleLeaseError,
      'a deferred job no longer holds the old lease',
    );
  });

  it('rejects any failure code other than rate_limited on the defer path', async () => {
    await seedJob('ajrl-defer-code', 'defer-code');
    const repo = createSqlIncidentRepository(db.executor);
    const claim = await claimOnly('ajrl-defer-code');
    await assert.rejects(
      repo.deferAiJob({
        jobId: 'ajrl-defer-code',
        leaseToken: claim.leaseToken,
        availableAt: new Date().toISOString(),
        failureCode: 'model_failed' as 'rate_limited',
      }),
      TypeError,
    );
  });

  it('saves and reads a checkpoint only under the current lease, and it survives lease release', async () => {
    await seedJob('ajrl-ckpt-1', 'ckpt-1');
    const repo = createSqlIncidentRepository(db.executor);
    const claim = await claimOnly('ajrl-ckpt-1');
    assert.equal(await repo.readAiJobCheckpoint('ajrl-ckpt-1', claim.leaseToken), null);

    assert.equal(
      await repo.saveAiJobCheckpoint('ajrl-ckpt-1', claim.leaseToken, { interpretation: { summary: 'Pohon tumbang' } }),
      true,
    );
    assert.equal(
      await repo.saveAiJobCheckpoint('ajrl-ckpt-1', '00000000-0000-4000-8000-000000000000', { interpretation: {} }),
      false,
      'a foreign lease cannot write the checkpoint',
    );
    assert.deepEqual(await repo.readAiJobCheckpoint('ajrl-ckpt-1', claim.leaseToken), { interpretation: { summary: 'Pohon tumbang' } });

    await repo.deferAiJob({
      jobId: 'ajrl-ckpt-1',
      leaseToken: claim.leaseToken,
      availableAt: new Date(Date.now() + 1_000).toISOString(),
      failureCode: 'rate_limited',
    });
    await db.executor.query(`UPDATE waspada.ai_jobs SET available_at = now() WHERE job_id = 'ajrl-ckpt-1'`);
    const second = await claimOnly('ajrl-ckpt-1');
    assert.notEqual(second.leaseToken, claim.leaseToken);
    assert.deepEqual(
      await repo.readAiJobCheckpoint('ajrl-ckpt-1', second.leaseToken),
      { interpretation: { summary: 'Pohon tumbang' } },
      'a later attempt with a new lease reads the earlier checkpoint',
    );
    assert.equal(await repo.readAiJobCheckpoint('ajrl-ckpt-1', claim.leaseToken), null, 'the old lease reads nothing');
  });

  it('requeues only needs_review jobs whose failure code is in the list', async () => {
    const repo = createSqlIncidentRepository(db.executor);
    const cases: Array<[string, string]> = [
      ['ajrl-rq-model', 'model_failed'],
      ['ajrl-rq-rate', 'rate_limited'],
      ['ajrl-rq-invalid', 'invalid_output'],
      ['ajrl-rq-review', 'triage_decision_missing'],
    ];
    for (const [jobId, code] of cases) {
      await seedJob(jobId, jobId);
      await db.executor.query(
        `UPDATE waspada.ai_jobs
         SET status = 'needs_review', attempt_count = 5, last_failure_code = $2,
             finished_at = now(), updated_at = now()
         WHERE job_id = $1`,
        [jobId, code],
      );
    }

    const requeued = await requeueStrandedAiJobs(db.executor, { codes: ['model_failed', 'rate_limited'] });
    assert.deepEqual([...requeued].sort(), ['ajrl-rq-model', 'ajrl-rq-rate']);

    const model = await repo.getAiJob('ajrl-rq-model');
    assert.equal(model?.status, 'pending');
    assert.equal(model?.attemptCount, 0, 'attempts are reset on requeue');
    assert.equal(model?.leaseToken, null);
    assert.equal((await repo.getAiJob('ajrl-rq-rate'))?.status, 'pending');

    const invalid = await repo.getAiJob('ajrl-rq-invalid');
    assert.equal(invalid?.status, 'needs_review');
    assert.equal(invalid?.lastFailureCode, 'invalid_output');
    assert.equal((await repo.getAiJob('ajrl-rq-review'))?.status, 'needs_review');

    assert.deepEqual(await requeueStrandedAiJobs(db.executor, { codes: [] }), []);
  });

  it('completion clears any checkpoint on the job row', async () => {
    await seedJob('ajrl-complete', 'complete');
    const repo = createSqlIncidentRepository(db.executor);
    const claim = await claimOnly('ajrl-complete');
    await repo.saveAiJobCheckpoint('ajrl-complete', claim.leaseToken, { interpretation: { summary: 'x' } });
    assert.equal(await repo.completeAiJob('ajrl-complete', claim.leaseToken), true);
    assert.equal((await row('ajrl-complete')).checkpoint_json, null);
  });

  it('migration 046 adds the checkpoint column and accepts retry with attempt_count 0 only', async () => {
    const column = await db.executor.query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
       WHERE table_schema = 'waspada' AND table_name = 'ai_jobs' AND column_name = 'checkpoint_json'`,
    );
    assert.equal(column.rows[0]?.data_type, 'jsonb');

    await seedJob('ajrl-constraint', 'constraint');
    await assert.doesNotReject(
      db.executor.query(`UPDATE waspada.ai_jobs SET status = 'leased', attempt_count = 1, lease_token = '${'a'.repeat(8)}-0000-4000-8000-000000000001', lease_started_at = now(), lease_expires_at = now() + interval '5 minutes', updated_at = now() WHERE job_id = 'ajrl-constraint'`),
    );
    await assert.doesNotReject(
      db.executor.query(`UPDATE waspada.ai_jobs SET status = 'retry', attempt_count = 0, lease_token = NULL, lease_started_at = NULL, lease_expires_at = NULL, updated_at = now() WHERE job_id = 'ajrl-constraint'`),
    );
    await assert.rejects(
      db.executor.query(`UPDATE waspada.ai_jobs SET attempt_count = 5 WHERE job_id = 'ajrl-constraint'`),
      /ai_jobs_retry_attempt_check/,
      'retry still requires attempt_count below max_attempts',
    );
  });

  it('migration 046 accepts the rate_limited triage model status on decisions and attempts', async () => {
    const decisions = await db.executor.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'waspada.news_triage_decisions'::regclass AND contype = 'c'
         AND pg_get_constraintdef(oid) LIKE '%rate_limited%'`,
    );
    assert.equal(decisions.rows.length, 1);
    const attempts = await db.executor.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'waspada.news_triage_attempts'::regclass AND contype = 'c'
         AND pg_get_constraintdef(oid) LIKE '%rate_limited%'`,
    );
    assert.equal(attempts.rows.length, 1);
    await assert.doesNotReject(
      db.executor.query(
        `INSERT INTO waspada.news_triage_attempts
           (dataset_kind, item_identity_hash, report_revision_id, source_id, trace_id, disposition, jakarta_scope,
            actionability, confidence, model_status)
         VALUES ('live', $1, 'rev-x', 'src-x', 'trace-x', 'uncertain', 'unknown', 'unknown', 'low', 'rate_limited')`,
        ['b'.repeat(64)],
      ),
    );
    await assert.rejects(
      db.executor.query(
        `INSERT INTO waspada.news_triage_attempts
           (dataset_kind, item_identity_hash, report_revision_id, source_id, trace_id, disposition, jakarta_scope,
            actionability, confidence, model_status)
         VALUES ('live', $1, 'rev-x', 'src-x', 'trace-x', 'uncertain', 'unknown', 'unknown', 'low', 'not_a_status')`,
        ['b'.repeat(64)],
      ),
      /model_status_check/,
    );
  });
});
