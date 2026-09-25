import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import { createRepositoryPorts, type NewReportRevision, type TraceRecord } from '../src/ports.js';
import type { EvidenceRetrievalQuery } from '../src/evidence-retrieval.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

const syntheticStartedAt = '2026-09-25T05:00:00Z';
const embeddingIdentity = {
  provider: 'synthetic-test-only',
  modelVersion: 'fixture-model-v1',
  dimensions: 2,
  distanceMetric: 'cosine' as const,
  vectorIndexVersion: 'fixture-index-v1',
};

const catalogTrace: TraceRecord = {
  traceId: 'trace-retrieval-catalog',
  datasetKind: null,
  startedAt: syntheticStartedAt,
  endedAt: null,
  outcome: 'open',
  metadata: { fixture: 'synthetic-test-only' },
};
const syntheticTrace: TraceRecord = {
  traceId: 'trace-retrieval-synthetic',
  datasetKind: 'synthetic',
  startedAt: syntheticStartedAt,
  endedAt: null,
  outcome: 'open',
  metadata: { fixture: 'synthetic-test-only' },
};
const historyTrace: TraceRecord = {
  traceId: 'trace-retrieval-history',
  datasetKind: 'historical',
  startedAt: syntheticStartedAt,
  endedAt: null,
  outcome: 'open',
  metadata: { fixture: 'synthetic-test-only' },
};

describe('RAG-CORE deterministic evidence retrieval', () => {
  let testDatabase: TestDatabase;
  let ports: ReturnType<typeof createRepositoryPorts>;

  before(async () => {
    testDatabase = await createTestDatabase();
    ports = createRepositoryPorts(testDatabase.executor);
    const migrations = await readMigrations(new URL('../migrations/', import.meta.url));
    await applyMigrations(testDatabase.executor, migrations);
    await ports.tracesAndAudit.createTrace(catalogTrace);
    await ports.tracesAndAudit.createTrace(syntheticTrace);
    await ports.tracesAndAudit.createTrace(historyTrace);
    await addSource('source-syn-alpha', 'active', 'approved', 'healthy');
    await addSource('source-syn-beta', 'paused', 'suspended', 'degraded');
    await addSource('source-syn-gamma', 'active', 'pending', 'unknown');
    await addSource('source-syn-history', 'retired', 'revoked', 'unavailable');

    await addFixture({
      datasetKind: 'synthetic',
      traceId: syntheticTrace.traceId,
      sourceId: 'source-syn-alpha',
      candidateId: 'candidate-syn-alpha',
      reportRevisionId: 'revision-syn-alpha',
      text: 'Synthetic notice: closure near Monas 😀; time 2026-09-25.',
      span: 'closure near Monas 😀',
      relation: 'supports',
      revisionStatus: 'eligible',
      publishedAt: '2026-09-25T05:00:00Z',
      observedAt: '2026-09-25T06:00:00Z',
      retrievedAt: '2026-09-25T07:00:00Z',
      eventTime: { start: '2026-09-25', end: null, precision: 'date' },
      origin: {
        originId: 'origin-syn-alpha',
        originKind: 'issuer_statement',
        lineageRelation: 'original',
        independenceStatus: 'established',
      },
      geometry: { geometryId: 'geometry-syn-alpha', longitude: 106.8, latitude: -6.2 },
      vector: [1, 0],
    });
    await addAlternateEmbedding('embedding-euclidean-syn-alpha', 'euclidean', 'fixture-euclidean-v1', [2, 0]);
    await addAlternateEmbedding('embedding-dot-syn-alpha', 'dot_product', 'fixture-dot-v1', [2, 0]);
    await addFixture({
      datasetKind: 'synthetic',
      traceId: syntheticTrace.traceId,
      sourceId: 'source-syn-beta',
      candidateId: 'candidate-syn-beta',
      reportRevisionId: 'revision-syn-beta',
      text: 'Synthetic report: NOT closure near Monas; this copied report contradicts the notice.',
      span: 'NOT closure near Monas',
      relation: 'contradicts',
      revisionStatus: 'retracted',
      publishedAt: '2026-09-25T05:15:00Z',
      observedAt: '2026-09-25T05:45:00Z',
      retrievedAt: '2026-09-25T07:30:00Z',
      eventTime: { start: '2026-09-26', end: '2026-09-26', precision: 'date' },
      origin: {
        originId: 'origin-syn-beta',
        originKind: 'reporter_observation',
        lineageRelation: 'copied',
        independenceStatus: 'dependent',
        dependsOnOriginIds: ['origin-syn-alpha'],
      },
      geometry: { geometryId: 'geometry-syn-beta', longitude: 106.80001, latitude: -6.2 },
      vector: [0.7, 0.7],
      embeddingStatus: 'invalidated',
    });
    await addFixture({
      datasetKind: 'synthetic',
      traceId: syntheticTrace.traceId,
      sourceId: 'source-syn-gamma',
      candidateId: 'candidate-syn-gamma',
      reportRevisionId: 'revision-syn-gamma',
      text: 'Synthetic record has closure token elsewhere; cited span is status unknown.',
      span: 'status unknown',
      relation: 'context',
      revisionStatus: 'quarantined',
      publishedAt: null,
      observedAt: null,
      retrievedAt: '2026-09-25T08:00:00Z',
      eventTime: { start: 'not-a-time', end: null, precision: 'exact' },
      vector: null,
    });
    await addFixture({
      datasetKind: 'historical',
      traceId: historyTrace.traceId,
      sourceId: 'source-syn-history',
      candidateId: 'candidate-history-closure',
      reportRevisionId: 'revision-history-closure',
      text: 'Synthetic historical closure record.',
      span: 'historical closure',
      relation: 'context',
      revisionStatus: 'eligible',
      publishedAt: '2026-09-20T05:00:00Z',
      observedAt: '2026-09-20T05:30:00Z',
      retrievedAt: '2026-09-20T06:00:00Z',
      eventTime: { start: '2026-09-20', end: '2026-09-20', precision: 'date' },
      vector: [1, 0],
    });
  });

  after(async () => {
    await testDatabase.close();
  });

  it('keeps contrary evidence, revision/source states, source times, and origin dependence', async () => {
    const result = await ports.evidenceRetrieval.search({
      datasetKind: 'synthetic',
      identifiers: [{ kind: 'candidate', value: 'candidate-syn-alpha' }],
      exactTerms: ['closure', 'Monas'],
    });
    assert.deepEqual(result.candidates.map((candidate) => candidate.candidateId), [
      'candidate-syn-alpha', 'candidate-syn-beta',
    ]);
    const alpha = result.candidates[0]!;
    const beta = result.candidates[1]!;
    assert.equal(alpha.relation, 'supports');
    assert.equal(beta.relation, 'contradicts');
    assert.equal(alpha.revisionStatus, 'eligible');
    assert.equal(beta.revisionStatus, 'retracted');
    assert.equal(beta.source.registryStatus, 'paused');
    assert.equal(beta.source.approvalStatus, 'suspended');
    assert.equal(beta.source.healthStatus, 'degraded');
    assert.deepEqual(beta.origins[0]?.dependsOnOriginIds, ['origin-syn-alpha']);
    assert.equal(beta.origins[0]?.independenceStatus, 'dependent');
    assert.equal(beta.originLineageStatus, 'recorded');
    assert.equal(Date.parse(alpha.publishedAt!), Date.parse('2026-09-25T05:00:00Z'));
    assert.equal(Date.parse(alpha.observedAt!), Date.parse('2026-09-25T06:00:00Z'));
    assert.equal(Date.parse(alpha.retrievedAt), Date.parse('2026-09-25T07:00:00Z'));
    assert.equal(alpha.matchFacets.identifiers.length, 1);
    assert.deepEqual(alpha.matchFacets.exactTerms, ['closure', 'Monas']);
    assert.equal('sufficient' in result, false);
    assert.equal('confidence' in alpha, false);
  });

  it('matches only terms inside the referenced span and leaves missing origin lineage unknown', async () => {
    const closureSearch = await ports.evidenceRetrieval.search({ datasetKind: 'synthetic', exactTerms: ['closure'] });
    assert.deepEqual(closureSearch.candidates.map((candidate) => candidate.candidateId), [
      'candidate-syn-beta', 'candidate-syn-alpha',
    ]);
    assert.equal(closureSearch.candidates.some((candidate) => candidate.candidateId === 'candidate-syn-gamma'), false);

    const gamma = await ports.evidenceRetrieval.search({
      datasetKind: 'synthetic',
      identifiers: [{ kind: 'candidate', value: 'candidate-syn-gamma' }],
    });
    assert.equal(gamma.candidates[0]?.originLineageStatus, 'unknown');
    assert.deepEqual(gamma.candidates[0]?.origins, []);
    assert.equal(gamma.candidates[0]?.relation, 'context');
    assert.equal(gamma.candidates[0]?.eventTime.status, 'invalid');
  });

  it('keeps report, event and validity time bases separate and intersects only linked source geometry', async () => {
    const result = await ports.evidenceRetrieval.search({
      datasetKind: 'synthetic',
      geometry: { type: 'Point', coordinates: [106.8, -6.2] },
      reportTime: { from: '2026-09-25T05:30:00Z', until: '2026-09-25T06:30:00Z' },
      eventTime: { from: '2026-09-25', until: '2026-09-25' },
    });
    assert.equal(result.candidates.length, 2, 'candidates match any requested facet, so beta remains through report time');
    const alpha = result.candidates.find((candidate) => candidate.candidateId === 'candidate-syn-alpha')!;
    const beta = result.candidates.find((candidate) => candidate.candidateId === 'candidate-syn-beta')!;
    assert.equal(alpha.candidateId, 'candidate-syn-alpha');
    assert.deepEqual(alpha.matchFacets.reportTimeFields, ['observed_at']);
    assert.equal(alpha.matchFacets.eventTime, true);
    assert.equal(alpha.matchFacets.geometry, true);
    assert.deepEqual(alpha.geometryMatches.map((match) => match.geometryId), ['geometry-syn-alpha']);
    assert.equal(alpha.validFrom, null);
    assert.equal(alpha.validUntil, null);
    assert.equal(beta.matchFacets.geometry, false);
    assert.equal(beta.matchFacets.eventTime, false);
  });

  it('binds semantic distance to the exact active chunk and embedding identity', async () => {
    const query: EvidenceRetrievalQuery = {
      datasetKind: 'synthetic',
      exactTerms: ['closure'],
      semantic: { identity: embeddingIdentity, queryVector: [1, 0] },
    };
    const result = await ports.evidenceRetrieval.search(query);
    assert.equal(result.semanticStatus, 'matched');
    assert.equal(result.indexVersion, embeddingIdentity.vectorIndexVersion);
    const alpha = result.candidates.find((candidate) => candidate.candidateId === 'candidate-syn-alpha')!;
    assert.equal(alpha.matchFacets.semanticDistance, 0);
    assert.equal(alpha.chunk?.chunkTextHash, sha256('Synthetic notice: closure near Monas 😀; time 2026-09-25.'));
    assert.equal(alpha.chunk?.embeddingModelVersion, 'fixture-model-v1');
    assert.equal(alpha.chunk?.embeddingDimensions, 2);
    assert.equal(alpha.chunk?.embeddingIndexVersion, 'fixture-index-v1');
    assert.equal(alpha.chunk?.embeddingStatus, 'matched');
    const beta = result.candidates.find((candidate) => candidate.candidateId === 'candidate-syn-beta')!;
    assert.equal(beta.chunk?.embeddingStatus, 'no_compatible_embedding');
    assert.equal(beta.matchFacets.semanticDistance, null, 'invalidated embedding runs are not semantic candidates');

    const incompatible = await ports.evidenceRetrieval.search({
      ...query,
      semantic: { identity: { ...embeddingIdentity, vectorIndexVersion: 'different-index-v9' }, queryVector: [1, 0] },
    });
    assert.equal(incompatible.semanticStatus, 'no_compatible_vector');
    assert.ok(incompatible.candidates.length > 0, 'exact terms still return candidates without compatible vectors');
    assert.equal(incompatible.candidates.some((candidate) => candidate.matchFacets.semanticDistance !== null), false);
  });

  it('keeps exact and temporal candidates when the caller has no query vector', async () => {
    const result = await ports.evidenceRetrieval.search({
      datasetKind: 'synthetic',
      identifiers: [{ kind: 'candidate', value: 'candidate-syn-alpha' }],
      reportTime: { from: '2026-09-25T05:00:00Z', until: '2026-09-25T07:00:00Z' },
      semantic: { identity: embeddingIdentity },
    });
    assert.equal(result.semanticStatus, 'query_vector_missing');
    assert.equal(result.candidates.length, 2, 'alpha matches the identifier and beta matches the report time');
    const alpha = result.candidates.find((candidate) => candidate.candidateId === 'candidate-syn-alpha')!;
    assert.deepEqual(alpha.matchFacets.reportTimeFields, ['published_at', 'observed_at', 'retrieved_at']);
    assert.equal(alpha.chunk?.embeddingStatus, 'query_vector_missing');
  });

  it('uses the stored distance metric operator selected by an exact embedding identity', async () => {
    const euclidean = await ports.evidenceRetrieval.search({
      datasetKind: 'synthetic',
      identifiers: [{ kind: 'candidate', value: 'candidate-syn-alpha' }],
      semantic: {
        identity: { ...embeddingIdentity, distanceMetric: 'euclidean', vectorIndexVersion: 'fixture-euclidean-v1' },
        queryVector: [1, 0],
      },
    });
    const euclideanCandidate = euclidean.candidates.find((candidate) => candidate.candidateId === 'candidate-syn-alpha')!;
    assert.equal(euclideanCandidate.matchFacets.semanticDistance, 1);
    assert.equal(euclideanCandidate.chunk?.embeddingDistanceMetric, 'euclidean');

    const dotProduct = await ports.evidenceRetrieval.search({
      datasetKind: 'synthetic',
      identifiers: [{ kind: 'candidate', value: 'candidate-syn-alpha' }],
      semantic: {
        identity: { ...embeddingIdentity, distanceMetric: 'dot_product', vectorIndexVersion: 'fixture-dot-v1' },
        queryVector: [1, 0],
      },
    });
    const dotProductCandidate = dotProduct.candidates.find((candidate) => candidate.candidateId === 'candidate-syn-alpha')!;
    assert.equal(dotProductCandidate.matchFacets.semanticDistance, -2);
    assert.equal(dotProductCandidate.chunk?.embeddingDistanceMetric, 'dot_product');
  });

  it('isolates datasets, includes statuses by default, and applies exact status filters', async () => {
    const synthetic = await ports.evidenceRetrieval.search({ datasetKind: 'synthetic', exactTerms: ['closure'] });
    assert.equal(synthetic.candidates.some((candidate) => candidate.datasetKind !== 'synthetic'), false);
    assert.equal(synthetic.candidates.some((candidate) => candidate.revisionStatus === 'retracted'), true);
    assert.equal(synthetic.candidates.some((candidate) => candidate.revisionStatus === 'quarantined'), false,
      'gamma does not match because closure is outside its evidence span');
    const quarantined = await ports.evidenceRetrieval.search({
      datasetKind: 'synthetic',
      identifiers: [{ kind: 'candidate', value: 'candidate-syn-gamma' }],
    });
    assert.equal(quarantined.candidates[0]?.revisionStatus, 'quarantined');
    assert.equal(quarantined.candidates[0]?.source.approvalStatus, 'pending');

    const historical = await ports.evidenceRetrieval.search({ datasetKind: 'historical', exactTerms: ['closure'] });
    assert.deepEqual(historical.candidates.map((candidate) => candidate.candidateId), ['candidate-history-closure']);

    const eligible = await ports.evidenceRetrieval.search({
      datasetKind: 'synthetic',
      exactTerms: ['closure'],
      filters: { revisionStatuses: ['eligible'] },
    });
    assert.deepEqual(eligible.candidates.map((candidate) => candidate.candidateId), ['candidate-syn-alpha']);
    assert.equal(eligible.filteredRowsOmitted, 2);
  });

  it('deduplicates repeated identifier and term facets before ranking', async () => {
    const result = await ports.evidenceRetrieval.search({
      datasetKind: 'synthetic',
      identifiers: [
        { kind: 'candidate', value: 'candidate-syn-alpha' },
        { kind: 'candidate', value: 'candidate-syn-alpha' },
      ],
      exactTerms: ['closure', 'closure'],
    });
    const alpha = result.candidates.find((candidate) => candidate.candidateId === 'candidate-syn-alpha')!;
    assert.equal(alpha.matchFacets.identifiers.length, 1);
    assert.deepEqual(alpha.matchFacets.exactTerms, ['closure']);
  });

  it('rejects malformed or non-CRS84 geometry before it reaches PostGIS', async () => {
    await assert.rejects(
      ports.evidenceRetrieval.search({
        datasetKind: 'synthetic',
        geometry: { type: 'LineString', coordinates: [[106.8, -6.2]] },
      }),
      /at least two CRS84 positions/,
    );
    await assert.rejects(
      ports.evidenceRetrieval.search({
        datasetKind: 'synthetic',
        geometry: {
          type: 'Polygon',
          coordinates: [[[106.8, -6.2], [106.9, -6.2], [106.9, -6.1], [106.8, -6.1]]],
        },
      }),
      /rings must be closed/,
    );
    await assert.rejects(
      ports.evidenceRetrieval.search({
        datasetKind: 'synthetic',
        geometry: { type: 'Point', coordinates: [181, -6.2] },
      }),
      /bounded two-dimensional CRS84 positions/,
    );
  });

  it('returns deterministic bounded results and reports scan/result truncation', async () => {
    const bounded: EvidenceRetrievalQuery = {
      datasetKind: 'synthetic',
      identifiers: [
        { kind: 'candidate', value: 'candidate-syn-alpha' },
        { kind: 'candidate', value: 'candidate-syn-beta' },
        { kind: 'candidate', value: 'candidate-syn-gamma' },
      ],
      maxRowsExamined: 2,
      maxResults: 1,
    };
    const first = await ports.evidenceRetrieval.search(bounded);
    const second = await ports.evidenceRetrieval.search(bounded);
    assert.deepEqual(first.candidates.map((candidate) => candidate.evidenceReferenceId),
      second.candidates.map((candidate) => candidate.evidenceReferenceId));
    assert.equal(first.rowsExamined, 2);
    assert.equal(first.scanTruncated, true);
    assert.equal(first.resultTruncated, true);
    await assert.rejects(
      ports.evidenceRetrieval.search({ ...bounded, maxRowsExamined: 251 }),
      /outside its hard bound/,
    );
    await assert.rejects(
      ports.evidenceRetrieval.search({
        datasetKind: 'synthetic', exactTerms: ['closure'],
        semantic: { identity: embeddingIdentity, queryVector: [1] },
      }),
      /match the requested embedding dimensions/,
    );
  });

  it('returns explicit full-reference and bounded-excerpt code-point offsets', async () => {
    const text = 'Synthetic fixture span: 😀' + 'x'.repeat(600) + 'zz-tail';
    await addFixture({
      datasetKind: 'synthetic',
      traceId: syntheticTrace.traceId,
      sourceId: 'source-syn-alpha',
      candidateId: 'candidate-syn-long-span',
      reportRevisionId: 'revision-syn-long-span',
      text,
      span: text,
      relation: 'context',
      revisionStatus: 'unreviewed',
      publishedAt: null,
      observedAt: null,
      retrievedAt: '2026-09-25T08:30:00Z',
      eventTime: { start: null, end: null, precision: 'unknown' },
      vector: null,
    });
    const result = await ports.evidenceRetrieval.search({
      datasetKind: 'synthetic',
      exactTerms: ['zz-tail'],
      maxSpanTextCodePoints: 100,
    });
    const candidate = result.candidates[0]!;
    assert.equal(candidate.spanEnd - candidate.spanStart, Array.from(text).length);
    assert.equal(candidate.spanTextEnd - candidate.spanTextStart, 100);
    assert.equal(Array.from(candidate.spanText).length, 100);
    assert.equal(candidate.spanTextTruncated, true);
    assert.equal(candidate.spanText.includes('😀'), true);
    assert.equal(candidate.spanText.includes('zz-tail'), false,
      'the exact term match remains tied to the full reference span while the excerpt is visibly capped');
  });

  async function addSource(
    sourceId: string,
    registryStatus: 'active' | 'paused' | 'retired',
    approvalStatus: 'pending' | 'approved' | 'suspended' | 'revoked',
    healthStatus: 'unknown' | 'healthy' | 'degraded' | 'unavailable',
  ): Promise<void> {
    await testDatabase.executor.query(
      `INSERT INTO waspada.source_registry
         (source_id, trace_id, registry_version, display_name, source_kind, remit,
          access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
          approval_status, health_status, auto_acquisition_enabled, auto_publication_policy)
       VALUES ($1, $2, 1, $3, 'other', ARRAY['synthetic test remit'], 'manual_fixture',
          ARRAY[]::text[], ARRAY['synthetic rows only'], ARRAY['test fixture'], $4,
          $5, $6, false, 'never')`,
      [sourceId, catalogTrace.traceId, `Synthetic source ${sourceId}`, registryStatus, approvalStatus, healthStatus],
    );
  }

  async function addFixture(fixture: FixtureInput): Promise<void> {
    const revision = makeRevision(fixture);
    await ports.reportRevisions.create(revision);
    const codePoints = Array.from(fixture.text);
    const spanStart = codePointOffset(fixture.text, fixture.text.indexOf(fixture.span));
    const spanEnd = spanStart + Array.from(fixture.span).length;
    const evidenceReferenceId = await ports.reportRevisions.createEvidenceReference({
      datasetKind: fixture.datasetKind,
      traceId: fixture.traceId,
      reportRevisionId: fixture.reportRevisionId,
      permittedTextHash: revision.permittedTextHash,
      spanStart,
      spanEnd,
      relation: fixture.relation,
    });
    await testDatabase.executor.query(
      `INSERT INTO waspada.extraction_results
         (dataset_kind, candidate_id, trace_id, report_revision_id, category, record_json)
       VALUES ($1, $2, $3, $4, 'transport_road_incidents', $5::jsonb)`,
      [fixture.datasetKind, fixture.candidateId, fixture.traceId, fixture.reportRevisionId,
        JSON.stringify({
          fixture: 'synthetic-test-only',
          event_time: fixture.eventTime,
          contractVersion: '2.0',
        })],
    );
    await testDatabase.executor.query(
      `INSERT INTO waspada.extraction_evidence (dataset_kind, candidate_id, evidence_ref_id)
       VALUES ($1, $2, $3)`,
      [fixture.datasetKind, fixture.candidateId, evidenceReferenceId],
    );
    if (fixture.origin) {
      await testDatabase.executor.query(
        `INSERT INTO waspada.evidence_origins
           (dataset_kind, origin_id, trace_id, origin_kind, source_id, lineage_relation,
            independence_status, record_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, '{"fixture":"synthetic-test-only"}'::jsonb)`,
        [fixture.datasetKind, fixture.origin.originId, fixture.traceId, fixture.origin.originKind,
          fixture.sourceId, fixture.origin.lineageRelation, fixture.origin.independenceStatus],
      );
      await testDatabase.executor.query(
        `INSERT INTO waspada.origin_report_revisions (dataset_kind, origin_id, report_revision_id)
         VALUES ($1, $2, $3)`,
        [fixture.datasetKind, fixture.origin.originId, fixture.reportRevisionId],
      );
      await testDatabase.executor.query(
        `INSERT INTO waspada.origin_evidence (dataset_kind, origin_id, evidence_ref_id)
         VALUES ($1, $2, $3)`,
        [fixture.datasetKind, fixture.origin.originId, evidenceReferenceId],
      );
      for (const dependencyId of fixture.origin.dependsOnOriginIds ?? []) {
        await testDatabase.executor.query(
          `INSERT INTO waspada.origin_dependencies (dataset_kind, origin_id, depends_on_origin_id)
           VALUES ($1, $2, $3)`,
          [fixture.datasetKind, fixture.origin.originId, dependencyId],
        );
      }
    }
    if (fixture.geometry) {
      await testDatabase.executor.query(
        `INSERT INTO waspada.geometries
           (dataset_kind, geometry_id, trace_id, role, shape, coordinate_reference_system,
            precision_m, precision_basis, display_label, record_json)
         VALUES ($1, $2, $3, 'incident_scene',
           ST_SetSRID(ST_GeomFromGeoJSON($4::text), 4326), 'OGC:CRS84', 25,
           'source_supplied', 'Synthetic test point', '{"fixture":"synthetic-test-only"}'::jsonb)`,
        [fixture.datasetKind, fixture.geometry.geometryId, fixture.traceId,
          JSON.stringify({ type: 'Point', coordinates: [fixture.geometry.longitude, fixture.geometry.latitude] })],
      );
      await testDatabase.executor.query(
        `INSERT INTO waspada.geometry_evidence (dataset_kind, geometry_id, evidence_ref_id)
         VALUES ($1, $2, $3)`,
        [fixture.datasetKind, fixture.geometry.geometryId, evidenceReferenceId],
      );
    }
    const chunkId = `chunk-${fixture.candidateId}`;
    const chunkHash = sha256(fixture.text);
    await testDatabase.executor.query(
      `INSERT INTO waspada.evidence_chunks
         (dataset_kind, chunk_id, trace_id, report_revision_id, permitted_text_hash,
          span_start, span_end, offset_unit, chunker_version, chunk_text_hash, status)
       VALUES ($1, $2, $3, $4, $5, 0, $6, 'unicode_code_points', 'synthetic-chunker-v1', $7, 'active')`,
      [fixture.datasetKind, chunkId, fixture.traceId, fixture.reportRevisionId,
        revision.permittedTextHash, codePoints.length, chunkHash],
    );
    if (fixture.vector) {
      const runId = `embedding-${fixture.candidateId}`;
      await testDatabase.executor.query(
        `INSERT INTO waspada.embedding_runs
           (dataset_kind, embedding_run_id, trace_id, chunk_id, capability, provider,
          model_version, dimensions, distance_metric, vector_index_version,
          input_text_hash, status, created_at)
         VALUES ($1, $2, $3, $4, 'embedding', $5, $6, 2, 'cosine', $7, $8, $9, $10)`,
        [fixture.datasetKind, runId, fixture.traceId, chunkId, embeddingIdentity.provider,
          embeddingIdentity.modelVersion, embeddingIdentity.vectorIndexVersion, chunkHash,
          fixture.embeddingStatus ?? 'available', fixture.retrievedAt],
      );
      await testDatabase.executor.query(
        `INSERT INTO waspada.embedding_vectors (dataset_kind, embedding_run_id, dimensions, embedding)
         VALUES ($1, $2, 2, $3::vector)`,
        [fixture.datasetKind, runId, `[${fixture.vector.join(',')}]`],
      );
    }
  }

  async function addAlternateEmbedding(
    embeddingRunId: string,
    distanceMetric: 'euclidean' | 'dot_product',
    vectorIndexVersion: string,
    vector: readonly [number, number],
  ): Promise<void> {
    const chunkId = 'chunk-candidate-syn-alpha';
    const chunkHash = sha256('Synthetic notice: closure near Monas 😀; time 2026-09-25.');
    await testDatabase.executor.query(
      `INSERT INTO waspada.embedding_runs
         (dataset_kind, embedding_run_id, trace_id, chunk_id, capability, provider,
          model_version, dimensions, distance_metric, vector_index_version,
          input_text_hash, status, created_at)
       VALUES ('synthetic', $1, $2, $3, 'embedding', $4, $5, 2, $6, $7, $8, 'available', $9)`,
      [embeddingRunId, syntheticTrace.traceId, chunkId, embeddingIdentity.provider,
        embeddingIdentity.modelVersion, distanceMetric, vectorIndexVersion, chunkHash, syntheticStartedAt],
    );
    await testDatabase.executor.query(
      `INSERT INTO waspada.embedding_vectors (dataset_kind, embedding_run_id, dimensions, embedding)
       VALUES ('synthetic', $1, 2, $2::vector)`,
      [embeddingRunId, `[${vector.join(',')}]`],
    );
  }
});

interface FixtureInput {
  readonly datasetKind: 'synthetic' | 'historical';
  readonly traceId: string;
  readonly sourceId: string;
  readonly candidateId: string;
  readonly reportRevisionId: string;
  readonly text: string;
  readonly span: string;
  readonly relation: 'supports' | 'contradicts' | 'context';
  readonly revisionStatus: 'unreviewed' | 'eligible' | 'quarantined' | 'superseded' | 'retracted';
  readonly publishedAt: string | null;
  readonly observedAt: string | null;
  readonly retrievedAt: string;
  readonly eventTime: { readonly start: string | null; readonly end: string | null; readonly precision: 'exact' | 'date' | 'range' | 'unknown' };
  readonly origin?: {
    readonly originId: string;
    readonly originKind: 'issuer_statement' | 'reporter_observation';
    readonly lineageRelation: 'original' | 'copied';
    readonly independenceStatus: 'established' | 'dependent';
    readonly dependsOnOriginIds?: readonly string[];
  };
  readonly geometry?: { readonly geometryId: string; readonly longitude: number; readonly latitude: number };
  readonly vector: readonly [number, number] | null;
  readonly embeddingStatus?: 'available' | 'invalidated';
}

function makeRevision(fixture: FixtureInput): NewReportRevision {
  return {
    datasetKind: fixture.datasetKind,
    reportRevisionId: fixture.reportRevisionId,
    traceId: fixture.traceId,
    sourceId: fixture.sourceId,
    canonicalUrl: `https://fixtures.invalid/${fixture.reportRevisionId}`,
    sourceRevisionKey: null,
    contentHash: sha256(`synthetic raw fixture: ${fixture.reportRevisionId}`),
    permittedText: fixture.text,
    permittedTextHash: sha256(fixture.text),
    normalizationVersion: 'synthetic-fixture-normalizer-v1',
    publishedAt: fixture.publishedAt,
    observedAt: fixture.observedAt,
    retrievedAt: fixture.retrievedAt,
    validFrom: null,
    validUntil: null,
    supersedesId: null,
    revisionStatus: fixture.revisionStatus,
    recordJson: { fixture: 'synthetic-test-only' },
  };
}

function codePointOffset(text: string, utf16Offset: number): number {
  return Array.from(text.slice(0, utf16Offset)).length;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
