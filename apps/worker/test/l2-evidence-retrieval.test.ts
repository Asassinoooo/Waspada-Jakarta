import assert from 'node:assert/strict';
import { it } from 'node:test';
import type {
  EvidenceRetrievalQuery,
  EvidenceRetrievalRepository,
  EvidenceRetrievalResult,
} from '../../db/src/evidence-retrieval.js';
import { createCandidateEvidenceRetriever } from '../src/layers/l2-model-grounding/retrieval.js';

it('passes a bounded evidence query to the injected read-only repository and preserves its candidates', async () => {
  const query: EvidenceRetrievalQuery = {
    datasetKind: 'synthetic',
    identifiers: [{ kind: 'candidate', value: 'candidate-synthetic-only' }],
  };
  const result = {
    datasetKind: 'synthetic',
    retrievalVersion: 'hybrid-evidence-v1',
    indexVersion: null,
    candidates: [{
      datasetKind: 'synthetic',
      candidateId: 'candidate-synthetic-only',
      reportRevisionId: 'revision-synthetic-only',
      permittedTextHash: 'a'.repeat(64),
      evidenceReferenceId: '1',
      spanStart: 0,
      spanEnd: 9,
      offsetUnit: 'unicode_code_points',
      relation: 'contradicts',
      spanText: 'Synthetic',
      spanTextStart: 0,
      spanTextEnd: 9,
      spanTextTruncated: false,
      revisionStatus: 'quarantined',
      source: {
        sourceId: 'source-synthetic-only',
        displayName: 'Synthetic test source',
        sourceKind: 'other',
        publisherGroupId: null,
        registryStatus: 'paused',
        approvalStatus: 'pending',
        healthStatus: 'unknown',
      },
      publishedAt: null,
      observedAt: null,
      retrievedAt: '2026-09-25T05:00:00Z',
      validFrom: null,
      validUntil: null,
      eventTime: { start: null, end: null, precision: 'unknown', status: 'unknown' },
      origins: [],
      originLineageStatus: 'unknown',
      geometryMatches: [],
      chunk: null,
      matchFacets: {
        identifiers: query.identifiers!,
        exactTerms: [],
        reportTimeFields: [],
        eventTime: false,
        geometry: false,
        semanticDistance: null,
      },
    }],
    rowsExamined: 1,
    filteredRowsOmitted: 0,
    invalidSpanRowsOmitted: 0,
    scanTruncated: false,
    resultTruncated: false,
    semanticStatus: 'not_requested',
  } satisfies EvidenceRetrievalResult;
  let receivedQuery: EvidenceRetrievalQuery | undefined;
  const repository: EvidenceRetrievalRepository = {
    async search(received) {
      receivedQuery = received;
      return result;
    },
  };

  const retriever = createCandidateEvidenceRetriever(repository);
  const retrieved = await retriever.retrieve(query);

  assert.equal(receivedQuery, query);
  assert.equal(retrieved, result);
  assert.equal(retrieved.candidates[0]?.relation, 'contradicts');
  assert.equal(retrieved.candidates[0]?.revisionStatus, 'quarantined');
  assert.equal('sufficient' in retrieved, false);
});
