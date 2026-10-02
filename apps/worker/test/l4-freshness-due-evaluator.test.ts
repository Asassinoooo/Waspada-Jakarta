import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  FreshnessDueTarget,
  FreshnessDueTargetCursor,
  FreshnessDueTargetPage,
  FreshnessDueTargetReader,
} from '../../db/src/freshness-due-target-reader.js';
import {
  createFreshnessDueEvaluator,
  FreshnessDueEvaluatorError,
  type FreshnessDueEvaluatorRecorderPort,
  type FreshnessDueEvaluatorRequest,
} from '../src/layers/l4-application-integration/freshness-due-evaluator.js';
import type {
  FreshnessRecorderTransitionRecord,
  FreshnessTransitionRecorderInput,
  FreshnessTransitionRecorderResult,
} from '../src/layers/l4-application-integration/freshness-transition-recorder.js';

describe('Layer 4 freshness due evaluator', () => {
  it('reads one bounded explicit-time page and maps each exact target serially', async () => {
    const claimSet = makeTarget({
      eventId: 'claim-event',
      eventVersion: 12,
      status: 'needs_update',
      transitionSequence: 2,
      validUntil: '2026-10-01T11:00:00.123456789+01:00',
      reviewDueAt: '2026-10-01T10:00:00.987654321Z',
    });
    const impact = makeTarget({
      eventId: 'impact-event',
      eventVersion: 5,
      target: { kind: 'impact', impactId: 'impact-a', impactVersion: 3 },
      status: 'current',
      transitionSequence: 0,
      validUntil: null,
      reviewDueAt: '2026-10-01T10:00:00.000000001Z',
    });
    const finalTarget = makeTarget({
      eventId: 'final-event',
      eventVersion: 8,
      target: { kind: 'impact', impactId: 'impact-final', impactVersion: 2 },
      status: 'needs_update',
      transitionSequence: 9,
      validUntil: '2026-10-01T09:00:00Z',
      reviewDueAt: null,
    });
    const continuation = cursorFor(finalTarget);
    const readerCalls: unknown[] = [];
    const reader = makeReader({
      targets: [claimSet, impact, finalTarget],
      nextCursor: continuation,
    }, readerCalls);
    const recorderCalls: FreshnessTransitionRecorderInput[] = [];
    let activeCalls = 0;
    let maximumActiveCalls = 0;
    const recorder: FreshnessDueEvaluatorRecorderPort = {
      async evaluateAndRecord(input) {
        activeCalls += 1;
        maximumActiveCalls = Math.max(maximumActiveCalls, activeCalls);
        recorderCalls.push(input);
        await Promise.resolve();
        activeCalls -= 1;
        return recorderCalls.length === 1
          ? persisted('written', input)
          : recorderCalls.length === 2
            ? persisted('replayed', input)
            : noChange(input);
      },
    };

    const request = makeRequest({ limit: 3 });
    const result = await createFreshnessDueEvaluator({ reader, recorder }).evaluate(request);

    assert.deepEqual(readerCalls, [{
      datasetKind: 'synthetic',
      now: request.now,
      limit: 3,
      cursor: null,
    }]);
    assert.equal(maximumActiveCalls, 1);
    assert.equal(recorderCalls.length, 3);
    assert.deepEqual(recorderCalls.map(({ eventId }) => eventId), [
      'claim-event', 'impact-event', 'final-event',
    ]);
    assert.deepEqual(recorderCalls[0], {
      datasetKind: 'synthetic',
      eventId: 'claim-event',
      eventVersion: 12,
      target: { kind: 'event_claim_set' },
      expectedSequence: 3,
      previousStatus: 'needs_update',
      validUntil: claimSet.validUntil,
      reviewDueAt: claimSet.reviewDueAt,
      now: request.now,
      newApplicableEvidenceEvaluated: false,
      evidenceReferenceIds: [],
      traceId: request.traceId,
      idempotencyKey: recorderCalls[0].idempotencyKey,
    });
    assert.deepEqual(recorderCalls[1], {
      datasetKind: 'synthetic',
      eventId: 'impact-event',
      eventVersion: 5,
      target: { kind: 'impact', impactId: 'impact-a', impactVersion: 3 },
      expectedSequence: 1,
      previousStatus: 'current',
      validUntil: null,
      reviewDueAt: impact.reviewDueAt,
      now: request.now,
      newApplicableEvidenceEvaluated: false,
      evidenceReferenceIds: [],
      traceId: request.traceId,
      idempotencyKey: recorderCalls[1].idempotencyKey,
    });
    for (const call of recorderCalls) {
      assert.match(call.idempotencyKey, /^freshness-due:[a-f0-9]{64}$/u);
      assert.ok(call.idempotencyKey.length <= 256);
      assert.equal(call.newApplicableEvidenceEvaluated, false);
      assert.deepEqual(call.evidenceReferenceIds, []);
    }
    assert.deepEqual(result, {
      outcome: 'completed',
      counts: { written: 1, replayed: 1, noChange: 1, conflicts: 0, failures: 0 },
      nextCursor: continuation,
    });
  });

  it('uses stable bounded idempotency keys for the run and complete target sequence identity', async () => {
    const baseTarget = makeTarget({ transitionSequence: 4 });
    const keys: string[] = [];

    async function evaluate(target: FreshnessDueTarget, overrides: Partial<FreshnessDueEvaluatorRequest> = {}) {
      const reader = makeReader({ targets: [target], nextCursor: null });
      const recorder: FreshnessDueEvaluatorRecorderPort = {
        async evaluateAndRecord(input) {
          keys.push(input.idempotencyKey);
          return noChange(input);
        },
      };
      await createFreshnessDueEvaluator({ reader, recorder }).evaluate(makeRequest(overrides));
    }

    await evaluate(baseTarget);
    await evaluate(baseTarget);
    await evaluate(baseTarget, { evaluationRunId: 'run-evaluator-next' });
    await evaluate(makeTarget({ datasetKind: 'live', transitionSequence: 4 }), { datasetKind: 'live' });
    await evaluate(makeTarget({ eventId: 'event-evaluator-next', transitionSequence: 4 }));
    await evaluate(makeTarget({ eventVersion: 4, transitionSequence: 4 }));
    await evaluate(makeTarget({
      target: { kind: 'impact', impactId: 'impact-evaluator', impactVersion: 2 },
      transitionSequence: 4,
    }));
    await evaluate(makeTarget({ transitionSequence: 5 }));

    assert.equal(keys.length, 8);
    assert.equal(keys[0], keys[1]);
    assert.equal(new Set(keys).size, keys.length - 1);
    assert.ok(keys.every((key) => /^freshness-due:[a-f0-9]{64}$/u.test(key) && key.length <= 256));
  });

  it('stops at the first conflict and resumes from the original cursor', async () => {
    const originalCursor: FreshnessDueTargetCursor = {
      eventId: 'resume-event',
      eventVersion: 2,
      target: { kind: 'event_claim_set' },
    };
    const targets = [
      makeTarget({ eventId: 'first-target' }),
      makeTarget({ eventId: 'conflict-target', target: { kind: 'impact', impactId: 'impact-conflict', impactVersion: 1 } }),
      makeTarget({ eventId: 'unvisited-target' }),
    ];
    const readerCalls: unknown[] = [];
    const recorderCalls: FreshnessTransitionRecorderInput[] = [];
    const reader = makeReader({ targets, nextCursor: cursorFor(targets[2]!) }, readerCalls);
    const recorder: FreshnessDueEvaluatorRecorderPort = {
      async evaluateAndRecord(input) {
        recorderCalls.push(input);
        return recorderCalls.length === 1
          ? persisted('written', input)
          : { outcome: 'conflict', code: 'stale_sequence' };
      },
    };

    const result = await createFreshnessDueEvaluator({ reader, recorder }).evaluate(
      makeRequest({ limit: 3, cursor: originalCursor }),
    );

    assert.equal(readerCalls.length, 1);
    assert.deepEqual(readerCalls[0], {
      datasetKind: 'synthetic',
      now: '2026-10-01T10:00:00.123456789Z',
      limit: 3,
      cursor: originalCursor,
    });
    assert.deepEqual(recorderCalls.map(({ eventId }) => eventId), ['first-target', 'conflict-target']);
    assert.deepEqual(result, {
      outcome: 'retry',
      counts: { written: 1, replayed: 0, noChange: 0, conflicts: 1, failures: 0 },
      resumeCursor: originalCursor,
    });
  });

  it('rejects invalid closed requests and oversized reader pages without processing targets', async () => {
    let readCalls = 0;
    let recordCalls = 0;
    const reader: FreshnessDueTargetReader = {
      async read() {
        readCalls += 1;
        return { targets: [makeTarget(), makeTarget({ eventId: 'second-target' })], nextCursor: null };
      },
    };
    const recorder: FreshnessDueEvaluatorRecorderPort = {
      async evaluateAndRecord(input) {
        recordCalls += 1;
        return noChange(input);
      },
    };
    const evaluator = createFreshnessDueEvaluator({ reader, recorder });

    for (const request of [
      { ...makeRequest(), privateText: 'never echo this' },
      makeRequest({ limit: 101 }),
      makeRequest({ now: '0000-01-01T00:00:00Z' }),
      makeRequest({ now: '2026-02-30T10:00:00Z' }),
      makeRequest({ now: '2026-02-00T10:00:00Z' }),
      makeRequest({ traceId: 'bad trace id' }),
    ]) {
      await assert.rejects(
        evaluator.evaluate(request),
        (error: unknown) => error instanceof FreshnessDueEvaluatorError
          && error.message === 'The freshness due-evaluator request is invalid.'
          && !error.message.includes('never echo this'),
      );
    }
    assert.equal(readCalls, 0);

    const result = await evaluator.evaluate(makeRequest({ limit: 1 }));
    assert.deepEqual(result, {
      outcome: 'retry',
      counts: { written: 0, replayed: 0, noChange: 0, conflicts: 0, failures: 1 },
      resumeCursor: null,
    });
    assert.equal(readCalls, 1);
    assert.equal(recordCalls, 0);

    const expiredPageEvaluator = createFreshnessDueEvaluator({
      reader: makeReader({ targets: [makeTarget({ status: 'expired' })], nextCursor: null }),
      recorder,
    });
    assert.deepEqual(await expiredPageEvaluator.evaluate(makeRequest({ limit: 1 })), {
      outcome: 'retry',
      counts: { written: 0, replayed: 0, noChange: 0, conflicts: 0, failures: 1 },
      resumeCursor: null,
    });
    assert.equal(recordCalls, 0);
  });

  it('returns content-free retries on reader and recorder failures', async () => {
    const originalCursor: FreshnessDueTargetCursor = {
      eventId: 'resume-safe',
      eventVersion: 3,
      target: { kind: 'impact', impactId: 'impact-safe', impactVersion: 1 },
    };
    const readerFailure = makeReaderFailure(new Error('private-reader-detail'));
    const readerRetry = await createFreshnessDueEvaluator({
      reader: readerFailure,
      recorder: makeRecorder(),
    }).evaluate(makeRequest({ cursor: originalCursor }));
    assert.deepEqual(readerRetry, {
      outcome: 'retry',
      counts: { written: 0, replayed: 0, noChange: 0, conflicts: 0, failures: 1 },
      resumeCursor: originalCursor,
    });

    const target = makeTarget({ eventId: 'sensitive-target' });
    const recorderFailure = await createFreshnessDueEvaluator({
      reader: makeReader({ targets: [target], nextCursor: null }),
      recorder: {
        async evaluateAndRecord() { throw new Error('private-recorder-detail'); },
      },
    }).evaluate(makeRequest({ cursor: originalCursor }));
    assert.deepEqual(recorderFailure, {
      outcome: 'retry',
      counts: { written: 0, replayed: 0, noChange: 0, conflicts: 0, failures: 1 },
      resumeCursor: originalCursor,
    });

    const serialized = JSON.stringify([readerRetry, recorderFailure]);
    assert.equal(serialized.includes('private-reader-detail'), false);
    assert.equal(serialized.includes('private-recorder-detail'), false);
    assert.equal(serialized.includes('sensitive-target'), false);
  });
});

function makeRequest(overrides: Partial<FreshnessDueEvaluatorRequest> = {}): FreshnessDueEvaluatorRequest {
  return {
    datasetKind: 'synthetic',
    now: '2026-10-01T10:00:00.123456789Z',
    limit: 10,
    cursor: null,
    traceId: 'trace-evaluator',
    evaluationRunId: 'run-evaluator',
    ...overrides,
  };
}

function makeTarget(overrides: Partial<FreshnessDueTarget> = {}): FreshnessDueTarget {
  return {
    datasetKind: 'synthetic',
    eventId: 'event-evaluator',
    eventVersion: 7,
    target: { kind: 'event_claim_set' },
    status: 'current',
    transitionSequence: 1,
    validUntil: null,
    reviewDueAt: '2026-10-01T10:00:00Z',
    ...overrides,
  };
}

function cursorFor(target: FreshnessDueTarget): FreshnessDueTargetCursor {
  return { eventId: target.eventId, eventVersion: target.eventVersion, target: target.target };
}

function makeReader(page: FreshnessDueTargetPage, calls: unknown[] = []): FreshnessDueTargetReader {
  return {
    async read(request) {
      calls.push(request);
      return page;
    },
  };
}

function makeReaderFailure(failure: Error): FreshnessDueTargetReader {
  return {
    async read() { throw failure; },
  };
}

function makeRecorder(): FreshnessDueEvaluatorRecorderPort {
  return { async evaluateAndRecord(input) { return noChange(input); } };
}

function noChange(input: FreshnessTransitionRecorderInput): FreshnessTransitionRecorderResult {
  return {
    outcome: 'no_change',
    status: input.previousStatus,
    reason: input.previousStatus === 'current' ? 'current_state_retained' : 'stale_state_retained',
  };
}

function persisted(
  outcome: 'written' | 'replayed',
  input: FreshnessTransitionRecorderInput,
): FreshnessTransitionRecorderResult {
  const record: FreshnessRecorderTransitionRecord = {
    transitionId: 'transition-evaluator',
    datasetKind: input.datasetKind,
    eventId: input.eventId,
    eventVersion: input.eventVersion,
    target: input.target,
    transitionSequence: input.expectedSequence,
    previousStatus: input.previousStatus,
    resultingStatus: input.previousStatus === 'current' ? 'needs_update' : 'expired',
    reason: input.validUntil === null ? 'review_deadline_missed' : 'issuer_validity_ended',
    evaluatedAt: input.now,
    traceId: input.traceId,
    idempotencyKey: input.idempotencyKey,
    requestFingerprint: 'f'.repeat(64),
    evidenceReferenceIds: [],
  };
  return { outcome, record };
}
