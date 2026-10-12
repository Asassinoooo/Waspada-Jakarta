import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { openLocalPipelineDatabase } from './database.js';
import { createLocalPipelineStore } from './store.js';
import { createLocalPipelineProcessor } from './processor.js';
import { createLocalMockModels } from './mock-models.js';
import { parseAuthoredFeed } from './feed.js';
import { createHash } from 'node:crypto';
import { preparePermittedText } from '../../apps/worker/src/layers/l1-data-knowledge/text-preparation.js';
import { readLocalPipelinePreview } from './preview.js';
import type { SqlExecutor, TransactionalSqlExecutor } from '../../apps/db/src/sql.js';
import type { LocalPipelineStore } from './contracts.js';

interface HistoricalEvidence {
  readonly reportRevisionId: string;
  readonly evidenceRefId: string;
  readonly originId: string;
}

test('preview validates canonical evidence from an older revision outside the newest twenty', { timeout: 180_000 }, async () => {
  const models = createLocalMockModels();
  const database = await openLocalPipelineDatabase({ profileId: models.profileId });
  try {
    const store = createLocalPipelineStore(database.executor);
    let now = '2026-10-12T07:00:00.000Z';
    const processor = createLocalPipelineProcessor({
      store,
      executor: database.executor,
      ...models,
      now: () => now,
    });
    const feed = parseAuthoredFeed(await readFile(new URL('./fixtures/feed.json', import.meta.url), 'utf8'));
    const start = '2026-10-12T07:00:00.000Z';
    await store.capture(feed, start);
    await processor.processIngestion();
    await processor.processAi();
    const initial = await readLocalPipelinePreview({
      executor: database.executor,
      models: 'mock',
      scheduler: { status: 'idle', polls: 0, collectionFailures: 0 },
      generatedAt: '2026-10-12T07:01:00.000Z',
    });
    assert.equal(initial.summary.ingestion.completed, 1);
    assert.equal(initial.summary.ai.completed, 1);
    assert.equal(initial.summary.proposals, 1);
    assert.deepEqual(new Set(initial.reports[0]?.proposal?.claims[0]?.evidence.map((entry) => entry.relation)),
      new Set(['supports', 'contradicts']));

    const oldValid = await addHistoricalEvidence(store, database.executor, {
      id: 'local-preview-old-valid',
      title: 'Older synthetic canonical source',
      text: 'A previous private synthetic revision supports a test claim.',
    });

    const baseReport = feed.reports[0]!;
    const latestCapturedAt = '2026-10-12T07:02:00.000Z';
    now = latestCapturedAt;
    for (let version = 2; version <= 21; version++) {
      await store.capture({
        ...feed,
        reports: [{ ...baseReport, text: `${baseReport.text}\nPembaruan sintetis versi ${version}.` }],
      }, latestCapturedAt);
    }
    await database.executor.query(
      `UPDATE waspada.acquisition_jobs AS job
       SET available_at = '2100-01-01T00:00:00Z'::timestamptz
       FROM waspada.local_report_inbox AS inbox
       JOIN waspada.local_report_snapshots AS snapshot ON snapshot.snapshot_id = inbox.snapshot_id
       WHERE job.job_id = inbox.source_poll_job_id
         AND snapshot.dataset_kind = 'synthetic' AND snapshot.source_id = 'local-authored-api'
         AND snapshot.stable_report_id = 'local-preview-old-valid'`,
    );
    for (let index = 0; index < 20; index++) await processor.processIngestion();
    await database.executor.query(
      `UPDATE waspada.local_ai_jobs AS job
       SET available_at = '2100-01-01T00:00:00Z'::timestamptz
       FROM waspada.local_report_snapshots AS snapshot
       WHERE job.snapshot_id = snapshot.snapshot_id
         AND snapshot.dataset_kind = 'synthetic' AND snapshot.source_id = 'local-authored-api'
         AND snapshot.stable_report_id = $1 AND snapshot.version BETWEEN 2 AND 20`,
      [baseReport.id],
    );
    await processor.processAi();

    const lineage = await database.executor.query<{
      version: number;
      report_revision_id: string;
      candidate_id: string;
    }>(
      `SELECT version, report_revision_id, candidate_id
       FROM waspada.local_report_snapshots
       WHERE dataset_kind = 'synthetic' AND source_id = 'local-authored-api'
         AND stable_report_id = $1 AND version IN (1, 21)`,
      [baseReport.id],
    );
    const oldSnapshot = lineage.rows.find((row) => Number(row.version) === 1)!;
    const latestSnapshot = lineage.rows.find((row) => Number(row.version) === 21)!;
    assert.ok(oldSnapshot && latestSnapshot);
    const currentProposal = await database.executor.query<{ proposal_id: string }>(
      `SELECT proposal_id FROM waspada.event_proposals
       WHERE dataset_kind = 'synthetic' AND candidate_id = $1`, [latestSnapshot.candidate_id],
    );
    const proposalId = currentProposal.rows[0]?.proposal_id;
    assert.ok(proposalId);

    await appendReferenceClaim(database.executor, proposalId, {
      claimId: 'claim-older-valid-reference',
      claimText: 'A private older source remains tied to its canonical revision.',
      evidence: oldValid,
    });
    const preview = await readLocalPipelinePreview({
      executor: database.executor,
      models: 'mock',
      scheduler: { status: 'completed', polls: 21, collectionFailures: 0 },
      generatedAt: '2026-10-12T08:00:00.000Z',
    });
    assert.equal(preview.truncated, true);
    assert.equal(preview.reports.length, 20);
    assert.equal(preview.reports.some((entry) => entry.version === 1), false);
    const latestReport = preview.reports.find((entry) => entry.version === 21)!;
    assert.ok(latestReport.proposal);
    assert.ok(latestReport.proposal.claims.find((claim) => claim.claimId === 'claim-older-valid-reference')
      ?.evidence.some((entry) => entry.reportRevisionId === oldValid.reportRevisionId));
    await assert.rejects(readLocalPipelinePreview({
      executor: tamperEvidenceRevisionText(database.executor, oldValid.reportRevisionId),
      models: 'mock',
      scheduler: { status: 'completed', polls: 21, collectionFailures: 0 },
      generatedAt: '2026-10-12T08:00:00.000Z',
    }), /local_preview_unavailable/);
    assert.equal((await readLocalPipelinePreview({
      executor: database.executor,
      models: 'mock',
      scheduler: { status: 'completed', polls: 21, collectionFailures: 0 },
      generatedAt: '2026-10-12T08:00:00.000Z',
    })).reports.length, 20);

    await assert.rejects(readLocalPipelinePreview({
      executor: omitAiStage(database.executor, 'extraction'),
      models: 'mock',
      scheduler: { status: 'completed', polls: 21, collectionFailures: 0 },
      generatedAt: '2026-10-12T08:00:00.000Z',
    }), /local_preview_unavailable/);
    assert.equal((await readLocalPipelinePreview({
      executor: database.executor,
      models: 'mock',
      scheduler: { status: 'completed', polls: 21, collectionFailures: 0 },
      generatedAt: '2026-10-12T08:00:00.000Z',
    })).summary.ai.completed, 2);
    await assert.rejects(readLocalPipelinePreview({
      executor: omitAiStage(database.executor, 'proposal'),
      models: 'mock',
      scheduler: { status: 'completed', polls: 21, collectionFailures: 0 },
      generatedAt: '2026-10-12T08:00:00.000Z',
    }), /local_preview_unavailable/);
    assert.equal((await readLocalPipelinePreview({
      executor: database.executor,
      models: 'mock',
      scheduler: { status: 'completed', polls: 21, collectionFailures: 0 },
      generatedAt: '2026-10-12T08:00:00.000Z',
    })).summary.ai.completed, 2);

    now = '2026-10-12T08:01:00.000Z';
    await store.capture({
      ...feed,
      reports: [{ ...baseReport, text: `${baseReport.text}\nPembaruan sintetis versi 22.` }],
    }, now);
    await processor.processIngestion();
    const pendingJob = await database.executor.query<{ job_id: string }>(
      `SELECT job.job_id FROM waspada.local_ai_jobs AS job
       JOIN waspada.local_report_snapshots AS snapshot ON snapshot.snapshot_id = job.snapshot_id
       WHERE snapshot.dataset_kind = 'synthetic' AND snapshot.source_id = 'local-authored-api'
         AND snapshot.stable_report_id = $1 AND snapshot.version = 22
         AND job.status = 'pending' AND job.attempt_count = 0`,
      [baseReport.id],
    );
    assert.equal(pendingJob.rows.length, 1);
    const pendingBaseline = await readLocalPipelinePreview({
      executor: database.executor,
      models: 'mock',
      scheduler: { status: 'completed', polls: 21, collectionFailures: 0 },
      generatedAt: '2026-10-12T08:02:00.000Z',
    });
    assert.equal(pendingBaseline.reports.find((report) => report.version === 22)?.ai?.status, 'pending');
    assert.deepEqual(pendingBaseline.reports.find((report) => report.version === 22)?.stages, []);
    await database.executor.query(
      `INSERT INTO waspada.local_ai_receipts (job_id, stage, receipt_json, receipt_sha256, recorded_at)
       VALUES ($1, 'extraction', '{}'::jsonb, $2, $3::timestamptz)`,
      [pendingJob.rows[0]!.job_id, createHash('sha256').update('{}').digest('hex'), now],
    );
    await assert.rejects(readLocalPipelinePreview({
      executor: database.executor,
      models: 'mock',
      scheduler: { status: 'completed', polls: 21, collectionFailures: 0 },
      generatedAt: '2026-10-12T08:02:00.000Z',
    }), /local_preview_unavailable/);
  } finally {
    await database.close();
  }
});

function omitAiStage(executor: TransactionalSqlExecutor, omittedStage: string): TransactionalSqlExecutor {
  const wrap = (inner: SqlExecutor): SqlExecutor => ({
    async query<Row extends object>(statement: string, parameters?: readonly unknown[]) {
      const result = await inner.query<Row>(statement, parameters);
      if (!statement.includes('FROM waspada.local_ai_receipts')) return result;
      return { rows: result.rows.filter((row) => (row as Record<string, unknown>).stage !== omittedStage) };
    },
    execute: (statement) => inner.execute(statement),
  });
  return {
    ...wrap(executor),
    async transaction<Result>(work: (transaction: SqlExecutor) => Promise<Result>): Promise<Result> {
      return executor.transaction((transaction) => work(wrap(transaction)));
    },
  };
}

function tamperEvidenceRevisionText(executor: TransactionalSqlExecutor, revisionId: string): TransactionalSqlExecutor {
  const wrap = (inner: SqlExecutor): SqlExecutor => ({
    async query<Row extends object>(statement: string, parameters?: readonly unknown[]) {
      const result = await inner.query<Row>(statement, parameters);
      if (!statement.includes('FROM waspada.proposal_claim_evidence AS link')) return result;
      return {
        rows: result.rows.map((row) => {
          const value = row as Record<string, unknown>;
          return value.report_revision_id === revisionId && typeof value.revision_text === 'string'
            ? { ...value, revision_text: `${value.revision_text} tampered` } as Row
            : row;
        }),
      };
    },
    execute: (statement) => inner.execute(statement),
  });
  return {
    ...wrap(executor),
    async transaction<Result>(work: (transaction: SqlExecutor) => Promise<Result>): Promise<Result> {
      return executor.transaction((transaction) => work(wrap(transaction)));
    },
  };
}

async function addHistoricalEvidence(
  store: LocalPipelineStore,
  executor: TransactionalSqlExecutor,
  input: { readonly id: string; readonly title: string; readonly text: string },
): Promise<HistoricalEvidence> {
  const capturedAt = '2026-10-12T06:00:00.000Z';
  const feed = parseAuthoredFeed(JSON.stringify({
    schemaVersion: 'local-synthetic-api-v1',
    datasetKind: 'synthetic',
    sourceId: 'local-authored-api',
    reports: [{ id: input.id, title: input.title, text: input.text, publishedAt: null, observedAt: null }],
  }));
  await store.capture(feed, capturedAt);
  const snapshotResult = await executor.query<{
    snapshot_id: string;
    report_revision_id: string;
    trace_id: string;
  }>(
    `SELECT snapshot_id, report_revision_id, trace_id FROM waspada.local_report_snapshots
     WHERE dataset_kind = 'synthetic' AND source_id = 'local-authored-api' AND stable_report_id = $1`,
    [input.id],
  );
  const snapshot = snapshotResult.rows[0];
  assert.ok(snapshot);
  const prepared = await preparePermittedText(input.text);
  const permittedTextHash = prepared.permittedTextHash;
  await executor.query(
    `INSERT INTO waspada.report_revisions
       (dataset_kind, report_revision_id, trace_id, source_id, canonical_url,
        source_revision_key, content_hash, permitted_text, permitted_text_hash,
        normalization_version, retrieved_at, revision_status)
     SELECT 'synthetic', snapshot.report_revision_id, snapshot.trace_id, snapshot.source_id,
            snapshot.canonical_url, snapshot.source_revision_key, snapshot.content_hash,
            $2, $3, $4, snapshot.captured_at_text::timestamptz, 'unreviewed'
     FROM waspada.local_report_snapshots AS snapshot WHERE snapshot.snapshot_id = $1`,
    [snapshot.snapshot_id, prepared.permittedText, permittedTextHash, prepared.normalizationVersion],
  );
  const evidenceRef = await executor.query<{ evidence_ref_id: string }>(
    `INSERT INTO waspada.evidence_references
       (dataset_kind, trace_id, report_revision_id, permitted_text_hash,
        span_start, span_end, offset_unit, relation)
     VALUES ('synthetic', $1, $2, $3, 0, $4, 'unicode_code_points', 'supports')
     RETURNING evidence_ref_id::text AS evidence_ref_id`,
    [snapshot.trace_id, snapshot.report_revision_id, permittedTextHash, Array.from(prepared.permittedText).length],
  );
  const evidenceRefId = evidenceRef.rows[0]?.evidence_ref_id;
  assert.ok(evidenceRefId);
  const originId = `origin-${input.id}`;
  await executor.query(
    `INSERT INTO waspada.evidence_origins
       (dataset_kind, origin_id, trace_id, origin_kind, source_id, lineage_relation, independence_status)
     VALUES ('synthetic', $1, $2, 'unknown', 'local-authored-api', 'unknown', 'unknown')`,
    [originId, snapshot.trace_id],
  );
  await executor.query(
    `INSERT INTO waspada.origin_report_revisions (dataset_kind, origin_id, report_revision_id)
     VALUES ('synthetic', $1, $2)`, [originId, snapshot.report_revision_id],
  );
  await executor.query(
    `INSERT INTO waspada.origin_evidence (dataset_kind, origin_id, evidence_ref_id)
     VALUES ('synthetic', $1, $2::bigint)`, [originId, evidenceRefId],
  );
  return { reportRevisionId: snapshot.report_revision_id, evidenceRefId, originId };
}

async function appendReferenceClaim(
  executor: TransactionalSqlExecutor,
  proposalId: string,
  input: { readonly claimId: string; readonly claimText: string; readonly evidence: HistoricalEvidence },
): Promise<void> {
  await executor.query(
    `INSERT INTO waspada.proposal_claims
       (dataset_kind, proposal_id, claim_id, support_assessment, evidence_label, claim_text, record_json)
     VALUES ('synthetic', $1, $2, 'uncertain', 'under_review', $3, '{}'::jsonb)`,
    [proposalId, input.claimId, input.claimText],
  );
  await executor.query(
    `INSERT INTO waspada.proposal_claim_evidence
       (dataset_kind, proposal_id, claim_id, evidence_kind, evidence_ref_id)
     VALUES ('synthetic', $1, $2, 'support', $3::bigint)`,
    [proposalId, input.claimId, input.evidence.evidenceRefId],
  );
  await executor.query(
    `INSERT INTO waspada.proposal_claim_origins
       (dataset_kind, proposal_id, claim_id, origin_id)
     VALUES ('synthetic', $1, $2, $3)`,
    [proposalId, input.claimId, input.evidence.originId],
  );
}
