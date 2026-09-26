import assert from 'node:assert/strict';
import test from 'node:test';
import type { GroundingContextRecord } from '../../db/src/grounding-contexts.js';
import type {
  CreateInvestigationInput,
  InvestigationCheckpointRecord,
} from '../../db/src/investigation-ledger.js';
import type {
  GroundingContext,
  ReasoningRequest,
} from '../src/layers/l2-model-grounding/contracts.js';
import type { InvestigationRequiredOutcome } from '../src/layers/l2-model-grounding/direct-reasoning.js';
import {
  createInsufficientContextEntryService,
  type InsufficientContextEntryCallerValues,
} from '../src/layers/l3-investigation/entry.js';

const sourceMarker = 'private-source-text-marker';
const conflictMarker = 'private-conflict-url-and-prompt-marker';
const checkpoint = {} as InvestigationCheckpointRecord;
const callerValues: InsufficientContextEntryCallerValues = {
  investigationId: 'investigation-entry-synthetic',
  requestedAt: '2026-09-26T05:15:00.000Z',
  policyVersion: 'policy-entry-v3',
  limits: {
    toolAttempts: 3,
    reasoningTurns: 2,
    activeSeconds: 45,
    modelTokens: 9_000,
  },
};

test('maps persisted identity and explicit case values while returning the ledger checkpoint unchanged', async () => {
  const source = makeOutcome({
    context: {
      missingFields: ['private missing label one', 'private missing label two'],
      conflicts: [conflictMarker],
    },
  });
  const calls: CreateInvestigationInput[] = [];
  const service = createInsufficientContextEntryService({
    async create(input) {
      calls.push(input);
      return checkpoint;
    },
  });

  const result = await service.open(source, callerValues);

  assert.equal(result.status, 'opened');
  if (result.status !== 'opened') assert.fail('expected the case to be opened');
  assert.strictEqual(result.checkpoint, checkpoint);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    datasetKind: 'synthetic',
    investigationId: callerValues.investigationId,
    traceId: 'trace-entry-synthetic',
    candidateId: 'candidate-entry-synthetic',
    contextId: 'context-entry-synthetic',
    eventId: 'event-entry-synthetic',
    eventVersion: 4,
    questions: ['missing_field_1', 'missing_field_2', 'conflict_1'],
    policyVersion: callerValues.policyVersion,
    limits: callerValues.limits,
    requestedAt: callerValues.requestedAt,
  });
  assert.strictEqual(calls[0]?.limits, callerValues.limits);
  const serializedQuestions = JSON.stringify(calls[0]?.questions);
  assert.ok(!serializedQuestions.includes(sourceMarker));
  assert.ok(!serializedQuestions.includes(conflictMarker));
});

test('uses a null event pair for no matches and the exact persisted pair for one match', async () => {
  const cases = [
    { events: [], eventId: null, eventVersion: null },
    { events: [{ eventId: 'event-entry-synthetic', eventVersion: 4 }], eventId: 'event-entry-synthetic', eventVersion: 4 },
  ] as const;

  for (const candidate of cases) {
    const calls: CreateInvestigationInput[] = [];
    const service = createInsufficientContextEntryService({
      async create(input) {
        calls.push(input);
        return checkpoint;
      },
    });
    const result = await service.open(makeOutcome({ context: { candidateEvents: candidate.events } }), callerValues);

    assert.equal(result.status, 'opened');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.eventId, candidate.eventId);
    assert.equal(calls[0]?.eventVersion, candidate.eventVersion);
  }
});

test('holds multiple candidate event matches for review without choosing one', async () => {
  let createCalls = 0;
  const service = createInsufficientContextEntryService({
    async create() {
      createCalls += 1;
      return checkpoint;
    },
  });

  const result = await service.open(makeOutcome({
    context: {
      candidateEvents: [
        { eventId: 'event-entry-one', eventVersion: 1 },
        { eventId: 'event-entry-two', eventVersion: 2 },
      ],
    },
  }), callerValues);

  assert.deepEqual(result, { status: 'review_required', reason: 'ambiguous_candidate_events' });
  assert.equal(createCalls, 0);
});

test('generates bounded stable labels from positions and replays identical create arguments', async () => {
  const missingFields = Array.from({ length: 11 }, (_, index) => 'private-missing-marker-' + index);
  const conflicts = Array.from({ length: 9 }, (_, index) => 'private-conflict-marker-' + index + '-' + conflictMarker);
  const outcome = makeOutcome({ context: { missingFields, conflicts } });
  const calls: CreateInvestigationInput[] = [];
  const service = createInsufficientContextEntryService({
    async create(input) {
      calls.push(input);
      return checkpoint;
    },
  });

  const first = await service.open(outcome, callerValues);
  const replay = await service.open(outcome, callerValues);

  assert.equal(first.status, 'opened');
  assert.equal(replay.status, 'opened');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  assert.deepEqual(calls[0]?.questions, [
    ...Array.from({ length: 11 }, (_, index) => 'missing_field_' + (index + 1)),
    ...Array.from({ length: 9 }, (_, index) => 'conflict_' + (index + 1)),
  ]);
  assert.equal(calls[0]?.questions.length, 20);
  assert.equal(JSON.stringify(calls[0]?.questions).includes('private-'), false);
  assert.equal(JSON.stringify(calls[0]?.questions).includes(conflictMarker), false);
});

test('returns review-required for zero or more than twenty questions without truncation', async () => {
  let createCalls = 0;
  const service = createInsufficientContextEntryService({
    async create() {
      createCalls += 1;
      return checkpoint;
    },
  });

  const none = await service.open(makeOutcome({ context: { missingFields: [], conflicts: [] } }), callerValues);
  const tooMany = await service.open(makeOutcome({
    context: {
      missingFields: Array.from({ length: 13 }, (_, index) => 'private-missing-' + index),
      conflicts: Array.from({ length: 8 }, (_, index) => 'private-conflict-' + index),
    },
  }), callerValues);

  assert.deepEqual(none, { status: 'review_required', reason: 'no_investigation_questions' });
  assert.deepEqual(tooMany, { status: 'review_required', reason: 'too_many_investigation_questions' });
  assert.equal(createCalls, 0);
});

test('rejects every mismatched persisted identity field and every sufficient context before ledger access', async () => {
  const mismatchedPersistedFields: Array<Record<string, unknown>> = [
    { schema_version: '1.0' },
    { record_type: 'OtherRecord' },
    { dataset_kind: 'historical' },
    { trace_id: 'trace-mismatch' },
    { context_id: 'context-mismatch' },
    { candidate_id: 'candidate-mismatch' },
    { sufficient: true },
  ];
  let createCalls = 0;
  const service = createInsufficientContextEntryService({
    async create() {
      createCalls += 1;
      return checkpoint;
    },
  });

  for (const persistedOverrides of mismatchedPersistedFields) {
    const result = await service.open(makeOutcome({ persisted: persistedOverrides }), callerValues);
    assert.deepEqual(result, { status: 'review_required', reason: 'context_identity_mismatch' });
  }

  const sufficient = await service.open(makeOutcome({ context: { sufficient: true } }), callerValues);
  assert.deepEqual(sufficient, { status: 'review_required', reason: 'context_not_insufficient' });
  assert.equal(createCalls, 0);
});

test('rejects a direct-reasoning success and missing explicit caller values', async () => {
  let createCalls = 0;
  const service = createInsufficientContextEntryService({
    async create() {
      createCalls += 1;
      return checkpoint;
    },
  });

  const directSuccess = { status: 'succeeded', capability: 'reasoning', value: {} };
  const unsupported = await service.open(
    directSuccess as unknown as InvestigationRequiredOutcome,
    callerValues,
  );
  const missingCallerValues: unknown[] = [
    undefined,
    { ...callerValues, investigationId: undefined },
    { ...callerValues, requestedAt: undefined },
    { ...callerValues, policyVersion: undefined },
    { ...callerValues, limits: undefined },
    { ...callerValues, limits: { ...callerValues.limits, modelTokens: undefined } },
  ];

  assert.deepEqual(unsupported, { status: 'review_required', reason: 'unsupported_outcome' });
  for (const missingValues of missingCallerValues) {
    const result = await service.open(
      makeOutcome(),
      missingValues as InsufficientContextEntryCallerValues,
    );
    assert.deepEqual(result, { status: 'review_required', reason: 'caller_values_missing' });
  }
  assert.equal(createCalls, 0);
});

test('propagates the exact ledger error object unchanged', async () => {
  const ledgerError = new Error('synthetic ledger failure');
  const service = createInsufficientContextEntryService({
    async create() {
      throw ledgerError;
    },
  });

  await assert.rejects(service.open(makeOutcome(), callerValues), (error: unknown) => {
    assert.strictEqual(error, ledgerError);
    return true;
  });
});

function makeOutcome(input: {
  readonly context?: Partial<GroundingContext>;
  readonly persisted?: Record<string, unknown>;
} = {}): InvestigationRequiredOutcome {
  const context: GroundingContext = {
    schemaVersion: '2.0',
    recordType: 'GroundingContext',
    datasetKind: 'synthetic',
    traceId: 'trace-entry-synthetic',
    contextId: 'context-entry-synthetic',
    candidateId: 'candidate-entry-synthetic',
    evidence: [{
      reference: {
        reportRevisionId: 'revision-entry-synthetic',
        permittedTextHash: 'a'.repeat(64),
        spanStart: 0,
        spanEnd: Array.from(sourceMarker).length,
        offsetUnit: 'unicode_code_points',
        relation: 'supports',
      },
      text: sourceMarker,
      sourceId: 'source-entry-synthetic',
      revisionStatus: 'eligible',
      publishedAt: null,
      observedAt: null,
      retrievedAt: '2026-09-26T05:00:00.000Z',
      origins: [],
    }],
    revisionStates: [],
    candidateEvents: [{ eventId: 'event-entry-synthetic', eventVersion: 4 }],
    priorDecisionIds: [],
    missingFields: ['private-missing-marker'],
    conflicts: [conflictMarker],
    retrievalVersion: 'retrieval-entry-synthetic-v1',
    indexVersion: 'index-entry-synthetic-v1',
    sufficient: false,
    ...input.context,
  };
  const persistedRecord = {
    schema_version: context.schemaVersion,
    trace_id: context.traceId,
    record_type: context.recordType,
    dataset_kind: context.datasetKind,
    context_id: context.contextId,
    candidate_id: context.candidateId,
    evidence: [],
    revision_states: [],
    candidate_events: context.candidateEvents.map(({ eventId, eventVersion }) => ({
      event_id: eventId,
      event_version: eventVersion,
    })),
    prior_decision_ids: [],
    missing_fields: [...context.missingFields],
    conflicts: [...context.conflicts],
    retrieval_version: context.retrievalVersion,
    index_version: context.indexVersion,
    sufficient: context.sufficient,
    ...input.persisted,
  } as GroundingContextRecord;
  const reasoningRequest: ReasoningRequest = { data: { groundingContext: context } };

  return { status: 'investigation_required', reasoningRequest, persistedRecord };
}
