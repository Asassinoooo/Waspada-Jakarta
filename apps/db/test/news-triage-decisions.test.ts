import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import {
  newsTriageIdentityHash,
  recordTriageDecision,
  readTriageDecision,
  readUncertainTriage,
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
});
