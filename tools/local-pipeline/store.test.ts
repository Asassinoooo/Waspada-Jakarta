import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRepositoryPorts } from '../../apps/db/src/ports.js';
import type { TransactionalSqlExecutor } from '../../apps/db/src/sql.js';
import { openLocalPipelineDatabase } from './database.js';
import type { AiStage, AuthoredFeed, AuthoredReport, ReportSnapshot } from './contracts.js';
import { LOCAL_FEED_SCHEMA, LOCAL_SOURCE_ID } from './contracts.js';
import { SqlLocalPipelineStore } from './store.js';

const T0 = '2026-10-12T02:00:00.000Z';

test('capture hashes canonical report fields and creates a new immutable version for A to B to A', async () => {
  const database = await openLocalPipelineDatabase({ profileId: 'capture-test' });
  try {
    const store = new SqlLocalPipelineStore(database.executor);
    const a = authoredReport('report-1', 'Initial wording');
    const b = authoredReport('report-1', 'Changed wording');
    assert.deepEqual(await store.capture(feed(a), T0), { captured: 1, unchanged: 0 });
    const originalSnapshot = await database.executor.query<{
      snapshot_id: string;
      content_hash: string;
      report_text: string;
    }>(
      `SELECT snapshot_id, content_hash, report_text
       FROM waspada.local_report_snapshots WHERE stable_report_id = $1`,
      [a.id],
    );
    const original = originalSnapshot.rows[0];
    assert.ok(original);
    await assert.rejects(
      database.executor.query(
        'UPDATE waspada.local_report_snapshots SET report_text = $1 WHERE snapshot_id = $2',
        ['mutated', original.snapshot_id],
      ),
      /local report snapshots are append-only/,
    );
    await assert.rejects(
      database.executor.query(
        'DELETE FROM waspada.local_report_snapshots WHERE snapshot_id = $1',
        [original.snapshot_id],
      ),
      /local report snapshots are append-only/,
    );
    assert.deepEqual(
      await store.capture(feed(a), '2026-10-12T02:00:30.000Z'),
      { captured: 0, unchanged: 1 },
      'failed snapshot mutations must not change the canonical capture',
    );
    assert.deepEqual(
      await database.executor.query(
        `SELECT content_hash, report_text FROM waspada.local_report_snapshots
         WHERE snapshot_id = $1`,
        [original.snapshot_id],
      ).then((result) => result.rows),
      [{ content_hash: original.content_hash, report_text: original.report_text }],
    );
    assert.deepEqual(await store.capture(feed(a), '2026-10-12T02:01:00.000Z'), { captured: 0, unchanged: 1 });
    assert.deepEqual(await store.capture(feed(b), '2026-10-12T02:02:00.000Z'), { captured: 1, unchanged: 0 });
    assert.deepEqual(await store.capture(feed(a), '2026-10-12T02:03:00.000Z'), { captured: 1, unchanged: 0 });

    const snapshots = await database.executor.query<{
      stable_report_id: string;
      version: number;
      content_hash: string;
      report_text: string;
      supersedes_id: string | null;
    }>(
      `SELECT stable_report_id, version, content_hash, report_text, supersedes_id
       FROM waspada.local_report_snapshots ORDER BY version`,
    );
    assert.deepEqual(snapshots.rows.map((row) => row.version), [1, 2, 3]);
    assert.deepEqual(snapshots.rows.map((row) => row.report_text), ['Initial wording', 'Changed wording', 'Initial wording']);
    const expectedA = createHash('sha256').update(JSON.stringify([
      a.id, a.title, a.text, a.publishedAt, a.observedAt,
    ])).digest('hex');
    assert.equal(snapshots.rows[0]?.content_hash, expectedA);
    assert.equal(snapshots.rows[2]?.content_hash, expectedA);
    assert.notEqual(snapshots.rows[0]?.supersedes_id, snapshots.rows[2]?.supersedes_id);
    assert.deepEqual(await store.summary().then((summary) => summary.ingestion), {
      pending: 3, leased: 0, retry: 0, completed: 0, terminal: 0,
    });
    assert.deepEqual(await store.claimAi(T0), null, 'capture alone must not schedule AI');
  } finally {
    await database.close();
  }
});

test('fresh nested file-backed PGlite state opens, persists, and refuses a different owner', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'rpl-local-pipeline-'));
  const dataDir = join(temporaryDirectory, 'nested', 'new-state');
  try {
    let database = await openLocalPipelineDatabase({ dataDir, profileId: 'durable-profile' });
    const firstStore = new SqlLocalPipelineStore(database.executor);
    await firstStore.capture(feed(authoredReport('durable-1', 'Persisted synthetic text')), T0);
    await database.close();

    database = await openLocalPipelineDatabase({ dataDir, profileId: 'durable-profile' });
    const reopened = new SqlLocalPipelineStore(database.executor);
    assert.deepEqual(
      await reopened.capture(feed(authoredReport('durable-1', 'Persisted synthetic text')), '2026-10-12T02:05:00.000Z'),
      { captured: 0, unchanged: 1 },
    );
    const job = await reopened.claimIngestion('2026-10-12T02:05:00.000Z');
    assert.ok(job);
    const snapshot = await reopened.ingestionSnapshot(job.jobId);
    assert.equal(snapshot?.text, 'Persisted synthetic text');
    await database.close();

    await assert.rejects(
      openLocalPipelineDatabase({ dataDir, profileId: 'another-profile' }),
      /owned by another profile or schema/,
    );

    database = await openLocalPipelineDatabase({ dataDir, profileId: 'durable-profile' });
    await database.executor.execute('DROP TABLE waspada.local_pipeline_owner');
    await database.close();
    await assert.rejects(
      openLocalPipelineDatabase({ dataDir, profileId: 'durable-profile' }),
      /already contains unowned waspada data/,
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('ingestion claims only mapped local reports and preserves report-version order', async () => {
  const database = await openLocalPipelineDatabase({ profileId: 'claim-isolation-test' });
  try {
    const store = new SqlLocalPipelineStore(database.executor);
    const first = authoredReport('ordered-report', 'Version one');
    const second = authoredReport('ordered-report', 'Version two');
    await store.capture(feed(first), T0);
    await store.capture(feed(second), '2026-10-12T02:00:01.000Z');
    await seedUnrelatedSyntheticPoll(database.executor, '2026-10-12T02:00:00.000Z');

    const claimed = await store.claimIngestion('2026-10-12T02:00:02.000Z');
    assert.ok(claimed);
    const firstSnapshot = await store.ingestionSnapshot(claimed.jobId);
    assert.equal(firstSnapshot?.version, 1);

    const claimedAgainBeforeFinish = await store.claimIngestion('2026-10-12T02:00:02.000Z');
    assert.equal(claimedAgainBeforeFinish, null, 'version two must wait for version one canonical L1 writes');
    const unrelated = await database.executor.query<{ status: string }>(
      `SELECT status FROM waspada.acquisition_jobs WHERE source_id = 'unrelated-synthetic-fixture'`,
    );
    assert.equal(unrelated.rows[0]?.status, 'pending', 'unmapped synthetic jobs must remain untouched');

    assert.equal(await store.finishIngestion(claimed, '2026-10-12T02:00:03.000Z', writeCanonicalRevision), true);
    const next = await store.claimIngestion('2026-10-12T02:00:04.000Z');
    assert.ok(next);
    assert.equal((await store.ingestionSnapshot(next.jobId))?.version, 2);
  } finally {
    await database.close();
  }
});

test('checkpoint receipts are ordered, immutable, replay-safe and lease fenced', async () => {
  const database = await openLocalPipelineDatabase({ profileId: 'checkpoint-test' });
  try {
    const store = new SqlLocalPipelineStore(database.executor);
    await store.capture(feed(authoredReport('checkpoint-report', 'Checkpoint text')), T0);
    const ingestion = await store.claimIngestion(T0);
    assert.ok(ingestion);
    assert.equal(await store.finishIngestion(ingestion, '2026-10-12T02:00:01.000Z', writeCanonicalRevision), true);

    await database.executor.execute('CREATE TABLE checkpoint_test_writes (write_key text PRIMARY KEY)');
    const ai = await store.claimAi('2026-10-12T02:00:02.000Z', 1_000);
    assert.ok(ai);
    let callbackCount = 0;
    await assert.rejects(
      store.checkpoint(ai, '2026-10-12T02:00:02.100Z', 'embedding', { model: 'fixture' }, async (tx) => {
        callbackCount += 1;
        await tx.query("INSERT INTO checkpoint_test_writes VALUES ('must-not-run')");
      }),
      /requires the extraction receipt/,
    );
    await assert.rejects(
      store.checkpoint(ai, '2026-10-12T02:00:02.200Z', 'extraction', { score: Number.POSITIVE_INFINITY }),
      /numbers must be finite/,
    );

    const extraction = { fixture: 'extraction', score: 0.75 };
    const firstWrite = await store.checkpoint(ai, '2026-10-12T02:00:02.300Z', 'extraction', extraction, async (tx) => {
      callbackCount += 1;
      await tx.query("INSERT INTO checkpoint_test_writes VALUES ('extraction')");
    });
    assert.equal(firstWrite, true);
    const replayedWrite = await store.checkpoint(ai, '2026-10-12T02:00:02.400Z', 'extraction', extraction, async (tx) => {
      callbackCount += 1;
      await tx.query("INSERT INTO checkpoint_test_writes VALUES ('duplicate')");
    });
    assert.equal(replayedWrite, true);
    assert.equal(callbackCount, 1, 'replayed stage receipts must skip committed canonical writes');
    assert.deepEqual(await store.readReceipt(ai.jobId, 'extraction'), extraction);
    await assert.rejects(
      store.checkpoint(ai, '2026-10-12T02:00:02.500Z', 'extraction', { fixture: 'changed' }),
      /already has different content/,
    );

    for (const stage of ['embedding', 'grounding', 'reasoning', 'proposal'] satisfies readonly AiStage[]) {
      assert.equal(await store.checkpoint(ai, '2026-10-12T02:00:02.600Z', stage, { stage }), true);
    }
    assert.equal(await store.completeAi(ai, '2026-10-12T02:00:02.700Z'), true);
    assert.equal(await store.completeAi(ai, '2026-10-12T02:00:02.800Z'), false);
  } finally {
    await database.close();
  }
});

test('AI lease renewal extends work past its original expiry without changing accounting and recovery resumes after renewals stop', async () => {
  const database = await openLocalPipelineDatabase({ profileId: 'ai-renewal-test' });
  try {
    const store = new SqlLocalPipelineStore(database.executor);
    await store.capture(feed(authoredReport('renewal-report', 'Renewal text')), T0);
    const ingestion = await store.claimIngestion(T0);
    assert.ok(ingestion);
    assert.equal(await store.finishIngestion(ingestion, plusMs(1_000), writeCanonicalRevision), true);
    const healthBefore = await sourceHealth(database.executor);

    const ai = await store.claimAi(plusMs(2_000), 1_000);
    assert.ok(ai);
    assert.equal(ai.leaseExpiresAt, plusMs(3_000));
    const extraction = { fixture: 'before-renewal', score: 1 };
    assert.equal(await store.checkpoint(ai, plusMs(2_100), 'extraction', extraction), true);

    const stateBefore = await database.executor.query<{
      snapshot_id: string;
      status: string;
      attempt_count: number;
      max_attempts: number;
      available_at: string;
      lease_token: string | null;
      lease_started_at: string | null;
      lease_expires_at: string | null;
      updated_at: string;
      finished_at: string | null;
    }>(
      `SELECT snapshot_id, status, attempt_count, max_attempts,
              available_at::text AS available_at, lease_token,
              lease_started_at::text AS lease_started_at,
              lease_expires_at::text AS lease_expires_at,
              updated_at::text AS updated_at, finished_at::text AS finished_at
       FROM waspada.local_ai_jobs WHERE job_id = $1`,
      [ai.jobId],
    );
    const receiptsBefore = await database.executor.query<{
      stage: string;
      receipt_json: unknown;
      receipt_sha256: string;
      recorded_at: string;
    }>(
      `SELECT stage, receipt_json, receipt_sha256, recorded_at::text AS recorded_at
       FROM waspada.local_ai_receipts WHERE job_id = $1 ORDER BY stage`,
      [ai.jobId],
    );
    assert.equal(stateBefore.rows.length, 1);
    assert.equal(receiptsBefore.rows.length, 1);

    assert.equal(await store.renewAi(ai, plusMs(2_500)), true, 'omitted duration defaults to the five-minute maximum');
    const renewed = await database.executor.query<{
      snapshot_id: string;
      status: string;
      attempt_count: number;
      max_attempts: number;
      available_at: string;
      lease_token: string | null;
      lease_started_at: string | null;
      lease_expires_at: string | null;
      updated_at: string;
      finished_at: string | null;
    }>(
      `SELECT snapshot_id, status, attempt_count, max_attempts,
              available_at::text AS available_at, lease_token,
              lease_started_at::text AS lease_started_at,
              lease_expires_at::text AS lease_expires_at,
              updated_at::text AS updated_at, finished_at::text AS finished_at
       FROM waspada.local_ai_jobs WHERE job_id = $1`,
      [ai.jobId],
    );
    const renewedRow = renewed.rows[0];
    const beforeRow = stateBefore.rows[0];
    assert.ok(renewedRow && beforeRow);
    assert.equal(Date.parse(renewedRow.lease_expires_at!), Date.parse(plusMs(302_500)));
    assert.ok(Date.parse(renewedRow.lease_expires_at!) > Date.parse(ai.leaseExpiresAt!));
    assert.equal(renewedRow.snapshot_id, beforeRow.snapshot_id);
    assert.equal(renewedRow.status, beforeRow.status);
    assert.equal(renewedRow.attempt_count, beforeRow.attempt_count);
    assert.equal(renewedRow.max_attempts, beforeRow.max_attempts);
    assert.equal(renewedRow.available_at, beforeRow.available_at);
    assert.equal(renewedRow.lease_token, beforeRow.lease_token);
    assert.equal(renewedRow.lease_started_at, beforeRow.lease_started_at);
    assert.equal(renewedRow.finished_at, beforeRow.finished_at);
    assert.equal(Date.parse(renewedRow.updated_at), Date.parse(plusMs(2_500)));

    const afterDefaultRenewal = Date.parse(renewedRow.lease_expires_at!);
    assert.equal(await store.renewAi(ai, plusMs(3_001), 1_000), true,
      'the current token can renew after the original expiry while a prior renewal remains active');
    const afterShortRenewal = await database.executor.query<{ lease_expires_at: string; updated_at: string }>(
      `SELECT lease_expires_at::text AS lease_expires_at, updated_at::text AS updated_at
       FROM waspada.local_ai_jobs WHERE job_id = $1`,
      [ai.jobId],
    ).then((result) => result.rows[0]);
    assert.ok(afterShortRenewal);
    assert.equal(Date.parse(afterShortRenewal.lease_expires_at), afterDefaultRenewal,
      'a shorter requested expiry must preserve the existing later expiry');
    assert.equal(Date.parse(afterShortRenewal.updated_at), Date.parse(plusMs(3_001)));
    assert.deepEqual(await database.executor.query(
      `SELECT stage, receipt_json, receipt_sha256, recorded_at::text AS recorded_at
       FROM waspada.local_ai_receipts WHERE job_id = $1 ORDER BY stage`,
      [ai.jobId],
    ).then((result) => result.rows), receiptsBefore.rows,
    'renewal must leave stage receipts byte-for-byte equivalent');
    assert.deepEqual(await sourceHealth(database.executor), healthBefore,
      'AI lease renewal must not touch source health');

    const oneMsBeforeExpiry = new Date(afterDefaultRenewal - 1).toISOString();
    assert.deepEqual(await store.recover(oneMsBeforeExpiry), { ingestion: 0, ai: 0 });
    const atExpiry = new Date(afterDefaultRenewal).toISOString();
    assert.deepEqual(await store.recover(atExpiry), { ingestion: 0, ai: 1 },
      'the lease becomes recoverable at its renewed expiry when heartbeats stop');

    const recovered = await database.executor.query<{ available_at: string }>(
      'SELECT available_at::text AS available_at FROM waspada.local_ai_jobs WHERE job_id = $1',
      [ai.jobId],
    ).then((result) => result.rows[0]);
    assert.ok(recovered);
    const retryAt = new Date(Date.parse(recovered.available_at)).toISOString();
    const retry = await store.claimAi(retryAt);
    assert.ok(retry);
    assert.equal(retry.attemptCount, 2);
    assert.notEqual(retry.leaseToken, ai.leaseToken);
    const retryStart = Date.parse(retryAt);
    const stages: readonly [AiStage, unknown][] = [
      ['extraction', extraction],
      ['embedding', { stage: 'embedding' }],
      ['grounding', { stage: 'grounding' }],
      ['reasoning', { stage: 'reasoning' }],
      ['proposal', { stage: 'proposal' }],
    ];
    for (const [index, [stage, value]] of stages.entries()) {
      assert.equal(await store.checkpoint(retry, new Date(retryStart + (index + 1) * 1_000).toISOString(), stage, value), true);
    }
    const completedAt = new Date(retryStart + 6_000).toISOString();
    assert.equal(await store.completeAi(retry, completedAt), true);
    assert.equal(await store.renewAi(ai, completedAt), false, 'a completed job cannot be renewed or revived');
    assert.deepEqual(await sourceHealth(database.executor), healthBefore);
  } finally {
    await database.close();
  }
});

test('AI renewal fences stale ownership, foreign snapshots, regressing time, lease boundaries, and terminal jobs', async () => {
  const database = await openLocalPipelineDatabase({ profileId: 'ai-renewal-fencing-test' });
  try {
    const store = new SqlLocalPipelineStore(database.executor);
    await store.capture(feed(authoredReport('renewal-fencing-report', 'Fencing text')), T0);
    const ingestion = await store.claimIngestion(T0);
    assert.ok(ingestion);
    assert.equal(await store.finishIngestion(ingestion, plusMs(1_000), writeCanonicalRevision), true);
    const ai = await store.claimAi(plusMs(2_000), 1_000);
    assert.ok(ai);

    await assert.rejects(store.renewAi(ai, plusMs(2_500), 999), /Lease duration/);
    await assert.rejects(store.renewAi(ai, plusMs(2_500), 300_001), /Lease duration/);
    assert.equal(await store.renewAi({ ...ai, leaseToken: 'stale-token' }, plusMs(2_500), 1_000), false);
    assert.equal(await store.renewAi({
      ...ai,
      snapshot: { ...ai.snapshot, reportRevisionId: 'foreign-report-revision' },
    }, plusMs(2_500), 1_000), false, 'caller-supplied snapshot identity must match the exact owned snapshot');

    const successfulRenewalAt = plusMs(2_600);
    assert.equal(await store.renewAi(ai, successfulRenewalAt, 1_000), true);
    const renewedExpiry = plusMs(3_600);
    assert.equal(await store.renewAi(ai, plusMs(2_550), 1_000), false,
      'updated_at cannot move backward even while the lease itself remains live');
    assert.equal(await store.renewAi(ai, renewedExpiry, 1_000), false,
      'expiry is exclusive and a lease cannot renew at its exact boundary');
    assert.equal(await store.renewAi(ai, plusMs(3_601), 1_000), false,
      'an expired lease cannot be revived');
    assert.deepEqual(await store.recover(renewedExpiry), { ingestion: 0, ai: 1 });
    assert.equal(await store.renewAi(ai, renewedExpiry, 1_000), false,
      'recovered retry state is not renewable with the old lease');

    let dueAt = await database.executor.query<{ available_at: string }>(
      'SELECT available_at::text AS available_at FROM waspada.local_ai_jobs WHERE job_id = $1',
      [ai.jobId],
    ).then((result) => result.rows[0]).then((row) => {
      assert.ok(row);
      return new Date(Date.parse(row.available_at)).toISOString();
    });
    for (let attempt = 2; attempt <= 5; attempt += 1) {
      const current = await store.claimAi(dueAt, 1_000);
      assert.ok(current);
      assert.equal(current.attemptCount, attempt);
      const failedAt = new Date(Date.parse(dueAt) + 100).toISOString();
      const transition = await store.failAi(current, failedAt, 'model_timeout');
      assert.equal(transition, attempt === 5 ? 'terminal' : 'retry');
      if (attempt === 5) {
        assert.equal(await store.renewAi(current, new Date(Date.parse(failedAt) + 100).toISOString(), 1_000), false,
          'a terminal job cannot be renewed or revived');
      } else {
        const next = await database.executor.query<{ available_at: string }>(
          'SELECT available_at::text AS available_at FROM waspada.local_ai_jobs WHERE job_id = $1',
          [ai.jobId],
        ).then((result) => result.rows[0]);
        assert.ok(next);
        dueAt = new Date(Date.parse(next.available_at)).toISOString();
      }
    }
  } finally {
    await database.close();
  }
});

test('expired AI lease cannot write and AI retry exhaustion leaves source health unchanged', async () => {
  const database = await openLocalPipelineDatabase({ profileId: 'ai-retry-test' });
  try {
    const store = new SqlLocalPipelineStore(database.executor);
    await store.capture(feed(authoredReport('retry-report', 'Retry text')), T0);
    const ingestion = await store.claimIngestion(T0);
    assert.ok(ingestion);
    assert.equal(await store.finishIngestion(ingestion, '2026-10-12T02:00:01.000Z', writeCanonicalRevision), true);
    const before = await sourceHealth(database.executor);

    const expired = await store.claimAi('2026-10-12T02:00:02.000Z', 1_000);
    assert.ok(expired);
    assert.deepEqual(await store.recover('2026-10-12T02:00:03.000Z'), { ingestion: 0, ai: 1 });
    let staleWrites = 0;
    assert.equal(await store.checkpoint(expired, '2026-10-12T02:00:03.001Z', 'extraction', { stale: true }, async () => {
      staleWrites += 1;
    }), false);
    assert.equal(staleWrites, 0);

    let now = '2026-10-12T02:00:33.000Z';
    const firstRetry = await store.claimAi(now);
    assert.ok(firstRetry);
    assert.equal(firstRetry.attemptCount, 2, 'lease recovery consumes the first processing attempt');
    assert.equal(await store.checkpoint(expired, '2026-10-12T02:00:33.001Z', 'extraction', { stale: true }, async () => {
      staleWrites += 1;
    }), false, 'an old token cannot write after a new lease has been issued');
    assert.equal(staleWrites, 0);
    assert.equal(await store.failAi(firstRetry, now, 'model_timeout'), 'retry');
    now = '2026-10-12T02:01:33.000Z';
    const expectedDelays = [120_000, 120_000];
    for (let attempt = 3; attempt <= 5; attempt += 1) {
      const ai = await store.claimAi(now);
      assert.ok(ai);
      assert.equal(ai.attemptCount, attempt);
      const transition = await store.failAi(ai, now, 'model_timeout');
      assert.equal(transition, attempt === 5 ? 'terminal' : 'retry');
      if (attempt < 5) {
        const nextAvailable = new Date(Date.parse(now) + expectedDelays[attempt - 3]!).toISOString();
        const blocked = await store.claimAi(new Date(Date.parse(nextAvailable) - 1).toISOString());
        assert.equal(blocked, null);
        now = nextAvailable;
      }
    }
    assert.deepEqual(await store.summary().then((summary) => summary.ai), {
      pending: 0, leased: 0, retry: 0, completed: 0, terminal: 1,
    });
    assert.deepEqual(await sourceHealth(database.executor), before,
      'AI errors must not change local source health or collection timestamps');
  } finally {
    await database.close();
  }
});

test('source-poll retries use the canonical five-attempt capped backoff policy', async () => {
  const database = await openLocalPipelineDatabase({ profileId: 'ingestion-retry-test' });
  try {
    const store = new SqlLocalPipelineStore(database.executor);
    await store.capture(feed(authoredReport('l1-retry-report', 'L1 retry text')), T0);
    let now = T0;
    const expectedDelays = [30_000, 60_000, 120_000, 120_000];
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const job = await store.claimIngestion(now);
      assert.ok(job);
      assert.equal(job.attemptCount, attempt);
      const transition = await store.failIngestion(job, now, 'l1_failed');
      assert.equal(transition, attempt === 5 ? 'terminal' : 'retry');
      if (attempt < 5) {
        const nextAvailable = new Date(Date.parse(now) + expectedDelays[attempt - 1]!).toISOString();
        assert.equal(await store.claimIngestion(new Date(Date.parse(nextAvailable) - 1).toISOString()), null);
        now = nextAvailable;
      }
    }
    assert.deepEqual(await store.summary().then((summary) => summary.ingestion), {
      pending: 0, leased: 0, retry: 0, completed: 0, terminal: 1,
    });
  } finally {
    await database.close();
  }
});

test('an AI retry for an older version does not block collection or AI for the newer version', async () => {
  const database = await openLocalPipelineDatabase({ profileId: 'ai-independent-version-test' });
  try {
    const store = new SqlLocalPipelineStore(database.executor);
    await store.capture(feed(authoredReport('independent-report', 'Version one')), T0);
    const firstIngestion = await store.claimIngestion(T0);
    assert.ok(firstIngestion);
    assert.equal(await store.finishIngestion(firstIngestion, '2026-10-12T02:00:01.000Z', writeCanonicalRevision), true);
    const firstAi = await store.claimAi('2026-10-12T02:00:02.000Z');
    assert.ok(firstAi);
    assert.equal(await store.failAi(firstAi, '2026-10-12T02:00:03.000Z', 'model_timeout'), 'retry');

    await store.capture(feed(authoredReport('independent-report', 'Version two')), '2026-10-12T02:00:04.000Z');
    const secondIngestion = await store.claimIngestion('2026-10-12T02:00:04.000Z');
    assert.ok(secondIngestion);
    assert.equal((await store.ingestionSnapshot(secondIngestion.jobId))?.version, 2);
    assert.equal(await store.finishIngestion(secondIngestion, '2026-10-12T02:00:05.000Z', writeCanonicalRevision), true);

    const secondAi = await store.claimAi('2026-10-12T02:00:06.000Z');
    assert.ok(secondAi);
    assert.equal(secondAi.snapshot.version, 2);
    assert.notEqual(secondAi.jobId, firstAi.jobId);
  } finally {
    await database.close();
  }
});

function feed(report: AuthoredReport): AuthoredFeed {
  return {
    schemaVersion: LOCAL_FEED_SCHEMA,
    datasetKind: 'synthetic',
    sourceId: LOCAL_SOURCE_ID,
    reports: [report],
  };
}

function plusMs(milliseconds: number): string {
  return new Date(Date.parse(T0) + milliseconds).toISOString();
}

function authoredReport(id: string, text: string): AuthoredReport {
  return {
    id,
    title: 'Synthetic report ' + id,
    text,
    publishedAt: '2026-10-12T01:00:00+07:00',
    observedAt: '2026-10-12T01:30:00+07:00',
  };
}

async function writeCanonicalRevision(tx: TransactionalSqlExecutor, snapshot: ReportSnapshot): Promise<void> {
  const revisions = createRepositoryPorts(tx).reportRevisions;
  const permittedTextHash = createHash('sha256').update(snapshot.text, 'utf8').digest('hex');
  await revisions.create({
    datasetKind: 'synthetic',
    reportRevisionId: snapshot.reportRevisionId,
    traceId: snapshot.traceId,
    sourceId: snapshot.sourceId,
    canonicalUrl: snapshot.canonicalUrl,
    sourceRevisionKey: snapshot.sourceRevisionKey,
    contentHash: snapshot.contentHash,
    permittedText: snapshot.text,
    permittedTextHash,
    normalizationVersion: 'local-fixture-v1',
    publishedAt: snapshot.publishedAt,
    observedAt: snapshot.observedAt,
    retrievedAt: snapshot.capturedAt,
    validFrom: null,
    validUntil: null,
    supersedesId: snapshot.supersedesId,
    revisionStatus: 'unreviewed',
    recordJson: { dataset_kind: 'synthetic', source_id: LOCAL_SOURCE_ID, stable_report_id: snapshot.id },
  });
  await revisions.createEvidenceReference({
    datasetKind: 'synthetic',
    traceId: snapshot.traceId,
    reportRevisionId: snapshot.reportRevisionId,
    permittedTextHash,
    spanStart: 0,
    spanEnd: Array.from(snapshot.text).length,
    relation: 'context',
  });
}

async function seedUnrelatedSyntheticPoll(executor: TransactionalSqlExecutor, now: string): Promise<void> {
  const traceId = 'unrelated-fixture-trace';
  await executor.query(
    `INSERT INTO waspada.traces
       (trace_id, dataset_kind, started_at, outcome, metadata)
     VALUES ($1, 'synthetic', $2, 'open', '{}'::jsonb)`,
    [traceId, now],
  );
  await executor.query(
    `INSERT INTO waspada.source_registry
       (source_id, trace_id, registry_version, display_name, source_kind, remit,
        access_method, approved_hosts, access_restrictions, reuse_basis,
        registry_status, approval_status, health_status, auto_acquisition_enabled,
        auto_publication_policy, polling_interval_seconds)
     VALUES ('unrelated-synthetic-fixture', $1, 1, 'Unrelated fixture', 'other',
        ARRAY['synthetic demonstration only'], 'manual_fixture', ARRAY[]::text[],
        ARRAY['synthetic test only'], ARRAY['authored synthetic test data'],
        'active', 'approved', 'unknown', true, 'never', 60)`,
    [traceId],
  );
  await executor.query(
    `INSERT INTO waspada.acquisition_jobs
       (job_id, dataset_kind, idempotency_key, job_kind, trace_id, source_id,
        status, attempt_count, max_attempts, available_at, created_at, updated_at)
     VALUES ('unrelated-synthetic-job', 'synthetic', 'unrelated-synthetic-key', 'source_poll',
        $1, 'unrelated-synthetic-fixture', 'pending', 0, 5, $2, $2, $2)`,
    [traceId, now],
  );
}

async function sourceHealth(executor: TransactionalSqlExecutor): Promise<readonly unknown[]> {
  const result = await executor.query<{
    health_status: string;
    last_checked_at: string | null;
    last_success_at: string | null;
  }>(
    `SELECT health_status, last_checked_at::text AS last_checked_at,
            last_success_at::text AS last_success_at
     FROM waspada.source_registry WHERE source_id = $1`,
    [LOCAL_SOURCE_ID],
  );
  return [
    result.rows[0]?.health_status,
    result.rows[0]?.last_checked_at,
    result.rows[0]?.last_success_at,
  ];
}
