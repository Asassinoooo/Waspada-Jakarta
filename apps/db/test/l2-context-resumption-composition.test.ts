import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  createSqlExactEvidenceReferenceReader,
  createSqlExactEvidenceSpanReader,
  type ExactEvidenceReferenceReadRequest,
  type ExactEvidenceSpanRequest,
} from '../src/evidence-retrieval.js';
import {
  createSqlGroundingContextRepository,
  type GroundingContextRecord,
  type GroundingEvidenceReference,
} from '../src/grounding-contexts.js';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import { createRepositoryPorts, type NewReportRevision, type TraceRecord } from '../src/ports.js';
import { createGroundingContextResumer, GroundingContextResumptionError } from '../../worker/src/layers/l2-model-grounding/context-resumption.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

const fixtureTime = '2026-10-01T01:00:00Z';
const reportText = {
  primary: 'Synthetic primary says the route is open 😀.',
  copy: 'Synthetic copied report says the route remains closed.',
};

describe('L2 refs-only grounding-context resume composition', () => {
  let database: TestDatabase;
  let ports: ReturnType<typeof createRepositoryPorts>;
  let record: GroundingContextRecord;
  let references: readonly GroundingEvidenceReference[];
  let evidenceIds: readonly string[];

  before(async () => {
    database = await createTestDatabase();
    const migrations = await readMigrations(new URL('../migrations/', import.meta.url));
    await applyMigrations(database.executor, migrations);
    ports = createRepositoryPorts(database.executor);
    await seedResumeFixture();
  });

  after(async () => database.close());

  it('resolves every saved identity once under the L2 reader, reloads provenance, and leaves rows unchanged', async () => {
    const snapshotBefore = await readPersistedSnapshot();
    const exactReferences = createSqlExactEvidenceReferenceReader(database.executor);
    const exactSpans = createSqlExactEvidenceSpanReader(database.executor);
    const contextRepository = createSqlGroundingContextRepository(database.executor);
    let referenceReadCount = 0;
    const referenceReadInputs: ExactEvidenceReferenceReadRequest[] = [];
    const spanReadInputs: ExactEvidenceSpanRequest[] = [];
    const resumer = createGroundingContextResumer({
      contexts: {
        async findById(datasetKind, contextId) {
          return withRole('waspada_l2_grounding_writer', () => contextRepository.findById(datasetKind, contextId));
        },
      },
      evidenceReferences: {
        async readExactReferences(request) {
          referenceReadCount += 1;
          referenceReadInputs.push(structuredClone(request));
          return withRole('waspada_l2_grounding_reader', () => exactReferences.readExactReferences(request));
        },
      },
      exactSpans: {
        async readExactSpan(request) {
          spanReadInputs.push(structuredClone(request));
          return withRole('waspada_l2_grounding_reader', () => exactSpans.readExactSpan(request));
        },
      },
    });

    const request = await resumer.resume('synthetic', record.context_id);

    assert.ok(request);
    assert.equal(referenceReadCount, 1, 'all saved identities resolve in one bounded SQL read');
    assert.deepEqual(referenceReadInputs[0]?.references, record.evidence.map(toIdentity));
    assert.deepEqual(spanReadInputs.map(({ evidenceReferenceId }) => evidenceReferenceId), evidenceIds);
    assert.equal(request.data.groundingContext.evidence.length, 2);
    assert.deepEqual(request.data.groundingContext.evidence.map(({ reference }) => reference.relation), [
      'supports', 'contradicts',
    ]);
    assert.deepEqual(request.data.groundingContext.evidence.map(({ text }) => text), [
      'says the route is open 😀', 'report says the route remains closed',
    ]);
    assert.equal(request.data.groundingContext.evidence[0]?.sourceId, 'source-resume-primary');
    assert.equal(request.data.groundingContext.evidence[0]?.publishedAt, '2026-10-01T01:02:03.123456Z');
    assert.equal(request.data.groundingContext.evidence[0]?.observedAt, '2026-10-01T02:03:04.000000Z');
    assert.equal(request.data.groundingContext.evidence[0]?.retrievedAt, '2026-10-01T03:04:05.654321Z');
    assert.deepEqual(request.data.groundingContext.evidence[1]?.origins, [{
      originId: 'origin-resume-copy',
      independenceStatus: 'dependent',
      dependsOnOriginIds: ['origin-resume-primary'],
    }]);
    assert.equal(request.data.groundingContext.sufficient, true);
    assert.equal(request.data.groundingContext.indexVersion, 'index-resume-v2');

    const directSnapshots = await withRole('waspada_l2_grounding_reader', () =>
      exactReferences.readExactReferences({
        datasetKind: 'synthetic',
        candidateId: record.candidate_id,
        references: record.evidence.map(toIdentity),
      }));
    assert.equal(directSnapshots.length, 2);
    assert.equal(new Set(directSnapshots.map((snapshot) => snapshot.evidenceReferenceId)).size, 2);
    assert.deepEqual(directSnapshots[1]?.origins, [{
      originId: 'origin-resume-copy',
      originKind: 'reporter_observation',
      sourceId: 'source-resume-copy',
      lineageRelation: 'copied',
      independenceStatus: 'dependent',
      dependsOnOriginIds: ['origin-resume-primary'],
    }]);
    assert.equal(directSnapshots[0]?.registryStatus, 'active');
    assert.equal(directSnapshots[0]?.approvalStatus, 'approved');
    assert.equal(directSnapshots[0]?.healthStatus, 'unavailable', 'source health does not gate stored evidence');
    assert.equal(directSnapshots[0]?.publishedAt, '2026-10-01T01:02:03.123456Z');
    assert.equal(directSnapshots[0]?.observedAt, '2026-10-01T02:03:04.000000Z');
    assert.equal(directSnapshots[0]?.retrievedAt, '2026-10-01T03:04:05.654321Z');

    const snapshotAfter = await readPersistedSnapshot();
    assert.deepEqual(snapshotAfter, snapshotBefore, 'resume changes no stored context, evidence, or origin rows');
    const stored = await database.executor.query<{ record_json: GroundingContextRecord }>(
      'SELECT record_json FROM waspada.grounding_contexts WHERE dataset_kind = $1 AND context_id = $2',
      [record.dataset_kind, record.context_id],
    );
    assert.equal(JSON.stringify(stored.rows[0]?.record_json).includes('primary says the route is open'), false);
    assert.equal(Object.hasOwn(stored.rows[0]!.record_json.evidence[0]!, 'text'), false);
  });

  it('keeps saved natural identities unique and resolves one row under the L2 reader', async () => {
    const identity = toIdentity(references[0]!);
    await assert.rejects(
      database.executor.query(
        'INSERT INTO waspada.evidence_references ' +
          '(dataset_kind, trace_id, report_revision_id, permitted_text_hash, span_start, span_end, offset_unit, relation) ' +
          'VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        ['synthetic', 'trace-resume-context', identity.reportRevisionId, identity.permittedTextHash,
          identity.spanStart, identity.spanEnd, identity.offsetUnit, identity.relation],
      ),
      /evidence_references_natural_identity_uq/,
    );
    const exactReferences = createSqlExactEvidenceReferenceReader(database.executor);
    const exactMatches = await withRole('waspada_l2_grounding_reader', () =>
      exactReferences.readExactReferences({
        datasetKind: 'synthetic',
        candidateId: record.candidate_id,
        references: [identity],
      }));
    assert.equal(exactMatches.length, 1);
    assert.equal(exactMatches[0]?.evidenceReferenceId, evidenceIds[0]);
  });

  it('returns no request when a saved span is invalidated by a current source assertion', async () => {
    const assertionRevision = await createRevision({
      reportRevisionId: 'revision-resume-withdrawal-assertion',
      sourceId: 'source-resume-copy',
      text: 'Synthetic publisher assertion that the prior report is withdrawn.',
      publishedAt: null,
      observedAt: fixtureTime,
      retrievedAt: fixtureTime,
    });
    await ports.reportRevisionSourceObservations.create({
      datasetKind: 'synthetic',
      observationId: 'observation-resume-withdrawn',
      traceId: 'trace-resume-context',
      targetReportRevisionId: 'revision-resume-copy',
      assertionReportRevisionId: assertionRevision.reportRevisionId,
      assertedState: 'withdrawn',
      retrievedAt: fixtureTime,
    });

    const snapshotBefore = await readPersistedSnapshot();
    const exactReferences = createSqlExactEvidenceReferenceReader(database.executor);
    const exactSpans = createSqlExactEvidenceSpanReader(database.executor);
    const contextRepository = createSqlGroundingContextRepository(database.executor);
    const resumer = createGroundingContextResumer({
      contexts: {
        async findById(datasetKind, contextId) {
          return withRole('waspada_l2_grounding_writer', () => contextRepository.findById(datasetKind, contextId));
        },
      },
      evidenceReferences: {
        async readExactReferences(request) {
          return withRole('waspada_l2_grounding_reader', () => exactReferences.readExactReferences(request));
        },
      },
      exactSpans: {
        async readExactSpan(request) {
          return withRole('waspada_l2_grounding_reader', () => exactSpans.readExactSpan(request));
        },
      },
    });

    await assert.rejects(
      resumer.resume('synthetic', record.context_id),
      (error: unknown) => error instanceof GroundingContextResumptionError && error.code === 'source_invalidated',
    );
    const snapshotAfter = await readPersistedSnapshot();
    assert.deepEqual(snapshotAfter, snapshotBefore, 'failed resume leaves all saved content and links unchanged');
  });

  it('keeps saved context rows private to the context writer', async () => {
    for (const role of [
      'waspada_l2_grounding_writer',
      'waspada_public_reader',
      'waspada_l3_coordinator',
    ]) {
      await database.executor.execute(`SET ROLE ${role}`);
      try {
        await assert.rejects(
          database.executor.query('SELECT permitted_text FROM waspada.report_revisions LIMIT 1'),
          /permission denied|denied/i,
        );
      } finally {
        await database.executor.execute('RESET ROLE');
      }
    }

    for (const role of [
      'waspada_public_reader',
      'waspada_l1_pipeline',
      'waspada_l2_grounding_reader',
      'waspada_l3_coordinator',
    ]) {
      await database.executor.execute(`SET ROLE ${role}`);
      try {
        await assert.rejects(
          database.executor.query('SELECT record_json FROM waspada.grounding_contexts LIMIT 1'),
          /permission denied|denied/i,
        );
      } finally {
        await database.executor.execute('RESET ROLE');
      }
    }
  });

  async function seedResumeFixture(): Promise<void> {
    const trace: TraceRecord = {
      traceId: 'trace-resume-context', datasetKind: 'synthetic', startedAt: fixtureTime,
      endedAt: null, outcome: 'open', metadata: { fixture: 'synthetic-test-only' },
    };
    await ports.tracesAndAudit.createTrace(trace);
    await insertSource('source-resume-primary', 'unavailable');
    await insertSource('source-resume-copy', 'healthy');

    const primary = await createRevision({
      reportRevisionId: 'revision-resume-primary',
      sourceId: 'source-resume-primary',
      text: reportText.primary,
      publishedAt: '2026-10-01T08:02:03.123456+07:00',
      observedAt: '2026-10-01T09:03:04+07:00',
      retrievedAt: '2026-10-01T10:04:05.654321+07:00',
    });
    const copy = await createRevision({
      reportRevisionId: 'revision-resume-copy',
      sourceId: 'source-resume-copy',
      text: reportText.copy,
      publishedAt: null,
      observedAt: '2026-10-01T11:05:06.000001+07:00',
      retrievedAt: '2026-10-01T12:06:07.000002+07:00',
    });
    const primaryRef = await ports.reportRevisions.createEvidenceReference({
      datasetKind: 'synthetic', traceId: trace.traceId, reportRevisionId: primary.reportRevisionId,
      permittedTextHash: primary.permittedTextHash,
      spanStart: Array.from('Synthetic primary ').length,
      spanEnd: Array.from('Synthetic primary ').length + Array.from('says the route is open 😀').length,
      relation: 'supports',
    });
    const copyRef = await ports.reportRevisions.createEvidenceReference({
      datasetKind: 'synthetic', traceId: trace.traceId, reportRevisionId: copy.reportRevisionId,
      permittedTextHash: copy.permittedTextHash,
      spanStart: Array.from('Synthetic copied ').length,
      spanEnd: Array.from('Synthetic copied ').length + Array.from('report says the route remains closed').length,
      relation: 'contradicts',
    });
    evidenceIds = [primaryRef, copyRef];
    references = [
      {
        report_revision_id: primary.reportRevisionId,
        permitted_text_hash: primary.permittedTextHash,
        span_start: Array.from('Synthetic primary ').length,
        span_end: Array.from('Synthetic primary ').length + Array.from('says the route is open 😀').length,
        offset_unit: 'unicode_code_points',
        relation: 'supports',
      },
      {
        report_revision_id: copy.reportRevisionId,
        permitted_text_hash: copy.permittedTextHash,
        span_start: Array.from('Synthetic copied ').length,
        span_end: Array.from('Synthetic copied ').length + Array.from('report says the route remains closed').length,
        offset_unit: 'unicode_code_points',
        relation: 'contradicts',
      },
    ];
    await database.executor.query(
      'INSERT INTO waspada.extraction_results ' +
        '(dataset_kind, candidate_id, trace_id, report_revision_id, category, record_json) ' +
        'VALUES ($1, $2, $3, $4, $5, $6::jsonb)',
      ['synthetic', 'candidate-resume-context', trace.traceId, primary.reportRevisionId,
        'transport_road_incidents', JSON.stringify({ fixture: 'synthetic-test-only' })],
    );
    for (const evidenceReferenceId of evidenceIds) {
      await database.executor.query(
        'INSERT INTO waspada.extraction_evidence (dataset_kind, candidate_id, evidence_ref_id) ' +
          'VALUES ($1, $2, $3)',
        ['synthetic', 'candidate-resume-context', evidenceReferenceId],
      );
    }

    await addOrigin({
      originId: 'origin-resume-primary', sourceId: 'source-resume-primary', evidenceReferenceId: primaryRef,
      originKind: 'issuer_statement', lineageRelation: 'original', independenceStatus: 'established',
    });
    await addOrigin({
      originId: 'origin-resume-copy', sourceId: 'source-resume-copy', evidenceReferenceId: copyRef,
      originKind: 'reporter_observation', lineageRelation: 'copied', independenceStatus: 'dependent',
    });
    await database.executor.query(
      'INSERT INTO waspada.origin_dependencies (dataset_kind, origin_id, depends_on_origin_id) ' +
        'VALUES ($1, $2, $3)',
      ['synthetic', 'origin-resume-copy', 'origin-resume-primary'],
    );

    record = {
      schema_version: '2.0',
      trace_id: trace.traceId,
      record_type: 'GroundingContext',
      dataset_kind: 'synthetic',
      context_id: 'context-resume-context',
      candidate_id: 'candidate-resume-context',
      evidence: references,
      revision_states: [
        { report_revision_id: primary.reportRevisionId, revision_status: 'eligible' },
        { report_revision_id: copy.reportRevisionId, revision_status: 'eligible' },
      ],
      candidate_events: [],
      prior_decision_ids: [],
      missing_fields: ['service_status'],
      conflicts: ['primary and copied report disagree'],
      retrieval_version: 'exact-retrieval-resume-v1',
      index_version: 'index-resume-v2',
      sufficient: true,
    };
    await withRole('waspada_l2_grounding_writer', () =>
      ports.groundingContexts.createOrVerify(record));
  }

  async function createRevision(input: {
    readonly reportRevisionId: string;
    readonly sourceId: string;
    readonly text: string;
    readonly publishedAt: string | null;
    readonly observedAt: string | null;
    readonly retrievedAt: string;
  }): Promise<NewReportRevision> {
    const revision: NewReportRevision = {
      datasetKind: 'synthetic',
      reportRevisionId: input.reportRevisionId,
      traceId: 'trace-resume-context',
      sourceId: input.sourceId,
      canonicalUrl: `https://synthetic.invalid/${input.reportRevisionId}`,
      sourceRevisionKey: null,
      contentHash: sha256(`synthetic raw ${input.reportRevisionId}`),
      permittedText: input.text,
      permittedTextHash: sha256(input.text),
      normalizationVersion: 'synthetic-test-normalizer-v1',
      publishedAt: input.publishedAt,
      observedAt: input.observedAt,
      retrievedAt: input.retrievedAt,
      validFrom: null,
      validUntil: null,
      supersedesId: null,
      revisionStatus: 'eligible',
      recordJson: { fixture: 'synthetic-test-only' },
    };
    await ports.reportRevisions.create(revision);
    return revision;
  }

  async function insertSource(sourceId: string, health: 'healthy' | 'unavailable'): Promise<void> {
    await database.executor.query(
      'INSERT INTO waspada.source_registry ' +
        '(source_id, trace_id, registry_version, display_name, source_kind, remit, access_method, ' +
        'approved_hosts, access_restrictions, reuse_basis, registry_status, approval_status, health_status, ' +
        'auto_acquisition_enabled, auto_publication_policy) ' +
        'VALUES ($1, $2, 1, $3, $4, ARRAY[$5], $6, ARRAY[]::text[], ARRAY[$7], ARRAY[$8], ' +
        '\'active\', \'approved\', $9, false, \'never\')',
      [sourceId, 'trace-resume-context', `Synthetic source ${sourceId}`, 'institution',
        'synthetic local test', 'manual_fixture', 'synthetic test only', 'test fixture', health],
    );
  }

  async function addOrigin(input: {
    readonly originId: string;
    readonly sourceId: string;
    readonly evidenceReferenceId: string;
    readonly originKind: string;
    readonly lineageRelation: string;
    readonly independenceStatus: 'established' | 'dependent' | 'unknown';
  }): Promise<void> {
    await database.executor.query(
      'INSERT INTO waspada.evidence_origins ' +
        '(dataset_kind, origin_id, trace_id, origin_kind, actor_label, source_id, lineage_relation, ' +
        'independence_status, record_json) VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8::jsonb)',
      ['synthetic', input.originId, 'trace-resume-context', input.originKind, input.sourceId,
        input.lineageRelation, input.independenceStatus, JSON.stringify({ fixture: 'synthetic-test-only' })],
    );
    await database.executor.query(
      'INSERT INTO waspada.origin_evidence (dataset_kind, origin_id, evidence_ref_id) VALUES ($1, $2, $3)',
      ['synthetic', input.originId, input.evidenceReferenceId],
    );
  }

  async function readPersistedSnapshot(): Promise<unknown> {
    const context = await database.executor.query(
      'SELECT dataset_kind, context_id, trace_id, candidate_id, retrieval_version, index_version, ' +
        'sufficient, record_json FROM waspada.grounding_contexts WHERE dataset_kind = $1 AND context_id = $2',
      [record.dataset_kind, record.context_id],
    );
    const groundingEvidence = await database.executor.query(
      'SELECT dataset_kind, context_id, evidence_ref_id::text AS evidence_ref_id ' +
        'FROM waspada.grounding_evidence WHERE dataset_kind = $1 AND context_id = $2 ORDER BY evidence_ref_id',
      [record.dataset_kind, record.context_id],
    );
    const extractionEvidence = await database.executor.query(
      'SELECT dataset_kind, candidate_id, evidence_ref_id::text AS evidence_ref_id ' +
        'FROM waspada.extraction_evidence WHERE dataset_kind = $1 AND candidate_id = $2 ORDER BY evidence_ref_id',
      [record.dataset_kind, record.candidate_id],
    );
    const origins = await database.executor.query(
      'SELECT dataset_kind, origin_id, source_id, lineage_relation, independence_status ' +
        'FROM waspada.evidence_origins WHERE dataset_kind = $1 ORDER BY origin_id',
      [record.dataset_kind],
    );
    const originEvidence = await database.executor.query(
      'SELECT dataset_kind, origin_id, evidence_ref_id::text AS evidence_ref_id ' +
        'FROM waspada.origin_evidence WHERE dataset_kind = $1 ORDER BY origin_id, evidence_ref_id',
      [record.dataset_kind],
    );
    const dependencies = await database.executor.query(
      'SELECT dataset_kind, origin_id, depends_on_origin_id FROM waspada.origin_dependencies ' +
        'WHERE dataset_kind = $1 ORDER BY origin_id, depends_on_origin_id',
      [record.dataset_kind],
    );
    return {
      context: context.rows,
      groundingEvidence: groundingEvidence.rows,
      extractionEvidence: extractionEvidence.rows,
      origins: origins.rows,
      originEvidence: originEvidence.rows,
      dependencies: dependencies.rows,
    };
  }

  async function withRole<Result>(role: string, work: () => Promise<Result>): Promise<Result> {
    await database.executor.execute(`SET ROLE ${role}`);
    try {
      return await work();
    } finally {
      await database.executor.execute('RESET ROLE');
    }
  }
});

function toIdentity(reference: GroundingEvidenceReference): ExactEvidenceReferenceReadRequest['references'][number] {
  return {
    reportRevisionId: reference.report_revision_id,
    permittedTextHash: reference.permitted_text_hash,
    spanStart: reference.span_start,
    spanEnd: reference.span_end,
    offsetUnit: reference.offset_unit,
    relation: reference.relation,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
