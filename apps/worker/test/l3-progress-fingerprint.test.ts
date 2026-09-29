import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  InvestigationProgressOperationResult,
  RefreshGroundingProgressInput,
} from '../../db/src/investigation-ledger.js';
import type { GroundingContext } from '../src/layers/l2-model-grounding/contracts.js';
import {
  canonicalizeClosedJson,
  createL3FingerprintService,
  L3FingerprintError,
  recordGroundingProgress,
} from '../src/layers/l3-investigation/progress-fingerprint.js';

const keyId = 'fixture-hmac-v1';
const keyMaterial = new Uint8Array(32).fill(91);

test('canonicalizes closed registered action JSON and emits stable fixed-format HMAC digests', async () => {
  const fingerprints = createL3FingerprintService({ keyId, keyMaterial });
  const first = await fingerprints.fingerprintAction({
    datasetKind: 'synthetic',
    investigationId: 'investigation_fingerprint',
    keyId,
    actionName: 'lookup.synthetic',
    parsedInput: { query: 'synthetic phrase', limit: 3, filters: { source: 'official', active: true } },
  });
  const reordered = await fingerprints.fingerprintAction({
    datasetKind: 'synthetic',
    investigationId: 'investigation_fingerprint',
    keyId,
    actionName: 'lookup.synthetic',
    parsedInput: { filters: { active: true, source: 'official' }, limit: 3, query: 'synthetic phrase' },
  });
  assert.deepEqual(first, reordered);
  assert.equal(first.keyId, keyId);
  assert.match(first.digestHex, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    await fingerprints.fingerprintAction({
      datasetKind: 'synthetic',
      investigationId: 'investigation_fingerprint',
      keyId,
      actionName: 'lookup.synthetic',
      parsedInput: { query: 'synthetic phrase', limit: 3, filters: { source: 'official', active: true } },
    }),
    first,
  );
});

test('domain-separates action and grounding fingerprints and scopes both to dataset and case', async () => {
  const fingerprints = createL3FingerprintService({ keyId, keyMaterial });
  const action = await fingerprints.fingerprintAction({
    datasetKind: 'synthetic',
    investigationId: 'investigation_fingerprint',
    keyId,
    actionName: 'lookup.synthetic',
    parsedInput: { query: 'synthetic phrase' },
  });
  const grounding = await fingerprints.fingerprintGrounding({
    datasetKind: 'synthetic',
    investigationId: 'investigation_fingerprint',
    keyId,
    context: makeContext(),
  });
  assert.notEqual(action.digestHex, grounding.digestHex);

  const otherDataset = await fingerprints.fingerprintAction({
    datasetKind: 'historical',
    investigationId: 'investigation_fingerprint',
    keyId,
    actionName: 'lookup.synthetic',
    parsedInput: { query: 'synthetic phrase' },
  });
  const otherCase = await fingerprints.fingerprintAction({
    datasetKind: 'synthetic',
    investigationId: 'investigation_other',
    keyId,
    actionName: 'lookup.synthetic',
    parsedInput: { query: 'synthetic phrase' },
  });
  assert.notEqual(action.digestHex, otherDataset.digestHex);
  assert.notEqual(action.digestHex, otherCase.digestHex);

  const historicalContext = makeContext({ datasetKind: 'historical' });
  const otherDatasetGrounding = await fingerprints.fingerprintGrounding({
    datasetKind: 'historical',
    investigationId: 'investigation_fingerprint',
    keyId,
    context: historicalContext,
  });
  const otherCaseGrounding = await fingerprints.fingerprintGrounding({
    datasetKind: 'synthetic',
    investigationId: 'investigation_other',
    keyId,
    context: makeContext(),
  });
  assert.notEqual(grounding.digestHex, otherDatasetGrounding.digestHex);
  assert.notEqual(grounding.digestHex, otherCaseGrounding.digestHex);
});

test('fails closed for missing, malformed, and mismatched runtime key configuration', async () => {
  const missing = createL3FingerprintService(undefined);
  await assert.rejects(missing.fingerprintAction({
    datasetKind: 'synthetic',
    investigationId: 'investigation_fingerprint',
    keyId,
    actionName: 'lookup.synthetic',
    parsedInput: { query: 'synthetic phrase' },
  }), (error: unknown) => error instanceof L3FingerprintError && error.code === 'fingerprint_unavailable');

  const malformed = createL3FingerprintService({ keyId: 'invalid key id', keyMaterial: new Uint8Array(32) });
  await assert.rejects(malformed.fingerprintAction({
    datasetKind: 'synthetic',
    investigationId: 'investigation_fingerprint',
    keyId,
    actionName: 'lookup.synthetic',
    parsedInput: { query: 'synthetic phrase' },
  }), (error: unknown) => error instanceof L3FingerprintError && error.code === 'fingerprint_unavailable');

  const configured = createL3FingerprintService({ keyId, keyMaterial });
  assert.throws(
    () => configured.assertCaseKeyId('rotated-key-v2'),
    (error: unknown) => error instanceof L3FingerprintError && error.code === 'fingerprint_key_mismatch',
  );
});

test('projects natural conflict prose using bounded counts without retaining or hashing the text', async () => {
  const fingerprints = createL3FingerprintService({ keyId, keyMaterial });
  const natural = makeContext({
    missingFields: ['No current service area is stated'],
    conflicts: ['Synthetic reports disagree on current service status'],
  });
  const sameCountsDifferentText = makeContext({
    missingFields: ['The affected region is unclear'],
    conflicts: ['Synthetic sources describe incompatible service hours'],
  });
  const first = await fingerprints.fingerprintGrounding({
    datasetKind: 'synthetic',
    investigationId: 'investigation_fingerprint',
    keyId,
    context: natural,
  });
  const second = await fingerprints.fingerprintGrounding({
    datasetKind: 'synthetic',
    investigationId: 'investigation_fingerprint',
    keyId,
    context: sameCountsDifferentText,
  });
  assert.deepEqual(second, first);

  const changedCount = await fingerprints.fingerprintGrounding({
    datasetKind: 'synthetic',
    investigationId: 'investigation_fingerprint',
    keyId,
    context: makeContext({
      missingFields: natural.missingFields,
      conflicts: [...natural.conflicts, 'A separate synthetic report is also inconsistent'],
    }),
  });
  assert.notEqual(changedCount.digestHex, first.digestHex);
});

test('reversing evidence and grounding metadata arrays preserves the canonical fingerprint', async () => {
  const fingerprints = createL3FingerprintService({ keyId, keyMaterial });
  const seed = makeContext();
  const seedEvidence = seed.evidence[0]!;
  const evidence = [
    {
      ...seedEvidence,
      sourceId: 'source_Z',
      reference: { ...seedEvidence.reference, reportRevisionId: 'revision_Z' },
      origins: [
        { originId: 'origin_Z', independenceStatus: 'established' as const, dependsOnOriginIds: ['origin_a'] },
        { originId: 'origin_a', independenceStatus: 'established' as const, dependsOnOriginIds: ['origin_Z'] },
      ],
    },
    {
      ...seedEvidence,
      sourceId: 'source_a',
      reference: { ...seedEvidence.reference, reportRevisionId: 'revision_a' },
      origins: [
        { originId: 'origin_c', independenceStatus: 'established' as const, dependsOnOriginIds: ['origin_b'] },
        { originId: 'origin_b', independenceStatus: 'established' as const, dependsOnOriginIds: ['origin_c'] },
      ],
    },
  ] satisfies GroundingContext['evidence'];
  const revisionStates = [
    { reportRevisionId: 'revision_Z', revisionStatus: 'eligible' as const },
    { reportRevisionId: 'revision_a', revisionStatus: 'quarantined' as const },
  ];
  const candidateEvents = [
    { eventId: 'event_Z', eventVersion: 2 },
    { eventId: 'event_a', eventVersion: 1 },
  ];
  const priorDecisionIds = ['decision_Z', 'decision_a'];
  const ordered = makeContext({ evidence, revisionStates, candidateEvents, priorDecisionIds });
  const reversed = makeContext({
    evidence: [...evidence].reverse().map((item) => ({ ...item, origins: [...item.origins].reverse() })),
    revisionStates: [...revisionStates].reverse(),
    candidateEvents: [...candidateEvents].reverse(),
    priorDecisionIds: [...priorDecisionIds].reverse(),
  });
  const first = await fingerprints.fingerprintGrounding({
    datasetKind: 'synthetic',
    investigationId: 'investigation_fingerprint',
    keyId,
    context: ordered,
  });
  const reordered = await fingerprints.fingerprintGrounding({
    datasetKind: 'synthetic',
    investigationId: 'investigation_fingerprint',
    keyId,
    context: reversed,
  });
  assert.deepEqual(reordered, first);
});

test('rejects non-JSON values and object accessors during strict canonicalization', () => {
  const accessor = Object.defineProperty({}, 'query', {
    enumerable: true,
    get() { throw new Error('private getter detail'); },
  });
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(canonicalizeClosedJson({ query: 'safe', nested: { limit: 2 } }), '{"nested":{"limit":2},"query":"safe"}');
  assert.equal(canonicalizeClosedJson(accessor), undefined);
  assert.equal(canonicalizeClosedJson(cyclic), undefined);
  assert.equal(canonicalizeClosedJson({ query: undefined }), undefined);
  assert.equal(canonicalizeClosedJson(new Date(0)), undefined);
});

test('grounds only the closed text-free projection and persists only scope, key ID, and digest', async () => {
  const fingerprints = createL3FingerprintService({ keyId, keyMaterial });
  const original = makeContext();
  const noisy = {
    ...original,
    privateQuery: 'RAW_QUERY_MARKER',
    rawUrl: 'https://private.invalid/RAW_URL_MARKER',
    evidence: original.evidence.map((item) => ({
      ...item,
      text: 'PRIVATE_EXCERPT_MARKER',
      observedAt: '2035-01-01T00:00:00Z',
      retrievedAt: '2035-01-01T00:00:00Z',
      rawUrl: 'https://private.invalid/EVIDENCE_URL_MARKER',
    })),
  } as unknown as GroundingContext;
  const first = await fingerprints.fingerprintGrounding({
    datasetKind: 'synthetic',
    investigationId: 'investigation_fingerprint',
    keyId,
    context: original,
  });
  const second = await fingerprints.fingerprintGrounding({
    datasetKind: 'synthetic',
    investigationId: 'investigation_fingerprint',
    keyId,
    context: noisy,
  });
  assert.deepEqual(second, first);

  let persisted: RefreshGroundingProgressInput | undefined;
  const ledger = {
    async getFingerprintKeyId() { return keyId; },
    async refreshGroundingProgress(input: RefreshGroundingProgressInput) {
      persisted = input;
      return {} as InvestigationProgressOperationResult;
    },
  };
  await recordGroundingProgress(ledger, fingerprints, {
    datasetKind: 'synthetic',
    investigationId: 'investigation_fingerprint',
    expectedCheckpointVersion: 8,
    context: noisy,
    refreshedAt: '2026-09-29T00:00:00Z',
  });
  assert.ok(persisted);
  assert.equal(persisted?.contextId, original.contextId);
  assert.equal(persisted?.fingerprintKeyId, keyId);
  assert.match(persisted?.digestHex ?? '', /^[a-f0-9]{64}$/);
  const persistedJson = JSON.stringify(persisted);
  for (const marker of [
    'RAW_QUERY_MARKER',
    'RAW_URL_MARKER',
    'EVIDENCE_URL_MARKER',
    'PRIVATE_EXCERPT_MARKER',
    'fixture-secret-marker',
    '91,91,91,91',
  ]) {
    assert.equal(persistedJson.includes(marker), false, 'persisted input must not contain ' + marker);
  }

  const changedEvidence = makeContext({
    evidence: [{
      ...original.evidence[0]!,
      reference: { ...original.evidence[0]!.reference, permittedTextHash: 'b'.repeat(64) },
    }],
  });
  const changed = await fingerprints.fingerprintGrounding({
    datasetKind: 'synthetic',
    investigationId: 'investigation_fingerprint',
    keyId,
    context: changedEvidence,
  });
  assert.notEqual(first.digestHex, changed.digestHex);
});

function makeContext(overrides: Partial<GroundingContext> = {}): GroundingContext {
  const defaultContext: GroundingContext = {
    schemaVersion: '2.0',
    recordType: 'GroundingContext',
    datasetKind: 'synthetic',
    traceId: 'trace_fingerprint',
    contextId: 'context_fingerprint',
    candidateId: 'candidate_fingerprint',
    evidence: [{
      reference: {
        reportRevisionId: 'revision_fingerprint',
        permittedTextHash: 'a'.repeat(64),
        spanStart: 0,
        spanEnd: 8,
        offsetUnit: 'unicode_code_points',
        relation: 'supports',
      },
      text: 'PRIVATE_EXCERPT_MARKER',
      sourceId: 'source_fingerprint',
      revisionStatus: 'eligible',
      publishedAt: '2026-09-29T00:00:00Z',
      observedAt: '2026-09-28T00:00:00Z',
      retrievedAt: '2026-09-28T00:00:01Z',
      origins: [{
        originId: 'origin_fingerprint',
        independenceStatus: 'established',
        dependsOnOriginIds: [],
      }],
    }],
    revisionStates: [{ reportRevisionId: 'revision_fingerprint', revisionStatus: 'eligible' }],
    candidateEvents: [{ eventId: 'event_fingerprint', eventVersion: 3 }],
    priorDecisionIds: ['decision_fingerprint'],
    missingFields: ['missing_field_1'],
    conflicts: ['source_conflict_1'],
    retrievalVersion: 'retrieval_v1',
    indexVersion: 'index_v1',
    sufficient: false,
  };
  return { ...defaultContext, ...overrides };
}
