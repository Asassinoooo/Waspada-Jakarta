import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import { JOB_QUEUE_POLICY } from '../src/queue.js';
import { createRepositoryPorts, type DatasetKind } from '../src/ports.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

const catalogTraceId = 'trace-queue-catalog';
const syntheticTraceId = 'trace-queue-synthetic';
const historicalTraceId = 'trace-queue-historical';
const t0 = '2026-09-25T12:00:00.000Z';
const dedupeTime = '2030-01-01T00:00:00.000Z';

describe('JOB-01 durable acquisition queue', () => {
  let database: TestDatabase;
  let ports: ReturnType<typeof createRepositoryPorts>;

  before(async () => {
    database = await createTestDatabase();
    ports = createRepositoryPorts(database.executor);
    const migrations = await readMigrations(new URL('../migrations/', import.meta.url));
    await applyMigrations(database.executor, migrations);
    await insertTrace(catalogTraceId, null);
    await insertTrace(syntheticTraceId, 'synthetic');
    await insertTrace(historicalTraceId, 'historical');
    await insertSource('source-queue-active', {
      registryStatus: 'active', approvalStatus: 'approved', autoAcquisitionEnabled: true,
      pollingIntervalSeconds: 300,
    });
    await insertSource('source-queue-pending', {
      registryStatus: 'active', approvalStatus: 'pending', autoAcquisitionEnabled: false,
      pollingIntervalSeconds: 300,
    });
    await insertSource('source-queue-suspended', {
      registryStatus: 'active', approvalStatus: 'suspended', autoAcquisitionEnabled: false,
      pollingIntervalSeconds: 300,
    });
    await insertSource('source-queue-paused', {
      registryStatus: 'paused', approvalStatus: 'approved', autoAcquisitionEnabled: false,
      pollingIntervalSeconds: 300,
    });
    await insertSource('source-queue-retired', {
      registryStatus: 'retired', approvalStatus: 'approved', autoAcquisitionEnabled: false,
      pollingIntervalSeconds: null,
    });
    await insertSource('source-queue-disabled', {
      registryStatus: 'active', approvalStatus: 'approved', autoAcquisitionEnabled: false,
      pollingIntervalSeconds: 300,
    });
    await insertSource('source-queue-no-interval', {
      registryStatus: 'active', approvalStatus: 'approved', autoAcquisitionEnabled: true,
      pollingIntervalSeconds: null,
    });
  });

  after(async () => {
    await database.close();
  });

  it('deduplicates by dataset and caller-supplied slot key while keeping datasets distinct', async () => {
    const first = await ports.acquisitionJobs.enqueueSourcePoll(sourcePollInput(
      'synthetic', 'poll:source-queue-active:slot-1', 'source-queue-active', dedupeTime,
    ));
    assert.equal(first.outcome, 'enqueued');
    if (first.outcome !== 'enqueued') return;

    const duplicate = await ports.acquisitionJobs.enqueueSourcePoll(sourcePollInput(
      'synthetic', 'poll:source-queue-active:slot-1', 'source-queue-active', addMs(dedupeTime, 5_000),
      'trace-queue-synthetic',
    ));
    assert.equal(duplicate.outcome, 'existing');
    if (duplicate.outcome !== 'existing') return;
    assert.equal(duplicate.job.jobId, first.job.jobId);
    assert.equal(duplicate.job.createdAt, first.job.createdAt);

    const nextSlot = await ports.acquisitionJobs.enqueueSourcePoll(sourcePollInput(
      'synthetic', 'poll:source-queue-active:slot-2', 'source-queue-active', addMs(dedupeTime, 300_000),
    ));
    assert.equal(nextSlot.outcome, 'enqueued');
    if (nextSlot.outcome !== 'enqueued') return;
    assert.notEqual(nextSlot.job.jobId, first.job.jobId);

    const otherDataset = await ports.acquisitionJobs.enqueueSourcePoll(sourcePollInput(
      'historical', 'poll:source-queue-active:slot-1', 'source-queue-active', dedupeTime, historicalTraceId,
    ));
    assert.equal(otherDataset.outcome, 'enqueued');
    if (otherDataset.outcome !== 'enqueued') return;
    assert.notEqual(otherDataset.job.jobId, first.job.jobId);

    await assert.rejects(
      ports.acquisitionJobs.enqueueSourcePoll(sourcePollInput(
        'synthetic', 'poll:source-queue-active:slot-1', 'source-queue-disabled', t0,
      )),
      /different acquisition request/,
    );
  });

  it('refuses automatic polls unless the source is active, approved, enabled and interval-configured', async () => {
    for (const sourceId of [
      'source-queue-pending', 'source-queue-suspended', 'source-queue-paused',
      'source-queue-retired', 'source-queue-disabled', 'source-queue-no-interval', 'missing-source',
    ]) {
      const result = await ports.acquisitionJobs.enqueueSourcePoll(sourcePollInput(
        'synthetic', `ineligible:${sourceId}`, sourceId, t0,
      ));
      assert.deepEqual(result, { outcome: 'source_not_schedulable' }, sourceId);
    }
    const count = await database.executor.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM waspada.acquisition_jobs
       WHERE idempotency_key LIKE 'ineligible:%'`,
    );
    assert.equal(count.rows[0]?.count, '0');
  });

  it('accepts only a minimal, safe authorized-caller submission request and deduplicates it', async () => {
    const input = {
      datasetKind: 'synthetic' as const,
      idempotencyKey: 'moderator:request-1',
      traceId: syntheticTraceId,
      requestedBy: 'moderator-17',
      submittedUrl: 'https://example.org/reports/42',
      requestedAt: dedupeTime,
    };
    const first = await ports.acquisitionJobs.enqueueModeratorSubmission(input);
    assert.equal(first.outcome, 'enqueued');
    if (first.outcome !== 'enqueued') return;
    assert.equal(first.job.jobKind, 'moderator_submission');
    assert.equal(first.job.sourceId, null);
    assert.equal(first.job.submittedUrl, input.submittedUrl);
    assert.equal(first.job.requestedBy, input.requestedBy);

    const duplicate = await ports.acquisitionJobs.enqueueModeratorSubmission({
      ...input, requestedAt: addMs(t0, 15_000),
    });
    assert.equal(duplicate.outcome, 'existing');
    if (duplicate.outcome !== 'existing') return;
    assert.equal(duplicate.job.jobId, first.job.jobId);

    const sameKeyDifferentDataset = await ports.acquisitionJobs.enqueueModeratorSubmission({
      ...input, datasetKind: 'historical', traceId: historicalTraceId,
    });
    assert.equal(sameKeyDifferentDataset.outcome, 'enqueued');

    await assert.rejects(
      ports.acquisitionJobs.enqueueModeratorSubmission({ ...input, submittedUrl: 'https://example.org/other' }),
      /different acquisition request/,
    );
    for (const unsafeUrl of [
      'http://example.org/report',
      'https://user:pass@example.org/report',
      'https://example.org/report#private-fragment',
      'https://example.org/report?access_token=secret',
      'https://example.org/report?X-Amz-Signature=secret',
      'https://example.org/has space',
      `https://example.org/${'x'.repeat(2048)}`,
    ]) {
      await assert.rejects(
        ports.acquisitionJobs.enqueueModeratorSubmission({
          ...input, idempotencyKey: `unsafe:${unsafeUrl.slice(0, 20)}`, submittedUrl: unsafeUrl,
        }),
        /Submitted URL/,
      );
    }
    await assert.rejects(
      ports.acquisitionJobs.enqueueModeratorSubmission({ ...input, requestedBy: 'moderator\nforged' }),
      /actor ID/,
    );

    const stored = await database.executor.query<{ columns: string; job_count: string }>(
      `SELECT string_agg(column_name, ',' ORDER BY ordinal_position) AS columns,
              (SELECT count(*)::text FROM waspada.acquisition_jobs WHERE job_id = $1) AS job_count
       FROM information_schema.columns
       WHERE table_schema = 'waspada' AND table_name = 'acquisition_jobs'`,
      [first.job.jobId],
    );
    assert.equal(stored.rows[0]?.job_count, '1');
    assert.doesNotMatch(stored.rows[0]?.columns ?? '', /permitted_text|excerpt|content_body|raw_error/);
  });

  it('atomically leases a due job once and rejects stale or wrong lease tokens', async () => {
    const queued = await ports.acquisitionJobs.enqueueModeratorSubmission({
      datasetKind: 'synthetic', idempotencyKey: 'claim:single', traceId: syntheticTraceId,
      requestedBy: 'moderator-claim', submittedUrl: 'https://example.org/claim', requestedAt: t0,
    });
    assert.equal(queued.outcome, 'enqueued');
    if (queued.outcome !== 'enqueued') return;

    const [claimA, claimB] = await Promise.all([
      ports.acquisitionJobs.claimDueJob(t0, 30_000),
      ports.acquisitionJobs.claimDueJob(t0, 30_000),
    ]);
    assert.equal([claimA, claimB].filter(Boolean).length, 1);
    const claimed = claimA ?? claimB;
    assert.ok(claimed);
    assert.equal(claimed.jobId, queued.job.jobId);
    assert.equal(claimed.status, 'leased');
    assert.equal(claimed.attemptCount, 1);
    assert.match(claimed.leaseToken ?? '', /^[0-9a-f-]{36}$/i);
    assert.equal(claimed.leaseExpiresAt, addMs(t0, 30_000));

    const wrongToken = randomUUID();
    assert.deepEqual(await ports.acquisitionJobs.renewLease(
      'synthetic', claimed.jobId, wrongToken, addMs(t0, 1_000),
    ), { outcome: 'not_owned' });
    assert.deepEqual(await ports.acquisitionJobs.complete(
      'synthetic', claimed.jobId, wrongToken, addMs(t0, 1_000),
    ), { outcome: 'not_owned' });
    assert.deepEqual(await ports.acquisitionJobs.fail(
      'synthetic', claimed.jobId, wrongToken,
      { failureCode: 'wrong_worker', disposition: 'permanent', now: addMs(t0, 1_000) },
    ), { outcome: 'not_owned' });

    const noShorten = await ports.acquisitionJobs.renewLease(
      'synthetic', claimed.jobId, claimed.leaseToken ?? '', addMs(t0, 10_000), 1_000,
    );
    assert.equal(noShorten.outcome, 'updated');
    if (noShorten.outcome === 'updated') assert.equal(noShorten.job.leaseExpiresAt, addMs(t0, 30_000));
    const renewed = await ports.acquisitionJobs.renewLease(
      'synthetic', claimed.jobId, claimed.leaseToken ?? '', addMs(t0, 10_000), 45_000,
    );
    assert.equal(renewed.outcome, 'updated');
    if (renewed.outcome === 'updated') {
      assert.equal(renewed.job.leaseToken, claimed.leaseToken);
      assert.equal(renewed.job.leaseExpiresAt, addMs(t0, 55_000));
    }
    assert.equal((await ports.acquisitionJobs.complete(
      'synthetic', claimed.jobId, claimed.leaseToken ?? '', addMs(t0, 11_000),
    )).outcome, 'updated');
    await assert.rejects(
      ports.acquisitionJobs.renewLease('synthetic', claimed.jobId, claimed.leaseToken ?? '', t0, 300_001),
      /Lease duration/,
    );
  });

  it('completes idempotently, marks source health healthy, and keeps incident state untouched', async () => {
    const queued = await ports.acquisitionJobs.enqueueSourcePoll(sourcePollInput(
      'synthetic', 'health:success', 'source-queue-active', t0,
    ));
    assert.equal(queued.outcome, 'enqueued');
    if (queued.outcome !== 'enqueued') return;
    const claimed = await ports.acquisitionJobs.claimDueJob(t0);
    assert.ok(claimed);
    assert.equal(claimed.sourceId, 'source-queue-active');

    const completed = await ports.acquisitionJobs.complete(
      'synthetic', claimed.jobId, claimed.leaseToken ?? '', addMs(t0, 1_000),
    );
    assert.equal(completed.outcome, 'updated');
    if (completed.outcome !== 'updated') return;
    assert.equal(completed.job.status, 'completed');
    assert.equal(completed.job.finishedAt, addMs(t0, 1_000));
    assert.deepEqual(await ports.acquisitionJobs.complete(
      'synthetic', claimed.jobId, claimed.leaseToken ?? '', addMs(t0, 2_000),
    ), { outcome: 'not_owned' });

    const health = await getSourceHealth('source-queue-active');
    assert.equal(health.health_status, 'healthy');
    assert.equal(health.last_checked_at, addMs(t0, 1_000));
    assert.equal(health.last_success_at, addMs(t0, 1_000));
    const eventCount = await database.executor.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM waspada.event_versions',
    );
    assert.equal(eventCount.rows[0]?.count, '0');
  });

  it('uses capped exponential retry, permanent terminal state and preserves the last source success', async () => {
    const successTime = addMs(t0, 2_000);
    const queued = await ports.acquisitionJobs.enqueueSourcePoll(sourcePollInput(
      'synthetic', 'health:retry', 'source-queue-active', successTime,
    ));
    assert.equal(queued.outcome, 'enqueued');
    if (queued.outcome !== 'enqueued') return;
    const firstClaim = await ports.acquisitionJobs.claimDueJob(successTime);
    assert.ok(firstClaim);
    const retryAt = addMs(successTime, 1_000);
    const failed = await ports.acquisitionJobs.fail('synthetic', firstClaim.jobId, firstClaim.leaseToken ?? '', {
      failureCode: 'upstream_timeout', disposition: 'retryable', now: retryAt,
    });
    assert.equal(failed.outcome, 'updated');
    if (failed.outcome !== 'updated') return;
    assert.equal(failed.job.status, 'retry');
    assert.equal(failed.job.lastFailureCode, 'upstream_timeout');
    assert.equal(failed.job.attemptCount, 1);
    assert.equal(failed.job.availableAt, addMs(retryAt, JOB_QUEUE_POLICY.baseRetryDelayMs));
    assert.deepEqual(await ports.acquisitionJobs.fail('synthetic', firstClaim.jobId, firstClaim.leaseToken ?? '', {
      failureCode: 'upstream_timeout', disposition: 'retryable', now: addMs(retryAt, 1_000),
    }), { outcome: 'not_owned' });

    const degraded = await getSourceHealth('source-queue-active');
    assert.equal(degraded.health_status, 'degraded');
    assert.equal(degraded.last_checked_at, retryAt);
    assert.equal(degraded.last_success_at, addMs(t0, 1_000));

    const secondClaim = await ports.acquisitionJobs.claimDueJob(failed.job.availableAt);
    assert.ok(secondClaim);
    const terminalTime = addMs(failed.job.availableAt, 1_000);
    const permanent = await ports.acquisitionJobs.fail('synthetic', secondClaim.jobId, secondClaim.leaseToken ?? '', {
      failureCode: 'source_denied', disposition: 'permanent', now: terminalTime,
    });
    assert.equal(permanent.outcome, 'updated');
    if (permanent.outcome !== 'updated') return;
    assert.equal(permanent.job.status, 'terminal');
    assert.equal(permanent.job.finishedAt, terminalTime);

    const unavailable = await getSourceHealth('source-queue-active');
    assert.equal(unavailable.health_status, 'unavailable');
    assert.equal(unavailable.last_checked_at, terminalTime);
    assert.equal(unavailable.last_success_at, addMs(t0, 1_000));
  });

  it('recovers crashed leases without resetting attempts and dead-letters at the finite limit', async () => {
    const queued = await ports.acquisitionJobs.enqueueSourcePoll(sourcePollInput(
      'synthetic', 'crash:recover', 'source-queue-active', '2026-09-25T12:30:00.000Z',
    ));
    assert.equal(queued.outcome, 'enqueued');
    if (queued.outcome !== 'enqueued') return;

    let expectedAttempts = 0;
    let recoverAt = Date.parse('2026-09-25T12:30:00.000Z');
    let recoveredJob = queued.job;
    while (expectedAttempts < JOB_QUEUE_POLICY.maxAttempts) {
      const claimTime = expectedAttempts === 0
        ? recoveredJob.availableAt
        : recoveredJob.availableAt;
      const claimed = await ports.acquisitionJobs.claimDueJob(claimTime, 1_000);
      assert.ok(claimed);
      expectedAttempts += 1;
      assert.equal(claimed.attemptCount, expectedAttempts);
      recoverAt = Date.parse(claimed.leaseExpiresAt ?? '') ;
      assert.equal(await ports.acquisitionJobs.recoverExpiredLeases(new Date(recoverAt).toISOString(), 10), 1);
      const stored = await ports.acquisitionJobs.findById('synthetic', queued.job.jobId);
      assert.ok(stored);
      recoveredJob = stored;
      assert.equal(recoveredJob.attemptCount, expectedAttempts);
      assert.equal(recoveredJob.lastFailureCode, 'lease_expired');
      assert.deepEqual(await ports.acquisitionJobs.complete(
        'synthetic', claimed.jobId, claimed.leaseToken ?? '', new Date(recoverAt).toISOString(),
      ), { outcome: 'not_owned' });
      if (expectedAttempts < JOB_QUEUE_POLICY.maxAttempts) {
        const delay = Math.min(
          JOB_QUEUE_POLICY.baseRetryDelayMs * 2 ** (expectedAttempts - 1),
          JOB_QUEUE_POLICY.maxRetryDelayMs,
        );
        assert.equal(recoveredJob.status, 'retry');
        assert.equal(recoveredJob.availableAt, new Date(recoverAt + delay).toISOString());
      } else {
        assert.equal(recoveredJob.status, 'terminal');
        assert.equal(recoveredJob.finishedAt, new Date(recoverAt).toISOString());
      }
    }

    assert.equal(recoveredJob.attemptCount, JOB_QUEUE_POLICY.maxAttempts);
    const health = await getSourceHealth('source-queue-active');
    assert.equal(health.health_status, 'unavailable');
    assert.equal(health.last_success_at, addMs(t0, 1_000));
  });

  it('rejects acknowledgements after lease expiry and applies all bounded worker inputs', async () => {
    const queued = await ports.acquisitionJobs.enqueueModeratorSubmission({
      datasetKind: 'synthetic', idempotencyKey: 'lease:expired', traceId: syntheticTraceId,
      requestedBy: 'moderator-lease', submittedUrl: 'https://example.org/expired', requestedAt: '2026-09-25T13:00:00.000Z',
    });
    assert.equal(queued.outcome, 'enqueued');
    const claimed = await ports.acquisitionJobs.claimDueJob('2026-09-25T13:00:00.000Z', 1_000);
    assert.ok(claimed);
    const expires = claimed.leaseExpiresAt ?? '';
    assert.deepEqual(await ports.acquisitionJobs.renewLease(
      'synthetic', claimed.jobId, claimed.leaseToken ?? '', expires,
    ), { outcome: 'not_owned' });
    assert.deepEqual(await ports.acquisitionJobs.complete(
      'synthetic', claimed.jobId, claimed.leaseToken ?? '', expires,
    ), { outcome: 'not_owned' });
    assert.deepEqual(await ports.acquisitionJobs.fail('synthetic', claimed.jobId, claimed.leaseToken ?? '', {
      failureCode: 'too_late', disposition: 'retryable', now: expires,
    }), { outcome: 'not_owned' });

    await assert.rejects(
      ports.acquisitionJobs.fail('synthetic', claimed.jobId, claimed.leaseToken ?? '', {
        failureCode: 'Raw exception: access_token=secret', disposition: 'permanent', now: expires,
      }),
      /Failure code/,
    );
    await assert.rejects(ports.acquisitionJobs.claimDueJob('not-a-time'), /valid timestamp/);
    await assert.rejects(ports.acquisitionJobs.recoverExpiredLeases(t0, 501), /Recovery limit/);
  });

  it('keeps L1 health writes, L4 policy writes and queue worker grants distinct', async () => {
    const grants = await database.executor.query<{
      l1_health: boolean;
      l1_policy: boolean;
      l4_health: boolean;
      l4_policy: boolean;
      l1_queue_update: boolean;
      l4_queue_update: boolean;
      public_queue_select: boolean;
    }>(
      `SELECT
         has_column_privilege('waspada_l1_pipeline', 'waspada.source_registry', 'health_status', 'UPDATE') AS l1_health,
         has_column_privilege('waspada_l1_pipeline', 'waspada.source_registry', 'registry_status', 'UPDATE') AS l1_policy,
         has_column_privilege('waspada_l4_publication_writer', 'waspada.source_registry', 'health_status', 'UPDATE') AS l4_health,
         has_column_privilege('waspada_l4_publication_writer', 'waspada.source_registry', 'registry_status', 'UPDATE') AS l4_policy,
         has_table_privilege('waspada_l1_pipeline', 'waspada.acquisition_jobs', 'UPDATE') AS l1_queue_update,
         has_table_privilege('waspada_l4_publication_writer', 'waspada.acquisition_jobs', 'UPDATE') AS l4_queue_update,
         has_table_privilege('public', 'waspada.acquisition_jobs', 'SELECT') AS public_queue_select`,
    );
    assert.deepEqual(grants.rows, [{
      l1_health: true, l1_policy: false, l4_health: false, l4_policy: true,
      l1_queue_update: true, l4_queue_update: false, public_queue_select: false,
    }]);
  });

  async function insertTrace(traceId: string, datasetKind: DatasetKind | null): Promise<void> {
    await database.executor.query(
      `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
       VALUES ($1, $2, $3, 'open', '{"fixture":"synthetic-only"}'::jsonb)`,
      [traceId, datasetKind, t0],
    );
  }

  async function insertSource(
    sourceId: string,
    fields: {
      registryStatus: 'active' | 'paused' | 'retired';
      approvalStatus: 'pending' | 'approved' | 'suspended';
      autoAcquisitionEnabled: boolean;
      pollingIntervalSeconds: number | null;
    },
  ): Promise<void> {
    await database.executor.query(
      `INSERT INTO waspada.source_registry
         (source_id, trace_id, registry_version, display_name, source_kind, remit,
          access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
          approval_status, health_status, auto_acquisition_enabled, auto_publication_policy,
          polling_interval_seconds)
       VALUES ($1, $2, 1, $3, 'authority', ARRAY['synthetic tests'], 'api', ARRAY['example.org'],
          ARRAY['synthetic only'], ARRAY['test only'], $4, $5, 'unknown', $6, 'never', $7)`,
      [sourceId, catalogTraceId, `Synthetic ${sourceId}`, fields.registryStatus, fields.approvalStatus,
        fields.autoAcquisitionEnabled, fields.pollingIntervalSeconds],
    );
  }

  async function getSourceHealth(sourceId: string): Promise<{
    health_status: string;
    last_checked_at: string | null;
    last_success_at: string | null;
  }> {
    const result = await database.executor.query<{
      health_status: string;
      last_checked_at: string | null;
      last_success_at: string | null;
    }>(
      `SELECT health_status, last_checked_at::text AS last_checked_at,
              last_success_at::text AS last_success_at
       FROM waspada.source_registry WHERE source_id = $1`,
      [sourceId],
    );
    const row = result.rows[0];
    assert.ok(row);
    return {
      health_status: row.health_status,
      last_checked_at: row.last_checked_at === null ? null : new Date(Date.parse(row.last_checked_at)).toISOString(),
      last_success_at: row.last_success_at === null ? null : new Date(Date.parse(row.last_success_at)).toISOString(),
    };
  }
});

function sourcePollInput(
  datasetKind: DatasetKind,
  idempotencyKey: string,
  sourceId: string,
  requestedAt: string,
  traceId = syntheticTraceId,
) {
  return { datasetKind, idempotencyKey, traceId, sourceId, requestedAt };
}

function addMs(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}
