import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createFreshnessTransitionRecorder,
  FreshnessTransitionRecorderError,
  type FreshnessTransitionAppendCommand,
  type FreshnessTransitionRecorderInput,
} from '../src/layers/l4-application-integration/freshness-transition-recorder.js';

describe('Layer 4 freshness transition recorder', () => {
  it('persists an issuer-expiry transition using the shared policy result', async () => {
    const calls: FreshnessTransitionAppendCommand[] = [];
    const recorder = createFreshnessTransitionRecorder({
      async append(command) { calls.push(command); return { outcome: 'conflict', code: 'stale_sequence' }; },
    });

    const result = await recorder.evaluateAndRecord(makeInput({
      previousStatus: 'needs_update', validUntil: '2026-10-01T10:00:00Z',
      now: '2026-10-01T10:00:00Z',
    }));

    assert.deepEqual(result, { outcome: 'conflict', code: 'stale_sequence' });
    assert.deepEqual(calls, [{
      datasetKind: 'synthetic', eventId: 'event-recorder', eventVersion: 3,
      target: { kind: 'event_claim_set' }, expectedSequence: 2, previousStatus: 'needs_update',
      resultingStatus: 'expired', reason: 'issuer_validity_ended', evaluatedAt: '2026-10-01T10:00:00Z',
      traceId: 'trace-recorder', idempotencyKey: 'freshness:review:3', evidenceReferenceIds: [],
    }]);
  });

  it('persists a due review transition for one exact impact target', async () => {
    const calls: FreshnessTransitionAppendCommand[] = [];
    const recorder = createFreshnessTransitionRecorder({
      async append(command) { calls.push(command); return { outcome: 'conflict', code: 'stale_sequence' }; },
    });

    await recorder.evaluateAndRecord(makeInput({
      target: { kind: 'impact', impactId: 'impact-recorder', impactVersion: 4 },
      previousStatus: 'current', reviewDueAt: '2026-10-01T10:00:00Z', now: '2026-10-01T10:00:00Z',
    }));

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      datasetKind: 'synthetic', eventId: 'event-recorder', eventVersion: 3,
      target: { kind: 'impact', impactId: 'impact-recorder', impactVersion: 4 },
      expectedSequence: 2, previousStatus: 'current', resultingStatus: 'needs_update',
      reason: 'review_deadline_missed', evaluatedAt: '2026-10-01T10:00:00Z',
      traceId: 'trace-recorder', idempotencyKey: 'freshness:review:3', evidenceReferenceIds: [],
    });
  });

  it('requires and preserves exact evidence-reference IDs on stale-to-current recovery', async () => {
    const calls: FreshnessTransitionAppendCommand[] = [];
    const recorder = createFreshnessTransitionRecorder({
      async append(command) { calls.push(command); return { outcome: 'conflict', code: 'stale_sequence' }; },
    });

    await recorder.evaluateAndRecord(makeInput({
      previousStatus: 'expired', validUntil: null, newApplicableEvidenceEvaluated: true,
      evidenceReferenceIds: ['27', '5'], now: '2026-10-01T10:00:00.123456789Z',
    }));

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      datasetKind: 'synthetic', eventId: 'event-recorder', eventVersion: 3,
      target: { kind: 'event_claim_set' }, expectedSequence: 2, previousStatus: 'expired',
      resultingStatus: 'current', reason: 'new_applicable_evidence_evaluated',
      evaluatedAt: '2026-10-01T10:00:00.123456789Z', traceId: 'trace-recorder',
      idempotencyKey: 'freshness:review:3', evidenceReferenceIds: ['5', '27'],
    });
  });

  it('does not call persistence for current, stale, or already-expired no-op evaluations', async () => {
    let writes = 0;
    const recorder = createFreshnessTransitionRecorder({
      async append() { writes += 1; return { outcome: 'conflict', code: 'stale_sequence' }; },
    });
    const cases: Array<[
      Partial<FreshnessTransitionRecorderInput>,
      { readonly status: string; readonly reason: string },
    ]> = [
      [{ previousStatus: 'current', reviewDueAt: '2026-10-01T10:01:00Z' }, { status: 'current', reason: 'current_state_retained' }],
      [{ previousStatus: 'needs_update' }, { status: 'needs_update', reason: 'stale_state_retained' }],
      [{ previousStatus: 'expired', validUntil: '2026-10-01T09:00:00Z' }, { status: 'expired', reason: 'issuer_validity_ended' }],
    ];

    for (const [overrides, expected] of cases) {
      assert.deepEqual(await recorder.evaluateAndRecord(makeInput(overrides)), {
        outcome: 'no_change', ...expected,
      });
    }
    assert.equal(writes, 0);
  });

  it('rejects invalid and evidence-free recovery input with stable redacted errors', async () => {
    let writes = 0;
    const recorder = createFreshnessTransitionRecorder({
      async append() { writes += 1; return { outcome: 'conflict', code: 'target_changed' }; },
    });

    await assert.rejects(
      recorder.evaluateAndRecord(makeInput({ now: 'private malformed timestamp' })),
      (error: unknown) => error instanceof FreshnessTransitionRecorderError
        && error.code === 'invalid_input' && error.message === 'invalid_input'
        && !error.message.includes('private malformed timestamp'),
    );
    await assert.rejects(
      recorder.evaluateAndRecord({ ...makeInput(), sourceText: 'private source text' } as unknown as FreshnessTransitionRecorderInput),
      (error: unknown) => error instanceof FreshnessTransitionRecorderError
        && error.code === 'invalid_input' && !error.message.includes('private source text'),
    );
    await assert.rejects(
      recorder.evaluateAndRecord(makeInput({
        previousStatus: 'needs_update', newApplicableEvidenceEvaluated: true, evidenceReferenceIds: [],
      })),
      (error: unknown) => error instanceof FreshnessTransitionRecorderError
        && error.code === 'evidence_references_required' && !error.message.includes('event-recorder'),
    );
    assert.equal(writes, 0);
  });
});

function makeInput(overrides: Partial<FreshnessTransitionRecorderInput> = {}): FreshnessTransitionRecorderInput {
  return {
    datasetKind: 'synthetic', eventId: 'event-recorder', eventVersion: 3,
    target: { kind: 'event_claim_set' }, expectedSequence: 2, previousStatus: 'current',
    validUntil: null, reviewDueAt: null, now: '2026-10-01T10:00:00Z',
    newApplicableEvidenceEvaluated: false, evidenceReferenceIds: [],
    traceId: 'trace-recorder', idempotencyKey: 'freshness:review:3', ...overrides,
  };
}
