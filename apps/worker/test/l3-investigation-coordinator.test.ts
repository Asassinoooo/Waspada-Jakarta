import assert from 'node:assert/strict';
import test from 'node:test';
import type { GroundingContextRecord } from '../../db/src/grounding-contexts.js';
import {
  InvestigationLedgerError,
  type AdvanceReviewPendingRecord,
  type CreateInvestigationInput,
  type InvestigationCheckpointRecord,
  type InvestigationLedgerRepository,
  type InvestigationProgressOperationResult,
  type InvestigationProgressSnapshotRecord,
  type ReservationRecord,
  type RefreshGroundingProgressInput,
} from '../../db/src/investigation-ledger.js';
import type {
  GroundingContext,
  ReasoningRequest,
} from '../src/layers/l2-model-grounding/contracts.js';
import {
  INVESTIGATION_PLAN_VERSION,
  type InvestigationPlanRequest,
  type ProposedInvestigationAction,
} from '../src/layers/l2-model-grounding/investigation-planner.js';
import type { InvestigationRequiredOutcome } from '../src/layers/l2-model-grounding/direct-reasoning.js';
import {
  createInvestigationCoordinator,
} from '../src/layers/l3-investigation/coordinator.js';
import type {
  InvestigationCoordinatorOutcome,
  OpenInvestigationAdvance,
  ResumeInvestigationAdvance,
} from '../src/layers/l3-investigation/contracts.js';
import {
  createInsufficientContextEntryService,
  type InsufficientContextEntryCallerValues,
} from '../src/layers/l3-investigation/entry.js';
import { createL3FingerprintService } from '../src/layers/l3-investigation/progress-fingerprint.js';
import type { ReasoningStepExecutor } from '../src/layers/l3-investigation/reasoning-step-executor.js';
import type { SingleStepExecutor } from '../src/layers/l3-investigation/single-step-executor.js';

const BASE_TIME = '2026-09-29T12:00:00.000Z';
const PRIVATE_SOURCE_TEXT = 'coordinator-private-source-excerpt-marker';
const PRIVATE_CONFLICT = 'coordinator-private-conflict-prose-marker';
const PRIVATE_ACTION_INPUT = 'coordinator-private-action-input-marker';
const PRIVATE_MODEL_OUTPUT = 'coordinator-private-model-output-marker';
const FINGERPRINTS = createL3FingerprintService({
  keyId: 'coordinator-fixture-key-v1',
  keyMaterial: new Uint8Array(32).fill(53),
});
const CALLER_VALUES: InsufficientContextEntryCallerValues = {
  investigationId: 'investigation-coordinator-synthetic',
  requestedAt: BASE_TIME,
  policyVersion: 'coordinator-policy-v1',
  limits: { toolAttempts: 5, reasoningTurns: 4, activeSeconds: 60, modelTokens: 12_000 },
};
const ACTION_MENU = [{ name: 'synthetic_search', description: 'Search one synthetic source index.' }];

test('sufficient context bypasses entry, planner, action and refresh', async () => {
  const context = makeContext({ sufficient: true, missingFields: [], conflicts: [] });
  const harness = makeHarness();
  const result = await harness.coordinator.advance({
    kind: 'sufficient_context',
    context,
    persistedRecord: persisted(context),
  });

  assert.equal(result.status, 'sufficient_context');
  assert.equal(harness.ledger.latest, null);
  assert.equal(harness.ledger.createCalls.length, 0);
  assert.equal(harness.planningCalls.length, 0);
  assert.equal(harness.actionCalls.length, 0);
  assert.equal(harness.refreshCalls.length, 0);
  assert.deepEqual(Object.keys(harness.coordinator).sort(), ['advance']);
});

test('opens a validated handoff and performs one planner call, action, and L1/L2 refresh', async () => {
  const context = makeContext({ conflicts: [PRIVATE_CONFLICT] });
  const refreshed = makeContext({
    contextId: 'context-coordinator-refreshed',
    missingFields: ['private missing detail'],
    conflicts: [],
  });
  const harness = makeHarness({ refreshResults: [refreshed] });

  const result = await harness.coordinator.advance(openInput(context));

  assert.equal(result.status, 'continue');
  assert.equal(harness.ledger.createCalls.length, 1);
  assert.equal(harness.planningCalls.length, 1);
  assert.equal(harness.actionCalls.length, 1);
  assert.equal(harness.refreshCalls.length, 1);
  assert.deepEqual(harness.planningCalls[0]?.request.questions, ['missing_field_1', 'conflict_1']);
  assert.deepEqual(harness.actionCalls[0]?.actionName, 'synthetic_search');
  assert.deepEqual(harness.refreshCalls[0]?.outputReferenceIds, ['l1-report-reference-synthetic']);
  assert.equal(harness.refreshCalls[0]?.previousContextId, context.contextId);
  assert.equal(result.checkpoint.context_id, refreshed.contextId);
  assert.equal(harness.progressCallCount, 1);
  assert.equal(harness.refreshPersistedBeforeProgress, true);
  assert.ok(harness.events.indexOf('planner_reconciled') < harness.events.indexOf('wall_now'));
  assert.ok(harness.events.indexOf('wall_now') < harness.events.indexOf('action_invoked'));
});

test('samples an action reservation time after planner reconciliation and compares offset-equivalent instants exactly', async () => {
  const context = makeContext({ missingFields: ['private gap'], conflicts: [] });
  const plannerTime = '2026-09-29T12:03:00.123456789Z';
  const actionTime = '2026-09-29T14:03:00.123456789+02:00';
  let clockRead = 0;
  const harness = makeHarness({
    planningCheckpointUpdatedAt: plannerTime,
    wallNow: () => {
      clockRead += 1;
      return clockRead === 1 ? actionTime : '2026-09-29T14:03:01.123456789+02:00';
    },
  });

  const result = await harness.coordinator.advance(openInput(context));

  assert.equal(result.status, 'continue');
  assert.equal(Date.parse(actionTime), Date.parse(plannerTime));
  assert.equal(harness.actionCalls[0]?.reservedAt, actionTime);
  assert.ok(harness.events.indexOf('planner_reconciled') < harness.events.indexOf('wall_now'));
  assert.ok(harness.events.indexOf('wall_now') < harness.events.indexOf('action_invoked'));
});

test('canonicalizes a lowercase RFC3339 wall clock before passing it to the action executor', async () => {
  const context = makeContext({ missingFields: ['private gap'], conflicts: [] });
  const harness = makeHarness({
    planningCheckpointUpdatedAt: '2026-09-29T12:03:00.123456789Z',
    wallNow: () => '2026-09-29t12:03:00.123456789z',
  });

  const result = await harness.coordinator.advance(openInput(context));

  assert.equal(result.status, 'continue');
  assert.equal(harness.actionCalls[0]?.reservedAt, '2026-09-29T12:03:00.123456789Z');
});

test('preserves previously accepted long reasoning reservation timestamps', async () => {
  const context = makeContext({ missingFields: ['private gap'], conflicts: [] });
  const reasoningReservedAt = '2026-09-29T12:00:10.123456789012345678901234567890Z';
  assert.ok(reasoningReservedAt.length > 40);
  assert.ok(Number.isFinite(Date.parse(reasoningReservedAt)));
  const harness = makeHarness();

  const result = await harness.coordinator.advance({
    ...openInput(context),
    reasoningReservedAt,
  });

  assert.equal(result.status, 'continue');
  assert.equal(harness.planningCalls.length, 1);
  assert.equal(harness.planningCalls[0]?.reservedAt, reasoningReservedAt);
  assert.equal(harness.actionCalls.length, 1);
});

test('invalid, throwing, impossible-date, and earlier action clocks latch the reconciled planner stage', async (t) => {
  const plannerTime = '2026-09-29T12:03:00.123456789Z';
  const cases: Array<{ readonly name: string; readonly plannerTime?: string; readonly wallNow: () => string }> = [
    { name: 'malformed timestamp', wallNow: () => 'not-rfc3339' },
    { name: 'trailing newline', wallNow: () => `${plannerTime}\n` },
    { name: 'fraction exceeds the bounded nine-digit profile', wallNow: () => '2026-09-29T12:03:00.1234567890Z' },
    { name: 'throwing clock', wallNow: () => { throw new Error('private clock failure'); } },
    { name: 'impossible calendar date', wallNow: () => '2026-02-30T12:03:00.123456789Z' },
    { name: 'backward by one fractional digit', wallNow: () => '2026-09-29T12:03:00.123456788Z' },
    {
      name: 'later local time whose offset makes its instant earlier',
      plannerTime,
      wallNow: () => '2026-09-29T14:02:59.123456789+02:00',
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const checkpointTime = item.plannerTime ?? plannerTime;
      const context = makeContext({ missingFields: ['private gap'], conflicts: [] });
      const harness = makeHarness({ planningCheckpointUpdatedAt: checkpointTime, wallNow: item.wallNow });
      const result = await harness.coordinator.advance(openInput(context));

      assert.equal(result.status, 'review_required');
      if (result.status !== 'review_required') assert.fail('expected a closed review result');
      assert.equal(result.reason, 'advance_review_pending');
      assert.equal(result.checkpoint, harness.ledger.latest);
      assert.equal(result.checkpoint?.checkpoint_version, 3);
      assert.equal(result.checkpoint?.updated_at, checkpointTime);
      assert.equal(result.checkpoint?.case_status, 'open');
      assert.equal(harness.ledger.marker?.stage, 'planning');
      assert.equal(harness.ledger.marker?.reason, 'invalid_action_timestamp');
      assert.equal(harness.wallNowCalls, 1);
      assert.equal(harness.actionCalls.length, 0);
      assert.equal(harness.refreshCalls.length, 0);
    });
  }
});

test('does not sample action time for malformed planner timestamps or proposals', async (t) => {
  await t.test('impossible planner checkpoint timestamp', async () => {
    const context = makeContext({ missingFields: ['private gap'], conflicts: [] });
    const plannerTime = '2026-02-30T12:03:00.000Z';
    const harness = makeHarness({ planningCheckpointUpdatedAt: plannerTime });
    const result = await harness.coordinator.advance(openInput(context));

    assert.equal(result.status, 'review_required');
    if (result.status !== 'review_required') assert.fail('expected a closed review result');
    assert.equal(result.reason, 'advance_review_pending');
    assert.equal(result.checkpoint, harness.ledger.latest);
    assert.equal(result.checkpoint?.updated_at, plannerTime);
    assert.equal(result.checkpoint?.case_status, 'open');
    assert.equal(harness.ledger.marker?.stage, 'planning');
    assert.equal(harness.ledger.marker?.reason, 'planner_result_uncertain');
    assert.equal(harness.wallNowCalls, 0);
    assert.equal(harness.actionCalls.length, 0);
    assert.equal(harness.refreshCalls.length, 0);
  });

  await t.test('malformed proposal', async () => {
    const context = makeContext({ missingFields: ['private gap'], conflicts: [] });
    const harness = makeHarness({ planningMode: 'malformed_proposal' });
    const result = await harness.coordinator.advance(openInput(context));

    assert.equal(result.status, 'review_required');
    if (result.status !== 'review_required') assert.fail('expected a closed review result');
    assert.equal(result.reason, 'advance_review_pending');
    assert.equal(result.checkpoint, harness.ledger.latest);
    assert.equal(result.checkpoint?.case_status, 'open');
    assert.equal(harness.ledger.marker?.stage, 'planning');
    assert.equal(harness.ledger.marker?.reason, 'planner_result_uncertain');
    assert.equal(harness.wallNowCalls, 0);
    assert.equal(harness.actionCalls.length, 0);
    assert.equal(harness.refreshCalls.length, 0);
  });

  await t.test('malformed planner checkpoint after durable reconciliation', async () => {
    const context = makeContext({ missingFields: ['private gap'], conflicts: [] });
    const harness = makeHarness({ planningMode: 'malformed_checkpoint' });
    const result = await harness.coordinator.advance(openInput(context));

    assert.equal(result.status, 'review_required');
    if (result.status !== 'review_required') assert.fail('expected a closed review result');
    assert.equal(result.reason, 'advance_review_pending');
    assert.equal(result.checkpoint, harness.ledger.latest);
    assert.equal(result.checkpoint?.checkpoint_version, 3);
    assert.equal(result.checkpoint?.case_status, 'open');
    assert.equal(harness.ledger.marker?.stage, 'planning');
    assert.equal(harness.ledger.marker?.reason, 'planner_result_uncertain');
    assert.equal(harness.actionCalls.length, 0);
    assert.equal(harness.refreshCalls.length, 0);
  });

  for (const mode of ['wrong_checkpoint_status', 'wrong_checkpoint_version'] as const) {
    await t.test(`valid but unexpected planner checkpoint ${mode}`, async () => {
      const context = makeContext({ missingFields: ['private gap'], conflicts: [] });
      const harness = makeHarness({ planningMode: mode });
      const result = await harness.coordinator.advance(openInput(context));

      assert.equal(result.status, 'review_required');
      if (result.status !== 'review_required') assert.fail('expected a closed review result');
      assert.equal(result.reason, 'advance_review_pending');
      assert.equal(result.checkpoint, harness.ledger.latest);
      assert.equal(result.checkpoint?.checkpoint_version, 3);
      assert.equal(result.checkpoint?.case_status, 'open');
      assert.equal(harness.ledger.marker?.stage, 'planning');
      assert.equal(harness.ledger.marker?.reason, 'planner_result_uncertain');
      assert.equal(harness.actionCalls.length, 0);
      assert.equal(harness.refreshCalls.length, 0);
    });
  }

  await t.test('a failed reservation lookup still attempts the locked marker insert', async () => {
    const context = makeContext({ missingFields: ['private gap'], conflicts: [] });
    const harness = makeHarness({ planningMode: 'malformed_proposal', reservationLookupMode: 'throws' });
    const result = await harness.coordinator.advance(openInput(context));

    assert.equal(result.status, 'review_required');
    if (result.status !== 'review_required') assert.fail('expected a closed review result');
    assert.equal(result.reason, 'advance_review_pending');
    assert.equal(harness.ledger.marker?.stage, 'planning');
    assert.equal(harness.ledger.marker?.reason, 'planner_result_uncertain');
    assert.equal(harness.actionCalls.length, 0);
    assert.equal(harness.refreshCalls.length, 0);
  });

  await t.test('a failed reservation lookup and failed marker insert stay ledger-uncertain', async () => {
    const context = makeContext({ missingFields: ['private gap'], conflicts: [] });
    const harness = makeHarness({
      planningMode: 'malformed_proposal',
      reservationLookupMode: 'throws',
      markerWriteFails: true,
    });
    const result = await harness.coordinator.advance(openInput(context));

    assert.equal(result.status, 'review_required');
    if (result.status !== 'review_required') assert.fail('expected a closed review result');
    assert.equal(result.reason, 'ledger_uncertain');
    assert.equal(harness.ledger.marker, null);
    assert.equal(harness.actionCalls.length, 0);
    assert.equal(harness.refreshCalls.length, 0);
  });
});

test('returns the sufficient refreshed context for caller-owned L2 synthesis', async () => {
  const context = makeContext({ missingFields: ['private gap'], conflicts: [] });
  const refreshed = makeContext({
    contextId: 'context-coordinator-sufficient',
    sufficient: true,
    missingFields: [],
    conflicts: [],
  });
  const harness = makeHarness({ refreshResults: [refreshed] });

  const result = await harness.coordinator.advance(openInput(context));

  assert.equal(result.status, 'sufficient_context');
  assert.equal(result.context.contextId, refreshed.contextId);
  assert.equal(result.persistedRecord.context_id, refreshed.contextId);
  assert.equal(harness.planningCalls.length, 1);
  assert.equal(harness.actionCalls.length, 1);
  assert.equal(harness.refreshCalls.length, 1);
});

test('uses refreshed question counts on a later checkpointed invocation', async () => {
  const context = makeContext({ missingFields: ['private gap'], conflicts: [] });
  const refreshed = makeContext({
    contextId: 'context-coordinator-two-gaps',
    missingFields: ['private gap one', 'private gap two'],
    conflicts: [],
  });
  const later = makeContext({
    contextId: 'context-coordinator-three-gaps',
    missingFields: ['private gap one', 'private gap two', 'private gap three'],
    conflicts: [],
  });
  const harness = makeHarness({ refreshResults: [refreshed, later] });

  const first = await harness.coordinator.advance(openInput(context));
  assert.equal(first.status, 'continue');
  const second = await harness.coordinator.advance(resumeInput(first, 'next'));

  assert.equal(second.status, 'continue');
  assert.deepEqual(harness.planningCalls[1]?.request.questions, ['missing_field_1', 'missing_field_2']);
  assert.equal(harness.planningCalls.length, 2);
  assert.equal(harness.actionCalls.length, 2);
  assert.equal(harness.refreshCalls.length, 2);
});

test('allows one unchanged progress snapshot and stops on the second', async () => {
  const context = makeContext({ missingFields: ['private gap'], conflicts: [] });
  const harness = makeHarness({ refreshResults: [context, context] });

  const first = await harness.coordinator.advance(openInput(context));
  assert.equal(first.status, 'continue');
  const second = await harness.coordinator.advance(resumeInput(first, 'unchanged'));

  assert.equal(second.status, 'review_required');
  assert.equal(second.reason, 'no_progress');
  assert.equal(second.checkpoint?.case_status, 'stopped_for_review');
  assert.equal(second.checkpoint?.stop_reason, 'no_progress');
  assert.equal(harness.progressSnapshots[1]?.consecutiveNoProgress, 1);
  assert.equal(harness.progressSnapshots[2]?.consecutiveNoProgress, 2);
});

test('duplicate action stops before refresh and records only the fixed review state', async () => {
  const context = makeContext({ missingFields: ['private gap'], conflicts: [] });
  const harness = makeHarness({ actionMode: 'duplicate' });

  const result = await harness.coordinator.advance(openInput(context));

  assert.equal(result.status, 'review_required');
  assert.equal(result.reason, 'duplicate_action');
  assert.equal(harness.planningCalls.length, 1);
  assert.equal(harness.actionCalls.length, 1);
  assert.equal(harness.refreshCalls.length, 0);
  assert.equal(harness.ledger.latest?.case_status, 'stopped_for_review');
  assert.equal(harness.ledger.latest?.stop_reason, 'awaiting_moderator');
  assert.equal(harness.ledger.latest?.budget.consumed.tool_attempts, 0);
});

test('planner abstention and exhausted durable budget stop without action or refresh', async (t) => {
  await t.test('abstention', async () => {
    const context = makeContext({ missingFields: ['private gap'], conflicts: [] });
    const harness = makeHarness({ planningMode: 'abstained' });
    const result = await harness.coordinator.advance(openInput(context));
    assert.equal(result.status, 'review_required');
    assert.equal(result.reason, 'planner_abstained');
    assert.equal(result.checkpoint?.stop_reason, 'awaiting_moderator');
    assert.equal(harness.actionCalls.length, 0);
    assert.equal(harness.refreshCalls.length, 0);
  });
  await t.test('budget exhaustion', async () => {
    const context = makeContext({ missingFields: ['private gap'], conflicts: [] });
    const harness = makeHarness({ planningMode: 'budget_exhausted' });
    const result = await harness.coordinator.advance(openInput(context));
    assert.equal(result.status, 'review_required');
    assert.equal(result.reason, 'budget_exhausted');
    assert.equal(result.checkpoint?.stop_reason, 'limit_exhausted');
    assert.equal(harness.actionCalls.length, 0);
    assert.equal(harness.refreshCalls.length, 0);
  });
});

test('planner rejection, failure, and replay do not sample an action reservation time', async (t) => {
  const cases: Array<{
    readonly name: string;
    readonly mode: 'abstained' | 'budget_exhausted' | 'failed' | 'replayed';
    readonly expectedWallNowCalls: number;
    readonly resultEvent: string;
  }> = [
    { name: 'abstained', mode: 'abstained', expectedWallNowCalls: 0, resultEvent: 'planner_result_rejected' },
    { name: 'budget rejected', mode: 'budget_exhausted', expectedWallNowCalls: 1, resultEvent: 'planner_result_rejected' },
    { name: 'failed', mode: 'failed', expectedWallNowCalls: 1, resultEvent: 'planner_result_rejected' },
    { name: 'replayed', mode: 'replayed', expectedWallNowCalls: 0, resultEvent: 'planner_result_replayed' },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const context = makeContext({ missingFields: ['private gap'], conflicts: [] });
      const harness = makeHarness({ planningMode: item.mode });
      const result = await harness.coordinator.advance(openInput(context));

      assert.equal(result.status, 'review_required');
      assert.equal(harness.events.indexOf(item.resultEvent) >= 0, true);
      assert.equal(harness.wallNowCalls, item.expectedWallNowCalls);
      if (item.expectedWallNowCalls > 0) {
        // This wall clock read belongs to the existing durable stop transition.
        assert.ok(harness.events.indexOf(item.resultEvent) < harness.events.indexOf('wall_now'));
        assert.equal(result.checkpoint?.case_status, 'stopped_for_review');
        assert.equal(result.checkpoint?.updated_at, '2026-09-29T12:10:00.000Z');
      }
      if (item.mode === 'replayed') {
        assert.equal(result.reason, 'advance_review_pending');
        assert.equal(result.checkpoint?.case_status, 'open');
        assert.equal(harness.ledger.marker?.stage, 'planning');
      }
      assert.equal(harness.actionCalls.length, 0);
      assert.equal(harness.refreshCalls.length, 0);
    });
  }
});

test('a replayed planner reservation latches before action or refresh', async () => {
  const context = makeContext({ missingFields: ['private gap'], conflicts: [] });
  const harness = makeHarness({ planningMode: 'replayed' });

  const result = await harness.coordinator.advance(openInput(context));

  assert.equal(result.status, 'review_required');
  assert.equal(result.reason, 'advance_review_pending');
  assert.equal(result.checkpoint?.case_status, 'open');
  assert.equal(result.checkpoint?.stop_reason, null);
  assert.equal(harness.ledger.marker?.reason, 'planner_replayed');
  assert.equal(harness.planningCalls.length, 1);
  assert.equal(harness.actionCalls.length, 0);
  assert.equal(harness.refreshCalls.length, 0);
});

test('maps a marker-denied action start to pending and leaves the open case untouched', async () => {
  const context = makeContext({ missingFields: ['private gap'], conflicts: [] });
  const harness = makeHarness({ actionMode: 'marker_denied' });

  const result = await harness.coordinator.advance(openInput(context));

  assert.equal(result.status, 'review_required');
  assert.equal(result.reason, 'advance_review_pending');
  assert.equal(result.checkpoint?.case_status, 'open');
  assert.equal(result.checkpoint?.stop_reason, null);
  assert.equal(result.checkpoint?.checkpoint_version, 3,
    'the already-reconciled planner checkpoint remains the latest adopted checkpoint');
  assert.equal(harness.actionCalls.length, 1);
  assert.equal(harness.refreshCalls.length, 0);
  assert.equal(harness.progressCallCount, 0);
  assert.equal(harness.ledger.reservations.get(harness.actionCalls[0]!.reservationId)?.status, 'reserved');
  assert.ok(harness.ledger.marker);
});

test('maps a marker-denied progress write to pending without adopting further progress', async () => {
  const context = makeContext({ missingFields: ['private gap'], conflicts: [] });
  const harness = makeHarness({ progressMode: 'marker_denied' });

  const result = await harness.coordinator.advance(openInput(context));

  assert.equal(result.status, 'review_required');
  assert.equal(result.reason, 'advance_review_pending');
  assert.equal(result.checkpoint?.case_status, 'open');
  assert.equal(result.checkpoint?.stop_reason, null);
  assert.equal(result.checkpoint?.checkpoint_version, 5,
    'the reconciled action checkpoint remains the latest progress checkpoint');
  assert.equal(harness.refreshCalls.length, 1);
  assert.equal(harness.progressCallCount, 0);
  assert.equal(harness.ledger.marker?.stage, 'progress');
});

test('checks a sticky marker before open replay, stale resume, and case-bound sufficient-context returns', async () => {
  const context = makeContext({ missingFields: ['private gap'], conflicts: [] });
  const harness = makeHarness();
  const initialOpen = openInput(context);
  const first = await harness.coordinator.advance(initialOpen);
  assert.equal(first.status, 'continue');
  if (first.status !== 'continue') assert.fail('expected a checkpointed continuation');

  harness.ledger.marker = {
    datasetKind: first.checkpoint.dataset_kind,
    investigationId: first.checkpoint.investigation_id,
    observedCheckpointVersion: first.checkpoint.checkpoint_version,
    stage: 'progress',
    reason: 'progress_uncertain',
    reservationId: initialOpen.actionReservationId,
    markedAt: BASE_TIME,
  };
  const planningCallsBefore = harness.planningCalls.length;
  const actionCallsBefore = harness.actionCalls.length;
  const createsBefore = harness.ledger.createCalls.length;

  const openReplay = await harness.coordinator.advance(initialOpen);
  assert.equal(openReplay.status, 'review_required');
  assert.equal(openReplay.reason, 'advance_review_pending');

  const stale = { ...first.checkpoint, checkpoint_version: first.checkpoint.checkpoint_version - 1 };
  const resume = await harness.coordinator.advance({
    ...resumeInput(first, 'pending-marker'),
    checkpoint: stale,
  });
  assert.equal(resume.status, 'review_required');
  assert.equal(resume.reason, 'advance_review_pending');

  const sufficient = makeContext({ ...first.context, sufficient: true, missingFields: [], conflicts: [] });
  const sufficientResult = await harness.coordinator.advance({
    kind: 'sufficient_context',
    context: sufficient,
    persistedRecord: persisted(sufficient),
    investigationId: first.checkpoint.investigation_id,
  });
  assert.equal(sufficientResult.status, 'review_required');
  assert.equal(sufficientResult.reason, 'advance_review_pending');
  assert.equal(harness.planningCalls.length, planningCallsBefore);
  assert.equal(harness.actionCalls.length, actionCallsBefore);
  assert.equal(harness.ledger.createCalls.length, createsBefore,
    'the open replay is held before idempotent entry is invoked');
});

test('latches failures while preparing progress after the action and refresh are durable', async (t) => {
  await t.test('missing fingerprint key', async () => {
    const context = makeContext({ missingFields: ['private gap'], conflicts: [] });
    const harness = makeHarness({ progressMode: 'missing_fingerprint_key' });
    const result = await harness.coordinator.advance(openInput(context));

    assert.equal(result.status, 'review_required');
    assert.equal(result.reason, 'advance_review_pending');
    assert.equal(result.checkpoint?.case_status, 'open');
    assert.equal(result.checkpoint?.checkpoint_version, 5);
    assert.equal(harness.refreshCalls.length, 1);
    assert.equal(harness.progressCallCount, 0);
    assert.equal(harness.ledger.marker?.stage, 'progress');
    assert.equal(harness.ledger.marker?.reason, 'progress_uncertain');
  });

  await t.test('invalid progress timestamp', async () => {
    const context = makeContext({ missingFields: ['private gap'], conflicts: [] });
    let wallRead = 0;
    const harness = makeHarness({
      wallNow: () => {
        wallRead += 1;
        return wallRead === 1 ? '2026-09-29T12:04:00Z' : 'not-rfc3339';
      },
    });
    const result = await harness.coordinator.advance(openInput(context));

    assert.equal(result.status, 'review_required');
    assert.equal(result.reason, 'advance_review_pending');
    assert.equal(result.checkpoint?.case_status, 'open');
    assert.equal(result.checkpoint?.checkpoint_version, 5);
    assert.equal(harness.refreshCalls.length, 1);
    assert.equal(harness.progressCallCount, 0);
    assert.equal(harness.ledger.marker?.stage, 'progress');
    assert.equal(harness.ledger.marker?.reason, 'progress_uncertain');
  });

  await t.test('timestamp precedes the reconciled action checkpoint', async () => {
    const context = makeContext({ missingFields: ['private gap'], conflicts: [] });
    let wallRead = 0;
    const harness = makeHarness({
      wallNow: () => {
        wallRead += 1;
        return wallRead === 1 ? '2026-09-29T12:04:00Z' : '2026-09-29T12:03:59Z';
      },
    });
    const result = await harness.coordinator.advance(openInput(context));

    assert.equal(result.status, 'review_required');
    assert.equal(result.reason, 'advance_review_pending');
    assert.equal(result.checkpoint?.case_status, 'open');
    assert.equal(result.checkpoint?.checkpoint_version, 5);
    assert.equal(harness.refreshCalls.length, 1);
    assert.equal(harness.progressCallCount, 0);
    assert.equal(harness.ledger.marker?.stage, 'progress');
    assert.equal(harness.ledger.marker?.reason, 'progress_uncertain');
  });
});

test('latches malformed progress results and write acknowledgements that may follow a commit', async (t) => {
  for (const mode of [
    'null_progress_result', 'malformed_progress_result', 'missing_progress_snapshot',
    'malformed_progress_snapshot', 'uncertain_progress_write', 'progress_conflict',
    'context_not_found', 'context_mismatch',
  ] as const) {
    await t.test(mode, async () => {
      const context = makeContext({ missingFields: ['private gap'], conflicts: [] });
      const harness = makeHarness({ progressMode: mode });
      const result = await harness.coordinator.advance(openInput(context));

      assert.equal(result.status, 'review_required');
      assert.equal(result.reason, 'advance_review_pending');
      assert.equal(result.checkpoint?.case_status, 'open');
      assert.equal(result.checkpoint?.stop_reason, null);
      assert.equal(harness.refreshCalls.length, 1);
      assert.equal(harness.ledger.marker?.stage, 'progress');
      assert.equal(harness.ledger.marker?.reason, 'progress_uncertain');
      assert.equal(harness.ledger.marker?.reservationId, harness.actionCalls[0]?.reservationId);
      if (mode === 'uncertain_progress_write') {
        assert.equal(harness.ledger.latest?.checkpoint_version, 6,
          'the fake models a committed progress write whose acknowledgement was lost');
        assert.equal(result.checkpoint?.checkpoint_version, 6,
          'the review result reports the latest checkpoint after the lost acknowledgement');
      } else {
        assert.equal(harness.ledger.latest?.checkpoint_version, 5);
        assert.equal(result.checkpoint?.checkpoint_version, 5);
      }
    });
  }
});

test('does not latch only known concurrent or terminal progress denials', async (t) => {
  for (const mode of ['reservation_in_flight', 'stale_checkpoint'] as const) {
    await t.test(mode, async () => {
      const context = makeContext({ missingFields: ['private gap'], conflicts: [] });
      const harness = makeHarness({ progressMode: mode });
      const result = await harness.coordinator.advance(openInput(context));

      assert.equal(result.status, 'review_required');
      if (result.status !== 'review_required') assert.fail('expected a closed review result');
      assert.equal(result.reason, 'ledger_uncertain');
      assert.equal(result.checkpoint?.case_status, 'open');
      assert.equal(harness.ledger.marker, null);
      assert.equal(harness.refreshCalls.length, 1);
    });
  }
});

test('a reconciled timeout gets one L1/L2 refresh then escalates', async () => {
  const context = makeContext({ missingFields: ['private gap'], conflicts: [] });
  const refreshed = makeContext({ contextId: 'context-coordinator-after-timeout', conflicts: [] });
  const harness = makeHarness({ actionMode: 'timed_out', refreshResults: [refreshed] });

  const result = await harness.coordinator.advance(openInput(context));

  assert.equal(result.status, 'review_required');
  assert.equal(result.reason, 'action_timed_out');
  assert.equal(harness.actionCalls.length, 1);
  assert.equal(harness.refreshCalls.length, 1);
  assert.equal(result.checkpoint?.stop_reason, 'tool_unavailable');
});

test('uncertain action results and invalid or stale case identities cannot reach refresh', async (t) => {
  await t.test('uncertain action result', async () => {
    const context = makeContext({ missingFields: ['private gap'], conflicts: [] });
    const harness = makeHarness({ actionMode: 'uncertain' });
    const result = await harness.coordinator.advance(openInput(context));
    assert.equal(result.status, 'review_required');
    assert.equal(result.reason, 'advance_review_pending');
    assert.equal(result.checkpoint?.case_status, 'open');
    assert.equal(harness.ledger.marker?.stage, 'action');
    assert.equal(harness.refreshCalls.length, 0);
  });
  await t.test('reservation in flight alone is not a review-pending trigger', async () => {
    const context = makeContext({ missingFields: ['private gap'], conflicts: [] });
    const harness = makeHarness({ actionMode: 'reservation_in_flight' });
    const result = await harness.coordinator.advance(openInput(context));
    assert.equal(result.status, 'review_required');
    assert.equal(result.reason, 'action_uncertain');
    assert.equal(result.checkpoint?.case_status, 'open');
    assert.equal(harness.ledger.marker, null);
    assert.equal(harness.refreshCalls.length, 0);
  });
  await t.test('unexpected action status after exact action reconciliation latches', async () => {
    const context = makeContext({ missingFields: ['private gap'], conflicts: [] });
    const harness = makeHarness({ actionMode: 'unexpected_result' });
    const result = await harness.coordinator.advance(openInput(context));

    assert.equal(result.status, 'review_required');
    if (result.status !== 'review_required') assert.fail('expected a closed review result');
    assert.equal(result.reason, 'advance_review_pending');
    assert.equal(result.checkpoint, harness.ledger.latest);
    assert.equal(result.checkpoint?.checkpoint_version, 5);
    assert.equal(harness.ledger.marker?.stage, 'action');
    assert.equal(harness.ledger.marker?.reason, 'invalid_action_result');
    assert.equal(harness.refreshCalls.length, 0);
  });
  await t.test('malformed executed receipt after exact action reconciliation latches', async () => {
    const context = makeContext({ missingFields: ['private gap'], conflicts: [] });
    const harness = makeHarness({ actionMode: 'malformed_receipt' });
    const result = await harness.coordinator.advance(openInput(context));

    assert.equal(result.status, 'review_required');
    if (result.status !== 'review_required') assert.fail('expected a closed review result');
    assert.equal(result.reason, 'advance_review_pending');
    assert.equal(result.checkpoint, harness.ledger.latest);
    assert.equal(result.checkpoint?.checkpoint_version, 5);
    assert.equal(harness.ledger.marker?.stage, 'action');
    assert.equal(harness.ledger.marker?.reason, 'invalid_action_result');
    assert.equal(harness.refreshCalls.length, 0);
  });
  await t.test('cross-case context', async () => {
    const context = makeContext({ missingFields: ['private gap'], conflicts: [] });
    const harness = makeHarness({ refreshResults: [context] });
    const first = await harness.coordinator.advance(openInput(context));
    assert.equal(first.status, 'continue');
    const wrongContext = makeContext({ candidateId: 'candidate-other-case', missingFields: ['private gap'], conflicts: [] });
    const result = await harness.coordinator.advance({
      ...resumeInput(first, 'cross-case'),
      context: wrongContext,
      persistedRecord: persisted(wrongContext),
    });
    assert.equal(result.status, 'review_required');
    assert.equal(result.reason, 'context_identity_mismatch');
    assert.equal(harness.planningCalls.length, 1);
    assert.equal(harness.refreshCalls.length, 1);
  });
  await t.test('same-case sufficient context must match the checkpoint context ID', async () => {
    const context = makeContext({ missingFields: ['private gap'], conflicts: [] });
    const harness = makeHarness();
    const first = await harness.coordinator.advance(openInput(context));
    assert.equal(first.status, 'continue');
    if (first.status !== 'continue') assert.fail('expected a checkpointed continuation');
    const substitute = makeContext({
      ...first.context,
      contextId: 'context-coordinator-sufficient-substitute',
      sufficient: true,
    });

    const result = await harness.coordinator.advance({
      ...resumeInput(first, 'sufficient-substitute'),
      context: substitute,
      persistedRecord: persisted(substitute),
    });

    assert.equal(result.status, 'review_required');
    assert.equal(result.reason, 'context_identity_mismatch');
    assert.equal(result.checkpoint?.context_id, first.checkpoint.context_id);
    assert.equal(harness.planningCalls.length, 1);
    assert.equal(harness.actionCalls.length, 1);
    assert.equal(harness.refreshCalls.length, 1);
  });
  await t.test('stale checkpoint', async () => {
    const context = makeContext({ missingFields: ['private gap'], conflicts: [] });
    const harness = makeHarness({ refreshResults: [context] });
    const first = await harness.coordinator.advance(openInput(context));
    assert.equal(first.status, 'continue');
    if (first.status !== 'continue') assert.fail('expected continuation');
    const stale = { ...first.checkpoint, checkpoint_version: first.checkpoint.checkpoint_version - 1 };
    const result = await harness.coordinator.advance({ ...resumeInput(first, 'stale'), checkpoint: stale });
    assert.equal(result.status, 'review_required');
    assert.equal(result.reason, 'stale_checkpoint');
    assert.equal(harness.planningCalls.length, 1);
  });
});

test('latches refresh failures and invalid results; a racing marker prevents adoption', async (t) => {
  await t.test('refresh throws after the action is reconciled', async () => {
    const context = makeContext({ missingFields: ['private gap'], conflicts: [] });
    const harness = makeHarness({ refreshMode: 'throws' });
    const result = await harness.coordinator.advance(openInput(context));

    assert.equal(result.status, 'review_required');
    if (result.status !== 'review_required') assert.fail('expected a closed review result');
    assert.equal(result.reason, 'advance_review_pending');
    assert.equal(harness.ledger.marker?.stage, 'refresh');
    assert.equal(harness.ledger.marker?.reason, 'refresh_failed');
    assert.equal(harness.progressCallCount, 0);
  });

  await t.test('invalid refreshed context after refresh latches', async () => {
    const context = makeContext({ missingFields: ['private gap'], conflicts: [] });
    const wrongCase = makeContext({ candidateId: 'candidate-invalid-refresh', missingFields: ['private gap'], conflicts: [] });
    const harness = makeHarness({ refreshResults: [wrongCase] });
    const result = await harness.coordinator.advance(openInput(context));

    assert.equal(result.status, 'review_required');
    if (result.status !== 'review_required') assert.fail('expected a closed review result');
    assert.equal(result.reason, 'advance_review_pending');
    assert.equal(harness.ledger.marker?.stage, 'refresh');
    assert.equal(harness.ledger.marker?.reason, 'invalid_refreshed_context');
    assert.equal(harness.progressCallCount, 0);
  });

  await t.test('marker committed during refresh leaves its persisted context unadopted', async () => {
    const context = makeContext({ missingFields: ['private gap'], conflicts: [] });
    const refreshed = makeContext({ contextId: 'context-persisted-under-race', conflicts: [] });
    const harness = makeHarness({ refreshResults: [refreshed], refreshMode: 'marker_during_refresh' });
    const result = await harness.coordinator.advance(openInput(context));

    assert.equal(result.status, 'review_required');
    if (result.status !== 'review_required') assert.fail('expected a closed review result');
    assert.equal(result.reason, 'advance_review_pending');
    assert.equal(result.checkpoint, harness.ledger.latest);
    assert.equal(harness.ledger.latest?.context_id, context.contextId);
    assert.equal(harness.ledger.persistedContexts.has(refreshed.contextId), true,
      'the refresh may persist an L2 context before observing the marker');
    assert.equal(harness.ledger.marker?.stage, 'refresh');
    assert.equal(harness.progressCallCount, 0);
  });
});

test('replaying an outer open request after the planner advanced cannot call either executor again', async () => {
  const context = makeContext({ missingFields: ['private gap'], conflicts: [] });
  const harness = makeHarness({ actionMode: 'replayed' });
  const input = openInput(context);

  const first = await harness.coordinator.advance(input);
  assert.equal(first.status, 'review_required');
  assert.equal(first.reason, 'advance_review_pending');
  assert.equal(first.checkpoint?.case_status, 'open');
  assert.equal(first.checkpoint?.stop_reason, null);
  assert.equal(harness.ledger.marker?.reason, 'action_replayed');
  const retry = await harness.coordinator.advance(input);

  assert.equal(retry.status, 'review_required');
  assert.equal(retry.reason, 'advance_review_pending');
  assert.equal(harness.planningCalls.length, 1);
  assert.equal(harness.actionCalls.length, 1);
  assert.equal(harness.actionCalls[0]?.reservationId, input.actionReservationId);
  assert.equal(harness.actionCalls[0]?.reservedAt, '2026-09-29T12:10:00.000Z');
  assert.equal(harness.refreshCalls.length, 0);
});

test('material disputes are durable review outcomes and operational storage excludes private data', async () => {
  const context = makeContext({ missingFields: ['private gap'], conflicts: [] });
  const disputed = makeContext({
    contextId: 'context-coordinator-disputed',
    missingFields: ['private gap'],
    conflicts: [PRIVATE_CONFLICT],
  });
  const harness = makeHarness({ refreshResults: [disputed] });

  const result = await harness.coordinator.advance(openInput(context));

  assert.equal(result.status, 'review_required');
  assert.equal(result.reason, 'material_dispute');
  assert.equal(result.checkpoint?.stop_reason, 'material_conflict');
  const durable = JSON.stringify({
    createInputs: harness.ledger.createCalls,
    checkpoints: harness.ledger.latest,
    progress: harness.progressSnapshots,
  });
  assert.equal(durable.includes(PRIVATE_SOURCE_TEXT), false);
  assert.equal(durable.includes(PRIVATE_CONFLICT), false);
  assert.equal(durable.includes(PRIVATE_ACTION_INPUT), false);
  assert.equal(durable.includes(PRIVATE_MODEL_OUTPUT), false);
});

function makeHarness(input: {
  readonly refreshResults?: readonly GroundingContext[];
  readonly actionMode?: 'success' | 'duplicate' | 'timed_out' | 'uncertain' | 'replayed' | 'marker_denied'
    | 'reservation_in_flight' | 'unexpected_result' | 'malformed_receipt';
  readonly planningMode?: 'proposed' | 'abstained' | 'budget_exhausted' | 'failed' | 'malformed_proposal'
    | 'malformed_checkpoint' | 'wrong_checkpoint_status' | 'wrong_checkpoint_version' | 'replayed';
  readonly progressMode?: 'marker_denied' | 'missing_fingerprint_key' | 'null_progress_result'
    | 'malformed_progress_result' | 'missing_progress_snapshot' | 'malformed_progress_snapshot'
    | 'uncertain_progress_write' | 'progress_conflict' | 'context_not_found' | 'context_mismatch'
    | 'reservation_in_flight' | 'stale_checkpoint';
  readonly refreshMode?: 'throws' | 'marker_during_refresh';
  readonly reservationLookupMode?: 'normal' | 'throws';
  readonly markerWriteFails?: boolean;
  readonly planningCheckpointUpdatedAt?: string;
  readonly wallNow?: () => string;
} = {}) {
  const ledger = new MemoryLedger(input.progressMode, input.reservationLookupMode, input.markerWriteFails);
  const entry = createInsufficientContextEntryService(ledger.repository, FINGERPRINTS);
  const events: string[] = [];
  const planningCalls: Array<{
    readonly request: InvestigationPlanRequest;
    readonly reservationId: string;
    readonly reservedAt: string;
  }> = [];
  const actionCalls: Array<{
    readonly actionName: string;
    readonly input: unknown;
    readonly reservationId: string;
    readonly reservedAt: string;
  }> = [];
  // Keep a simple, readable record of refresh arguments without retaining report content.
  const refreshInputs: Array<{
    readonly previousContextId: string;
    readonly outputReferenceIds: readonly string[];
  }> = [];
  const refreshResults = [...(input.refreshResults ?? [makeContext({
    contextId: 'context-coordinator-refreshed-default',
    missingFields: ['private gap'],
    conflicts: [],
  })])];
  let wallTick = 0;
  let wallNowCalls = 0;

  const reasoningStep: ReasoningStepExecutor = {
    async plan(rawProposal) {
      const proposal = rawProposal as {
        readonly datasetKind: 'synthetic';
        readonly investigationId: string;
        readonly expectedCheckpointVersion: number;
        readonly reservationId: string;
        readonly reservedAt: string;
        readonly request: InvestigationPlanRequest;
      };
      planningCalls.push({
        request: proposal.request,
        reservationId: proposal.reservationId,
        reservedAt: proposal.reservedAt,
      });
      if (input.planningMode === 'abstained') {
        const checkpoint = ledger.stopDirectly('awaiting_moderator');
        events.push('planner_result_rejected');
        return { status: 'review_required', reason: 'planner_abstained', checkpoint };
      }
      if (input.planningMode === 'budget_exhausted') {
        events.push('planner_result_rejected');
        return { status: 'review_required', reason: 'budget_exhausted', checkpoint: ledger.latest! };
      }
      const current = ledger.latest!;
      if (current.checkpoint_version !== proposal.expectedCheckpointVersion) {
        events.push('planner_result_rejected');
        return { status: 'review_required', reason: 'stale_checkpoint', checkpoint: current };
      }
      const checkpoint = ledger.advance(2);
      ledger.recordReservation(proposal.investigationId, proposal.reservationId, 'reasoning', 'reconciled');
      const reconciledCheckpoint = input.planningCheckpointUpdatedAt === undefined
        ? checkpoint
        : ledger.setUpdatedAt(input.planningCheckpointUpdatedAt);
      const unexpectedCheckpoint = input.planningMode === 'wrong_checkpoint_status'
        ? { ...reconciledCheckpoint, case_status: 'paused' as const }
        : input.planningMode === 'wrong_checkpoint_version'
          ? {
            ...reconciledCheckpoint,
            checkpoint_id: `checkpoint-${reconciledCheckpoint.checkpoint_version + 1}`,
            checkpoint_version: reconciledCheckpoint.checkpoint_version + 1,
          }
          : reconciledCheckpoint;
      events.push('planner_reconciled');
      if (input.planningMode === 'replayed') {
        events.push('planner_result_replayed');
        return { status: 'replayed', checkpoint: reconciledCheckpoint };
      }
      if (input.planningMode === 'failed') {
        events.push('planner_result_rejected');
        return { status: 'review_required', reason: 'planner_timed_out', checkpoint: reconciledCheckpoint };
      }
      if (input.planningMode === 'malformed_proposal') {
        events.push('planner_result_proposed');
        return {
          status: 'proposed',
          checkpoint: reconciledCheckpoint,
          proposal: {
            schemaVersion: INVESTIGATION_PLAN_VERSION,
            recordType: 'InvestigationPlanResult',
            outcome: 'proposed',
            actionName: 'unregistered_action',
            input: {},
          } as ProposedInvestigationAction,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelVersion: 'fixture-model', promptVersion: 'fixture-prompt' },
        };
      }
      if (input.planningMode === 'malformed_checkpoint') {
        events.push('planner_result_proposed');
        return {
          status: 'proposed',
          checkpoint: {} as InvestigationCheckpointRecord,
          proposal: {
            schemaVersion: INVESTIGATION_PLAN_VERSION,
            recordType: 'InvestigationPlanResult',
            outcome: 'proposed',
            actionName: 'synthetic_search',
            input: {},
          } as ProposedInvestigationAction,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelVersion: 'fixture-model', promptVersion: 'fixture-prompt' },
        };
      }
      if (input.planningMode === 'wrong_checkpoint_status' || input.planningMode === 'wrong_checkpoint_version') {
        events.push('planner_result_proposed');
        return {
          status: 'proposed',
          checkpoint: unexpectedCheckpoint,
          proposal: {
            schemaVersion: INVESTIGATION_PLAN_VERSION,
            recordType: 'InvestigationPlanResult',
            outcome: 'proposed',
            actionName: 'synthetic_search',
            input: {},
          },
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelVersion: 'fixture-model', promptVersion: 'fixture-prompt' },
        };
      }
      if (input.actionMode === 'replayed') {
        const plan: ProposedInvestigationAction = {
          schemaVersion: INVESTIGATION_PLAN_VERSION,
          recordType: 'InvestigationPlanResult',
          outcome: 'proposed',
          actionName: 'synthetic_search',
          input: { query: PRIVATE_MODEL_OUTPUT },
        };
        events.push('planner_result_proposed');
        return {
          status: 'proposed',
          checkpoint: reconciledCheckpoint,
          proposal: plan,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelVersion: 'fixture-model', promptVersion: 'fixture-prompt' },
        };
      }
      events.push('planner_result_proposed');
      return {
        status: 'proposed',
        checkpoint: reconciledCheckpoint,
        proposal: {
          schemaVersion: INVESTIGATION_PLAN_VERSION,
          recordType: 'InvestigationPlanResult',
          outcome: 'proposed',
          actionName: 'synthetic_search',
          input: { query: PRIVATE_ACTION_INPUT },
        },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelVersion: 'fixture-model', promptVersion: 'fixture-prompt' },
      };
    },
  };
  const singleStep: SingleStepExecutor = {
    async execute(rawProposal) {
      events.push('action_invoked');
      const proposal = rawProposal as {
        readonly actionName: string;
        readonly input: unknown;
        readonly reservationId: string;
        readonly reservedAt: string;
      };
      actionCalls.push({
        actionName: proposal.actionName,
        input: proposal.input,
        reservationId: proposal.reservationId,
        reservedAt: proposal.reservedAt,
      });
      if (input.actionMode === 'duplicate') {
        return { status: 'review_required', reason: 'duplicate_action', checkpoint: ledger.latest! };
      }
      if (input.actionMode === 'uncertain') {
        ledger.recordReservation(ledger.latest!.investigation_id, proposal.reservationId, 'tool', 'started');
        return { status: 'review_required', reason: 'reservation_state_uncertain', checkpoint: ledger.latest! };
      }
      if (input.actionMode === 'reservation_in_flight') {
        ledger.recordReservation(ledger.latest!.investigation_id, proposal.reservationId, 'tool', 'started');
        return { status: 'review_required', reason: 'reservation_in_flight', checkpoint: ledger.latest! };
      }
      if (input.actionMode === 'marker_denied') {
        const current = ledger.latest!;
        ledger.recordReservation(current.investigation_id, proposal.reservationId, 'tool', 'reserved');
        ledger.marker = {
          datasetKind: current.dataset_kind,
          investigationId: current.investigation_id,
          observedCheckpointVersion: current.checkpoint_version,
          stage: 'action',
          reason: 'action_result_uncertain',
          reservationId: proposal.reservationId,
          markedAt: BASE_TIME,
        };
        throw new InvestigationLedgerError('advance_review_pending');
      }
      if (input.actionMode === 'replayed') {
        ledger.recordReservation(ledger.latest!.investigation_id, proposal.reservationId, 'tool', 'reconciled');
        return { status: 'replayed', checkpoint: ledger.latest! };
      }
      if (input.actionMode === 'unexpected_result' || input.actionMode === 'malformed_receipt') {
        ledger.advance(2);
        const checkpoint = ledger.setUpdatedAt(proposal.reservedAt);
        ledger.recordReservation(ledger.latest!.investigation_id, proposal.reservationId, 'tool', 'reconciled');
        if (input.actionMode === 'unexpected_result') return { status: 'unexpected' } as never;
        return { status: 'executed', checkpoint, receipt: {} } as never;
      }
      ledger.advance(2);
      const checkpoint = ledger.setUpdatedAt(proposal.reservedAt);
      ledger.recordReservation(ledger.latest!.investigation_id, proposal.reservationId, 'tool', 'reconciled');
      return {
        status: 'executed',
        checkpoint,
        receipt: {
          outcome: input.actionMode === 'timed_out' ? 'timed_out' : 'succeeded',
          outputReferenceIds: ['l1-report-reference-synthetic'],
        },
      };
    },
  };
  const refreshPort = {
    async refresh(refreshInput: {
      readonly datasetKind: 'synthetic';
      readonly investigationId: string;
      readonly previousContextId: string;
      readonly traceId: string;
      readonly candidateId: string;
      readonly eventId: string | null;
      readonly eventVersion: number | null;
      readonly outputReferenceIds: readonly string[];
    }) {
      events.push('refresh_invoked');
      refreshInputs.push({
        previousContextId: refreshInput.previousContextId,
        outputReferenceIds: refreshInput.outputReferenceIds,
      });
      if (input.refreshMode === 'throws') throw new Error('synthetic refresh failure');
      const context = refreshResults.shift() ?? makeContext({ conflicts: [] });
      const persistedRecord = persisted(context);
      ledger.registerPersistedContext(context, persistedRecord);
      if (input.refreshMode === 'marker_during_refresh') {
        const actionReservation = [...ledger.reservations.values()].find((reservation) =>
          reservation.investigationId === refreshInput.investigationId && reservation.actionKind === 'tool');
        assert.ok(actionReservation);
        ledger.marker = {
          datasetKind: refreshInput.datasetKind,
          investigationId: refreshInput.investigationId,
          observedCheckpointVersion: ledger.latest!.checkpoint_version,
          stage: 'refresh',
          reason: 'refresh_failed',
          reservationId: actionReservation.reservationId,
          markedAt: BASE_TIME,
        };
      }
      return { context, persistedRecord };
    },
  };
  const coordinator = createInvestigationCoordinator({
    entry,
    ledger: ledger.repository,
    fingerprints: FINGERPRINTS,
    reasoningStep,
    singleStep,
    refreshPort,
    actionMenu: ACTION_MENU,
    wallNow: () => {
      wallNowCalls += 1;
      events.push('wall_now');
      if (input.wallNow) return input.wallNow();
      const value = new Date(Date.parse('2026-09-29T12:10:00.000Z') + wallTick * 1000).toISOString();
      wallTick += 1;
      return value;
    },
  });

  return {
    coordinator,
    ledger,
    planningCalls,
    actionCalls,
    events,
    refreshCalls: refreshInputs,
    get wallNowCalls() { return wallNowCalls; },
    get progressCallCount() { return ledger.progressSnapshots.length - 1; },
    get progressSnapshots() { return ledger.progressSnapshots; },
    get refreshPersistedBeforeProgress() {
      return ledger.progressSnapshots.length > 0 && ledger.lastProgressWasPersisted;
    },
  };
}

class MemoryLedger {
  constructor(
    private readonly progressMode?: 'marker_denied' | 'missing_fingerprint_key' | 'null_progress_result'
      | 'malformed_progress_result' | 'missing_progress_snapshot' | 'malformed_progress_snapshot'
      | 'uncertain_progress_write' | 'progress_conflict' | 'context_not_found' | 'context_mismatch'
      | 'reservation_in_flight' | 'stale_checkpoint',
    private readonly reservationLookupMode: 'normal' | 'throws' = 'normal',
    private readonly markerWriteFails = false,
  ) {}

  latest: InvestigationCheckpointRecord | null = null;
  marker: AdvanceReviewPendingRecord | null = null;
  readonly createCalls: CreateInvestigationInput[] = [];
  readonly progressSnapshots: InvestigationProgressSnapshotRecord[] = [];
  readonly persistedContexts = new Map<string, GroundingContextRecord>();
  readonly reservations = new Map<string, ReservationRecord>();
  lastProgressWasPersisted = false;

  readonly repository: InvestigationLedgerRepository = {
    create: async (createInput) => {
      this.createCalls.push(createInput);
      if (this.latest) return this.latest;
      const checkpoint = makeCheckpoint(createInput);
      this.latest = checkpoint;
      this.progressSnapshots.push({
        datasetKind: createInput.datasetKind,
        investigationId: createInput.investigationId,
        checkpointVersion: 1,
        candidateId: createInput.candidateId,
        contextId: createInput.contextId,
        fingerprintKeyId: createInput.fingerprintKeyId,
        digestHex: createInput.initialGroundingDigestHex,
        consecutiveNoProgress: 0,
        recordedAt: createInput.requestedAt,
      });
      return checkpoint;
    },
    getLatest: async (_datasetKind, _investigationId) => this.latest,
    getAdvanceReviewPending: async (datasetKind, investigationId) => (
      this.marker?.datasetKind === datasetKind && this.marker.investigationId === investigationId
        ? this.marker
        : null
    ),
    markAdvanceReviewPending: async (input) => {
      if (this.markerWriteFails) throw new Error('synthetic marker write failure');
      if (!this.latest || this.latest.dataset_kind !== input.datasetKind
        || this.latest.investigation_id !== input.investigationId
        || input.observedCheckpointVersion > this.latest.checkpoint_version) {
        throw new InvestigationLedgerError('investigation_not_found');
      }
      if (input.reservationId) {
        const reservation = this.reservations.get(input.reservationId);
        if (!reservation || reservation.status === 'released') {
          throw new InvestigationLedgerError('advance_review_pending_conflict');
        }
      }
      if (this.marker) {
        const same = this.marker.datasetKind === input.datasetKind
          && this.marker.investigationId === input.investigationId
          && this.marker.observedCheckpointVersion === input.observedCheckpointVersion
          && this.marker.stage === input.stage
          && this.marker.reason === input.reason
          && this.marker.reservationId === (input.reservationId ?? null);
        if (!same) throw new InvestigationLedgerError('advance_review_pending_conflict');
        return { marker: this.marker, replayed: true };
      }
      this.marker = {
        datasetKind: input.datasetKind,
        investigationId: input.investigationId,
        observedCheckpointVersion: input.observedCheckpointVersion,
        stage: input.stage,
        reason: input.reason,
        reservationId: input.reservationId ?? null,
        markedAt: BASE_TIME,
      };
      return { marker: this.marker, replayed: false };
    },
    getFingerprintKeyId: async () => this.progressMode === 'missing_fingerprint_key'
      ? null
      : this.createCalls[0]?.fingerprintKeyId ?? null,
    refreshGroundingProgress: async (progressInput) => {
      if (this.progressMode === 'marker_denied') {
        const current = this.latest;
        const actionReservation = [...this.reservations.values()].find((reservation) =>
          reservation.investigationId === progressInput.investigationId && reservation.actionKind === 'tool');
        assert.ok(current && actionReservation);
        this.marker = {
          datasetKind: current.dataset_kind,
          investigationId: current.investigation_id,
          observedCheckpointVersion: current.checkpoint_version,
          stage: 'progress',
          reason: 'progress_uncertain',
          reservationId: actionReservation.reservationId,
          markedAt: BASE_TIME,
        };
        throw new InvestigationLedgerError('advance_review_pending');
      }
      if (this.progressMode === 'null_progress_result') return null as unknown as InvestigationProgressOperationResult;
      if (this.progressMode === 'malformed_progress_result') {
        return {} as InvestigationProgressOperationResult;
      }
      if (this.progressMode === 'missing_progress_snapshot') {
        return { checkpoint: this.latest! } as InvestigationProgressOperationResult;
      }
      if (this.progressMode === 'malformed_progress_snapshot') {
        return { checkpoint: this.latest!, snapshot: { checkpointVersion: 'broken' } } as unknown as InvestigationProgressOperationResult;
      }
      if (this.progressMode === 'progress_conflict') {
        throw new InvestigationLedgerError('progress_conflict');
      }
      if (this.progressMode === 'context_not_found' || this.progressMode === 'context_mismatch'
        || this.progressMode === 'reservation_in_flight' || this.progressMode === 'stale_checkpoint') {
        throw new InvestigationLedgerError(this.progressMode);
      }
      if (this.progressMode === 'uncertain_progress_write') {
        await this.recordProgress(progressInput);
        throw new Error('synthetic progress acknowledgement lost');
      }
      return this.recordProgress(progressInput);
    },
    getInFlightReservation: async () => null,
    getActionReservation: async (datasetKind, investigationId, reservationId) => {
      if (this.reservationLookupMode === 'throws') throw new Error('synthetic reservation lookup failure');
      const reservation = this.reservations.get(reservationId);
      return reservation?.datasetKind === datasetKind && reservation.investigationId === investigationId
        ? reservation
        : null;
    },
    reserveAction: async () => { throw new Error('unused repository reserveAction'); },
    startAction: async () => { throw new Error('unused repository startAction'); },
    reconcileAction: async () => { throw new Error('unused repository reconcileAction'); },
    reconcileInterrupted: async () => { throw new Error('unused repository reconcileInterrupted'); },
    releaseUninvoked: async () => { throw new Error('unused repository releaseUninvoked'); },
    pause: async () => { throw new Error('unused repository pause'); },
    resume: async () => { throw new Error('unused repository resume'); },
    terminate: async (input) => {
      const current = this.latest;
      if (!current || current.checkpoint_version !== input.expectedCheckpointVersion) {
        throw new InvestigationLedgerError('stale_checkpoint');
      }
      if ([...this.reservations.values()].some((reservation) =>
        reservation.investigationId === input.investigationId
          && (reservation.status === 'reserved' || reservation.status === 'started'))) {
        throw new InvestigationLedgerError('reservation_in_flight');
      }
      this.latest = {
        ...current,
        checkpoint_id: `checkpoint-${current.checkpoint_version + 1}`,
        checkpoint_version: current.checkpoint_version + 1,
        case_status: input.status,
        stop_reason: input.stopReason,
        updated_at: input.completedAt,
        completed_at: input.completedAt,
      };
      return { checkpoint: this.latest, replayed: false };
    },
  };

  advance(count: number): InvestigationCheckpointRecord {
    const current = this.latest;
    assert.ok(current, 'expected a durable case before a step');
    let next = current;
    for (let index = 0; index < count; index += 1) {
      const version = next.checkpoint_version + 1;
      next = {
        ...next,
        checkpoint_id: `checkpoint-${version}`,
        checkpoint_version: version,
        updated_at: new Date(Date.parse(BASE_TIME) + version * 60_000).toISOString(),
      };
    }
    this.latest = next;
    return next;
  }

  recordReservation(
    investigationId: string,
    reservationId: string,
    actionKind: 'tool' | 'reasoning',
    status: ReservationRecord['status'],
  ): void {
    const current = this.latest;
    assert.ok(current);
    this.reservations.set(reservationId, {
      datasetKind: current.dataset_kind,
      reservationId,
      investigationId,
      actionKind,
      actionName: actionKind === 'tool' ? 'synthetic_search' : 'l2_investigation_planning',
      expectedCheckpointVersion: current.checkpoint_version - (status === 'reconciled' ? 1 : 0),
      reserved: { toolAttempts: actionKind === 'tool' ? 1 : 0, reasoningTurns: actionKind === 'reasoning' ? 1 : 0,
        activeSeconds: 1, modelTokens: actionKind === 'reasoning' ? 1 : 0 },
      status,
      outcome: status === 'reconciled' ? 'succeeded' : null,
      actual: { activeSeconds: status === 'reconciled' ? 1 : 0, modelTokens: status === 'reconciled' && actionKind === 'reasoning' ? 1 : 0 },
      createdAt: BASE_TIME,
      startedAt: status === 'reserved' ? null : BASE_TIME,
      finishedAt: status === 'reconciled' ? BASE_TIME : null,
      reconciledCheckpointVersion: status === 'reconciled' ? current.checkpoint_version : null,
    });
  }

  setUpdatedAt(updatedAt: string): InvestigationCheckpointRecord {
    assert.ok(this.latest, 'expected a durable checkpoint before changing its timestamp');
    this.latest = { ...this.latest, updated_at: updatedAt };
    return this.latest;
  }

  stopDirectly(stopReason: 'awaiting_moderator' | 'limit_exhausted'): InvestigationCheckpointRecord {
    const current = this.latest;
    assert.ok(current);
    this.latest = {
      ...current,
      checkpoint_id: `checkpoint-${current.checkpoint_version + 1}`,
      checkpoint_version: current.checkpoint_version + 1,
      case_status: 'stopped_for_review',
      stop_reason: stopReason,
      updated_at: BASE_TIME,
      completed_at: BASE_TIME,
    };
    return this.latest;
  }

  registerPersistedContext(context: GroundingContext, record: GroundingContextRecord): void {
    this.persistedContexts.set(context.contextId, record);
  }

  private async recordProgress(input: RefreshGroundingProgressInput): Promise<InvestigationProgressOperationResult> {
    const current = this.latest;
    if (!current || current.checkpoint_version !== input.expectedCheckpointVersion) {
      throw new InvestigationLedgerError('stale_checkpoint');
    }
    const record = this.persistedContexts.get(input.contextId);
    this.lastProgressWasPersisted = !!record
      && record.dataset_kind === input.datasetKind
      && record.candidate_id === current.candidate_id;
    if (!this.lastProgressWasPersisted) throw new InvestigationLedgerError('context_not_found');
    const previous = this.progressSnapshots.at(-1)!;
    const consecutiveNoProgress = previous.digestHex === input.digestHex
      ? Math.min(previous.consecutiveNoProgress + 1, 2)
      : 0;
    const version = current.checkpoint_version + 1;
    const stopped = consecutiveNoProgress >= 2;
    this.latest = {
      ...current,
      checkpoint_id: `checkpoint-${version}`,
      checkpoint_version: version,
      context_id: input.contextId,
      case_status: stopped ? 'stopped_for_review' : 'open',
      stop_reason: stopped ? 'no_progress' : null,
      updated_at: input.refreshedAt,
      completed_at: stopped ? input.refreshedAt : null,
    };
    const snapshot: InvestigationProgressSnapshotRecord = {
      datasetKind: input.datasetKind,
      investigationId: input.investigationId,
      checkpointVersion: version,
      candidateId: current.candidate_id,
      contextId: input.contextId,
      fingerprintKeyId: input.fingerprintKeyId,
      digestHex: input.digestHex,
      consecutiveNoProgress,
      recordedAt: input.refreshedAt,
    };
    this.progressSnapshots.push(snapshot);
    return { checkpoint: this.latest, snapshot, replayed: false };
  }
}

function makeCheckpoint(input: CreateInvestigationInput): InvestigationCheckpointRecord {
  return {
    schema_version: '2.0',
    trace_id: input.traceId,
    record_type: 'InvestigationCheckpoint',
    dataset_kind: input.datasetKind,
    checkpoint_id: 'checkpoint-1',
    investigation_id: input.investigationId,
    checkpoint_version: 1,
    candidate_id: input.candidateId,
    context_id: input.contextId,
    event_id: input.eventId,
    event_version: input.eventVersion,
    case_status: 'open',
    stop_reason: null,
    budget: {
      policy_version: input.policyVersion,
      limits: {
        tool_attempts: input.limits.toolAttempts,
        reasoning_turns: input.limits.reasoningTurns,
        active_seconds: input.limits.activeSeconds,
        model_tokens: input.limits.modelTokens,
      },
      consumed: { tool_attempts: 0, reasoning_turns: 0, active_seconds: 0, model_tokens: 0 },
      reserved: { tool_attempts: 0, reasoning_turns: 0, active_seconds: 0, model_tokens: 0 },
    },
    attempts: [],
    reasoning_runs: [],
    created_at: input.requestedAt,
    updated_at: input.requestedAt,
    completed_at: null,
  };
}

function makeContext(overrides: Partial<GroundingContext> = {}): GroundingContext {
  return {
    schemaVersion: '2.0',
    recordType: 'GroundingContext',
    datasetKind: 'synthetic',
    traceId: 'trace-coordinator-synthetic',
    contextId: 'context-coordinator-initial',
    candidateId: 'candidate-coordinator-synthetic',
    evidence: [{
      reference: {
        reportRevisionId: 'revision-coordinator-synthetic',
        permittedTextHash: 'a'.repeat(64),
        spanStart: 0,
        spanEnd: Array.from(PRIVATE_SOURCE_TEXT).length,
        offsetUnit: 'unicode_code_points',
        relation: 'supports',
      },
      text: PRIVATE_SOURCE_TEXT,
      sourceId: 'source-coordinator-synthetic',
      revisionStatus: 'eligible',
      publishedAt: null,
      observedAt: null,
      retrievedAt: BASE_TIME,
      origins: [{ originId: 'origin-coordinator-synthetic', independenceStatus: 'established', dependsOnOriginIds: [] }],
    }],
    revisionStates: [{ reportRevisionId: 'revision-coordinator-synthetic', revisionStatus: 'eligible' }],
    candidateEvents: [{ eventId: 'event-coordinator-synthetic', eventVersion: 7 }],
    priorDecisionIds: [],
    missingFields: ['private missing detail'],
    conflicts: [PRIVATE_CONFLICT],
    retrievalVersion: 'retrieval-coordinator-v1',
    indexVersion: 'index-coordinator-v1',
    sufficient: false,
    ...overrides,
  };
}

function persisted(context: GroundingContext): GroundingContextRecord {
  return {
    schema_version: context.schemaVersion,
    trace_id: context.traceId,
    record_type: context.recordType,
    dataset_kind: context.datasetKind,
    context_id: context.contextId,
    candidate_id: context.candidateId,
    evidence: context.evidence.map(({ reference }) => ({
      report_revision_id: reference.reportRevisionId,
      permitted_text_hash: reference.permittedTextHash,
      span_start: reference.spanStart,
      span_end: reference.spanEnd,
      offset_unit: reference.offsetUnit,
      relation: reference.relation,
    })),
    revision_states: context.revisionStates.map(({ reportRevisionId, revisionStatus }) => ({
      report_revision_id: reportRevisionId,
      revision_status: revisionStatus,
    })),
    candidate_events: context.candidateEvents.map(({ eventId, eventVersion }) => ({
      event_id: eventId,
      event_version: eventVersion,
    })),
    prior_decision_ids: [...context.priorDecisionIds],
    missing_fields: [...context.missingFields],
    conflicts: [...context.conflicts],
    retrieval_version: context.retrievalVersion,
    index_version: context.indexVersion,
    sufficient: context.sufficient,
  };
}

function handoff(context: GroundingContext): InvestigationRequiredOutcome {
  const reasoningRequest: ReasoningRequest = { data: { groundingContext: context } };
  return { status: 'investigation_required', reasoningRequest, persistedRecord: persisted(context) };
}

function openInput(context: GroundingContext): OpenInvestigationAdvance {
  return {
    kind: 'open',
    outcome: handoff(context),
    callerValues: { ...CALLER_VALUES },
    reasoningReservationId: 'reservation-coordinator-plan-1',
    reasoningReservedAt: '2026-09-29T12:00:10.000Z',
    actionReservationId: 'reservation-coordinator-action-1',
  };
}

function resumeInput(
  outcome: Extract<InvestigationCoordinatorOutcome, { status: 'continue' }>,
  suffix: string,
): ResumeInvestigationAdvance {
  return {
    kind: 'resume',
    checkpoint: outcome.checkpoint,
    context: outcome.context,
    persistedRecord: outcome.persistedRecord,
    reasoningReservationId: `reservation-plan-${suffix}`,
    reasoningReservedAt: new Date(Date.parse(outcome.checkpoint.updated_at) + 10_000).toISOString(),
    actionReservationId: `reservation-action-${suffix}`,
  };
}
