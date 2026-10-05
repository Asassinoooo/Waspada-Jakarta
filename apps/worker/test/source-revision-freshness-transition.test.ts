import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  AppendFreshnessTransitionInput,
  FreshnessTransitionAppendResult,
  AppendSourceRevisionFreshnessTransitionInput,
  SourceRevisionFreshnessTransitionAppendResult,
} from '../../db/src/freshness-transition-ledger.js';
import type {
  SourceRevisionFreshnessTarget,
  SourceRevisionFreshnessTargetRequest,
} from '../../db/src/source-revision-freshness-target-reader.js';
import type {
  SourceRevisionReviewCandidate,
  SourceRevisionReviewCandidateCursor,
  SourceRevisionReviewCandidatePage,
} from '../../db/src/source-revision-review-candidate-reader.js';
import {
  createSourceRevisionFreshnessTransitionCoordinator,
  SourceRevisionFreshnessTransitionError,
  type SourceRevisionFreshnessTransitionPorts,
} from '../src/layers/l4-application-integration/source-revision-freshness-transition.js';

const NOW = '2026-10-01T10:00:00.000000Z';
const TRACE_ID = 'trace-source-freshness-transition';

describe('source-revision freshness transition coordinator', () => {
  it('validates explicit RFC3339 time, live scope and page bounds before reading', async () => {
    let candidateReads = 0;
    const coordinator = createSourceRevisionFreshnessTransitionCoordinator({
      candidates: { async read() { candidateReads += 1; return emptyPage(); } },
      targets: { async read() { return []; } },
      ledger: { async append() { return { outcome: 'conflict', code: 'stale_sequence' }; } },
    });

    for (const request of [
      { datasetKind: 'historical', now: NOW, limit: 1, traceId: TRACE_ID },
      { datasetKind: 'live', now: NOW, limit: 0, traceId: TRACE_ID },
      { datasetKind: 'live', now: NOW, limit: 101, traceId: TRACE_ID },
      { datasetKind: 'live', now: '2026-02-29T10:00:00Z', limit: 1, traceId: TRACE_ID },
      { datasetKind: 'live', now: '2026-10-01', limit: 1, traceId: TRACE_ID },
      { datasetKind: 'live', now: NOW, limit: 1, traceId: TRACE_ID, extra: true },
      { datasetKind: 'live', now: NOW, limit: 1, traceId: TRACE_ID, cursor: undefined },
    ]) {
      await assert.rejects(coordinator.processPage(request), (error: unknown) =>
        error instanceof SourceRevisionFreshnessTransitionError
          && error.code === 'invalid_request'
          && error.message === 'The source-revision freshness transition request is invalid.');
    }
    assert.equal(candidateReads, 0);
  });

  it('deduplicates targets deterministically, expires at equality, and records only the selected source ID', async () => {
    const candidates: SourceRevisionReviewCandidate[] = [
      makeCandidate('obs-a-retracted', 'retracted', { kind: 'event_claim_set' }),
      makeCandidate('obs-a-retracted', 'retracted', impactTarget()),
      makeCandidate('obs-current', 'current', { kind: 'event_claim_set' }),
      makeCandidate('obs-withdrawn-duplicate', 'withdrawn', { kind: 'event_claim_set' }),
      makeCandidate('obs-z-superseded', 'superseded', { kind: 'event_claim_set' }),
      makeCandidate('obs-z-superseded', 'superseded', impactTarget()),
    ];
    const targetResults: SourceRevisionFreshnessTarget[] = [
      makeTarget({ kind: 'event_claim_set' }, 'current', 0, NOW),
      makeTarget(impactTarget(), 'current', 4, '2026-10-01T10:00:00.000001Z'),
    ];
    const commands: (AppendFreshnessTransitionInput | AppendSourceRevisionFreshnessTransitionInput)[] = [];
    const targetRequests: (readonly SourceRevisionFreshnessTargetRequest[])[] = [];
    let ledgerCall = 0;
    const coordinator = coordinatorFor({
      candidates: page(candidates),
      async readTargets(request) {
        targetRequests.push(request);
        return targetResults;
      },
      async append(command) {
        commands.push(command);
        ledgerCall += 1;
        return ledgerResult(ledgerCall === 1 ? 'written' : 'replayed');
      },
    });

    const result = await coordinator.processPage({
      datasetKind: 'live', now: '2026-10-01T12:00:00+02:00', limit: 100, traceId: TRACE_ID,
    });

    assert.equal(result.outcome, 'completed');
    if (result.outcome !== 'completed') return;
    assert.deepEqual(result.counts, {
      candidates: 6, invalidatingCandidates: 5, selectedTargets: 2,
      duplicateCandidates: 3, skippedCandidates: 1, written: 1, replayed: 1, noChange: 0,
    });
    assert.equal(targetRequests.length, 1);
    assert.deepEqual(targetRequests[0], [
      { eventId: 'event-source-freshness', eventVersion: 3, target: { kind: 'event_claim_set' } },
      { eventId: 'event-source-freshness', eventVersion: 3, target: impactTarget() },
    ]);
    assert.equal(commands.length, 2);
    assert.equal(commands[0]?.reason, 'issuer_validity_ended');
    assert.equal(commands[0]?.previousStatus, 'current');
    assert.equal(commands[0]?.resultingStatus, 'expired');
    assert.equal(Object.hasOwn(commands[0]!, 'sourceObservationId'), false,
      'issuer validity takes precedence and stores no source-observation ID');
    assert.equal(commands[1]?.reason, 'source_report_retracted',
      'the lexical first observation is selected consistently across duplicate candidates');
    assert.equal(commands[1] !== undefined && 'sourceObservationId' in commands[1]
      ? commands[1].sourceObservationId : undefined, 'obs-a-retracted');
    assert.equal(commands[1]?.previousStatus, 'current');
    assert.equal(commands[1]?.resultingStatus, 'needs_update');
    for (const command of commands) {
      assert.match(command.idempotencyKey, /^source-revision-freshness:[a-f0-9]{64}$/u);
      assert.ok(command.idempotencyKey.length <= 256);
      assert.equal(command.traceId, TRACE_ID);
      assert.deepEqual(command.evidenceReferenceIds, []);
    }
  });

  it('applies withdrawn assertions alongside current statements to exact event and impact targets', async () => {
    const candidates = sortCandidates([
      makeCandidate('obs-current-withdrawn', 'current', { kind: 'event_claim_set' }),
      makeCandidate('obs-withdrawn-event', 'withdrawn', { kind: 'event_claim_set' }),
      makeCandidate('obs-withdrawn-impact', 'withdrawn', impactTarget()),
    ]);
    const commands: (AppendFreshnessTransitionInput | AppendSourceRevisionFreshnessTransitionInput)[] = [];
    const targetRequests: (readonly SourceRevisionFreshnessTargetRequest[])[] = [];
    const coordinator = coordinatorFor({
      candidates: page(candidates),
      async readTargets(request) {
        targetRequests.push(request);
        return request.map((target) => makeTarget(target.target, 'current', 0, '2026-10-02T10:00:00Z'));
      },
      async append(command) {
        commands.push(command);
        return ledgerResult('written');
      },
    });

    const result = await coordinator.processPage({
      datasetKind: 'live', now: NOW, limit: 10, traceId: TRACE_ID,
    });
    assert.equal(result.outcome, 'completed');
    if (result.outcome !== 'completed') return;
    assert.deepEqual(result.counts, {
      candidates: 3, invalidatingCandidates: 2, selectedTargets: 2,
      duplicateCandidates: 0, skippedCandidates: 1, written: 2, replayed: 0, noChange: 0,
    });
    assert.deepEqual(targetRequests, [[
      { eventId: 'event-source-freshness', eventVersion: 3, target: { kind: 'event_claim_set' } },
      { eventId: 'event-source-freshness', eventVersion: 3, target: impactTarget() },
    ]]);
    assert.deepEqual(commands.map((command) => ({
      target: command.target,
      reason: command.reason,
      observationId: 'sourceObservationId' in command ? command.sourceObservationId : null,
      previousStatus: command.previousStatus,
      resultingStatus: command.resultingStatus,
    })), [
      {
        target: { kind: 'event_claim_set' },
        reason: 'source_report_withdrawn',
        observationId: 'obs-withdrawn-event',
        previousStatus: 'current',
        resultingStatus: 'needs_update',
      },
      {
        target: impactTarget(),
        reason: 'source_report_withdrawn',
        observationId: 'obs-withdrawn-impact',
        previousStatus: 'current',
        resultingStatus: 'needs_update',
      },
    ]);
  });

  it('rejects malformed withdrawn candidate lineage without reading targets or writing', async () => {
    let targetReads = 0;
    let ledgerWrites = 0;
    const invalidCandidate = {
      ...makeCandidate('obs-withdrawn-invalid', 'withdrawn', { kind: 'event_claim_set' }),
      replacementReportRevisionId: 'unexpected-replacement',
    };
    const coordinator = coordinatorFor({
      candidates: {
        async read() {
          return { candidates: [invalidCandidate], nextCursor: null };
        },
      },
      async readTargets() { targetReads += 1; return []; },
      async append() { ledgerWrites += 1; return ledgerResult('written'); },
    });
    const result = await coordinator.processPage({
      datasetKind: 'live', now: NOW, limit: 1, traceId: TRACE_ID,
    });
    assert.deepEqual(result, {
      outcome: 'failed', code: 'candidate_page_invalid', counts: zeroCounts(), resumeCursor: null,
    });
    assert.equal(targetReads, 0);
    assert.equal(ledgerWrites, 0);
  });

  it('treats sub-microsecond just-before validity as expired and keeps stale statuses sticky', async () => {
    const beforeCandidate = makeCandidate('obs-before', 'superseded', { kind: 'event_claim_set' }, 'event-before');
    const stickyCandidates = [
      makeCandidate('obs-before', 'superseded', { kind: 'event_claim_set' }, 'event-before'),
      makeCandidate('obs-expired', 'withdrawn', { kind: 'event_claim_set' }, 'event-expired'),
      makeCandidate('obs-needs-update', 'retracted', { kind: 'impact', impactId: 'impact-sticky', impactVersion: 1 }, 'event-sticky'),
      makeCandidate('obs-withdrawn', 'withdrawn', { kind: 'event_claim_set' }, 'event-withdrawn'),
      makeCandidate('obs-withdrawn-expiry', 'withdrawn', { kind: 'event_claim_set' }, 'event-withdrawn-expiry'),
      makeCandidate('obs-current', 'current', { kind: 'event_claim_set' }, 'event-current'),
    ];
    const commands: (AppendFreshnessTransitionInput | AppendSourceRevisionFreshnessTransitionInput)[] = [];
    const coordinator = coordinatorFor({
      candidates: page(sortCandidates(stickyCandidates)),
      async readTargets(request) {
        return request.map((target) => {
          if (target.eventId === 'event-before') {
            return makeTarget(target.target, 'current', 0, '2026-10-01T10:00:00.0000001Z', target.eventId);
          }
          if (target.eventId === 'event-expired') {
            return makeTarget(target.target, 'expired', 7, '2026-09-30T10:00:00Z', target.eventId);
          }
          if (target.eventId === 'event-withdrawn-expiry') {
            return makeTarget(target.target, 'current', 0, NOW, target.eventId);
          }
          return makeTarget(target.target, 'needs_update', 2, null, target.eventId);
        });
      },
      async append(command) { commands.push(command); return ledgerResult('written'); },
    });

    const result = await coordinator.processPage({
      datasetKind: 'live', now: '2026-10-01T10:00:00.0000002Z', limit: 100, traceId: TRACE_ID,
    });
    assert.equal(beforeCandidate.eventId, 'event-before');
    assert.equal(result.outcome, 'completed');
    if (result.outcome !== 'completed') return;
    assert.equal(commands.length, 2);
    assert.equal(commands.every((command) => command.reason === 'issuer_validity_ended'), true);
    assert.equal(commands.every((command) => command.resultingStatus === 'expired'), true);
    const withdrawnExpiry = commands.find((command) => command.eventId === 'event-withdrawn-expiry');
    assert.ok(withdrawnExpiry);
    assert.equal(Object.hasOwn(withdrawnExpiry, 'sourceObservationId'), false,
      'issuer expiry takes precedence for withdrawn targets at validity equality');
    assert.equal(result.counts.noChange, 3,
      'already-expired and needs-update targets are not downgraded or rewritten');
    assert.equal(result.counts.skippedCandidates, 1,
      'current-only assertions are skipped without target reads or writes');
  });

  it('stops serial appends on a stale conflict and returns the original input cursor', async () => {
    const inputCursor = cursor('obs-a-before', 'event-before');
    const candidates = sortCandidates([
      makeCandidate('obs-b', 'retracted', { kind: 'event_claim_set' }, 'event-b'),
      makeCandidate('obs-c', 'withdrawn', { kind: 'event_claim_set' }, 'event-c'),
    ]);
    const appended: string[] = [];
    const targetResults = candidates.map((candidate) =>
      makeTarget(candidate.target, 'current', 0, null, candidate.eventId));
    const coordinator = coordinatorFor({
      candidates: page(candidates, cursor('obs-c', 'event-c')),
      async readTargets() { return targetResults; },
      async append(command) {
        appended.push(command.eventId);
        return appended.length === 1
          ? ledgerResult('written')
          : { outcome: 'conflict', code: 'stale_sequence' };
      },
    });

    const result = await coordinator.processPage({
      datasetKind: 'live', now: NOW, limit: 2, cursor: inputCursor, traceId: TRACE_ID,
    });
    assert.deepEqual(result, {
      outcome: 'conflict',
      code: 'stale_target',
      counts: {
        candidates: 2, invalidatingCandidates: 2, selectedTargets: 2,
        duplicateCandidates: 0, skippedCandidates: 0, written: 1, replayed: 0, noChange: 0,
      },
      resumeCursor: inputCursor,
    });
    assert.deepEqual(appended, ['event-b', 'event-c'], 'writes are serial and stop at the first conflict');
    assert.notDeepEqual(result.resumeCursor, cursor('obs-c', 'event-c'));
  });

  it('does not advance a page when an exact target disappeared or a reader/storage port fails', async () => {
    const inputCursor = cursor('obs-before', 'event-before');
    const candidate = makeCandidate('obs-next', 'retracted', { kind: 'event_claim_set' }, 'event-next');
    const input = { datasetKind: 'live', now: NOW, limit: 1, cursor: inputCursor, traceId: TRACE_ID };
    const next = cursor('obs-next', 'event-next');

    const missingTarget = coordinatorFor({
      candidates: page([candidate], next), async readTargets() { return []; },
      async append() { assert.fail('stale target must not append'); },
    });
    assert.deepEqual(await missingTarget.processPage(input), {
      outcome: 'conflict', code: 'stale_target',
      counts: {
        candidates: 1, invalidatingCandidates: 1, selectedTargets: 1,
        duplicateCandidates: 0, skippedCandidates: 0, written: 0, replayed: 0, noChange: 0,
      },
      resumeCursor: inputCursor,
    });

    const readFailure = coordinatorFor({
      candidates: { async read() { throw new Error('private diagnostics'); } },
      async readTargets() { return []; },
      async append() { assert.fail('failed candidate read must not append'); },
    });
    assert.deepEqual(await readFailure.processPage(input), {
      outcome: 'failed', code: 'candidate_read_failed',
      counts: zeroCounts(), resumeCursor: inputCursor,
    });

    const targetFailure = coordinatorFor({
      candidates: page([candidate], next),
      async readTargets() { throw new Error('private diagnostics'); },
      async append() { assert.fail('failed target read must not append'); },
    });
    const failedResult = await targetFailure.processPage(input);
    assert.equal(failedResult.outcome, 'failed');
    if (failedResult.outcome === 'failed') {
      assert.equal(failedResult.code, 'target_read_failed');
      assert.deepEqual(failedResult.resumeCursor, inputCursor);
      assert.equal(JSON.stringify(failedResult).includes('private diagnostics'), false);
    }

    const ledgerFailure = coordinatorFor({
      candidates: page([candidate], next),
      async readTargets(request) {
        return request.map((target) => makeTarget(target.target, 'current', 0, null, target.eventId));
      },
      async append() { throw new Error('private diagnostics'); },
    });
    const appendFailure = await ledgerFailure.processPage(input);
    assert.equal(appendFailure.outcome, 'failed');
    if (appendFailure.outcome === 'failed') {
      assert.equal(appendFailure.code, 'ledger_write_failed');
      assert.deepEqual(appendFailure.resumeCursor, inputCursor);
    }
  });
});

interface PortOverrides {
  readonly candidates?: { read(request: unknown): Promise<unknown> };
  readonly readTargets?: (request: readonly SourceRevisionFreshnessTargetRequest[]) => Promise<unknown>;
  readonly append?: (input: AppendFreshnessTransitionInput | AppendSourceRevisionFreshnessTransitionInput) =>
    Promise<FreshnessTransitionAppendResult | SourceRevisionFreshnessTransitionAppendResult>;
}

function coordinatorFor(overrides: PortOverrides) {
  const ports = {
    candidates: overrides.candidates ?? { async read() { return emptyPage(); } },
    targets: {
      async read(request: unknown) {
        if (!isObject(request) || !Array.isArray(request.targets)) return null;
        return overrides.readTargets?.(request.targets as SourceRevisionFreshnessTargetRequest[]) ?? [];
      },
    },
    ledger: { async append(input: AppendFreshnessTransitionInput | AppendSourceRevisionFreshnessTransitionInput) {
      return overrides.append?.(input) ?? ledgerResult('written');
    } },
  };
  return createSourceRevisionFreshnessTransitionCoordinator(ports as unknown as SourceRevisionFreshnessTransitionPorts);
}

function page(
  candidates: readonly SourceRevisionReviewCandidate[],
  nextCursor: SourceRevisionReviewCandidateCursor | null = null,
): { read(): Promise<SourceRevisionReviewCandidatePage> } {
  return { async read() { return { candidates, nextCursor }; } };
}

function emptyPage(): SourceRevisionReviewCandidatePage {
  return { candidates: [], nextCursor: null };
}

function makeCandidate(
  observationId: string,
  assertedState: 'current' | 'superseded' | 'retracted' | 'withdrawn',
  target: SourceRevisionReviewCandidate['target'],
  eventId = 'event-source-freshness',
): SourceRevisionReviewCandidate {
  return {
    datasetKind: 'live',
    observationId,
    assertedState: assertedState as SourceRevisionReviewCandidate['assertedState'],
    targetReportRevisionId: 'revision-target',
    assertionReportRevisionId: 'revision-assertion',
    replacementReportRevisionId: assertedState === 'superseded' ? 'revision-replacement' : null,
    publisherObservedAt: null,
    retrievedAt: NOW,
    recordedAt: NOW,
    eventId,
    eventVersion: 3,
    target,
  };
}

function makeTarget(
  target: SourceRevisionFreshnessTarget['target'],
  status: SourceRevisionFreshnessTarget['status'],
  transitionSequence: number,
  validUntil: string | null,
  eventId = 'event-source-freshness',
): SourceRevisionFreshnessTarget {
  return { eventId, eventVersion: 3, target, status, transitionSequence, validUntil };
}

function impactTarget(): SourceRevisionReviewCandidate['target'] {
  return { kind: 'impact', impactId: 'impact-source-freshness', impactVersion: 2 };
}

function cursor(observationId: string, eventId: string): SourceRevisionReviewCandidateCursor {
  return { observationId, eventId, eventVersion: 3, target: { kind: 'event_claim_set' } };
}

function sortCandidates(candidates: readonly SourceRevisionReviewCandidate[]): SourceRevisionReviewCandidate[] {
  return [...candidates].sort((left, right) => {
    const leftKey = JSON.stringify([left.observationId, left.eventId, left.eventVersion,
      left.target.kind, left.target.kind === 'impact' ? left.target.impactId : '',
      left.target.kind === 'impact' ? left.target.impactVersion : 0]);
    const rightKey = JSON.stringify([right.observationId, right.eventId, right.eventVersion,
      right.target.kind, right.target.kind === 'impact' ? right.target.impactId : '',
      right.target.kind === 'impact' ? right.target.impactVersion : 0]);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function ledgerResult(
  outcome: 'written' | 'replayed',
): FreshnessTransitionAppendResult | SourceRevisionFreshnessTransitionAppendResult {
  return { outcome, record: {} as never };
}

function zeroCounts() {
  return {
    candidates: 0, invalidatingCandidates: 0, selectedTargets: 0,
    duplicateCandidates: 0, skippedCandidates: 0, written: 0, replayed: 0, noChange: 0,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
