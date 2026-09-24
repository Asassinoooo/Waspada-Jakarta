import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import { createRepositoryPorts, type NewReportRevision, type TraceRecord } from '../src/ports.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

const sourceCatalogTrace: TraceRecord = {
  traceId: 'trace-source-catalog',
  datasetKind: null,
  startedAt: '2026-09-24T10:00:00Z',
  endedAt: null,
  outcome: 'open',
  metadata: { fixture: 'synthetic-test-only' },
};

describe('DATA-01 relational persistence', () => {
  let testDatabase: TestDatabase;
  let ports: ReturnType<typeof createRepositoryPorts>;
  let revision: NewReportRevision;
  let evidenceRefId: string;
  let geometryId: string;

  before(async () => {
    testDatabase = await createTestDatabase();
    ports = createRepositoryPorts(testDatabase.executor);
    const migrations = await readMigrations(new URL('../migrations/', import.meta.url));
    await applyMigrations(testDatabase.executor, migrations);

    await ports.tracesAndAudit.createTrace(sourceCatalogTrace);
    await ports.tracesAndAudit.createTrace(makeTrace('trace-synthetic', 'synthetic'));
    await testDatabase.executor.query(
      `INSERT INTO waspada.source_registry
         (source_id, trace_id, registry_version, display_name, source_kind, remit,
          access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
          approval_status, health_status, auto_acquisition_enabled, auto_publication_policy)
       VALUES ('source-fixture', 'trace-source-catalog', 1, 'Synthetic fixture source',
          'other', ARRAY['fixture contract checks'], 'manual_fixture', ARRAY[]::text[],
          ARRAY['synthetic rows only'], ARRAY['test fixture'], 'active', 'approved',
          'unknown', false, 'never')`,
    );

    const permittedText = 'Synthetic fixture: Jl. Merdeka ditutup; lokasi contoh 🚧.';
    const permittedTextHash = sha256(permittedText);
    revision = makeRevision(permittedText, permittedTextHash);
    await ports.reportRevisions.create(revision);
    evidenceRefId = await ports.reportRevisions.createEvidenceReference({
      datasetKind: 'synthetic',
      traceId: revision.traceId,
      reportRevisionId: revision.reportRevisionId,
      permittedTextHash,
      spanStart: 0,
      spanEnd: Array.from(permittedText).length,
      relation: 'supports',
    });
    geometryId = 'geometry-synthetic-point';
  });

  after(async () => {
    await testDatabase.close();
  });

  it('exposes typed source/revision ports and validates exact text hashes and code-point spans', async () => {
    const source = await ports.sourceRegistry.findById('source-fixture');
    assert.equal(source?.approvalStatus, 'approved');
    assert.equal(source?.autoAcquisitionEnabled, false);
    assert.equal(source?.autoPublicationPolicy, 'never');

    const stored = await ports.reportRevisions.findById('synthetic', revision.reportRevisionId);
    assert.equal(stored?.permittedText, revision.permittedText);
    assert.equal(stored?.permittedTextHash, revision.permittedTextHash);
    assert.equal(stored?.recordJson.record_type, 'ReportRevision');
    assert.ok(Number(evidenceRefId) > 0);

    await assert.rejects(
      ports.reportRevisions.create({ ...revision, reportRevisionId: 'bad-hash', permittedTextHash: '0'.repeat(64) }),
      /does not match the exact permitted_text/,
    );
    await assert.rejects(
      ports.reportRevisions.createEvidenceReference({
        datasetKind: 'synthetic', traceId: revision.traceId,
        reportRevisionId: revision.reportRevisionId, permittedTextHash: 'f'.repeat(64),
        spanStart: 0, spanEnd: 1, relation: 'supports',
      }),
      /hash does not match/,
    );
    await assert.rejects(
      ports.reportRevisions.createEvidenceReference({
        datasetKind: 'synthetic', traceId: revision.traceId,
        reportRevisionId: revision.reportRevisionId, permittedTextHash: revision.permittedTextHash,
        spanStart: 0, spanEnd: Array.from(revision.permittedText).length + 1, relation: 'supports',
      }),
      /Unicode code-point range/,
    );
  });

  it('prevents a record in one dataset from referring to another dataset revision', async () => {
    await assert.rejects(
      testDatabase.executor.query(
        `INSERT INTO waspada.evidence_references
           (dataset_kind, trace_id, report_revision_id, permitted_text_hash,
            span_start, span_end, offset_unit, relation)
         VALUES ('live', 'trace-synthetic', $1, $2, 0, 1, 'unicode_code_points', 'supports')`,
        [revision.reportRevisionId, revision.permittedTextHash],
      ),
      /foreign key constraint/i,
    );

    const count = await testDatabase.executor.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM waspada.report_revisions WHERE dataset_kind <> 'synthetic'",
    );
    assert.equal(count.rows[0]?.count, '0');
  });

  it('stores only valid WGS 84 geometry, links evidence and supports spatial queries', async () => {
    await testDatabase.executor.query(
      `INSERT INTO waspada.geometries
         (dataset_kind, geometry_id, trace_id, role, shape, coordinate_reference_system,
          precision_m, precision_basis, display_label)
       VALUES ('synthetic', $1, 'trace-synthetic', 'approximate_place',
          ST_GeomFromText('POINT(106.8272 -6.1754)', 4326), 'OGC:CRS84', NULL, 'unknown', NULL)`,
      [geometryId],
    );
    await testDatabase.executor.query(
      `INSERT INTO waspada.geometry_evidence (dataset_kind, geometry_id, evidence_ref_id)
       VALUES ('synthetic', $1, $2)`,
      [geometryId, evidenceRefId],
    );

    const spatial = await testDatabase.executor.query<{ geometry_id: string; srid: number }>(
      `SELECT geometry_id, ST_SRID(shape) AS srid
       FROM waspada.geometries
       WHERE ST_DWithin(shape::geography, ST_GeogFromText('SRID=4326;POINT(106.8272 -6.1754)'), 10)`,
    );
    assert.deepEqual(spatial.rows, [{ geometry_id: geometryId, srid: 4326 }]);

    await assert.rejects(
      testDatabase.executor.query(
        `INSERT INTO waspada.geometries
           (dataset_kind, geometry_id, trace_id, role, shape, coordinate_reference_system, precision_basis)
         VALUES ('synthetic', 'geometry-wrong-srid', 'trace-synthetic', 'approximate_place',
           ST_GeomFromText('POINT(106 -6)', 3857), 'OGC:CRS84', 'unknown')`,
      ),
      /geometry SRID|does not match column SRID|violates check constraint/i,
    );
    await assert.rejects(
      testDatabase.executor.query(
        `INSERT INTO waspada.geometries
           (dataset_kind, geometry_id, trace_id, role, shape, coordinate_reference_system, precision_basis)
         VALUES ('synthetic', 'geometry-wrong-type', 'trace-synthetic', 'approximate_place',
           ST_GeomFromText('CIRCULARSTRING(0 0, 1 1, 2 0)', 4326), 'OGC:CRS84', 'unknown')`,
      ),
      /violates check constraint/i,
    );
  });

  it('keeps vector dimensions as per-run metadata and supports vector distance queries', async () => {
    const textHash = sha256('synthetic chunk');
    await testDatabase.executor.query(
      `INSERT INTO waspada.evidence_chunks
         (dataset_kind, chunk_id, trace_id, report_revision_id, permitted_text_hash,
          span_start, span_end, offset_unit, chunker_version, chunk_text_hash, status)
       VALUES ('synthetic', 'chunk-a', 'trace-synthetic', $1, $2, 0, 10,
          'unicode_code_points', 'chunker-test-v1', $3, 'active')`,
      [revision.reportRevisionId, revision.permittedTextHash, textHash],
    );
    await insertEmbeddingRun(testDatabase, 'embedding-a', 2);
    await insertEmbeddingRun(testDatabase, 'embedding-b', 3);
    await testDatabase.executor.query(
      `INSERT INTO waspada.embedding_vectors (dataset_kind, embedding_run_id, dimensions, embedding)
       VALUES ('synthetic', 'embedding-a', 2, '[1,0]'::vector),
              ('synthetic', 'embedding-b', 3, '[0,1,0]'::vector)`,
    );

    const nearest = await testDatabase.executor.query<{ embedding_run_id: string; distance: number }>(
      `SELECT embedding_run_id, embedding <=> '[1,0]'::vector AS distance
       FROM waspada.embedding_vectors
       WHERE dataset_kind = 'synthetic' AND dimensions = 2
       ORDER BY embedding <=> '[1,0]'::vector
       LIMIT 1`,
    );
    assert.equal(nearest.rows[0]?.embedding_run_id, 'embedding-a');
    assert.equal(nearest.rows[0]?.distance, 0);

    await insertEmbeddingRun(testDatabase, 'embedding-bad-dimension', 2);
    await assert.rejects(
      testDatabase.executor.query(
        `INSERT INTO waspada.embedding_vectors (dataset_kind, embedding_run_id, dimensions, embedding)
         VALUES ('synthetic', 'embedding-bad-dimension', 2, '[1,0,0]'::vector)`,
      ),
      /check constraint/i,
    );
    const dimensions = await testDatabase.executor.query<{ embedding_run_id: string; dimensions: number }>(
      'SELECT embedding_run_id, dimensions FROM waspada.embedding_runs WHERE dataset_kind = $1 ORDER BY embedding_run_id',
      ['synthetic'],
    );
    assert.deepEqual(dimensions.rows, [
      { embedding_run_id: 'embedding-a', dimensions: 2 },
      { embedding_run_id: 'embedding-b', dimensions: 3 },
      { embedding_run_id: 'embedding-bad-dimension', dimensions: 2 },
    ]);
  });

  it('links traces and append-only audit rows while isolating audit datasets', async () => {
    await ports.tracesAndAudit.createTrace(makeTrace('trace-audit', 'synthetic'));
    assert.equal(await ports.tracesAndAudit.finishTrace(
      'trace-audit', 'synthetic', '2026-09-24T10:05:00Z', 'succeeded', { check: 'fixture' },
    ), true);
    assert.equal(await ports.tracesAndAudit.finishTrace(
      'trace-audit', 'synthetic', '2026-09-24T10:06:00Z', 'succeeded', { check: 'fixture' },
    ), false);

    await ports.tracesAndAudit.appendAuditRecord({
      datasetKind: 'synthetic', auditId: 'audit-1', traceId: 'trace-audit',
      occurredAt: '2026-09-24T10:04:00Z', actorId: null, action: 'fixture.persisted',
      entityType: 'ReportRevision', entityId: revision.reportRevisionId,
      reason: null, details: { synthetic: true },
    });
    const audit = await ports.tracesAndAudit.listAuditByTraceId('trace-audit', 'synthetic');
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.entityId, revision.reportRevisionId);

    await assert.rejects(
      testDatabase.executor.query(
        `INSERT INTO waspada.audit_records
           (dataset_kind, audit_id, trace_id, occurred_at, action, entity_type, entity_id)
         VALUES ('live', 'audit-cross-dataset', 'trace-audit', '2026-09-24T10:04:00Z',
           'fixture.invalid', 'ReportRevision', $1)`,
        [revision.reportRevisionId],
      ),
      /foreign key constraint/i,
    );
  });

  it('enforces investigation budget bounds and keeps checkpoints dataset-scoped', async () => {
    await seedGroundingContext(testDatabase, revision, evidenceRefId);
    await insertInvestigationRequest(testDatabase, { consumed: 1, reserved: 1 });
    await insertCheckpoint(testDatabase, { consumed: 1, reserved: 1 });

    await assert.rejects(
      insertCheckpoint(testDatabase, { consumed: 5, reserved: 1, checkpointVersion: 2 }),
      /check constraint/i,
    );
    await assert.rejects(
      testDatabase.executor.query(
        `INSERT INTO waspada.investigation_requests
           (dataset_kind, investigation_id, trace_id, candidate_id, context_id, questions,
            budget_policy_version, limit_tool_attempts, limit_reasoning_turns,
            limit_active_seconds, limit_model_tokens, requested_at, record_json)
         VALUES ('live', 'investigation-cross', 'trace-synthetic', 'candidate-synthetic',
            'context-synthetic', ARRAY['fixture question'], 'budget-v1', 5, 4, 60, 12000,
            '2026-09-24T10:10:00Z', '{}'::jsonb)`,
      ),
      /foreign key constraint/i,
    );
  });

  it('publishes only the configured latest version and hides withdrawn tombstones', async () => {
    await seedProposal(testDatabase, evidenceRefId);
    await testDatabase.executor.query(
      `INSERT INTO waspada.dataset_namespace_config (singleton, dataset_kind)
       VALUES (true, 'synthetic')`,
    );

    await insertPublicationVersionOne(testDatabase, evidenceRefId, geometryId);
    const publicVersion = await testDatabase.executor.query<{ event_id: string; version: number }>(
      'SELECT event_id, version FROM waspada.public_event_versions',
    );
    assert.deepEqual(publicVersion.rows, [{ event_id: 'event-synthetic', version: 1 }]);
    const publicImpact = await testDatabase.executor.query<{ impact_id: string }>(
      'SELECT impact_id FROM waspada.public_event_impacts',
    );
    assert.deepEqual(publicImpact.rows, [{ impact_id: 'impact-synthetic' }]);

    await insertWithdrawalVersionTwo(testDatabase);
    const withdrawnProjection = await testDatabase.executor.query<{ event_id: string }>(
      'SELECT event_id FROM waspada.public_event_versions',
    );
    assert.deepEqual(withdrawnProjection.rows, []);
    const withdrawnImpacts = await testDatabase.executor.query<{ impact_id: string }>(
      'SELECT impact_id FROM waspada.public_event_impacts',
    );
    assert.deepEqual(withdrawnImpacts.rows, []);

    const privileges = await testDatabase.executor.query<{
      reader_view: boolean;
      reader_base: boolean;
      l1_source_insert: boolean;
      l4_event_update: boolean;
    }>(
      `SELECT has_table_privilege('waspada_public_reader', 'waspada.public_event_versions', 'SELECT') AS reader_view,
              has_table_privilege('waspada_public_reader', 'waspada.report_revisions', 'SELECT') AS reader_base,
              has_table_privilege('waspada_l1_pipeline', 'waspada.source_registry', 'INSERT') AS l1_source_insert,
              has_table_privilege('waspada_l4_publication_writer', 'waspada.event_versions', 'UPDATE') AS l4_event_update`,
    );
    assert.deepEqual(privileges.rows[0], {
      reader_view: true,
      reader_base: false,
      l1_source_insert: false,
      l4_event_update: false,
    });
  });
});

function makeTrace(traceId: string, datasetKind: 'synthetic'): TraceRecord {
  return {
    traceId,
    datasetKind,
    startedAt: '2026-09-24T10:00:00Z',
    endedAt: null,
    outcome: 'open',
    metadata: { fixture: 'synthetic-test-only' },
  };
}

function makeRevision(permittedText: string, permittedTextHash: string): NewReportRevision {
  return {
    datasetKind: 'synthetic',
    reportRevisionId: 'revision-synthetic',
    traceId: 'trace-synthetic',
    sourceId: 'source-fixture',
    canonicalUrl: 'https://synthetic.invalid/fixture/revision',
    sourceRevisionKey: 'fixture-1',
    contentHash: sha256('synthetic original fixture bytes'),
    permittedText,
    permittedTextHash,
    normalizationVersion: 'normalization-test-v1',
    publishedAt: '2026-09-24T09:59:00Z',
    observedAt: '2026-09-24T09:58:00Z',
    retrievedAt: '2026-09-24T10:00:00Z',
    validFrom: null,
    validUntil: null,
    supersedesId: null,
    revisionStatus: 'eligible',
    recordJson: {
      schema_version: '2.0',
      trace_id: 'trace-synthetic',
      record_type: 'ReportRevision',
      dataset_kind: 'synthetic',
      report_revision_id: 'revision-synthetic',
      source_id: 'source-fixture',
      canonical_url: 'https://synthetic.invalid/fixture/revision',
      source_revision_key: 'fixture-1',
      content_hash: sha256('synthetic original fixture bytes'),
      permitted_text: permittedText,
      permitted_text_hash: permittedTextHash,
      normalization_version: 'normalization-test-v1',
      published_at: '2026-09-24T09:59:00Z',
      observed_at: '2026-09-24T09:58:00Z',
      retrieved_at: '2026-09-24T10:00:00Z',
      validity: { valid_from: null, valid_until: null },
      supersedes_id: null,
      revision_status: 'eligible',
    },
  };
}

async function seedGroundingContext(
  testDatabase: TestDatabase,
  report: NewReportRevision,
  referenceId: string,
): Promise<void> {
  await testDatabase.executor.query(
    `INSERT INTO waspada.extraction_results
       (dataset_kind, candidate_id, trace_id, report_revision_id, category, record_json)
     VALUES ('synthetic', 'candidate-synthetic', 'trace-synthetic', $1,
       'transport_road_incidents', '{"record_type":"ExtractionResult"}'::jsonb)`,
    [report.reportRevisionId],
  );
  await testDatabase.executor.query(
    `INSERT INTO waspada.extraction_evidence (dataset_kind, candidate_id, evidence_ref_id)
     VALUES ('synthetic', 'candidate-synthetic', $1)`,
    [referenceId],
  );
  await testDatabase.executor.query(
    `INSERT INTO waspada.grounding_contexts
       (dataset_kind, context_id, trace_id, candidate_id, retrieval_version, index_version, sufficient, record_json)
     VALUES ('synthetic', 'context-synthetic', 'trace-synthetic', 'candidate-synthetic',
       'retrieval-test-v1', 'index-test-v1', true, '{"record_type":"GroundingContext"}'::jsonb)`,
  );
  await testDatabase.executor.query(
    `INSERT INTO waspada.grounding_evidence (dataset_kind, context_id, evidence_ref_id)
     VALUES ('synthetic', 'context-synthetic', $1)`,
    [referenceId],
  );
}

async function insertInvestigationRequest(
  testDatabase: TestDatabase,
  usage: { consumed: number; reserved: number },
): Promise<void> {
  await testDatabase.executor.query(
    `INSERT INTO waspada.investigation_requests
       (dataset_kind, investigation_id, trace_id, candidate_id, context_id, questions,
        budget_policy_version, limit_tool_attempts, limit_reasoning_turns,
        limit_active_seconds, limit_model_tokens, consumed_tool_attempts,
        reserved_tool_attempts, requested_at, record_json)
     VALUES ('synthetic', 'investigation-synthetic', 'trace-synthetic',
        'candidate-synthetic', 'context-synthetic', ARRAY['synthetic question'], 'budget-v1',
        5, 4, 60, 12000, $1, $2, '2026-09-24T10:10:00Z', '{}'::jsonb)`,
    [usage.consumed, usage.reserved],
  );
}

async function insertCheckpoint(
  testDatabase: TestDatabase,
  usage: { consumed: number; reserved: number; checkpointVersion?: number },
): Promise<void> {
  await testDatabase.executor.query(
    `INSERT INTO waspada.investigation_checkpoints
       (dataset_kind, checkpoint_id, investigation_id, checkpoint_version, trace_id,
        candidate_id, context_id, case_status, budget_policy_version, limit_tool_attempts,
        limit_reasoning_turns, limit_active_seconds, limit_model_tokens,
        consumed_tool_attempts, reserved_tool_attempts, attempts, reasoning_runs,
        created_at, updated_at, record_json)
     VALUES ('synthetic', $1, 'investigation-synthetic', $2, 'trace-synthetic',
        'candidate-synthetic', 'context-synthetic', 'open', 'budget-v1', 5, 4, 60, 12000,
        $3, $4, '[]'::jsonb, '[]'::jsonb, '2026-09-24T10:10:00Z',
        '2026-09-24T10:10:00Z', '{}'::jsonb)`,
    [
      `checkpoint-synthetic-${usage.checkpointVersion ?? 1}`,
      usage.checkpointVersion ?? 1,
      usage.consumed,
      usage.reserved,
    ],
  );
}

async function seedProposal(testDatabase: TestDatabase, evidenceRefId: string): Promise<void> {
  await seedGroundingContextIfMissing(testDatabase, evidenceRefId);
  await testDatabase.executor.query(
    `INSERT INTO waspada.event_proposals
       (dataset_kind, proposal_id, trace_id, candidate_id, context_id, proposed_at, record_json)
     VALUES ('synthetic', 'proposal-synthetic', 'trace-synthetic', 'candidate-synthetic',
       'context-synthetic', '2026-09-24T10:20:00Z', '{"record_type":"EventProposal"}'::jsonb)`,
  );
  await testDatabase.executor.query(
    `INSERT INTO waspada.proposal_claims
       (dataset_kind, proposal_id, claim_id, support_assessment, evidence_label, claim_text, record_json)
     VALUES ('synthetic', 'proposal-synthetic', 'claim-synthetic', 'supported', 'issuer_notice',
       'Synthetic fixture claim only', '{"claim_id":"claim-synthetic"}'::jsonb)`,
  );
  await testDatabase.executor.query(
    `INSERT INTO waspada.proposal_claim_evidence
       (dataset_kind, proposal_id, claim_id, evidence_kind, evidence_ref_id)
     VALUES ('synthetic', 'proposal-synthetic', 'claim-synthetic', 'support', $1)`,
    [evidenceRefId],
  );
}

async function seedGroundingContextIfMissing(testDatabase: TestDatabase, evidenceRefId: string): Promise<void> {
  const exists = await testDatabase.executor.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM waspada.grounding_contexts
       WHERE dataset_kind = 'synthetic' AND context_id = 'context-synthetic'
     ) AS exists`,
  );
  if (!exists.rows[0]?.exists) {
    await seedGroundingContext(testDatabase, revisionForProposal, evidenceRefId);
  }
}

const revisionForProposal: NewReportRevision = {
  datasetKind: 'synthetic',
  reportRevisionId: 'revision-synthetic',
  traceId: 'trace-synthetic',
  sourceId: 'source-fixture',
  canonicalUrl: 'https://synthetic.invalid/fixture/revision',
  sourceRevisionKey: 'fixture-1',
  contentHash: '0'.repeat(64),
  permittedText: 'placeholder',
  permittedTextHash: sha256('placeholder'),
  normalizationVersion: 'normalization-test-v1',
  publishedAt: null,
  observedAt: null,
  retrievedAt: '2026-09-24T10:00:00Z',
  validFrom: null,
  validUntil: null,
  supersedesId: null,
  revisionStatus: 'eligible',
  recordJson: {},
};

async function insertPublicationVersionOne(
  testDatabase: TestDatabase,
  evidenceRefId: string,
  geometryId: string,
): Promise<void> {
  const claim = {
    claim_id: 'claim-synthetic',
    text: 'Synthetic fixture claim only',
    event_time: { kind: 'unknown' },
    validity: { valid_from: null, valid_until: null },
    scope: { place_ids: [], service_ids: [], institution_ids: [], audience_ids: [], geometry_ids: [geometryId] },
    qualifiers: [],
    support: [{ report_revision_id: 'revision-synthetic', permitted_text_hash: revisionForProposal.permittedTextHash,
      span_start: 0, span_end: 1, offset_unit: 'unicode_code_points', relation: 'supports' }],
    contradictions: [],
    context_evidence: [],
    origin_ids: [],
    evidence_label: 'issuer_notice',
  };
  const eventRecord = {
    schema_version: '2.0', trace_id: 'trace-synthetic', record_type: 'Event', dataset_kind: 'synthetic',
    event_id: 'event-synthetic', version: 1, supersedes_version: null,
    title: 'Synthetic event', summary: 'Synthetic test event only', category: 'transport_road_incidents',
    tags: [], lifecycle: 'ongoing', freshness: { status: 'current', evaluated_at: '2026-09-24T10:20:00Z',
      review_due_at: '2026-09-24T11:20:00Z', basis: 'fixture' },
    event_time: { kind: 'unknown' }, validity: { valid_from: null, valid_until: null },
    scope: { place_ids: [], service_ids: [], institution_ids: [], audience_ids: [], geometry_ids: [geometryId] },
    claims: [claim], impact_refs: [{ impact_id: 'impact-synthetic', version: 1 }],
    publication_status: 'published', withdrawal_reason: null, publication_decision_id: 'decision-synthetic',
    published_at: '2026-09-24T10:20:00Z', withdrawn_at: null,
  };
  const impactRecord = {
    schema_version: '2.0', trace_id: 'trace-synthetic', record_type: 'Impact', dataset_kind: 'synthetic',
    impact_id: 'impact-synthetic', version: 1, event_id: 'event-synthetic', event_version: 1,
    impact_type: 'road_closure', title: 'Synthetic closure', description: 'Test only',
    lifecycle: 'ongoing', freshness: { status: 'current', evaluated_at: '2026-09-24T10:20:00Z',
      review_due_at: '2026-09-24T11:20:00Z', basis: 'fixture' },
    event_time: { kind: 'unknown' }, validity: { valid_from: null, valid_until: null },
    scope: { place_ids: [], service_ids: [], institution_ids: [], audience_ids: [], geometry_ids: [geometryId] },
    supporting_claim_ids: ['claim-synthetic'], published_at: '2026-09-24T10:20:00Z',
  };

  await testDatabase.executor.execute('BEGIN; SET CONSTRAINTS ALL DEFERRED;');
  try {
    await testDatabase.executor.query(
      `INSERT INTO waspada.publication_decisions
         (dataset_kind, decision_id, trace_id, proposal_id, policy_version, event_id,
          event_version, decided_at, record_json)
       VALUES ('synthetic', 'decision-synthetic', 'trace-synthetic', 'proposal-synthetic',
          'policy-test-v1', 'event-synthetic', 1, '2026-09-24T10:20:00Z', '{"decision":"publish"}'::jsonb)`,
    );
    await testDatabase.executor.query(
      `INSERT INTO waspada.publication_claim_decisions
         (dataset_kind, decision_id, proposal_id, claim_id, disposition, reason_codes)
       VALUES ('synthetic', 'decision-synthetic', 'proposal-synthetic', 'claim-synthetic',
          'publish', ARRAY['fixture-valid'])`,
    );
    await testDatabase.executor.query(
      `INSERT INTO waspada.publication_decision_evidence
         (dataset_kind, decision_id, claim_id, evidence_ref_id)
       VALUES ('synthetic', 'decision-synthetic', 'claim-synthetic', $1)`,
      [evidenceRefId],
    );
    await testDatabase.executor.query(
      `INSERT INTO waspada.event_versions
         (dataset_kind, event_id, version, trace_id, title, summary, category, lifecycle,
          publication_status, publication_decision_id, published_at, record_json)
       VALUES ('synthetic', 'event-synthetic', 1, 'trace-synthetic', 'Synthetic event',
          'Synthetic test event only', 'transport_road_incidents', 'ongoing', 'published',
          'decision-synthetic', '2026-09-24T10:20:00Z', $1::jsonb)`,
      [JSON.stringify(eventRecord)],
    );
    await testDatabase.executor.query(
      `INSERT INTO waspada.event_claims
         (dataset_kind, event_id, event_version, claim_id, claim_text, evidence_label, record_json)
       VALUES ('synthetic', 'event-synthetic', 1, 'claim-synthetic',
          'Synthetic fixture claim only', 'issuer_notice', $1::jsonb)`,
      [JSON.stringify(claim)],
    );
    await testDatabase.executor.query(
      `INSERT INTO waspada.event_claim_evidence
         (dataset_kind, event_id, event_version, claim_id, evidence_kind, evidence_ref_id)
       VALUES ('synthetic', 'event-synthetic', 1, 'claim-synthetic', 'support', $1)`,
      [evidenceRefId],
    );
    await testDatabase.executor.query(
      `INSERT INTO waspada.event_claim_geometries
         (dataset_kind, event_id, event_version, claim_id, geometry_id)
       VALUES ('synthetic', 'event-synthetic', 1, 'claim-synthetic', $1)`,
      [geometryId],
    );
    await testDatabase.executor.query(
      `INSERT INTO waspada.impact_versions
         (dataset_kind, impact_id, version, trace_id, event_id, event_version,
          impact_type, lifecycle, published_at, record_json)
       VALUES ('synthetic', 'impact-synthetic', 1, 'trace-synthetic', 'event-synthetic', 1,
          'road_closure', 'ongoing', '2026-09-24T10:20:00Z', $1::jsonb)`,
      [JSON.stringify(impactRecord)],
    );
    await testDatabase.executor.query(
      `INSERT INTO waspada.impact_claim_support
         (dataset_kind, impact_id, impact_version, event_id, event_version, claim_id)
       VALUES ('synthetic', 'impact-synthetic', 1, 'event-synthetic', 1, 'claim-synthetic')`,
    );
    await testDatabase.executor.query(
      `INSERT INTO waspada.event_impact_refs
         (dataset_kind, event_id, event_version, impact_id, impact_version)
       VALUES ('synthetic', 'event-synthetic', 1, 'impact-synthetic', 1)`,
    );
    await testDatabase.executor.execute('COMMIT;');
  } catch (error) {
    await testDatabase.executor.execute('ROLLBACK;');
    throw error;
  }
}

async function insertWithdrawalVersionTwo(testDatabase: TestDatabase): Promise<void> {
  const tombstone = {
    schema_version: '2.0', trace_id: 'trace-synthetic', record_type: 'Event', dataset_kind: 'synthetic',
    event_id: 'event-synthetic', version: 2, supersedes_version: 1,
    title: 'Synthetic withdrawal', summary: 'Synthetic tombstone', category: 'transport_road_incidents',
    tags: [], lifecycle: 'unknown', freshness: { status: 'expired', evaluated_at: '2026-09-24T10:30:00Z',
      review_due_at: '2026-09-24T10:30:00Z', basis: 'fixture' },
    event_time: { kind: 'unknown' }, validity: { valid_from: null, valid_until: null },
    scope: { place_ids: [], service_ids: [], institution_ids: [], audience_ids: [], geometry_ids: [] },
    claims: [], impact_refs: [], publication_status: 'withdrawn', withdrawal_reason: 'duplicate',
    publication_decision_id: 'decision-withdrawal', published_at: null, withdrawn_at: '2026-09-24T10:30:00Z',
  };

  await testDatabase.executor.execute('BEGIN; SET CONSTRAINTS ALL DEFERRED;');
  try {
    await testDatabase.executor.query(
      `INSERT INTO waspada.publication_decisions
         (dataset_kind, decision_id, trace_id, proposal_id, policy_version, event_id,
          event_version, decided_at, record_json)
       VALUES ('synthetic', 'decision-withdrawal', 'trace-synthetic', 'proposal-synthetic',
          'policy-test-v1', 'event-synthetic', 2, '2026-09-24T10:30:00Z', '{"decision":"withdraw"}'::jsonb)`,
    );
    await testDatabase.executor.query(
      `INSERT INTO waspada.publication_claim_decisions
         (dataset_kind, decision_id, proposal_id, claim_id, disposition, reason_codes)
       VALUES ('synthetic', 'decision-withdrawal', 'proposal-synthetic', 'claim-synthetic',
          'retract', ARRAY['fixture-withdrawal'])`,
    );
    await testDatabase.executor.query(
      `INSERT INTO waspada.publication_decision_evidence
         (dataset_kind, decision_id, claim_id, evidence_ref_id)
       VALUES ('synthetic', 'decision-withdrawal', 'claim-synthetic',
          (SELECT evidence_ref_id FROM waspada.evidence_references WHERE dataset_kind = 'synthetic' LIMIT 1))`,
    );
    await testDatabase.executor.query(
      `INSERT INTO waspada.event_versions
         (dataset_kind, event_id, version, trace_id, supersedes_version, title, summary,
          category, lifecycle, publication_status, withdrawal_reason, publication_decision_id,
          withdrawn_at, record_json)
       VALUES ('synthetic', 'event-synthetic', 2, 'trace-synthetic', 1, 'Synthetic withdrawal',
          'Synthetic tombstone', 'transport_road_incidents', 'unknown', 'withdrawn', 'duplicate',
          'decision-withdrawal', '2026-09-24T10:30:00Z', $1::jsonb)`,
      [JSON.stringify(tombstone)],
    );
    await testDatabase.executor.execute('COMMIT;');
  } catch (error) {
    await testDatabase.executor.execute('ROLLBACK;');
    throw error;
  }
}

async function insertEmbeddingRun(testDatabase: TestDatabase, embeddingRunId: string, dimensions: number): Promise<void> {
  await testDatabase.executor.query(
    `INSERT INTO waspada.embedding_runs
       (dataset_kind, embedding_run_id, trace_id, chunk_id, capability, provider,
        model_version, dimensions, distance_metric, vector_index_version,
        input_text_hash, status, created_at)
     VALUES ('synthetic', $1, 'trace-synthetic', 'chunk-a', 'embedding',
        'local-test', 'model-not-selected-fixture', $2, 'cosine', 'index-test-v1',
        $3, 'available', '2026-09-24T10:15:00Z')`,
    [embeddingRunId, dimensions, sha256('synthetic chunk')],
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
