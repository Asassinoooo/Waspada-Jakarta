import assert from 'node:assert/strict';
import { it } from 'node:test';
import type {
  EvidenceRetrievalQuery,
  EvidenceRetrievalRepository,
  EvidenceRetrievalResult,
} from '../../db/src/evidence-retrieval.js';
import {
  consoleTelemetry,
  L2_RETRIEVAL_EVENT_NAME,
  type L2RetrievalErrorTelemetryRecord,
  type L2RetrievalSuccessTelemetryRecord,
  type TelemetryRecord,
} from '../src/layers/l5-evaluation-monitoring/telemetry.js';
import { createCandidateEvidenceRetriever } from '../src/layers/l2-model-grounding/retrieval.js';

it('passes a bounded evidence query to the injected read-only repository and preserves its candidates', async () => {
  const queryMarker = 'private-exact-term-marker';
  const resultMarker = 'private-evidence-text-marker';
  const query: EvidenceRetrievalQuery = {
    datasetKind: 'synthetic',
    identifiers: [{ kind: 'candidate', value: 'candidate-synthetic-only' }],
    exactTerms: [queryMarker],
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
      spanText: resultMarker,
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
    rowsExamined: 17,
    filteredRowsOmitted: 0,
    invalidSpanRowsOmitted: 0,
    scanTruncated: true,
    resultTruncated: true,
    semanticStatus: 'no_compatible_vector',
  } satisfies EvidenceRetrievalResult;
  let receivedQuery: EvidenceRetrievalQuery | undefined;
  const telemetryRecords: TelemetryRecord[] = [];
  const repository: EvidenceRetrievalRepository = {
    async search(received) {
      receivedQuery = received;
      return result;
    },
  };

  const retriever = createCandidateEvidenceRetriever(repository, {
    record(record) {
      telemetryRecords.push(record);
      throw new Error('sink failure must be ignored');
    },
  });
  const retrieved = await retriever.retrieve(query);

  assert.equal(receivedQuery, query);
  assert.equal(retrieved, result);
  assert.equal(retrieved.candidates[0]?.relation, 'contradicts');
  assert.equal(retrieved.candidates[0]?.revisionStatus, 'quarantined');
  assert.equal('sufficient' in retrieved, false);
  assert.equal(telemetryRecords.length, 1);
  const [record] = telemetryRecords;
  assert.ok(record);
  if (record.eventName !== L2_RETRIEVAL_EVENT_NAME || record.outcome !== 'success') {
    assert.fail('expected one successful retrieval telemetry record');
  }
  assert.deepEqual(Object.keys(record).sort(), [
    'candidateCount',
    'durationMs',
    'eventName',
    'outcome',
    'resultTruncated',
    'rowsExamined',
    'scanTruncated',
    'semanticStatus',
  ]);
  assert.ok(Number.isFinite(record.durationMs));
  assert.ok(record.durationMs >= 0);
  assert.equal(record.candidateCount, result.candidates.length);
  assert.equal(record.rowsExamined, result.rowsExamined);
  assert.equal(record.scanTruncated, result.scanTruncated);
  assert.equal(record.resultTruncated, result.resultTruncated);
  assert.equal(record.semanticStatus, result.semanticStatus);
  assert.ok(!JSON.stringify(record).includes(queryMarker));
  assert.ok(!JSON.stringify(record).includes(resultMarker));
});

it('preserves the exact repository error when recording retrieval errors also throws', async () => {
  const queryMarker = 'private-error-query-marker';
  const query: EvidenceRetrievalQuery = {
    datasetKind: 'synthetic',
    exactTerms: [queryMarker],
  };
  const repositoryError = new Error('private SQL and repository details');
  let receivedQuery: EvidenceRetrievalQuery | undefined;
  const records: TelemetryRecord[] = [];
  const repository: EvidenceRetrievalRepository = {
    async search(received) {
      receivedQuery = received;
      throw repositoryError;
    },
  };

  const retriever = createCandidateEvidenceRetriever(repository, {
    record(record) {
      records.push(record);
      throw new Error('private sink details');
    },
  });

  await assert.rejects(retriever.retrieve(query), (error: unknown) => error === repositoryError);
  assert.equal(receivedQuery, query);
  assert.equal(records.length, 1);
  const [record] = records;
  assert.ok(record);
  if (record.eventName !== L2_RETRIEVAL_EVENT_NAME || record.outcome !== 'error') {
    assert.fail('expected one retrieval error telemetry record');
  }
  assert.deepEqual(Object.keys(record).sort(), ['durationMs', 'eventName', 'outcome']);
  assert.ok(Number.isFinite(record.durationMs));
  assert.ok(record.durationMs >= 0);
  assert.ok(!JSON.stringify(record).includes(queryMarker));
  assert.ok(!JSON.stringify(record).includes(repositoryError.message));
});

it('defaults to no-op telemetry unless a caller injects a sink', async () => {
  const result = {
    datasetKind: 'synthetic',
    retrievalVersion: 'hybrid-evidence-v1',
    indexVersion: null,
    candidates: [],
    rowsExamined: 0,
    filteredRowsOmitted: 0,
    invalidSpanRowsOmitted: 0,
    scanTruncated: false,
    resultTruncated: false,
    semanticStatus: 'not_requested',
  } satisfies EvidenceRetrievalResult;
  const repository: EvidenceRetrievalRepository = {
    async search() {
      return result;
    },
  };
  const writes: unknown[] = [];
  const originalLog = console.log;
  console.log = (...messages: unknown[]) => {
    writes.push(...messages);
  };

  try {
    const retrieved = await createCandidateEvidenceRetriever(repository).retrieve({
      datasetKind: 'synthetic',
    });
    assert.equal(retrieved, result);
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(writes, []);
});

it('console telemetry serializes exact retrieval allowlists and ignores forged properties', () => {
  const marker = 'private-telemetry-forgery-marker';
  const writes: unknown[] = [];
  const originalLog = console.log;
  console.log = (...messages: unknown[]) => {
    writes.push(...messages);
  };

  try {
    consoleTelemetry.record({
      eventName: L2_RETRIEVAL_EVENT_NAME,
      outcome: 'success',
      durationMs: 2,
      candidateCount: 3,
      rowsExamined: 12,
      scanTruncated: false,
      resultTruncated: true,
      semanticStatus: 'matched',
      query: marker,
      spanText: marker,
      sourceId: marker,
    } as L2RetrievalSuccessTelemetryRecord);
    consoleTelemetry.record({
      eventName: L2_RETRIEVAL_EVENT_NAME,
      outcome: 'error',
      durationMs: 4,
      query: marker,
      error: marker,
    } as L2RetrievalErrorTelemetryRecord);
    consoleTelemetry.record({
      eventName: L2_RETRIEVAL_EVENT_NAME,
      outcome: marker,
      durationMs: 6,
      query: marker,
    } as unknown as L2RetrievalErrorTelemetryRecord);
    consoleTelemetry.record({
      eventName: marker,
      outcome: 'success',
      query: marker,
    } as unknown as L2RetrievalSuccessTelemetryRecord);
  } finally {
    console.log = originalLog;
  }

  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0], {
    event_name: L2_RETRIEVAL_EVENT_NAME,
    outcome: 'success',
    duration_ms: 2,
    candidate_count: 3,
    rows_examined: 12,
    scan_truncated: false,
    result_truncated: true,
    semantic_status: 'matched',
  });
  assert.deepEqual(writes[1], {
    event_name: L2_RETRIEVAL_EVENT_NAME,
    outcome: 'error',
    duration_ms: 4,
  });
  assert.ok(writes.every((write) => write !== null && typeof write === 'object' && Object.getPrototypeOf(write) === Object.prototype));
  assert.ok(!JSON.stringify(writes).includes(marker));
});
