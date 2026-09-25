import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import { createRepositoryPorts } from '../src/ports.js';
import {
  PublicationWriteError,
  SqlPublicationWriter,
  type PublicationClaimDecision,
  type PublicationEventVersionDraft,
  type PublicationImpactVersionDraft,
  type PublicationWriteCommand,
} from '../src/publication-writer.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

const fixtureTraceId = 'trace-pub-write-fixture';
const fixtureProposalId = 'proposal-pub-write-create';
const fixtureEventId = 'event-pub-write-fixture';
const fixtureClaimId = 'claim-pub-write-fixture';
const fixtureImpactId = 'impact-pub-write-fixture';
const fixtureOriginId = 'origin-pub-write-fixture';
const fixtureGeometryId = 'geometry-pub-write-fixture';
const unrelatedGeometryId = 'geometry-pub-write-unrelated-fixture';
const supportText = 'Authored synthetic fixture: the station entrance remains closed for the exercise.';
const supportHash = sha256(supportText);
let supportReferences: {
  readonly support: EvidenceReferenceFixture;
  readonly contradicts: EvidenceReferenceFixture;
  readonly context: EvidenceReferenceFixture;
};

describe('PUB-WRITE-CORE manual publication writer', () => {
  let database: TestDatabase;
  let writer: SqlPublicationWriter;

  before(async () => {
    database = await createTestDatabase();
    const migrations = await readMigrations(new URL('../migrations/', import.meta.url));
    await applyMigrations(database.executor, migrations);
    writer = new SqlPublicationWriter(database.executor);

    // Test-only live namespace marker. This does not represent a real source, source right, or reviewer right.
    await database.executor.query(
      `INSERT INTO waspada.dataset_namespace_config (singleton, dataset_kind)
       VALUES (true, 'live')`,
    );
    await database.executor.query(
      `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, metadata)
       VALUES ($1, 'live', '2026-09-25T05:00:00Z', $2::jsonb)`,
      [fixtureTraceId, JSON.stringify({ fixture: 'synthetic-live-shaped-test-only', source_and_reviewer_rights: 'not_asserted' })],
    );
    await database.executor.query(
      `INSERT INTO waspada.source_registry
         (source_id, trace_id, registry_version, display_name, source_kind, remit,
          access_method, access_restrictions, reuse_basis, registry_status,
          approval_status, health_status, auto_acquisition_enabled, auto_publication_policy)
       VALUES ('source-pub-write-fixture', $1, 1, 'Synthetic test fixture only', 'other',
          ARRAY['authored test fixture'], 'manual_fixture',
          ARRAY['no real source material or permission is represented'],
          ARRAY['test-only authored record'], 'active', 'approved', 'unknown', false, 'never')`,
      [fixtureTraceId],
    );
    await database.executor.query(
      `INSERT INTO waspada.report_revisions
         (dataset_kind, report_revision_id, trace_id, source_id, canonical_url,
          content_hash, permitted_text, permitted_text_hash, normalization_version,
          retrieved_at, revision_status, record_json)
       VALUES ('live', 'revision-pub-write-fixture', $1, 'source-pub-write-fixture',
          'https://example.invalid/synthetic-test-fixture', $2, $3, $2,
          'fixture-normalization-v1', '2026-09-25T05:00:00Z', 'eligible', $4::jsonb)`,
      [fixtureTraceId, supportHash, supportText,
        JSON.stringify({ fixture: 'synthetic-live-shaped-test-only', rights: 'not_asserted' })],
    );

    supportReferences = {
      support: await insertEvidenceReference(database, 'supports'),
      contradicts: await insertEvidenceReference(database, 'contradicts'),
      context: await insertEvidenceReference(database, 'context'),
    };
    await database.executor.query(
      `INSERT INTO waspada.evidence_origins
         (dataset_kind, origin_id, trace_id, origin_kind, actor_label,
          lineage_relation, independence_status, record_json)
       VALUES ('live', $1, $2, 'original_document', 'Synthetic test fixture only',
          'original', 'established', $3::jsonb)`,
      [fixtureOriginId, fixtureTraceId, JSON.stringify({ fixture: 'authored-test-only' })],
    );
    await database.executor.query(
      `INSERT INTO waspada.origin_evidence (dataset_kind, origin_id, evidence_ref_id)
       VALUES ('live', $1, $2)`,
      [fixtureOriginId, supportReferences.support.id],
    );
    await database.executor.query(
      `INSERT INTO waspada.geometries
         (dataset_kind, geometry_id, trace_id, role, shape, coordinate_reference_system,
          precision_basis, display_label, record_json)
       VALUES ('live', $1, $2, 'route_segment',
          ST_GeomFromText('LINESTRING(106.70 -6.20, 106.71 -6.20)', 4326),
          'OGC:CRS84', 'moderator_generalization', 'Synthetic test fixture route', $3::jsonb)`,
      [fixtureGeometryId, fixtureTraceId, JSON.stringify({ fixture: 'authored-test-only' })],
    );
    await database.executor.query(
      `INSERT INTO waspada.geometry_evidence (dataset_kind, geometry_id, evidence_ref_id)
       VALUES ('live', $1, $2)`,
      [fixtureGeometryId, supportReferences.support.id],
    );
    await database.executor.query(
      `INSERT INTO waspada.geometries
         (dataset_kind, geometry_id, trace_id, role, shape, coordinate_reference_system,
          precision_basis, display_label, record_json)
       VALUES ('live', $1, $2, 'facility', ST_SetSRID(ST_MakePoint(106.72, -6.21), 4326),
          'OGC:CRS84', 'unknown', 'Unrelated fixture geometry', $3::jsonb)`,
      [unrelatedGeometryId, fixtureTraceId, JSON.stringify({ fixture: 'authored-test-only', unrelated_to_claim: true })],
    );
    await database.executor.query(
      `INSERT INTO waspada.extraction_results
         (dataset_kind, candidate_id, trace_id, report_revision_id, category, record_json)
       VALUES ('live', 'candidate-pub-write-fixture', $1, 'revision-pub-write-fixture',
          'transport_road_incidents', $2::jsonb)`,
      [fixtureTraceId, JSON.stringify({ fixture: 'synthetic-live-shaped-test-only' })],
    );
    await database.executor.query(
      `INSERT INTO waspada.grounding_contexts
         (dataset_kind, context_id, trace_id, candidate_id, retrieval_version,
          index_version, sufficient, record_json)
       VALUES ('live', 'context-pub-write-fixture', $1, 'candidate-pub-write-fixture',
          'retrieval-fixture-v1', 'index-fixture-v1', true, $2::jsonb)`,
      [fixtureTraceId, JSON.stringify({ fixture: 'synthetic-live-shaped-test-only' })],
    );
    for (const reference of Object.values(supportReferences)) {
      await database.executor.query(
        `INSERT INTO waspada.grounding_evidence (dataset_kind, context_id, evidence_ref_id)
         VALUES ('live', 'context-pub-write-fixture', $1)`,
        [reference.id],
      );
    }
    await seedProposal(database, fixtureProposalId, null);
  });

  after(async () => {
    await database.close();
  });

  it('writes a complete event and impact set under the L4 role, preserves evidence relations, and safely replays', async () => {
    const command = makeCommand({ idempotencyKey: 'pub-write-create-key' });
    const first = await runAsWriter(database, () => writer.publish(command));
    assert.deepEqual(first, {
      outcome: 'written', decisionId: command.decisionId,
      eventId: command.event.event_id, eventVersion: 1,
    });

    const replay = await runAsWriter(database, () => writer.publish(command));
    assert.deepEqual(replay, {
      outcome: 'replayed', decisionId: command.decisionId,
      eventId: command.event.event_id, eventVersion: 1,
    });

    const event = await database.executor.query<{ record_json: Record<string, unknown> }>(
      `SELECT record_json FROM waspada.event_versions
       WHERE dataset_kind = 'live' AND event_id = $1 AND version = 1`,
      [fixtureEventId],
    );
    const eventRecord = event.rows[0]?.record_json;
    assert.ok(eventRecord);
    assert.equal(eventRecord.record_type, 'Event');
    assert.deepEqual(eventRecord.impact_refs, [{ impact_id: fixtureImpactId, version: 1 }]);
    assert.deepEqual((eventRecord.event_time as Record<string, unknown>), {
      start: '2026-09-25', end: '2026-09-25T05:00:00Z', precision: 'range',
    });

    const eventEvidence = await database.executor.query<{ evidence_kind: string; count: string }>(
      `SELECT evidence_kind, count(*)::text AS count
       FROM waspada.event_claim_evidence
       WHERE dataset_kind = 'live' AND event_id = $1 AND event_version = 1
       GROUP BY evidence_kind ORDER BY evidence_kind`,
      [fixtureEventId],
    );
    assert.deepEqual(eventEvidence.rows, [
      { evidence_kind: 'context', count: '1' },
      { evidence_kind: 'contradiction', count: '1' },
      { evidence_kind: 'support', count: '1' },
    ]);

    const decisionEvidence = await database.executor.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM waspada.publication_decision_evidence
       WHERE dataset_kind = 'live' AND decision_id = $1 AND claim_id = $2`,
      [command.decisionId, fixtureClaimId],
    );
    assert.equal(decisionEvidence.rows[0]?.count, '3');

    const receipt = await database.executor.query<{ row: Record<string, unknown> }>(
      `SELECT to_jsonb(receipt) AS row FROM waspada.publication_write_receipts AS receipt
       WHERE dataset_kind = 'live' AND idempotency_key = $1`,
      [command.idempotencyKey],
    );
    assert.deepEqual(Object.keys(receipt.rows[0]!.row).sort(), [
      'created_at', 'dataset_kind', 'decision_id', 'event_id', 'event_version',
      'idempotency_key', 'request_fingerprint',
    ]);
    assert.match(String(receipt.rows[0]!.row.request_fingerprint), /^[0-9a-f]{64}$/);

    const outbox = await database.executor.query<{ row: Record<string, unknown> }>(
      `SELECT to_jsonb(entry) AS row FROM waspada.publication_outbox AS entry
       WHERE dataset_kind = 'live' AND event_id = $1 AND event_version = 1`,
      [fixtureEventId],
    );
    assert.deepEqual(Object.keys(outbox.rows[0]!.row).sort(), [
      'created_at', 'dataset_kind', 'event_id', 'event_kind', 'event_version',
      'occurred_at', 'outbox_id', 'trace_id',
    ]);
    assert.equal(outbox.rows[0]!.row.event_kind, 'event_version_published');
    assert.equal(outbox.rows[0]!.row.trace_id, fixtureTraceId);
  });

  it('updates only the exact current version and appends the next impact version', async () => {
    const proposalId = 'proposal-pub-write-update';
    await seedProposal(database, proposalId, { eventId: fixtureEventId, baseVersion: 1 });
    const command = makeCommand({
      proposalId,
      decisionId: 'decision-pub-write-update',
      idempotencyKey: 'pub-write-update-key',
      event: eventDraft(2, 1),
      impact: impactDraft(2, 2),
      expectedTarget: { event_id: fixtureEventId, base_event_version: 1 },
    });
    const result = await runAsWriter(database, () => writer.publish(command));
    assert.deepEqual(result, {
      outcome: 'written', decisionId: command.decisionId,
      eventId: fixtureEventId, eventVersion: 2,
    });

    const rows = await database.executor.query<{ version: number }>(
      `SELECT version FROM waspada.event_versions
       WHERE dataset_kind = 'live' AND event_id = $1 ORDER BY version`,
      [fixtureEventId],
    );
    assert.deepEqual(rows.rows.map((row) => Number(row.version)), [1, 2]);
    const impacts = await database.executor.query<{ impact_version: number; event_version: number }>(
      `SELECT ref.impact_version, impact.event_version
       FROM waspada.event_impact_refs AS ref
       JOIN waspada.impact_versions AS impact
         ON impact.dataset_kind = ref.dataset_kind AND impact.event_id = ref.event_id
        AND impact.impact_id = ref.impact_id AND impact.version = ref.impact_version
       WHERE ref.dataset_kind = 'live' AND ref.event_id = $1 AND ref.event_version = 2`,
      [fixtureEventId],
    );
    assert.deepEqual(impacts.rows.map((row) => [Number(row.impact_version), Number(row.event_version)]), [[2, 2]]);
    const outboxCount = await database.executor.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM waspada.publication_outbox
       WHERE dataset_kind = 'live' AND event_id = $1`,
      [fixtureEventId],
    );
    assert.equal(outboxCount.rows[0]?.count, '2');
  });

  it('returns stable conflicts for changed idempotency payloads, duplicate creates, and stale retries', async () => {
    const created = makeCommand({
      proposalId: 'proposal-pub-write-conflict-create',
      decisionId: 'decision-pub-write-conflict-create',
      idempotencyKey: 'pub-write-conflict-create-key',
      event: eventDraft(1, null, 'event-pub-write-conflict'),
      impact: impactDraft(1, 1, 'event-pub-write-conflict', 'impact-pub-write-conflict'),
    });
    await seedProposal(database, created.proposalId, null);
    assert.equal((await writer.publish(created)).outcome, 'written');

    const changedPayload = { ...created, event: { ...created.event, title: 'Different approved title' } };
    assert.deepEqual(await writer.publish(changedPayload), { outcome: 'conflict', code: 'idempotency_key_reused' });

    const duplicateCreate = { ...created, idempotencyKey: 'pub-write-duplicate-event-key' };
    assert.deepEqual(await writer.publish(duplicateCreate), { outcome: 'conflict', code: 'event_version_exists' });

    const staleProposalId = 'proposal-pub-write-stale';
    await seedProposal(database, staleProposalId, { eventId: fixtureEventId, baseVersion: 1 });
    const stale = makeCommand({
      proposalId: staleProposalId,
      decisionId: 'decision-pub-write-stale',
      idempotencyKey: 'pub-write-stale-key',
      expectedTarget: { event_id: fixtureEventId, base_event_version: 1 },
      event: eventDraft(2, 1),
      impact: impactDraft(3, 2),
    });
    assert.deepEqual(await writer.publish(stale), { outcome: 'conflict', code: 'stale_event_version' });
    const staleRows = await database.executor.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM waspada.publication_decisions
       WHERE dataset_kind = 'live' AND decision_id = 'decision-pub-write-stale'`,
    );
    assert.equal(staleRows.rows[0]?.count, '0');
  });

  it('serializes concurrent new-event commands for the same event ID', async () => {
    const eventId = 'event-pub-write-concurrent';
    const leftProposalId = 'proposal-pub-write-concurrent-left';
    const rightProposalId = 'proposal-pub-write-concurrent-right';
    await seedProposal(database, leftProposalId, null);
    await seedProposal(database, rightProposalId, null);
    const left = makeCommand({
      proposalId: leftProposalId,
      decisionId: 'decision-pub-write-concurrent-left',
      idempotencyKey: 'pub-write-concurrent-left-key',
      event: eventDraft(1, null, eventId),
      impact: impactDraft(1, 1, eventId, 'impact-pub-write-concurrent-left'),
    });
    const right = makeCommand({
      proposalId: rightProposalId,
      decisionId: 'decision-pub-write-concurrent-right',
      idempotencyKey: 'pub-write-concurrent-right-key',
      event: eventDraft(1, null, eventId),
      impact: impactDraft(1, 1, eventId, 'impact-pub-write-concurrent-right'),
    });
    const results = await Promise.all([writer.publish(left), writer.publish(right)]);
    assert.deepEqual(results.map((result) => result.outcome).sort(), ['conflict', 'written']);
    assert.deepEqual(results.filter((result) => result.outcome === 'conflict'), [
      { outcome: 'conflict', code: 'event_version_exists' },
    ]);
    const rows = await database.executor.query<{ versions: string; outbox: string }>(
      `SELECT (SELECT count(*)::text FROM waspada.event_versions
               WHERE dataset_kind = 'live' AND event_id = $1) AS versions,
              (SELECT count(*)::text FROM waspada.publication_outbox
               WHERE dataset_kind = 'live' AND event_id = $1) AS outbox`,
      [eventId],
    );
    assert.deepEqual(rows.rows[0], { versions: '1', outbox: '1' });
  });

  it('rejects missing, unauthorized, review-only, non-live, empty, malformed, and mismatched commands before writes', async () => {
    const base = makeCommand({
      proposalId: 'proposal-pub-write-invalid',
      decisionId: 'decision-pub-write-invalid',
      idempotencyKey: 'pub-write-invalid-base',
      event: eventDraft(1, null, 'event-pub-write-invalid'),
      impact: impactDraft(1, 1, 'event-pub-write-invalid', 'impact-pub-write-invalid'),
    });
    await seedProposal(database, base.proposalId, null);
    await assert.rejects(
      writer.publish({ ...base, moderatorApproval: undefined } as unknown as PublicationWriteCommand),
      (error: unknown) => error instanceof PublicationWriteError,
    );
    await assert.rejects(
      writer.publish({ ...base, moderatorApproval: { ...base.moderatorApproval, trusted_caller_authorized: false } } as never),
      (error: unknown) => error instanceof PublicationWriteError && error.code === 'moderator_approval_required',
    );
    await assert.rejects(
      writer.publish({ ...base, moderatorApproval: { ...base.moderatorApproval, action: 'hold' } } as never),
      (error: unknown) => error instanceof PublicationWriteError && error.code === 'moderator_approval_required',
    );
    await assert.rejects(
      writer.publish({ ...base, datasetKind: 'synthetic' } as never),
      (error: unknown) => error instanceof PublicationWriteError && error.code === 'invalid_command',
    );
    await assert.rejects(
      writer.publish({ ...base, datasetKind: 'historical' } as never),
      (error: unknown) => error instanceof PublicationWriteError && error.code === 'invalid_command',
    );
    await assert.rejects(
      writer.publish({ ...base, claimDecisions: [] } as never),
      (error: unknown) => error instanceof PublicationWriteError && error.code === 'invalid_command',
    );
    await assert.rejects(
      writer.publish({
        ...base,
        claimDecisions: [{ ...base.claimDecisions[0]!, disposition: 'review' }],
      } as never),
      (error: unknown) => error instanceof PublicationWriteError && error.code === 'invalid_command',
    );
    await assert.rejects(
      writer.publish({ ...base, extraConfidence: 0.99 } as never),
      (error: unknown) => error instanceof PublicationWriteError && error.code === 'invalid_command',
    );
    await assert.rejects(
      writer.publish({
        ...base,
        claimDecisions: [{
          ...base.claimDecisions[0]!,
          evidence: base.claimDecisions[0]!.evidence.map((reference, index) => index === 0
            ? { ...reference, span_end: reference.span_start }
            : reference),
        }],
      } as never),
      (error: unknown) => error instanceof PublicationWriteError,
    );
    await assert.rejects(
      writer.publish({
        ...base,
        expectedTarget: { event_id: null, base_event_version: null },
        event: eventDraft(2, 1),
      } as never),
      (error: unknown) => error instanceof PublicationWriteError && error.code === 'invalid_command',
    );
    await assert.rejects(
      writer.publish({
        ...base,
        impacts: [{ ...base.impacts[0]!, event_version: 2 }],
      } as never),
      (error: unknown) => error instanceof PublicationWriteError && error.code === 'invalid_command',
    );
    await assert.rejects(
      writer.publish({
        ...base,
        impacts: [{ ...base.impacts[0]!, supporting_claim_ids: ['claim-missing'] }],
      } as never),
      (error: unknown) => error instanceof PublicationWriteError && error.code === 'publication_evidence_invalid',
    );
    await assert.rejects(
      writer.publish({
        ...base,
        idempotencyKey: 'pub-write-unrelated-impact-geometry-key',
        decisionId: 'decision-pub-write-unrelated-impact-geometry',
        impacts: [{
          ...base.impacts[0]!,
          impact_id: 'impact-pub-write-unrelated-geometry',
          scope: { ...base.impacts[0]!.scope, geometry_ids: [unrelatedGeometryId] },
        }],
      }),
      (error: unknown) => error instanceof PublicationWriteError && error.code === 'publication_evidence_invalid',
    );
  });

  it('requires ordered time scopes and compares date-only endpoints at midnight UTC', async () => {
    const base = makeCommand({ idempotencyKey: 'pub-write-time-scope-validation' });
    const invalidScopes: readonly PublicationEventVersionDraft['event_time'][] = [
      { start: null, end: null, precision: 'exact' },
      { start: '2026-09-25T10:00:00Z', end: '2026-09-25T09:00:00Z', precision: 'exact' },
      { start: '2026-09-26', end: '2026-09-25', precision: 'date' },
      { start: '2026-09-26', end: '2026-09-25T23:59:59Z', precision: 'range' },
      { start: '2026-09-25', end: null, precision: 'range' },
    ];
    for (const [index, eventTime] of invalidScopes.entries()) {
      await assert.rejects(
        writer.publish({
          ...base,
          idempotencyKey: `${base.idempotencyKey}-${index}`,
          event: { ...base.event, event_time: eventTime },
        }),
        (error: unknown) => error instanceof PublicationWriteError && error.code === 'invalid_command',
      );
    }
  });

  it('rejects a synthetic configured namespace, including idempotent replays', async () => {
    await database.executor.query("UPDATE waspada.dataset_namespace_config SET dataset_kind = 'synthetic' WHERE singleton = true");
    try {
      await assert.rejects(
        writer.publish(makeCommand({
          idempotencyKey: 'pub-write-synthetic-namespace-key',
          proposalId: 'proposal-pub-write-synthetic-namespace',
        })),
        (error: unknown) => error instanceof PublicationWriteError && error.code === 'live_dataset_namespace_required',
      );
      await assert.rejects(
        writer.publish(makeCommand({ idempotencyKey: 'pub-write-create-key' })),
        (error: unknown) => error instanceof PublicationWriteError && error.code === 'live_dataset_namespace_required',
      );
    } finally {
      await database.executor.query("UPDATE waspada.dataset_namespace_config SET dataset_kind = 'live' WHERE singleton = true");
    }
  });

  it('rolls back decisions, versions, audit, outbox, and receipt after a mid-transaction failure', async () => {
    await database.executor.execute(`
      CREATE FUNCTION waspada.test_reject_publication_outbox_insert()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'fixture outbox failure'; END;
      $$;
      CREATE TRIGGER test_reject_publication_outbox_insert
      BEFORE INSERT ON waspada.publication_outbox
      FOR EACH ROW EXECUTE FUNCTION waspada.test_reject_publication_outbox_insert();
    `);
    const command = makeCommand({
      proposalId: 'proposal-pub-write-rollback',
      decisionId: 'decision-pub-write-rollback',
      idempotencyKey: 'pub-write-rollback-key',
      event: eventDraft(1, null, 'event-pub-write-rollback'),
      impact: impactDraft(1, 1, 'event-pub-write-rollback', 'impact-pub-write-rollback'),
    });
    await seedProposal(database, command.proposalId, null);
    try {
      await assert.rejects(writer.publish(command), /fixture outbox failure/);
    } finally {
      await database.executor.execute('DROP TRIGGER test_reject_publication_outbox_insert ON waspada.publication_outbox');
      await database.executor.execute('DROP FUNCTION waspada.test_reject_publication_outbox_insert()');
    }
    for (const [table, predicate] of [
      ['publication_decisions', "decision_id = 'decision-pub-write-rollback'"],
      ['event_versions', "event_id = 'event-pub-write-rollback'"],
      ['impact_versions', "impact_id = 'impact-pub-write-rollback'"],
      ['audit_records', "entity_id = 'event-pub-write-rollback:1'"],
      ['publication_outbox', "event_id = 'event-pub-write-rollback'"],
      ['publication_write_receipts', "idempotency_key = 'pub-write-rollback-key'"],
    ] as const) {
      const count = await database.executor.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM waspada.${table} WHERE dataset_kind = 'live' AND ${predicate}`,
      );
      assert.equal(count.rows[0]?.count, '0', `${table} must roll back`);
    }
  });

  it('denies unrelated reads and mutations under SET ROLE while retaining the existing narrow source lookup', async () => {
    const ports = createRepositoryPorts(database.executor);
    await runAsWriter(database, async () => {
      const source = await ports.sourceRegistry.findById('source-pub-write-fixture');
      assert.equal(source?.displayName, 'Synthetic test fixture only');
      await assert.rejects(
        database.executor.query('SELECT permitted_text FROM waspada.report_revisions LIMIT 1'),
        /permission denied/,
      );
      await assert.rejects(
        database.executor.query('SELECT * FROM waspada.publication_write_receipts LIMIT 1'),
        /permission denied/,
      );
      const appendOnlyTables = [
        ['publication_decisions', "record_json = '{}'::jsonb"],
        ['event_versions', "title = 'changed'"],
        ['publication_write_receipts', 'created_at = now()'],
        ['publication_outbox', 'occurred_at = now()'],
      ] as const;
      for (const [table, update] of appendOnlyTables) {
        await assert.rejects(
          database.executor.query(`UPDATE waspada.${table} SET ${update} WHERE dataset_kind = 'live'`),
          /permission denied/,
          `${table} UPDATE must be denied`,
        );
        await assert.rejects(
          database.executor.query(`DELETE FROM waspada.${table} WHERE dataset_kind = 'live'`),
          /permission denied/,
          `${table} DELETE must be denied`,
        );
      }
    });
  });

  it('keeps publication, receipt, and outbox records append-only at the database layer', async () => {
    await assert.rejects(
      database.executor.query("UPDATE waspada.publication_write_receipts SET created_at = now() WHERE dataset_kind = 'live'"),
      /append-only/,
    );
    await assert.rejects(
      database.executor.query("DELETE FROM waspada.publication_outbox WHERE dataset_kind = 'live'"),
      /append-only/,
    );
    await assert.rejects(
      database.executor.query("UPDATE waspada.event_versions SET title = 'changed' WHERE dataset_kind = 'live'"),
      /append-only/,
    );
  });
});

interface EvidenceReferenceFixture {
  readonly id: string;
  readonly relation: 'supports' | 'contradicts' | 'context';
  readonly record: {
    readonly report_revision_id: string;
    readonly permitted_text_hash: string;
    readonly span_start: number;
    readonly span_end: number;
    readonly offset_unit: 'unicode_code_points';
    readonly relation: 'supports' | 'contradicts' | 'context';
  };
}

async function insertEvidenceReference(
  database: TestDatabase,
  relation: EvidenceReferenceFixture['relation'],
): Promise<EvidenceReferenceFixture> {
  const result = await database.executor.query<{ evidence_ref_id: string | number | bigint }>(
    `INSERT INTO waspada.evidence_references
       (dataset_kind, trace_id, report_revision_id, permitted_text_hash,
        span_start, span_end, offset_unit, relation)
     VALUES ('live', $1, 'revision-pub-write-fixture', $2, 0, $3,
        'unicode_code_points', $4)
     RETURNING evidence_ref_id`,
    [fixtureTraceId, supportHash, Array.from(supportText).length, relation],
  );
  const record: EvidenceReferenceFixture['record'] = {
    report_revision_id: 'revision-pub-write-fixture',
    permitted_text_hash: supportHash,
    span_start: 0,
    span_end: Array.from(supportText).length,
    offset_unit: 'unicode_code_points',
    relation,
  };
  return { id: String(result.rows[0]!.evidence_ref_id), relation, record };
}

async function seedProposal(
  database: TestDatabase,
  proposalId: string,
  target: { readonly eventId: string; readonly baseVersion: number } | null,
): Promise<void> {
  const claim = proposalClaimRecord();
  const eventProposal = {
    schema_version: '2.0',
    trace_id: fixtureTraceId,
    record_type: 'EventProposal',
    dataset_kind: 'live',
    proposal_id: proposalId,
    candidate_id: 'candidate-pub-write-fixture',
    context_id: 'context-pub-write-fixture',
    event_id: target?.eventId ?? null,
    base_event_version: target?.baseVersion ?? null,
    investigation_id: null,
    claims: [claim],
    unresolved_fields: [],
    model_runs: [],
    proposed_at: '2026-09-25T05:00:00Z',
  };
  await database.executor.query(
    `INSERT INTO waspada.event_proposals
       (dataset_kind, proposal_id, trace_id, candidate_id, context_id,
        event_id, base_event_version, investigation_id, proposed_at, record_json)
     VALUES ('live', $1, $2, 'candidate-pub-write-fixture', 'context-pub-write-fixture',
        $3, $4, NULL, '2026-09-25T05:00:00Z', $5::jsonb)`,
    [proposalId, fixtureTraceId, target?.eventId ?? null, target?.baseVersion ?? null,
      JSON.stringify(eventProposal)],
  );
  await database.executor.query(
    `INSERT INTO waspada.proposal_claims
       (dataset_kind, proposal_id, claim_id, support_assessment, evidence_label, claim_text, record_json)
     VALUES ('live', $1, $2, 'supported', 'issuer_notice', $3, $4::jsonb)`,
    [proposalId, fixtureClaimId, claim.text, JSON.stringify(claim)],
  );
  const references: readonly [EvidenceReferenceFixture['relation'], EvidenceReferenceFixture][] = [
    ['supports', supportReferences.support],
    ['contradicts', supportReferences.contradicts],
    ['context', supportReferences.context],
  ];
  for (const [relation, reference] of references) {
    const evidenceKind = relation === 'supports' ? 'support' : relation === 'contradicts' ? 'contradiction' : 'context';
    await database.executor.query(
      `INSERT INTO waspada.proposal_claim_evidence
         (dataset_kind, proposal_id, claim_id, evidence_kind, evidence_ref_id)
       VALUES ('live', $1, $2, $3, $4)`,
      [proposalId, fixtureClaimId, evidenceKind, reference.id],
    );
  }
  await database.executor.query(
    `INSERT INTO waspada.proposal_claim_origins
       (dataset_kind, proposal_id, claim_id, origin_id)
     VALUES ('live', $1, $2, $3)`,
    [proposalId, fixtureClaimId, fixtureOriginId],
  );
}

function proposalClaimRecord(): Record<string, unknown> {
  return {
    claim_id: fixtureClaimId,
    text: 'Authored synthetic fixture: station entry is temporarily closed.',
    event_time: { start: '2026-09-25T04:30:00Z', end: null, precision: 'exact' },
    validity: { valid_from: '2026-09-25T04:00:00Z', valid_until: '2026-09-25T06:00:00Z' },
    scope: {
      place_ids: ['place-fixture-station'],
      service_ids: ['service-fixture-rail'],
      institution_ids: [],
      audience_ids: ['commuters'],
      geometry_ids: [fixtureGeometryId],
    },
    qualifiers: ['Synthetic fixture only; no live conditions asserted.'],
    support: [supportReferences.support.record],
    contradictions: [supportReferences.contradicts.record],
    context_evidence: [supportReferences.context.record],
    origin_ids: [fixtureOriginId],
    support_assessment: 'supported',
    evidence_label: 'issuer_notice',
  };
}

function makeCommand(options: {
  readonly proposalId?: string;
  readonly decisionId?: string;
  readonly idempotencyKey: string;
  readonly event?: PublicationEventVersionDraft;
  readonly impact?: PublicationImpactVersionDraft;
  readonly expectedTarget?: PublicationWriteCommand['expectedTarget'];
}): PublicationWriteCommand {
  return {
    datasetKind: 'live',
    idempotencyKey: options.idempotencyKey,
    traceId: fixtureTraceId,
    proposalId: options.proposalId ?? fixtureProposalId,
    decisionId: options.decisionId ?? `decision-${options.idempotencyKey}`,
    policyVersion: 'publication-policy-fixture-v1',
    expectedTarget: options.expectedTarget ?? { event_id: null, base_event_version: null },
    moderatorApproval: {
      action: 'approve',
      trusted_caller_authorized: true,
      actor_id: 'fixture-moderator-reviewer',
      decided_at: '2026-09-25T05:00:00Z',
      reason: 'Synthetic test-only manual review; no real reviewer rights are represented.',
    },
    claimDecisions: [claimDecision()],
    event: options.event ?? eventDraft(1, null),
    impacts: [options.impact ?? impactDraft(1, 1)],
  };
}

function claimDecision(disposition: PublicationClaimDecision['disposition'] = 'publish'): PublicationClaimDecision {
  return {
    claim_id: fixtureClaimId,
    disposition,
    reason_codes: ['manual_fixture_review'],
    evidence: [
      supportReferences.support.record,
      supportReferences.contradicts.record,
      supportReferences.context.record,
    ],
  };
}

function eventDraft(
  version: number,
  supersedesVersion: number | null,
  eventId = fixtureEventId,
): PublicationEventVersionDraft {
  return {
    event_id: eventId,
    version,
    supersedes_version: supersedesVersion,
    title: 'Synthetic test fixture station notice',
    summary: 'Authored fixture text for the local publication writer tests.',
    category: 'transport_road_incidents',
    tags: [{ namespace: 'service', value: 'rail' }],
    lifecycle: 'ongoing',
    freshness: {
      status: 'current', evaluated_at: '2026-09-25T05:00:00Z',
      review_due_at: '2026-09-25T05:30:00Z', basis: 'manual_review',
    },
    event_time: { start: '2026-09-25', end: '2026-09-25T05:00:00Z', precision: 'range' },
    validity: { valid_from: '2026-09-25T04:00:00Z', valid_until: '2026-09-25T06:00:00Z' },
    scope: {
      place_ids: ['place-fixture-station'],
      service_ids: ['service-fixture-rail'],
      institution_ids: [],
      audience_ids: ['commuters'],
      geometry_ids: [fixtureGeometryId],
    },
    published_at: '2026-09-25T05:00:00Z',
  };
}

function impactDraft(
  version: number,
  eventVersion: number,
  eventId = fixtureEventId,
  impactId = fixtureImpactId,
): PublicationImpactVersionDraft {
  return {
    impact_id: impactId,
    version,
    event_id: eventId,
    event_version: eventVersion,
    impact_type: 'facility_closure',
    title: 'Synthetic fixture access change',
    description: 'Authored fixture impact; no current real-world closure is asserted.',
    lifecycle: 'ongoing',
    freshness: {
      status: 'current', evaluated_at: '2026-09-25T05:00:00Z',
      review_due_at: '2026-09-25T05:30:00Z', basis: 'manual_review',
    },
    event_time: { start: '2026-09-25T04:30:00Z', end: null, precision: 'exact' },
    validity: { valid_from: '2026-09-25T04:00:00Z', valid_until: '2026-09-25T06:00:00Z' },
    scope: {
      place_ids: ['place-fixture-station'],
      service_ids: ['service-fixture-rail'],
      institution_ids: [],
      audience_ids: ['commuters'],
      geometry_ids: [fixtureGeometryId],
    },
    supporting_claim_ids: [fixtureClaimId],
    published_at: '2026-09-25T05:00:00Z',
  };
}

async function runAsWriter<Result>(database: TestDatabase, operation: () => Promise<Result>): Promise<Result> {
  await database.executor.execute('SET ROLE waspada_l4_publication_writer');
  try {
    return await operation();
  } finally {
    await database.executor.execute('RESET ROLE');
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
