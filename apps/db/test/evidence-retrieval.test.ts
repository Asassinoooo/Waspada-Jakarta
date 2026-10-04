import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  createSqlEvidenceRetrievalRepository,
  createSqlExactEvidenceSpanReader,
  ExactEvidenceSpanReadError,
} from '../src/evidence-retrieval.js';
import { assembleGroundingReasoningRequest } from '../../worker/src/layers/l2-model-grounding/grounding-context.js';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import { createRepositoryPorts, type NewReportRevision, type TraceRecord } from '../src/ports.js';
import type { EvidenceRetrievalCandidate, EvidenceRetrievalQuery } from '../src/evidence-retrieval.js';
import type { SqlExecutor } from '../src/sql.js';
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

  it('executes retrieval branches under the least-privilege L2 reader and denies writes and unrelated reads', async () => {
    const retriever = createSqlEvidenceRetrievalRepository(testDatabase.executor);
    await testDatabase.executor.execute('SET ROLE waspada_l2_grounding_reader');
    try {
      const activeRole = await testDatabase.executor.query<{ current_user: string }>(
        'SELECT current_user',
      );
      assert.equal(activeRole.rows[0]?.current_user, 'waspada_l2_grounding_reader');

      const nonSemantic = await retriever.search({
        datasetKind: 'synthetic',
        identifiers: [{ kind: 'candidate', value: 'candidate-syn-beta' }],
      });
      const beta = nonSemantic.candidates.find((candidate) => candidate.candidateId === 'candidate-syn-beta');
      assert.ok(beta, 'the non-semantic query returns the copied report');
      assert.equal(beta.origins[0]?.originId, 'origin-syn-beta');
      assert.deepEqual(beta.origins[0]?.dependsOnOriginIds, ['origin-syn-alpha']);

      const existingRelations = await retriever.search({
        datasetKind: 'synthetic',
        identifiers: [
          { kind: 'candidate', value: 'candidate-syn-alpha' },
          { kind: 'candidate', value: 'candidate-syn-beta' },
          { kind: 'candidate', value: 'candidate-syn-gamma' },
        ],
      });
      const existingRelationsByCandidate = new Map(existingRelations.candidates.map((candidate) => [
        candidate.candidateId,
        candidate.relation,
      ]));
      assert.deepEqual([...existingRelationsByCandidate.entries()].sort(([left], [right]) => left.localeCompare(right)), [
        ['candidate-syn-alpha', 'supports'],
        ['candidate-syn-beta', 'contradicts'],
        ['candidate-syn-gamma', 'context'],
      ]);

      const spatial = await retriever.search({
        datasetKind: 'synthetic',
        identifiers: [{ kind: 'candidate', value: 'candidate-syn-beta' }],
        geometry: { type: 'Point', coordinates: [106.80001, -6.2] },
      });
      const spatialBeta = spatial.candidates.find((candidate) => candidate.candidateId === 'candidate-syn-beta');
      assert.equal(spatialBeta?.geometryMatches[0]?.geometryId, 'geometry-syn-beta');
      assert.deepEqual(spatialBeta?.origins[0]?.dependsOnOriginIds, ['origin-syn-alpha']);

      const semantic = await retriever.search({
        datasetKind: 'synthetic',
        identifiers: [{ kind: 'candidate', value: 'candidate-syn-alpha' }],
        semantic: { identity: embeddingIdentity, queryVector: [1, 0] },
      });
      const semanticAlpha = semantic.candidates.find((candidate) => candidate.candidateId === 'candidate-syn-alpha');
      assert.equal(semanticAlpha?.matchFacets.semanticDistance, 0);
      assert.equal(semanticAlpha?.chunk?.embeddingRunId, 'embedding-candidate-syn-alpha');
      assert.equal(semanticAlpha?.origins[0]?.originId, 'origin-syn-alpha');

      const combined = await retriever.search({
        datasetKind: 'synthetic',
        identifiers: [{ kind: 'candidate', value: 'candidate-syn-alpha' }],
        geometry: { type: 'Point', coordinates: [106.8, -6.2] },
        semantic: { identity: embeddingIdentity, queryVector: [1, 0] },
      });
      const combinedAlpha = combined.candidates.find((candidate) => candidate.candidateId === 'candidate-syn-alpha');
      assert.equal(combinedAlpha?.geometryMatches[0]?.geometryId, 'geometry-syn-alpha');
      assert.equal(combinedAlpha?.matchFacets.semanticDistance, 0);

      await assert.rejects(
        testDatabase.executor.query(
          `INSERT INTO waspada.extraction_evidence (dataset_kind, candidate_id, evidence_ref_id)
           VALUES ('synthetic', 'forbidden-candidate', -1)`,
        ),
        /permission denied for table extraction_evidence/,
      );
      await assert.rejects(
        testDatabase.executor.query(
          `UPDATE waspada.report_revisions SET revision_status = 'eligible'
           WHERE dataset_kind = 'synthetic' AND report_revision_id = 'revision-syn-alpha'`,
        ),
        /permission denied for table report_revisions/,
      );
      await assert.rejects(
        testDatabase.executor.query(
          `DELETE FROM waspada.evidence_references
           WHERE dataset_kind = 'synthetic' AND evidence_ref_id = -1`,
        ),
        /permission denied for table evidence_references/,
      );
      await assert.rejects(
        testDatabase.executor.query('SELECT access_restrictions FROM waspada.source_registry LIMIT 1'),
        /permission denied for table source_registry/,
      );
      await assert.rejects(
        testDatabase.executor.query('SELECT canonical_url FROM waspada.report_revisions LIMIT 1'),
        /permission denied for table report_revisions/,
      );
      await assert.rejects(
        testDatabase.executor.query('SELECT * FROM waspada.audit_records LIMIT 1'),
        /permission denied for table audit_records/,
      );
    } finally {
      await testDatabase.executor.execute('RESET ROLE');
    }
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

  it('retrieves updates references exactly under the least-privilege L2 reader', async () => {
    await addFixture({
      datasetKind: 'synthetic',
      traceId: syntheticTrace.traceId,
      sourceId: 'source-syn-alpha',
      candidateId: 'candidate-syn-delta',
      reportRevisionId: 'revision-syn-delta',
      text: 'Synthetic update: the fixture notice has a corrected time.',
      span: 'fixture notice has a corrected time',
      relation: 'updates',
      revisionStatus: 'eligible',
      publishedAt: '2026-09-25T08:15:00Z',
      observedAt: '2026-09-25T08:20:00Z',
      retrievedAt: '2026-09-25T08:25:00Z',
      eventTime: { start: '2026-09-25', end: null, precision: 'date' },
      vector: null,
    });

    await testDatabase.executor.execute('SET ROLE waspada_l2_grounding_reader');
    try {
      const update = await ports.evidenceRetrieval.search({
        datasetKind: 'synthetic',
        identifiers: [{ kind: 'candidate', value: 'candidate-syn-delta' }],
      });
      assert.equal(update.candidates.length, 1);
      assert.equal(update.candidates[0]?.relation, 'updates');
    } finally {
      await testDatabase.executor.execute('RESET ROLE');
    }
  });

  it('rehydrates only exact code-point spans under the least-privilege L2 reader', async () => {
    const reader = createSqlExactEvidenceSpanReader(testDatabase.executor);
    await testDatabase.executor.execute('SET ROLE waspada_l2_grounding_reader');
    try {
      const result = await ports.evidenceRetrieval.search({
        datasetKind: 'synthetic',
        identifiers: [{ kind: 'candidate', value: 'candidate-syn-alpha' }],
      });
      assert.equal(result.candidates.length, 1);
      const candidate = result.candidates[0]!;
      const request = {
        datasetKind: candidate.datasetKind,
        candidateId: candidate.candidateId,
        evidenceReferenceId: candidate.evidenceReferenceId,
        reportRevisionId: candidate.reportRevisionId,
        permittedTextHash: candidate.permittedTextHash,
        spanStart: candidate.spanStart,
        spanEnd: candidate.spanEnd,
        offsetUnit: candidate.offsetUnit,
        relation: candidate.relation,
        revisionStatus: candidate.revisionStatus,
      } as const;
      const exact = await reader.readExactSpan(request);

      assert.equal(exact.text, 'closure near Monas 😀');
      assert.equal(Array.from(exact.text).length, candidate.spanEnd - candidate.spanStart);
      assert.equal(exact.text.includes('Synthetic notice:'), false, 'the whole report is not returned');
      assert.equal(exact.text.includes('2026-09-25.'), false, 'text outside the cited span is not returned');
      assert.equal(exact.revisionStatus, candidate.revisionStatus);

      await assert.rejects(
        reader.readExactSpan({ ...request, permittedTextHash: 'b'.repeat(64) }),
        (error: unknown) => error instanceof ExactEvidenceSpanReadError && error.code === 'identity_mismatch',
      );
      await assert.rejects(
        reader.readExactSpan({ ...request, spanStart: request.spanStart + 1 }),
        (error: unknown) => error instanceof ExactEvidenceSpanReadError && error.code === 'identity_mismatch',
      );
      await assert.rejects(
        reader.readExactSpan({ ...request, relation: 'contradicts' }),
        (error: unknown) => error instanceof ExactEvidenceSpanReadError && error.code === 'identity_mismatch',
      );
      await assert.rejects(
        reader.readExactSpan({ ...request, revisionStatus: 'retracted' }),
        (error: unknown) => error instanceof ExactEvidenceSpanReadError && error.code === 'identity_mismatch',
      );
      await assert.rejects(
        reader.readExactSpan({ ...request, candidateId: 'candidate-syn-beta' }),
        (error: unknown) => error instanceof ExactEvidenceSpanReadError && error.code === 'not_found',
      );
      await assert.rejects(
        reader.readExactSpan({ ...request, spanEnd: request.spanStart + 40_001 }),
        (error: unknown) => error instanceof ExactEvidenceSpanReadError && error.code === 'span_too_large',
      );
      await assert.rejects(
        testDatabase.executor.query('SELECT access_restrictions FROM waspada.source_registry'),
        /permission denied|denied/i,
      );
    } finally {
      await testDatabase.executor.execute('RESET ROLE');
    }
  });

  it('blocks exact spans with any same-dataset non-current source assertion under the L2 reader', async () => {
    const invalidationCases = [
      { state: 'superseded' as const, reportRevisionId: 'revision-gate-superseded' },
      { state: 'retracted' as const, reportRevisionId: 'revision-gate-retracted' },
      { state: 'withdrawn' as const, reportRevisionId: 'revision-gate-withdrawn' },
    ];
    for (const { state, reportRevisionId } of invalidationCases) {
      const candidateId = `candidate-gate-${state}`;
      await addFixture({
        datasetKind: 'synthetic',
        traceId: syntheticTrace.traceId,
        sourceId: 'source-syn-alpha',
        candidateId,
        reportRevisionId,
        text: `Authored synthetic ${state} target text.`,
        span: `${state} target text`,
        relation: 'supports',
        revisionStatus: 'eligible',
        publishedAt: null,
        observedAt: null,
        retrievedAt: syntheticStartedAt,
        eventTime: { start: null, end: null, precision: 'unknown' },
        vector: null,
      });

      let assertionRevisionId = reportRevisionId;
      let replacementRevisionId: string | null = null;
      if (state === 'superseded') {
        replacementRevisionId = `${reportRevisionId}-replacement`;
        assertionRevisionId = replacementRevisionId;
        await addAssertionRevision(
          replacementRevisionId,
          `Publisher synthetic notice: ${reportRevisionId} is superseded.`,
          reportRevisionId,
        );
      } else {
        assertionRevisionId = `${reportRevisionId}-notice`;
        await addAssertionRevision(
          assertionRevisionId,
          `Publisher synthetic notice: ${reportRevisionId} is ${state}.`,
        );
      }
      await addSourceObservation({
        observationId: `observation-gate-${state}`,
        targetReportRevisionId: reportRevisionId,
        assertionReportRevisionId: assertionRevisionId,
        assertedState: state,
        replacementReportRevisionId: replacementRevisionId,
      });
    }

    // A revision ID is only unique within its dataset. This historical assertion
    // must not affect the synthetic report with the same ID.
    await addAssertionRevision(
      'revision-syn-alpha',
      'Historical synthetic notice for an independent dataset namespace.',
      null,
      'historical',
      historyTrace.traceId,
    );
    await addSourceObservation({
      datasetKind: 'historical',
      traceId: historyTrace.traceId,
      observationId: 'observation-gate-other-dataset',
      targetReportRevisionId: 'revision-syn-alpha',
      assertionReportRevisionId: 'revision-syn-alpha',
      assertedState: 'retracted',
    });

    const observedQueryRows: Array<{
      readonly source_revision_invalidated: boolean;
      readonly exact_span_text: string | null;
    }> = [];
    const recordingExecutor: SqlExecutor = {
      async query<Row extends object>(statement: string, parameters?: readonly unknown[]) {
        const result = await testDatabase.executor.query<Row>(statement, parameters);
        if (statement.includes('AS source_revision_invalidated')) {
          const row = result.rows[0] as {
            readonly source_revision_invalidated: boolean;
            readonly exact_span_text: string | null;
          } | undefined;
          if (row) observedQueryRows.push(row);
        }
        return result;
      },
      execute: (statement) => testDatabase.executor.execute(statement),
    };
    const reader = createSqlExactEvidenceSpanReader(recordingExecutor);

    async function expectSourceInvalidated(request: ReturnType<typeof exactSpanRequest>): Promise<void> {
      const previousQueryCount = observedQueryRows.length;
      await assert.rejects(
        reader.readExactSpan(request),
        (error: unknown) => error instanceof ExactEvidenceSpanReadError
          && error.code === 'source_invalidated'
          && error.message === 'source_invalidated'
          && !error.message.includes(request.reportRevisionId),
      );
      assert.equal(observedQueryRows.length, previousQueryCount + 1,
        'the exact-span denial is returned by one bounded SQL snapshot');
      assert.equal(observedQueryRows[previousQueryCount]?.source_revision_invalidated, true);
      assert.equal(observedQueryRows[previousQueryCount]?.exact_span_text, null,
        'the SQL snapshot denies without returning any span text');
    }

    const alphaRequest = await exactSpanRequestFor('candidate-syn-alpha');
    const noObservation = await withL2Reader(() => reader.readExactSpan(alphaRequest));
    assert.equal(noObservation.text, 'closure near Monas 😀',
      'an observation in another dataset does not invalidate the exact synthetic revision');
    assert.equal(observedQueryRows.at(-1)?.source_revision_invalidated, false);
    assert.equal(observedQueryRows.at(-1)?.exact_span_text, 'closure near Monas 😀');

    await addSourceObservation({
      observationId: 'observation-gate-alpha-current',
      targetReportRevisionId: 'revision-syn-alpha',
      assertionReportRevisionId: 'revision-syn-alpha',
      assertedState: 'current',
    });
    const currentOnly = await withL2Reader(() => reader.readExactSpan(alphaRequest));
    assert.equal(currentOnly.text, 'closure near Monas 😀');
    assert.equal(observedQueryRows.at(-1)?.source_revision_invalidated, false);
    assert.equal(observedQueryRows.at(-1)?.exact_span_text, 'closure near Monas 😀');

    for (const { state, reportRevisionId } of invalidationCases) {
      const request = await withL2Reader(async () => {
        const candidate = (await ports.evidenceRetrieval.search({
          datasetKind: 'synthetic',
          identifiers: [{ kind: 'candidate', value: `candidate-gate-${state}` }],
        })).candidates[0];
        assert.ok(candidate);
        return exactSpanRequest(candidate);
      });
      assert.equal(request.reportRevisionId, reportRevisionId);
      await expectSourceInvalidated(request);
    }

    await addSourceObservation({
      observationId: 'observation-gate-alpha-retracted',
      targetReportRevisionId: 'revision-syn-alpha',
      assertionReportRevisionId: 'revision-syn-alpha',
      assertedState: 'retracted',
    });
    await expectSourceInvalidated(alphaRequest);

    await withL2Reader(async () => {
      await assert.rejects(
        testDatabase.executor.query('SELECT observation_id FROM waspada.report_revision_source_observations'),
        /permission denied|denied/i,
        'the L2 reader sees only the three granted assertion columns',
      );
    });
  });

  it('projects relational timestamps as timezone-independent RFC3339 accepted by strict L2 assembly', async () => {
    await addFixture({
      datasetKind: 'synthetic',
      traceId: syntheticTrace.traceId,
      sourceId: 'source-syn-alpha',
      candidateId: 'candidate-syn-timestamp-rfc3339',
      reportRevisionId: 'revision-syn-timestamp-rfc3339',
      text: 'Synthetic timestamp report with cited evidence.',
      span: 'cited evidence',
      relation: 'supports',
      revisionStatus: 'eligible',
      publishedAt: '2026-09-26T12:34:56.123456+05:30',
      observedAt: '2026-09-26T08:09:10.000007-04:00',
      retrievedAt: '2026-09-26T13:14:15.987654+07:00',
      validFrom: '2026-09-26T13:00:00.100200+07:00',
      validUntil: '2026-09-26T13:30:00.654321+07:00',
      eventTime: { start: '2026-09-24T09:01:02.123456+02:00', end: null, precision: 'exact' },
      vector: null,
    });

    await testDatabase.executor.execute("SET TIME ZONE 'Asia/Jakarta'");
    try {
      const result = await ports.evidenceRetrieval.search({
        datasetKind: 'synthetic',
        identifiers: [{ kind: 'candidate', value: 'candidate-syn-timestamp-rfc3339' }],
      });
      assert.equal(result.candidates.length, 1);
      const candidate = result.candidates[0]!;
      assert.deepEqual({
        publishedAt: candidate.publishedAt,
        observedAt: candidate.observedAt,
        retrievedAt: candidate.retrievedAt,
        validFrom: candidate.validFrom,
        validUntil: candidate.validUntil,
      }, {
        publishedAt: '2026-09-26T07:04:56.123456Z',
        observedAt: '2026-09-26T12:09:10.000007Z',
        retrievedAt: '2026-09-26T06:14:15.987654Z',
        validFrom: '2026-09-26T06:00:00.100200Z',
        validUntil: '2026-09-26T06:30:00.654321Z',
      });
      for (const value of [candidate.publishedAt, candidate.observedAt, candidate.retrievedAt,
        candidate.validFrom, candidate.validUntil]) {
        assert.match(value ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
      }
      assert.deepEqual(candidate.eventTime, {
        start: '2026-09-24T09:01:02.123456+02:00',
        end: null,
        precision: 'exact',
        status: 'valid',
      }, 'schema 2.0 event-time JSON remains unchanged');

      const request = await assembleGroundingReasoningRequest(
        createSqlExactEvidenceSpanReader(testDatabase.executor),
        {
          retrieval: result,
          datasetKind: 'synthetic',
          traceId: 'trace-timestamp-context',
          contextId: 'context-timestamp-context',
          candidateId: 'candidate-syn-timestamp-rfc3339',
          evidenceReferenceIds: [candidate.evidenceReferenceId],
          candidateEvents: [],
          priorDecisionIds: [],
          missingFields: [],
          conflicts: [],
          sufficient: false,
        },
      );
      assert.deepEqual({
        publishedAt: request.data.groundingContext.evidence[0]?.publishedAt,
        observedAt: request.data.groundingContext.evidence[0]?.observedAt,
        retrievedAt: request.data.groundingContext.evidence[0]?.retrievedAt,
      }, {
        publishedAt: '2026-09-26T07:04:56.123456Z',
        observedAt: '2026-09-26T12:09:10.000007Z',
        retrievedAt: '2026-09-26T06:14:15.987654Z',
      });

      const nullableResult = await ports.evidenceRetrieval.search({
        datasetKind: 'synthetic',
        identifiers: [{ kind: 'candidate', value: 'candidate-syn-gamma' }],
      });
      assert.equal(nullableResult.candidates[0]?.publishedAt, null);
      assert.equal(nullableResult.candidates[0]?.observedAt, null);
      assert.equal(nullableResult.candidates[0]?.validFrom, null);
      assert.equal(nullableResult.candidates[0]?.validUntil, null);
    } finally {
      await testDatabase.executor.execute('RESET TIME ZONE');
    }
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

  async function addAssertionRevision(
    reportRevisionId: string,
    text: string,
    supersedesId: string | null = null,
    datasetKind: 'synthetic' | 'historical' = 'synthetic',
    traceId = syntheticTrace.traceId,
  ): Promise<void> {
    const revision: NewReportRevision = {
      datasetKind,
      reportRevisionId,
      traceId,
      sourceId: 'source-syn-alpha',
      canonicalUrl: `https://fixtures.invalid/${reportRevisionId}`,
      sourceRevisionKey: null,
      contentHash: sha256(`synthetic raw assertion fixture: ${reportRevisionId}`),
      permittedText: text,
      permittedTextHash: sha256(text),
      normalizationVersion: 'synthetic-fixture-normalizer-v1',
      publishedAt: null,
      observedAt: null,
      retrievedAt: syntheticStartedAt,
      validFrom: null,
      validUntil: null,
      supersedesId,
      revisionStatus: 'eligible',
      recordJson: { fixture: 'synthetic-test-only' },
    };
    await ports.reportRevisions.create(revision);
  }

  async function addSourceObservation(input: {
    readonly datasetKind?: 'synthetic' | 'historical';
    readonly traceId?: string;
    readonly observationId: string;
    readonly targetReportRevisionId: string;
    readonly assertionReportRevisionId: string;
    readonly assertedState: 'current' | 'superseded' | 'retracted' | 'withdrawn';
    readonly replacementReportRevisionId?: string | null;
  }): Promise<void> {
    await testDatabase.executor.query(
      `INSERT INTO waspada.report_revision_source_observations
         (dataset_kind, observation_id, trace_id, source_id, target_report_revision_id,
          assertion_report_revision_id, asserted_state, replacement_report_revision_id,
          publisher_observed_at, retrieved_at)
       VALUES ($1, $2, $3, 'source-syn-alpha', $4, $5, $6, $7, $8, $9)`,
      [input.datasetKind ?? 'synthetic', input.observationId, input.traceId ?? syntheticTrace.traceId,
        input.targetReportRevisionId, input.assertionReportRevisionId, input.assertedState,
        input.replacementReportRevisionId ?? null, '2026-09-25T09:00:00Z', '2026-09-25T09:01:00Z'],
    );
  }

  async function exactSpanRequestFor(candidateId: string) {
    return withL2Reader(async () => {
      const candidate = (await ports.evidenceRetrieval.search({
        datasetKind: 'synthetic',
        identifiers: [{ kind: 'candidate', value: candidateId }],
      })).candidates[0];
      assert.ok(candidate);
      return exactSpanRequest(candidate);
    });
  }

  function exactSpanRequest(candidate: EvidenceRetrievalCandidate) {
    return {
      datasetKind: candidate.datasetKind,
      candidateId: candidate.candidateId,
      evidenceReferenceId: candidate.evidenceReferenceId,
      reportRevisionId: candidate.reportRevisionId,
      permittedTextHash: candidate.permittedTextHash,
      spanStart: candidate.spanStart,
      spanEnd: candidate.spanEnd,
      offsetUnit: candidate.offsetUnit,
      relation: candidate.relation,
      revisionStatus: candidate.revisionStatus,
    } as const;
  }

  async function withL2Reader<Result>(work: () => Promise<Result>): Promise<Result> {
    await testDatabase.executor.execute('SET ROLE waspada_l2_grounding_reader');
    try {
      return await work();
    } finally {
      await testDatabase.executor.execute('RESET ROLE');
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
  readonly relation: 'supports' | 'contradicts' | 'updates' | 'context';
  readonly revisionStatus: 'unreviewed' | 'eligible' | 'quarantined' | 'superseded' | 'retracted';
  readonly publishedAt: string | null;
  readonly observedAt: string | null;
  readonly retrievedAt: string;
  readonly validFrom?: string | null;
  readonly validUntil?: string | null;
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
    validFrom: fixture.validFrom ?? null,
    validUntil: fixture.validUntil ?? null,
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
