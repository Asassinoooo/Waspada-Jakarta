import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import {
  newsTriageIdentityHash,
  recordTriageDecision,
  recordTriageAttempt,
  readTriageDecision,
  readTriageDecisionForRevision,
  readLatestAttemptForRevision,
  readUncertainTriage,
  markTriageReviewed,
  NEWS_TRIAGE_POLICY_VERSION,
} from '../src/news-triage-store.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

describe('WJ-INT-02 news triage decisions: audit-only persistence, idempotent upsert', () => {
  let db: TestDatabase;

  before(async () => {
    db = await createTestDatabase();
    const migrations = await readMigrations(new URL('../migrations/', import.meta.url));
    await applyMigrations(db.executor, migrations);
  });

  after(async () => {
    await db?.close();
  });

  it('records an ingest decision with canonical category and reads it back', async () => {
    const hash = newsTriageIdentityHash('source-antara-metro', 'feed-7001');
    const row = await recordTriageDecision(db.executor, {
      datasetKind: 'synthetic',
      itemIdentityHash: hash,
      sourceId: 'source-antara-metro',
      traceId: 'trace-triage-001',
      disposition: 'ingest',
      jakartaScope: 'dki_jakarta',
      actionability: 'actionable',
      primaryCategory: 'fires_infrastructure_hazards',
      incidentType: 'kebakaran rumah',
      confidence: 'high',
      reasonCodes: ['triage_v1_ingest'],
      modelStatus: 'ok',
    });
    assert.equal(row.disposition, 'ingest');
    assert.equal(row.primaryCategory, 'fires_infrastructure_hazards');
    assert.equal(row.policyVersion, NEWS_TRIAGE_POLICY_VERSION);

    const reread = await readTriageDecision(db.executor, 'synthetic', hash);
    assert.equal(reread?.disposition, 'ingest');
    assert.equal(reread?.itemIdentityHash, hash);
  });

  it('upserts on repeat polling without duplicate rows (idempotency)', async () => {
    const hash = newsTriageIdentityHash('source-antara-metro', 'feed-7002');
    const base = {
      datasetKind: 'synthetic',
      itemIdentityHash: hash,
      sourceId: 'source-antara-metro',
      traceId: 'trace-triage-002',
      disposition: 'drop' as const,
      jakartaScope: 'outside_scope' as const,
      actionability: 'none' as const,
      primaryCategory: null,
      incidentType: null,
      confidence: 'high' as const,
      reasonCodes: ['outside_scope'],
      modelStatus: 'ok' as const,
    };
    await recordTriageDecision(db.executor, base);
    await recordTriageDecision(db.executor, base);
    const count = await db.executor.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM waspada.news_triage_decisions
       WHERE dataset_kind = 'synthetic' AND item_identity_hash = $1`,
      [hash],
    );
    assert.equal(count.rows[0]?.count, '1');
  });

  it('keys accepted decisions by revision and preserves attempt history', async () => {
    const hash = newsTriageIdentityHash('source-antara-metro', 'feed-7010');
    await recordTriageDecision(db.executor, {
      datasetKind: 'synthetic',
      itemIdentityHash: hash,
      sourceId: 'source-antara-metro',
      traceId: 'trace-triage-010',
      disposition: 'ingest',
      jakartaScope: 'dki_jakarta',
      actionability: 'actionable',
      primaryCategory: 'disasters_weather',
      incidentType: 'banjir',
      confidence: 'high',
      reasonCodes: ['triage_v1_ingest'],
      modelStatus: 'ok',
      reportRevisionId: 'rep-7010-a',
      contentHash: 'a'.repeat(64),
    });
    const byRevision = await readTriageDecisionForRevision(db.executor, 'synthetic', 'rep-7010-a');
    assert.equal(byRevision?.itemIdentityHash, hash);
    assert.equal(byRevision?.reportRevisionId, 'rep-7010-a');

    // Changed content: new revision row + attempt linked by supersedes_hash.
    await recordTriageAttempt(db.executor, {
      datasetKind: 'synthetic',
      itemIdentityHash: hash,
      reportRevisionId: 'rep-7010-b',
      sourceId: 'source-antara-metro',
      traceId: 'trace-triage-011',
      disposition: 'ingest',
      jakartaScope: 'dki_jakarta',
      actionability: 'actionable',
      primaryCategory: 'disasters_weather',
      incidentType: 'banjir',
      confidence: 'high',
      reasonCodes: ['triage_v1_ingest'],
      modelStatus: 'ok',
      contentHash: 'b'.repeat(64),
      supersedesHash: 'a'.repeat(64),
    });
    await recordTriageDecision(db.executor, {
      datasetKind: 'synthetic',
      itemIdentityHash: hash,
      sourceId: 'source-antara-metro',
      traceId: 'trace-triage-011',
      disposition: 'ingest',
      jakartaScope: 'dki_jakarta',
      actionability: 'actionable',
      primaryCategory: 'disasters_weather',
      incidentType: 'banjir',
      confidence: 'high',
      reasonCodes: ['triage_v1_ingest'],
      modelStatus: 'ok',
      reportRevisionId: 'rep-7010-b',
      contentHash: 'b'.repeat(64),
      supersedesHash: 'a'.repeat(64),
    });
    const attempts = await db.executor.query<{ report_revision_id: string }>(
      `SELECT report_revision_id FROM waspada.news_triage_attempts
       WHERE dataset_kind = 'synthetic' AND item_identity_hash = $1
       ORDER BY evaluated_at ASC`,
      [hash],
    );
    assert.ok(attempts.rows.some((r) => r.report_revision_id === 'rep-7010-b'));
    const moved = await readTriageDecisionForRevision(db.executor, 'synthetic', 'rep-7010-b');
    assert.equal(moved?.supersedesHash, 'a'.repeat(64));
  });

  it('marks uncertain rows reviewed only where still uncertain', async () => {
    const hash = newsTriageIdentityHash('source-metro', 'feed-7011');
    await recordTriageDecision(db.executor, {
      datasetKind: 'synthetic',
      itemIdentityHash: hash,
      sourceId: 'source-metro',
      traceId: 'trace-triage-012',
      disposition: 'uncertain',
      jakartaScope: 'unknown',
      actionability: 'unknown',
      primaryCategory: null,
      incidentType: null,
      confidence: 'low',
      reasonCodes: ['ambiguous_location'],
      modelStatus: 'ok',
    });
    const marked = await markTriageReviewed(db.executor, 'synthetic', hash, 'mod-01');
    assert.equal(marked, true);
    const reread = await readTriageDecision(db.executor, 'synthetic', hash);
    assert.equal(reread?.reviewedBy, 'mod-01');
    assert.ok(typeof reread?.reviewedAt === 'string');
    const idempotent = await markTriageReviewed(db.executor, 'synthetic', hash, 'mod-01');
    assert.equal(idempotent, true);
  });

  it('lists only uncertain rows for bounded review and rejects invented categories', async () => {
    const uncertainHash = newsTriageIdentityHash('source-metro', 'feed-7003');
    await recordTriageDecision(db.executor, {
      datasetKind: 'synthetic',
      itemIdentityHash: uncertainHash,
      sourceId: 'source-metro',
      traceId: 'trace-triage-003',
      disposition: 'uncertain',
      jakartaScope: 'unknown',
      actionability: 'unknown',
      primaryCategory: null,
      incidentType: null,
      confidence: 'low',
      reasonCodes: ['ambiguous_location'],
      modelStatus: 'ok',
    });
    const uncertain = await readUncertainTriage(db.executor, 'synthetic', 100);
    assert.ok(uncertain.every((r) => r.disposition === 'uncertain'));
    assert.ok(uncertain.some((r) => r.itemIdentityHash === uncertainHash));

    await assert.rejects(
      recordTriageDecision(db.executor, {
        datasetKind: 'synthetic',
        itemIdentityHash: newsTriageIdentityHash('source-metro', 'feed-7004'),
        sourceId: 'source-metro',
        traceId: 'trace-triage-004',
        disposition: 'ingest',
        jakartaScope: 'dki_jakarta',
        actionability: 'actionable',
        primaryCategory: 'flood',
        incidentType: 'banjir',
        confidence: 'high',
        reasonCodes: ['triage_v1_ingest'],
        modelStatus: 'ok',
      }),
      /check constraint/i,
    );
  });

  it('stores primary_category on incidents and rejects invented values', async () => {
    await db.executor.query(
      `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
       VALUES ('trace-cat-001', 'synthetic', now(), 'succeeded', '{}'::jsonb)`,
    );
    await db.executor.query(
      `INSERT INTO waspada.source_registry (
         source_id, trace_id, registry_version, display_name, source_kind, remit,
         access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
         approval_status, health_status, auto_acquisition_enabled, auto_publication_policy
       ) VALUES ('source-cat', 'trace-cat-001', 1, 'Cat Fixture', 'newsroom', ARRAY['news'],
         'manual_fixture', ARRAY[]::text[], ARRAY[]::text[], ARRAY['public'],
         'active', 'approved', 'healthy', false, 'never')`,
    );
    const hash = 'a'.repeat(64);
    await db.executor.query(
      `INSERT INTO waspada.report_revisions (
         dataset_kind, report_revision_id, trace_id, source_id, canonical_url,
         content_hash, permitted_text, permitted_text_hash, normalization_version,
         retrieved_at, revision_status, record_json
       ) VALUES ('synthetic', 'rev-cat-001', 'trace-cat-001', 'source-cat',
         'https://example.invalid/cat', $1, 'Kebakaran di Tebet', $1, 'v1', now(), 'unreviewed', '{}'::jsonb)`,
      [hash],
    );
    await db.executor.query(
      `INSERT INTO waspada.incidents (
         incident_id, dataset_kind, title, description, incident_type, primary_category,
         status, severity, location_label, shape, event_time,
         first_observed_at, last_updated_at, discrepancies, uncertainty_notes,
         record_json, created_at
       ) VALUES ('inc-cat-001', 'synthetic', 'Kebakaran Tebet', 'Kebakaran rumah di Tebet',
         'kebakaran rumah', 'fires_infrastructure_hazards', 'investigating', 'unknown',
         'Tebet', NULL, '{}'::jsonb, now(), now(), '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, now())`,
    );
    const got = await db.executor.query<{ primary_category: string }>(
      `SELECT primary_category FROM waspada.incidents
       WHERE dataset_kind = 'synthetic' AND incident_id = 'inc-cat-001'`,
    );
    assert.equal(got.rows[0]?.primary_category, 'fires_infrastructure_hazards');

    await assert.rejects(
      db.executor.query(
        `INSERT INTO waspada.incidents (
           incident_id, dataset_kind, title, description, incident_type, primary_category,
           status, severity, location_label, shape, event_time,
           first_observed_at, last_updated_at, discrepancies, uncertainty_notes,
           record_json, created_at
         ) VALUES ('inc-cat-bad', 'synthetic', 'X', 'Y', 'banjir', 'flood', 'investigating', 'unknown',
           NULL, NULL, '{}'::jsonb, now(), now(), '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, now())`,
      ),
      /check constraint/i,
    );
  });

  it('reads the latest attempt for a revision and null when none exists', async () => {
    const missing = await readLatestAttemptForRevision(db.executor, 'synthetic', 'rep-latest-none');
    assert.equal(missing, null);

    const hash = newsTriageIdentityHash('source-antara-metro', 'feed-latest');
    const base = {
      datasetKind: 'synthetic',
      itemIdentityHash: hash,
      reportRevisionId: 'rep-latest-001',
      sourceId: 'source-antara-metro',
      traceId: 'trace-triage-latest',
      disposition: 'ingest' as const,
      jakartaScope: 'dki_jakarta' as const,
      actionability: 'actionable' as const,
      primaryCategory: 'disasters_weather' as const,
      incidentType: 'banjir' as const,
      confidence: 'high' as const,
      reasonCodes: ['triage_v1_ingest'],
      modelStatus: 'ok' as const,
      contentHash: 'c'.repeat(64),
    };
    await recordTriageAttempt(db.executor, base);
    await new Promise((r) => setTimeout(r, 15));
    await recordTriageAttempt(db.executor, { ...base, traceId: 'trace-triage-latest-2' });
    const latest = await readLatestAttemptForRevision(db.executor, 'synthetic', 'rep-latest-001');
    assert.equal(latest?.reportRevisionId, 'rep-latest-001');
    assert.equal(latest?.itemIdentityHash, hash);
    assert.equal(latest?.traceId, 'trace-triage-latest-2');
    assert.equal(latest?.contentHash, 'c'.repeat(64));
  });

  it('markTriageReviewed only flips the uncertain flag and never creates revisions or jobs', async () => {
    const hash = newsTriageIdentityHash('source-review-pin', 'feed-review');
    await recordTriageDecision(db.executor, {
      datasetKind: 'synthetic',
      itemIdentityHash: hash,
      sourceId: 'source-review-pin',
      traceId: 'trace-review-pin',
      disposition: 'uncertain',
      jakartaScope: 'unknown',
      actionability: 'unknown',
      primaryCategory: null,
      incidentType: null,
      confidence: 'low',
      reasonCodes: ['provider_error'],
      modelStatus: 'provider_error',
    });
    const marked = await markTriageReviewed(db.executor, 'synthetic', hash, 'mod-1');
    assert.equal(marked, true);
    const row = await readTriageDecision(db.executor, 'synthetic', hash);
    assert.equal(row?.reviewedBy, 'mod-1');
    assert.ok(row?.reviewedAt);
    assert.equal(row?.disposition, 'uncertain');
    const revs = await db.executor.query<{ report_revision_id: string }>(
      `SELECT report_revision_id FROM waspada.report_revisions WHERE trace_id = 'trace-review-pin'`,
    );
    assert.equal(revs.rows.length, 0);
    const jobs = await db.executor.query<{ job_id: string }>(
      `SELECT job_id FROM waspada.ai_jobs WHERE trace_id = 'trace-review-pin'`,
    );
    assert.equal(jobs.rows.length, 0);
  });
});
