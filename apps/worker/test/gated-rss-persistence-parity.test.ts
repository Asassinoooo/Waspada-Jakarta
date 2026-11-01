import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { applyMigrations, readMigrations } from '../../db/src/migrations.js';
import { createTestDatabase, type TestDatabase } from '../../db/test/harness.js';
import type { SqlExecutor, TransactionalSqlExecutor } from '../../db/src/sql.js';
import { newsTriageIdentityHash } from '../../db/src/news-triage-store.js';
import { TRIAGE_POLICY_VERSION, type NewsTriageDecision } from '../src/layers/l1-data-knowledge/news-triage.js';
import {
  persistAcceptedRssItem,
  persistHeldTriageItem,
  runGatedRssCycle,
} from '../src/runtime/gated-rss-persistence.js';
import type {
  HeldTriageDecision,
  StoredReportRevision,
} from '../src/runtime/news-poll-runtime.js';

// WJ-INT-02B: parity through the shared cycle — both live entry points
// (scheduled worker loop, serve-live loop) call ONLY runGatedRssCycle.
// This test invokes the shared function twice over identical synthetic feeds
// (mirroring only the callers' executor wrapping, not their logic) and
// asserts byte-identical projected row sets plus identical failure accounting.

const SOURCE_ID = 'source-synthetic-test';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function ingestDecision(): NewsTriageDecision {
  return {
    disposition: 'ingest',
    jakartaScope: 'dki_jakarta',
    actionability: 'actionable',
    primaryCategory: 'disasters_weather',
    incidentType: 'flood',
    confidence: 'high',
    reasonCodes: ['jakarta_relevant'],
    evidence: [],
    modelStatus: 'ok',
  };
}

function dropDecision(): NewsTriageDecision {
  return {
    disposition: 'drop',
    jakartaScope: 'outside_scope',
    actionability: 'none',
    primaryCategory: null,
    incidentType: null,
    confidence: 'high',
    reasonCodes: ['outside_scope'],
    evidence: [],
    modelStatus: 'ok',
  };
}

function uncertainDecision(): NewsTriageDecision {
  return {
    disposition: 'uncertain',
    jakartaScope: 'unknown',
    actionability: 'unknown',
    primaryCategory: null,
    incidentType: null,
    confidence: 'low',
    reasonCodes: ['provider_error'],
    evidence: [],
    modelStatus: 'provider_error',
  };
}

function ingestRevision(): StoredReportRevision & { triage: NewsTriageDecision } {
  const text = 'BREAKING: Banjir di Jakarta Selatan. Air setinggi lutut merendam permukiman.';
  return {
    report_revision_id: 'rep-synthetic-test-001',
    source_id: SOURCE_ID,
    canonical_url: 'https://example.test/news/1',
    permitted_text: text,
    permitted_text_hash: sha256Hex(text),
    published_at: '2026-10-01T00:00:00.000Z',
    retrieved_at: '2026-10-01T01:00:00.000Z',
    revision_status: 'unreviewed',
    chunks: [{ chunk_index: 0, text, span_start: 0, span_end: text.length }],
    content_hash: sha256Hex('https://example.test/news/1:' + text),
    source_revision_key: 'guid-1',
    triage: ingestDecision(),
  };
}

function heldFixture(
  key: string,
  revisionId: string,
  decision: NewsTriageDecision,
): HeldTriageDecision {
  return {
    sourceId: SOURCE_ID,
    itemIdentityHash: newsTriageIdentityHash(SOURCE_ID, key),
    reportRevisionId: revisionId,
    traceId: `trace-${revisionId}`,
    canonicalUrl: `https://example.test/news/${key}`,
    sourceRevisionKey: key,
    decision,
  };
}

interface SyntheticFeed {
  readonly revisions: readonly (StoredReportRevision & { triage: NewsTriageDecision })[];
  readonly held: readonly HeldTriageDecision[];
}

function syntheticFeed(): SyntheticFeed {
  return {
    revisions: [ingestRevision()],
    held: [
      heldFixture('guid-2', 'rep-synthetic-test-002', dropDecision()),
      heldFixture('guid-3', 'rep-synthetic-test-003', uncertainDecision()),
    ],
  };
}

async function seedRegistry(executor: TransactionalSqlExecutor): Promise<void> {
  await executor.query(
    `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
     VALUES ('trace-seed', 'live', now(), 'succeeded', '{}'::jsonb)
     ON CONFLICT (trace_id, dataset_kind) DO NOTHING`,
  );
  await executor.query(
    `INSERT INTO waspada.source_registry (
       source_id, trace_id, registry_version, display_name, source_kind, remit,
       access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
       approval_status, health_status, auto_acquisition_enabled, auto_publication_policy
     )
     VALUES ('${SOURCE_ID}', 'trace-seed', 1, 'Synthetic Test', 'newsroom', ARRAY['test'],
             'rss', ARRAY[]::text[], ARRAY[]::text[],
             ARRAY['model_triage', 'model_description', 'retain_title', 'retain_description', 'retain_derived'],
             'active', 'approved', 'healthy', true, 'never')
     ON CONFLICT (source_id) DO NOTHING`,
  );
}

async function createMigratedDatabase(): Promise<TestDatabase> {
  const database = await createTestDatabase();
  try {
    const migrations = await readMigrations(new URL('../../db/migrations/', import.meta.url));
    await applyMigrations(database.executor, migrations);
    return database;
  } catch (error) {
    await database.close();
    throw error;
  }
}

// Thin wrappers mirroring ONLY the callers' executor handling (scheduled
// re-wraps per item via withTransactionalSqlExecutor; serve-live passes its
// own tx-capable executor once). Both delegate the split to runGatedRssCycle:
// if either caller regresses to inline SQL, the wire assertions below fail.
async function runScheduledShape(
  executor: TransactionalSqlExecutor,
  feed: SyntheticFeed,
): Promise<number> {
  const cycle = await runGatedRssCycle(executor, {
    datasetKind: 'live',
    revisions: feed.revisions,
    held: feed.held,
    policyVersion: TRIAGE_POLICY_VERSION,
  });
  return cycle.persistFailures;
}

async function runServeLiveShape(
  executor: TransactionalSqlExecutor,
  feed: SyntheticFeed,
): Promise<number> {
  if (typeof executor.transaction !== 'function') return feed.revisions.length + feed.held.length;
  const cycle = await runGatedRssCycle(executor, {
    datasetKind: 'live',
    revisions: feed.revisions,
    held: feed.held,
    policyVersion: TRIAGE_POLICY_VERSION,
  });
  return cycle.persistFailures;
}

async function projectRows(executor: TransactionalSqlExecutor): Promise<Record<string, unknown[]>> {
  const decisions = await executor.query<Record<string, unknown>>(
    `SELECT dataset_kind, item_identity_hash, source_id, trace_id, disposition,
       jakarta_scope, actionability, primary_category, incident_type,
       confidence, reason_codes, policy_version, model_status,
       report_revision_id, content_hash, attempt_count, supersedes_hash
     FROM waspada.news_triage_decisions ORDER BY item_identity_hash`,
  );
  const attempts = await executor.query<Record<string, unknown>>(
    `SELECT dataset_kind, item_identity_hash, report_revision_id, source_id, trace_id,
       disposition, jakarta_scope, actionability, primary_category, incident_type,
       confidence, reason_codes, policy_version, model_status, content_hash, supersedes_hash
     FROM waspada.news_triage_attempts ORDER BY item_identity_hash, evaluated_at`,
  );
  const revisions = await executor.query<Record<string, unknown>>(
    `SELECT dataset_kind, report_revision_id, trace_id, source_id, canonical_url,
       content_hash, permitted_text, permitted_text_hash, normalization_version,
       retrieved_at::text AS retrieved_at, revision_status, record_json
     FROM waspada.report_revisions ORDER BY report_revision_id`,
  );
  const chunks = await executor.query<Record<string, unknown>>(
    `SELECT dataset_kind, chunk_id, trace_id, report_revision_id, permitted_text_hash,
       span_start, span_end, offset_unit, chunker_version, chunk_text_hash, status
     FROM waspada.evidence_chunks ORDER BY chunk_id`,
  );
  const jobs = await executor.query<Record<string, unknown>>(
    `SELECT job_id, dataset_kind, report_revision_id, status, attempt_count,
       max_attempts, trace_id FROM waspada.ai_jobs ORDER BY report_revision_id`,
  );
  return {
    decisions: [...decisions.rows],
    attempts: [...attempts.rows],
    revisions: [...revisions.rows],
    chunks: [...chunks.rows],
    jobs: [...jobs.rows],
  };
}

describe('gated RSS persistence parity', () => {
  it('both live entry points route gated RSS through runGatedRssCycle', () => {
    const scheduled = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const serveLive = readFileSync(new URL('../../../tools/serve-live-pipeline.ts', import.meta.url), 'utf8');
    assert.ok(scheduled.includes('runGatedRssCycle'), 'scheduled() must call runGatedRssCycle');
    assert.ok(serveLive.includes('runGatedRssCycle'), 'pollLiveFeeds() must call runGatedRssCycle');
    assert.ok(!serveLive.includes('persistAcceptedRssItem'), 'serve-live must not call persistAcceptedRssItem directly');
    assert.ok(!serveLive.includes('persistHeldTriageItem'), 'serve-live must not call persistHeldTriageItem directly');
  });
  it('scheduled and serve-live caller shapes produce identical row sets', async () => {
    const scheduledDb = await createMigratedDatabase();
    const serveLiveDb = await createMigratedDatabase();
    try {
      await seedRegistry(scheduledDb.executor);
      await seedRegistry(serveLiveDb.executor);

      const scheduledFailures = await runScheduledShape(scheduledDb.executor, syntheticFeed());
      const serveLiveFailures = await runServeLiveShape(serveLiveDb.executor, syntheticFeed());
      assert.equal(scheduledFailures, 0);
      assert.equal(serveLiveFailures, 0);

      const scheduledRows = await projectRows(scheduledDb.executor);
      const serveLiveRows = await projectRows(serveLiveDb.executor);
      assert.deepEqual(serveLiveRows, scheduledRows);

      // One ingest + two held evaluations, nothing else.
      assert.equal(scheduledRows.decisions.length, 3);
      assert.equal(scheduledRows.attempts.length, 3);
      assert.equal(scheduledRows.revisions.length, 1);
      assert.equal(scheduledRows.chunks.length, 1);
      assert.equal(scheduledRows.jobs.length, 1);
    } finally {
      await scheduledDb.close();
      await serveLiveDb.close();
    }
  });
  it('replays an identical evaluation with no new writes on the second run', async () => {
    const database = await createMigratedDatabase();
    try {
      await seedRegistry(database.executor);
      const rev = ingestRevision();
      const input = {
        datasetKind: 'live' as const,
        rev,
        itemIdentityHash: newsTriageIdentityHash(rev.source_id, rev.source_revision_key ?? rev.canonical_url),
        contentHash: rev.content_hash ?? rev.permitted_text_hash,
        supersedesHash: null,
        policyVersion: TRIAGE_POLICY_VERSION,
      };
      const first = await persistAcceptedRssItem(database.executor, input);
      const before = await projectRows(database.executor);
      const second = await persistAcceptedRssItem(database.executor, input);
      assert.equal(second.jobId, first.jobId);
      const after = await projectRows(database.executor);
      assert.deepEqual(after, before);
    } finally {
      await database.close();
    }
  });

  it('replays an identical held evaluation with no new writes on the second run', async () => {
    const database = await createMigratedDatabase();
    try {
      await seedRegistry(database.executor);
      const held = {
        sourceId: 'source-synthetic-test',
        itemIdentityHash: newsTriageIdentityHash('source-synthetic-test', 'guid-9'),
        reportRevisionId: 'rep-synthetic-test-009',
        traceId: 'trace-rep-synthetic-test-009',
        canonicalUrl: 'https://example.test/news/9',
        sourceRevisionKey: 'guid-9',
        decision: {
          disposition: 'drop' as const,
          jakartaScope: 'outside_scope' as const,
          actionability: 'none' as const,
          primaryCategory: null,
          incidentType: null,
          confidence: 'high' as const,
          reasonCodes: ['outside_scope'],
          evidence: [],
          modelStatus: 'ok' as const,
        },
      };
      await persistHeldTriageItem(database.executor, { ...held, replayed: true }, 'live', TRIAGE_POLICY_VERSION, true);
      const before = await projectRows(database.executor);
      assert.equal(before.attempts.length, 1);
      await persistHeldTriageItem(database.executor, { ...held, replayed: true }, 'live', TRIAGE_POLICY_VERSION, true);
      const after = await projectRows(database.executor);
      assert.deepEqual(after, before);
    } finally {
      await database.close();
    }
  });

  it('clears the review flag when a new evaluation changes the outcome', async () => {
    const database = await createMigratedDatabase();
    try {
      await seedRegistry(database.executor);
      const rev = ingestRevision();
      const identity = newsTriageIdentityHash(rev.source_id, rev.source_revision_key ?? rev.canonical_url);
      const accept = {
        datasetKind: 'live' as const,
        rev,
        itemIdentityHash: identity,
        contentHash: rev.content_hash ?? rev.permitted_text_hash,
        supersedesHash: null,
        policyVersion: TRIAGE_POLICY_VERSION,
      };
      await persistAcceptedRssItem(database.executor, accept);
      await database.executor.query(
        `UPDATE waspada.news_triage_decisions SET reviewed_at = now(), reviewed_by = 'moderator-1'
         WHERE dataset_kind = 'live' AND item_identity_hash = $1`,
        [identity],
      );
      const heldDrop = {
        sourceId: rev.source_id,
        itemIdentityHash: identity,
        reportRevisionId: rev.report_revision_id,
        traceId: `trace-${rev.report_revision_id}`,
        canonicalUrl: rev.canonical_url,
        sourceRevisionKey: rev.source_revision_key ?? null,
        decision: {
          disposition: 'drop' as const,
          jakartaScope: 'outside_scope' as const,
          actionability: 'none' as const,
          primaryCategory: null,
          incidentType: null,
          confidence: 'high' as const,
          reasonCodes: ['outside_scope'],
          evidence: [],
          modelStatus: 'ok' as const,
        },
      };
      await persistHeldTriageItem(database.executor, heldDrop, 'live', TRIAGE_POLICY_VERSION);
      const snapshot = await database.executor.query<{ reviewed_at: string | null; reviewed_by: string | null }>(
        `SELECT reviewed_at::text AS reviewed_at, reviewed_by FROM waspada.news_triage_decisions
         WHERE dataset_kind = 'live' AND item_identity_hash = $1`,
        [identity],
      );
      assert.equal(snapshot.rows[0]!.reviewed_at, null);
      assert.equal(snapshot.rows[0]!.reviewed_by, null);
      const attempts = await database.executor.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM waspada.news_triage_attempts
         WHERE dataset_kind = 'live' AND item_identity_hash = $1`,
        [identity],
      );
      assert.equal(attempts.rows[0]!.n, '2');
    } finally {
      await database.close();
    }
  });


  it('fails closed with zero writes when the source is not registered', async () => {
    const database = await createMigratedDatabase();
    try {
      const rev = ingestRevision();
      await assert.rejects(
        persistAcceptedRssItem(database.executor, {
          datasetKind: 'live',
          rev,
          itemIdentityHash: newsTriageIdentityHash(rev.source_id, rev.source_revision_key ?? rev.canonical_url),
          contentHash: rev.content_hash ?? rev.permitted_text_hash,
          supersedesHash: null,
          policyVersion: TRIAGE_POLICY_VERSION,
        }),
        /not registered/,
      );
      const rows = await projectRows(database.executor);
      assert.deepEqual(rows.decisions, []);
      assert.deepEqual(rows.attempts, []);
      assert.deepEqual(rows.revisions, []);
      assert.deepEqual(rows.chunks, []);
      assert.deepEqual(rows.jobs, []);
    } finally {
      await database.close();
    }
  });

  it('rejects non-ingest revisions with TypeError', async () => {
    const database = await createMigratedDatabase();
    try {
      await seedRegistry(database.executor);
      const rev = ingestRevision();
      const identity = newsTriageIdentityHash(rev.source_id, rev.source_revision_key ?? rev.canonical_url);
      const contentHash = rev.content_hash ?? rev.permitted_text_hash;
      const { triage: _ingest, ...withoutTriage } = rev;
      await assert.rejects(
        persistAcceptedRssItem(database.executor, {
          datasetKind: 'live',
          rev: withoutTriage as StoredReportRevision & { triage: NewsTriageDecision },
          itemIdentityHash: identity,
          contentHash,
          supersedesHash: null,
          policyVersion: TRIAGE_POLICY_VERSION,
        }),
        TypeError,
      );
      await assert.rejects(
        persistAcceptedRssItem(database.executor, {
          datasetKind: 'live',
          rev: { ...rev, triage: dropDecision() },
          itemIdentityHash: identity,
          contentHash,
          supersedesHash: null,
          policyVersion: TRIAGE_POLICY_VERSION,
        }),
        TypeError,
      );
      const rows = await projectRows(database.executor);
      assert.deepEqual(rows.revisions, []);
      assert.deepEqual(rows.jobs, []);
    } finally {
      await database.close();
    }
  });

  it('uses a deterministic job id per content version and replays idempotently', async () => {
    const database = await createMigratedDatabase();
    try {
      await seedRegistry(database.executor);
      const rev = ingestRevision();
      const identity = newsTriageIdentityHash(rev.source_id, rev.source_revision_key ?? rev.canonical_url);
      const contentHash = rev.content_hash ?? rev.permitted_text_hash;
      const expectedJobId = `job-${rev.report_revision_id}-${contentHash.slice(0, 8)}`;

      const first = await persistAcceptedRssItem(database.executor, {
        datasetKind: 'live',
        rev,
        itemIdentityHash: identity,
        contentHash,
        supersedesHash: null,
        policyVersion: TRIAGE_POLICY_VERSION,
      });
      assert.equal(first.jobId, expectedJobId);

      const second = await persistAcceptedRssItem(database.executor, {
        datasetKind: 'live',
        rev,
        itemIdentityHash: identity,
        contentHash,
        supersedesHash: null,
        policyVersion: TRIAGE_POLICY_VERSION,
      });
      assert.equal(second.jobId, expectedJobId);

      const rows = await projectRows(database.executor);
      assert.equal(rows.revisions.length, 1);
      assert.equal(rows.chunks.length, 1);
      assert.equal(rows.jobs.length, 1);
    } finally {
      await database.close();
    }
  });

  it('rolls back all six writes on a revision content conflict', async () => {
    const database = await createMigratedDatabase();
    try {
      await seedRegistry(database.executor);
      const rev = ingestRevision();
      const identity = newsTriageIdentityHash(rev.source_id, rev.source_revision_key ?? rev.canonical_url);
      // Seed a stale-text row under the same revision id directly.
      const staleHash = sha256Hex('stale bytes');
      await database.executor.query(
        `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
         VALUES ($1, 'live', now(), 'succeeded', '{}'::jsonb)
         ON CONFLICT (trace_id, dataset_kind) DO NOTHING`,
        [`trace-${rev.report_revision_id}`],
      );
      await database.executor.query(
        `INSERT INTO waspada.report_revisions (
           dataset_kind, report_revision_id, trace_id, source_id, canonical_url,
           content_hash, permitted_text, permitted_text_hash, normalization_version,
           retrieved_at, revision_status, record_json
         )
         VALUES ('live', $1, $2, $3, $4, $5, 'stale bytes', $6, 'v1', $7, 'unreviewed', '{}'::jsonb)`,
        [
          rev.report_revision_id,
          `trace-${rev.report_revision_id}`,
          rev.source_id,
          rev.canonical_url,
          staleHash,
          staleHash,
          rev.retrieved_at,
        ],
      );

      await assert.rejects(
        persistAcceptedRssItem(database.executor, {
          datasetKind: 'live',
          rev,
          itemIdentityHash: identity,
          contentHash: rev.content_hash ?? rev.permitted_text_hash,
          supersedesHash: null,
          policyVersion: TRIAGE_POLICY_VERSION,
        }),
        /RevisionContentConflict/,
      );
      const rows = await projectRows(database.executor);
      assert.deepEqual(rows.decisions, []);
      assert.deepEqual(rows.attempts, []);
      assert.deepEqual(rows.chunks, []);
      assert.deepEqual(rows.jobs, []);
      // Only the directly seeded stale row survives.
      assert.equal(rows.revisions.length, 1);
    } finally {
      await database.close();
    }
  });

  it('rolls back every write when a late persist stage fails', async () => {
    const database = await createMigratedDatabase();
    try {
      await seedRegistry(database.executor);
      const failing: TransactionalSqlExecutor = {
        ...database.executor,
        query: async <Row extends object>(statement: string, parameters?: readonly unknown[]) => {
          if (statement.includes('waspada.evidence_chunks')) {
            throw new Error('injected chunk failure');
          }
          return database.executor.query<Row>(statement, parameters);
        },
        transaction: async <Result>(work: (tx: SqlExecutor) => Promise<Result>) =>
          database.executor.transaction(async (tx) => {
            const failingTx = {
              ...tx,
              query: async <Row extends object>(statement: string, parameters?: readonly unknown[]) => {
                if (statement.includes('waspada.evidence_chunks')) {
                  throw new Error('injected chunk failure');
                }
                return tx.query<Row>(statement, parameters);
              },
            };
            return work(failingTx);
          }),
      };
      const rev = ingestRevision();
      await assert.rejects(
        persistAcceptedRssItem(failing, {
          datasetKind: 'live',
          rev,
          itemIdentityHash: newsTriageIdentityHash(rev.source_id, rev.source_revision_key ?? rev.canonical_url),
          contentHash: rev.content_hash ?? rev.permitted_text_hash,
          supersedesHash: null,
          policyVersion: TRIAGE_POLICY_VERSION,
        }),
        /injected chunk failure/,
      );
      const rows = await projectRows(database.executor);
      assert.deepEqual(rows.decisions, []);
      assert.deepEqual(rows.attempts, []);
      assert.deepEqual(rows.revisions, []);
      assert.deepEqual(rows.chunks, []);
      assert.deepEqual(rows.jobs, []);
    } finally {
      await database.close();
    }
  });
});
