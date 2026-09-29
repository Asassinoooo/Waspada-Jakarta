import assert from 'node:assert/strict';
import test from 'node:test';
import type { GroundingContextRecord } from '../../db/src/grounding-contexts.js';
import {
  InvestigationLedgerError,
  type CreateInvestigationInput,
  type InvestigationCheckpointRecord,
  type InvestigationLedgerRepository,
  type InvestigationProgressOperationResult,
  type InvestigationProgressSnapshotRecord,
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

test('a replayed planner reservation stops before action or refresh', async () => {
  const context = makeContext({ missingFields: ['private gap'], conflicts: [] });
  const harness = makeHarness({ planningMode: 'replayed' });

  const result = await harness.coordinator.advance(openInput(context));

  assert.equal(result.status, 'review_required');
  assert.equal(result.reason, 'replayed_planner_step');
  assert.equal(result.checkpoint?.case_status, 'stopped_for_review');
  assert.equal(result.checkpoint?.stop_reason, 'awaiting_moderator');
  assert.equal(harness.planningCalls.length, 1);
  assert.equal(harness.actionCalls.length, 0);
  assert.equal(harness.refreshCalls.length, 0);
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
    assert.equal(result.reason, 'action_uncertain');
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

test('replaying an outer open request after the planner advanced cannot call either executor again', async () => {
  const context = makeContext({ missingFields: ['private gap'], conflicts: [] });
  const harness = makeHarness({ actionMode: 'replayed' });
  const input = openInput(context);

  const first = await harness.coordinator.advance(input);
  assert.equal(first.status, 'review_required');
  assert.equal(first.reason, 'replayed_action_step');
  assert.equal(first.checkpoint?.case_status, 'stopped_for_review');
  assert.equal(first.checkpoint?.stop_reason, 'awaiting_moderator');
  const retry = await harness.coordinator.advance(input);

  assert.equal(retry.status, 'review_required');
  assert.equal(retry.reason, 'stale_checkpoint');
  assert.equal(harness.planningCalls.length, 1);
  assert.equal(harness.actionCalls.length, 1);
  assert.equal(harness.actionCalls[0]?.reservationId, input.actionReservationId);
  assert.equal(harness.actionCalls[0]?.reservedAt, input.actionReservedAt);
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
  readonly actionMode?: 'success' | 'duplicate' | 'timed_out' | 'uncertain' | 'replayed';
  readonly planningMode?: 'proposed' | 'abstained' | 'budget_exhausted' | 'replayed';
} = {}) {
  const ledger = new MemoryLedger();
  const entry = createInsufficientContextEntryService(ledger.repository, FINGERPRINTS);
  const planningCalls: Array<{ readonly request: InvestigationPlanRequest; readonly reservationId: string }> = [];
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

  const reasoningStep: ReasoningStepExecutor = {
    async plan(rawProposal) {
      const proposal = rawProposal as {
        readonly datasetKind: 'synthetic';
        readonly investigationId: string;
        readonly expectedCheckpointVersion: number;
        readonly reservationId: string;
        readonly request: InvestigationPlanRequest;
      };
      planningCalls.push({ request: proposal.request, reservationId: proposal.reservationId });
      if (input.planningMode === 'abstained') {
        const checkpoint = ledger.stopDirectly('awaiting_moderator');
        return { status: 'review_required', reason: 'planner_abstained', checkpoint };
      }
      if (input.planningMode === 'budget_exhausted') {
        return { status: 'review_required', reason: 'budget_exhausted', checkpoint: ledger.latest! };
      }
      const current = ledger.latest!;
      if (current.checkpoint_version !== proposal.expectedCheckpointVersion) {
        return { status: 'review_required', reason: 'stale_checkpoint', checkpoint: current };
      }
      const checkpoint = ledger.advance(2);
      if (input.planningMode === 'replayed') return { status: 'replayed', checkpoint };
      if (input.actionMode === 'replayed') {
        const plan: ProposedInvestigationAction = {
          schemaVersion: INVESTIGATION_PLAN_VERSION,
          recordType: 'InvestigationPlanResult',
          outcome: 'proposed',
          actionName: 'synthetic_search',
          input: { query: PRIVATE_MODEL_OUTPUT },
        };
        return {
          status: 'proposed',
          checkpoint,
          proposal: plan,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelVersion: 'fixture-model', promptVersion: 'fixture-prompt' },
        };
      }
      return {
        status: 'proposed',
        checkpoint,
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
        return { status: 'review_required', reason: 'reservation_state_uncertain', checkpoint: ledger.latest! };
      }
      if (input.actionMode === 'replayed') {
        return { status: 'replayed', checkpoint: ledger.latest! };
      }
      const checkpoint = ledger.advance(2);
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
      readonly previousContextId: string;
      readonly outputReferenceIds: readonly string[];
    }) {
      refreshInputs.push({
        previousContextId: refreshInput.previousContextId,
        outputReferenceIds: refreshInput.outputReferenceIds,
      });
      const context = refreshResults.shift() ?? makeContext({ conflicts: [] });
      const persistedRecord = persisted(context);
      ledger.registerPersistedContext(context, persistedRecord);
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
    refreshCalls: refreshInputs,
    get progressCallCount() { return ledger.progressSnapshots.length - 1; },
    get progressSnapshots() { return ledger.progressSnapshots; },
    get refreshPersistedBeforeProgress() {
      return ledger.progressSnapshots.length > 0 && ledger.lastProgressWasPersisted;
    },
  };
}

class MemoryLedger {
  latest: InvestigationCheckpointRecord | null = null;
  readonly createCalls: CreateInvestigationInput[] = [];
  readonly progressSnapshots: InvestigationProgressSnapshotRecord[] = [];
  readonly persistedContexts = new Map<string, GroundingContextRecord>();
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
    getFingerprintKeyId: async () => this.createCalls[0]?.fingerprintKeyId ?? null,
    refreshGroundingProgress: async (progressInput) => this.recordProgress(progressInput),
    getInFlightReservation: async () => null,
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
    actionReservedAt: '2026-09-29T12:10:00.000Z',
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
    actionReservedAt: new Date(Date.parse(outcome.checkpoint.updated_at) + 20_000).toISOString(),
  };
}
