import assert from 'node:assert/strict';
import test from 'node:test';
import {
  InvestigationLedgerError,
} from '../../db/src/investigation-ledger.js';
import type {
  InvestigationCheckpointRecord,
  InvestigationLedgerRepository,
  ReconcileActionInput,
  ReservationOperationResult,
  ReservationRecord,
  ReserveActionInput,
} from '../../db/src/investigation-ledger.js';
import {
  INVESTIGATION_PLAN_CAPABILITY,
  type InvestigationPlanUsage,
  type InvestigationPlanner,
  type InvestigationPlannerOutcome,
  type InvestigationPlannerPreflightOutcome,
  type InvestigationPlanRequest,
} from '../src/layers/l2-model-grounding/investigation-planner.js';
import {
  createReasoningStepExecutor,
  type ReasoningStepExecutorClock,
  type ReasoningStepExecutorTimer,
} from '../src/layers/l3-investigation/reasoning-step-executor.js';
import type { TelemetryRecord, TelemetrySink } from '../src/layers/l5-evaluation-monitoring/telemetry.js';

const timestamp = '2026-09-28T12:00:00.000Z';
const requestBase: InvestigationPlanRequest = {
  schemaVersion: '1.0',
  recordType: 'InvestigationPlanRequest',
  groundingContext: {
    schemaVersion: '2.0',
    recordType: 'GroundingContext',
    datasetKind: 'synthetic',
    traceId: 'trace_reasoning_step',
    contextId: 'context_reasoning_step',
    candidateId: 'candidate_reasoning_step',
    evidence: [],
    revisionStates: [],
    candidateEvents: [],
    priorDecisionIds: [],
    missingFields: ['synthetic_status'],
    conflicts: ['synthetic_sources_disagree'],
    retrievalVersion: 'retrieval_synthetic_v1',
    indexVersion: 'index_synthetic_v1',
    sufficient: false,
  },
  questions: ['missing_field_1', 'conflict_1'],
  actionMenu: [
    { name: 'synthetic_search', description: 'Search the synthetic source index.' },
    { name: 'gazetteer_lookup', description: 'Resolve a synthetic place name.' },
  ],
};

const usage: InvestigationPlanUsage = {
  inputTokens: 18,
  outputTokens: 7,
  totalTokens: 25,
  modelVersion: 'synthetic-model-v3',
  promptVersion: 'synthetic-prompt-v2',
};

function proposedPlan() {
  return {
    schemaVersion: '1.0',
    recordType: 'InvestigationPlanResult',
    outcome: 'proposed',
    actionName: 'synthetic_search',
    input: { query: 'synthetic service status' },
  };
}

function abstainedPlan() {
  return {
    schemaVersion: '1.0',
    recordType: 'InvestigationPlanResult',
    outcome: 'abstained',
    reason: 'ambiguous_context',
  };
}

function successfulOutcome(value: unknown = proposedPlan(), callUsage: unknown = usage) {
  return { status: 'succeeded', capability: INVESTIGATION_PLAN_CAPABILITY, value, usage: callUsage };
}

function planRequest(overrides: Partial<InvestigationPlanRequest> = {}): InvestigationPlanRequest {
  return { ...requestBase, ...overrides };
}

function makeProposal(overrides: Record<string, unknown> = {}) {
  return {
    datasetKind: 'synthetic',
    investigationId: 'investigation_reasoning_step',
    expectedCheckpointVersion: 2,
    reservationId: 'reservation_reasoning_step_1',
    reservedAt: timestamp,
    request: requestBase,
    ...overrides,
  };
}

function makePlanner(config: {
  readonly result?: unknown;
  readonly error?: boolean;
  readonly preflight?: unknown;
  readonly preflightError?: boolean;
  readonly calls?: string[];
  readonly options?: unknown[];
  readonly onCall?: (signal: AbortSignal, callOptions: unknown) => void;
} = {}) {
  const calls = config.calls ?? [];
  const callOptions = config.options ?? [];
  const planner: InvestigationPlanner = {
    async preflight(rawRequest): Promise<InvestigationPlannerPreflightOutcome> {
      calls.push('preflight');
      if (config.preflightError) throw new Error('private preflight details');
      if (config.preflight !== undefined) return config.preflight as InvestigationPlannerPreflightOutcome;
      return {
        status: 'ready',
        capability: INVESTIGATION_PLAN_CAPABILITY,
        request: rawRequest as InvestigationPlanRequest,
      };
    },
    async propose(_rawRequest, options) {
      calls.push('planner');
      callOptions.push(options);
      config.onCall?.(options.signal, options);
      if (config.error) throw new Error('private model provider details');
      return (config.result === undefined ? successfulOutcome() : config.result) as InvestigationPlannerOutcome;
    },
  };
  return { planner, calls, callOptions };
}

function makeExecutor(input: {
  readonly ledger: InvestigationLedgerRepository;
  readonly planner: InvestigationPlanner;
  readonly maxActiveSeconds?: number;
  readonly maxModelTokens?: number;
  readonly clock?: TestClock;
  readonly timer?: FakeTimer;
  readonly telemetry?: TelemetrySink;
}) {
  const clock = input.clock ?? makeClock();
  const timer = input.timer ?? new FakeTimer();
  const executor = createReasoningStepExecutor({
    ledger: input.ledger,
    planner: input.planner,
    maxActiveSeconds: input.maxActiveSeconds ?? 9,
    maxModelTokens: input.maxModelTokens ?? 80,
    clock,
    timer,
    ...(input.telemetry ? { telemetry: input.telemetry } : {}),
  });
  return { executor, clock, timer };
}

function makeLedger(config: {
  readonly calls?: string[];
  readonly latestCheckpoint?: InvestigationCheckpointRecord | null;
  readonly inFlightReservation?: ReservationRecord | null;
  readonly latestError?: Error;
  readonly inFlightError?: Error;
  readonly reserveResult?: (checkpoint: InvestigationCheckpointRecord) => ReservationOperationResult;
  readonly startResult?: (checkpoint: InvestigationCheckpointRecord) => ReservationOperationResult;
  readonly reserveError?: Error;
  readonly startError?: Error;
  readonly reconcileError?: Error;
  readonly terminateError?: Error;
  readonly reconcileResult?: (checkpoint: InvestigationCheckpointRecord) => { checkpoint: InvestigationCheckpointRecord; replayed: boolean };
  readonly terminateResult?: (checkpoint: InvestigationCheckpointRecord) => { checkpoint: InvestigationCheckpointRecord; replayed: boolean };
} = {}) {
  const calls = config.calls ?? [];
  const reserveInputs: ReserveActionInput[] = [];
  const startInputs: Array<Parameters<InvestigationLedgerRepository['startAction']>[0]> = [];
  const reconcileInputs: ReconcileActionInput[] = [];
  const terminateInputs: Array<Parameters<InvestigationLedgerRepository['terminate']>[0]> = [];
  const releaseInputs: Array<Parameters<InvestigationLedgerRepository['releaseUninvoked']>[0]> = [];
  const latestCheckpoint = config.latestCheckpoint === undefined ? makeCheckpoint(2) : config.latestCheckpoint;
  const reservationCheckpoint = makeCheckpoint(3);
  const finalCheckpoint = makeCheckpoint(4);
  const stoppedCheckpoint = makeCheckpoint(5, { case_status: 'stopped_for_review', stop_reason: 'awaiting_moderator' });
  const repository: InvestigationLedgerRepository = {
    async create() { throw new Error('unexpected create'); },
    async getLatest() {
      calls.push('getLatest');
      if (config.latestError) throw config.latestError;
      return latestCheckpoint;
    },
    async getInFlightReservation() {
      calls.push('getInFlight');
      if (config.inFlightError) throw config.inFlightError;
      return config.inFlightReservation ?? null;
    },
    async reserveAction(input) {
      calls.push('reserve');
      reserveInputs.push(input);
      if (config.reserveError) throw config.reserveError;
      return config.reserveResult?.(reservationCheckpoint) ?? {
        reservation: makeReservation(input),
        checkpoint: reservationCheckpoint,
        mayInvoke: false,
        replayed: false,
      };
    },
    async startAction(input) {
      calls.push('start');
      startInputs.push(input);
      if (config.startError) throw config.startError;
      return config.startResult?.(reservationCheckpoint) ?? {
        reservation: makeReservation({
          investigationId: input.investigationId,
          reservationId: input.reservationId,
          startedAt: input.startedAt,
          status: 'started',
        }),
        checkpoint: reservationCheckpoint,
        mayInvoke: true,
        replayed: false,
      };
    },
    async reconcileAction(input) {
      calls.push('reconcile');
      reconcileInputs.push(input);
      if (config.reconcileError) throw config.reconcileError;
      return config.reconcileResult?.(finalCheckpoint) ?? { checkpoint: finalCheckpoint, replayed: false };
    },
    async reconcileInterrupted() { throw new Error('unexpected interrupted reconciliation'); },
    async releaseUninvoked(input) {
      calls.push('release');
      releaseInputs.push(input);
      return { checkpoint: reservationCheckpoint, replayed: false };
    },
    async pause() { throw new Error('unexpected pause'); },
    async resume() { throw new Error('unexpected resume'); },
    async terminate(input) {
      calls.push('terminate');
      terminateInputs.push(input);
      if (config.terminateError) throw config.terminateError;
      return config.terminateResult?.(stoppedCheckpoint) ?? { checkpoint: stoppedCheckpoint, replayed: false };
    },
  };
  return {
    calls,
    reserveInputs,
    startInputs,
    reconcileInputs,
    terminateInputs,
    releaseInputs,
    reservationCheckpoint,
    finalCheckpoint,
    stoppedCheckpoint,
    repository,
  };
}

function makeReservation(
  input: Partial<ReserveActionInput & { startedAt: string; status: 'reserved' | 'started' }> = {},
): ReservationRecord {
  return {
    datasetKind: input.datasetKind ?? 'synthetic',
    reservationId: input.reservationId ?? 'reservation_reasoning_step_1',
    investigationId: input.investigationId ?? 'investigation_reasoning_step',
    actionKind: input.actionKind ?? 'reasoning',
    actionName: input.actionName ?? 'l2_investigation_planning',
    expectedCheckpointVersion: input.expectedCheckpointVersion ?? 2,
    reserved: {
      toolAttempts: 0,
      reasoningTurns: 1,
      activeSeconds: input.reservedActiveSeconds ?? 9,
      modelTokens: input.reservedModelTokens ?? 80,
    },
    status: input.status ?? (input.startedAt ? 'started' : 'reserved'),
    outcome: null,
    actual: { activeSeconds: 0, modelTokens: 0 },
    createdAt: input.reservedAt ?? timestamp,
    startedAt: input.startedAt ?? null,
    finishedAt: null,
    reconciledCheckpointVersion: null,
  };
}

function makeCheckpoint(
  version: number,
  overrides: Partial<InvestigationCheckpointRecord> = {},
): InvestigationCheckpointRecord {
  return {
    schema_version: '2.0',
    trace_id: 'trace_reasoning_step',
    record_type: 'InvestigationCheckpoint',
    dataset_kind: 'synthetic',
    checkpoint_id: `checkpoint_reasoning_step_${version}`,
    investigation_id: 'investigation_reasoning_step',
    checkpoint_version: version,
    candidate_id: 'candidate_reasoning_step',
    context_id: 'context_reasoning_step',
    event_id: null,
    event_version: null,
    case_status: 'open',
    stop_reason: null,
    budget: {
      policy_version: 'policy_reasoning_step_v1',
      limits: { tool_attempts: 5, reasoning_turns: 4, active_seconds: 60, model_tokens: 12_000 },
      consumed: { tool_attempts: 0, reasoning_turns: 0, active_seconds: 0, model_tokens: 0 },
      reserved: { tool_attempts: 0, reasoning_turns: 0, active_seconds: 0, model_tokens: 0 },
    },
    attempts: [],
    reasoning_runs: [],
    created_at: timestamp,
    updated_at: timestamp,
    completed_at: null,
    ...overrides,
  };
}

interface TestClock extends ReasoningStepExecutorClock {
  advance(milliseconds: number): void;
}

function makeClock(): TestClock {
  let monotonic = 0;
  return {
    wallNow: () => timestamp,
    monotonicNow: () => monotonic,
    advance(milliseconds) { monotonic += milliseconds; },
  };
}

class FakeTimer implements ReasoningStepExecutorTimer {
  callback: (() => void) | undefined;
  lastDelayMs: number | undefined;

  constructor(private readonly failToCreate = false) {}

  setTimeout(callback: () => void, delayMs: number): unknown {
    if (this.failToCreate) throw new Error('timer unavailable');
    this.callback = callback;
    this.lastDelayMs = delayMs;
    return callback;
  }

  clearTimeout(handle: unknown): void {
    if (handle === this.callback) this.callback = undefined;
  }

  fire(): void { this.callback?.(); }
}

test('reserves and starts one bounded reasoning call before returning a proposal', async () => {
  const calls: string[] = [];
  const ledger = makeLedger({ calls });
  const clock = makeClock();
  let suppliedSignal: AbortSignal | undefined;
  let suppliedCallOptions: unknown;
  const planner = makePlanner({
    calls,
    onCall: (signal, callOptions) => {
      suppliedSignal = signal;
      suppliedCallOptions = callOptions;
      clock.advance(2_300);
    },
  });
  const { executor, timer } = makeExecutor({ ledger: ledger.repository, planner: planner.planner, clock });
  const result = await executor.plan(makeProposal());

  assert.deepEqual(calls, ['preflight', 'getLatest', 'getInFlight', 'reserve', 'start', 'planner', 'reconcile']);
  assert.deepEqual(ledger.reserveInputs[0], {
    datasetKind: 'synthetic',
    investigationId: 'investigation_reasoning_step',
    reservationId: 'reservation_reasoning_step_1',
    expectedCheckpointVersion: 2,
    actionKind: 'reasoning',
    actionName: 'l2_investigation_planning',
    reservedActiveSeconds: 9,
    reservedModelTokens: 80,
    reservedAt: timestamp,
  });
  assert.deepEqual(ledger.startInputs[0], {
    datasetKind: 'synthetic',
    investigationId: 'investigation_reasoning_step',
    reservationId: 'reservation_reasoning_step_1',
    startedAt: timestamp,
  });
  assert.equal(timer.lastDelayMs, 9_000);
  assert.equal(suppliedSignal?.aborted, false);
  assert.deepEqual(suppliedCallOptions, { signal: suppliedSignal, maxTotalTokens: 80 });
  assert.deepEqual(ledger.reconcileInputs[0], {
    datasetKind: 'synthetic',
    investigationId: 'investigation_reasoning_step',
    reservationId: 'reservation_reasoning_step_1',
    expectedCheckpointVersion: 3,
    outcome: 'succeeded',
    actualActiveSeconds: 3,
    actualModelTokens: 25,
    finishedAt: timestamp,
    modelRun: {
      capability: 'reasoning',
      model_version: 'synthetic-model-v3',
      prompt_version: 'synthetic-prompt-v2',
      input_tokens: 18,
      output_tokens: 7,
    },
  });
  assert.deepEqual(result, {
    status: 'proposed',
    checkpoint: ledger.finalCheckpoint,
    proposal: proposedPlan(),
    usage,
  });
  assert.equal(ledger.terminateInputs.length, 0);
});

test('rejects missing, stale, closed, in-flight, mismatched and insufficient case state before reservation', async () => {
  const scenarios: Array<{
    name: string;
    ledger?: ReturnType<typeof makeLedger>;
    proposal?: Record<string, unknown>;
    planner?: ReturnType<typeof makePlanner>;
    reason: string;
  }> = [
    { name: 'missing case', ledger: makeLedger({ latestCheckpoint: null }), reason: 'investigation_not_found' },
    { name: 'closed case', ledger: makeLedger({ latestCheckpoint: makeCheckpoint(2, { case_status: 'paused' }) }), reason: 'investigation_not_open' },
    { name: 'stale version', proposal: makeProposal({ expectedCheckpointVersion: 1 }), reason: 'stale_checkpoint' },
    { name: 'wrong dataset', proposal: makeProposal({ datasetKind: 'historical' }), reason: 'context_identity_mismatch' },
    { name: 'wrong trace', proposal: makeProposal({ request: planRequest({ groundingContext: { ...requestBase.groundingContext, traceId: 'trace_other' } }) }), reason: 'context_identity_mismatch' },
    { name: 'wrong context', proposal: makeProposal({ request: planRequest({ groundingContext: { ...requestBase.groundingContext, contextId: 'context_other' } }) }), reason: 'context_identity_mismatch' },
    { name: 'wrong candidate', proposal: makeProposal({ request: planRequest({ groundingContext: { ...requestBase.groundingContext, candidateId: 'candidate_other' } }) }), reason: 'context_identity_mismatch' },
    {
      name: 'wrong event id',
      proposal: makeProposal({ request: planRequest({ groundingContext: { ...requestBase.groundingContext, candidateEvents: [{ eventId: 'event_current', eventVersion: 4 }] } }) }),
      ledger: makeLedger({ latestCheckpoint: makeCheckpoint(2, { event_id: 'event_other', event_version: 4 }) }),
      reason: 'context_identity_mismatch',
    },
    {
      name: 'wrong event version',
      proposal: makeProposal({ request: planRequest({ groundingContext: { ...requestBase.groundingContext, candidateEvents: [{ eventId: 'event_current', eventVersion: 5 }] } }) }),
      ledger: makeLedger({ latestCheckpoint: makeCheckpoint(2, { event_id: 'event_current', event_version: 4 }) }),
      reason: 'context_identity_mismatch',
    },
    { name: 'wrong questions', proposal: makeProposal({ request: planRequest({ questions: ['missing_field_1'] }) }), reason: 'context_identity_mismatch' },
    { name: 'reordered questions', proposal: makeProposal({ request: planRequest({ questions: ['conflict_1', 'missing_field_1'] }) }), reason: 'context_identity_mismatch' },
    { name: 'sufficient context', planner: makePlanner({ preflight: { status: 'invalid_request', capability: INVESTIGATION_PLAN_CAPABILITY, reason: 'sufficient_context' } }), reason: 'planner_preflight_rejected' },
  ];
  for (const scenario of scenarios) {
    const calls: string[] = [];
    const ledger = scenario.ledger ?? makeLedger({ calls });
    const planner = scenario.planner ?? makePlanner({ calls });
    const { executor } = makeExecutor({ ledger: ledger.repository, planner: planner.planner });
    const result = await executor.plan(scenario.proposal ?? makeProposal());
    assert.equal(result.status, 'review_required', scenario.name);
    if (result.status === 'review_required') assert.equal(result.reason, scenario.reason, scenario.name);
    assert.equal(ledger.reserveInputs.length, 0, scenario.name);
    assert.equal(planner.calls.filter((call) => call === 'planner').length, 0, scenario.name);
  }

  const inFlightLedger = makeLedger({ inFlightReservation: makeReservation({ status: 'started', startedAt: timestamp }) });
  const inFlightPlanner = makePlanner();
  const inFlightExecutor = makeExecutor({ ledger: inFlightLedger.repository, planner: inFlightPlanner.planner }).executor;
  const inFlight = await inFlightExecutor.plan(makeProposal());
  assert.deepEqual(inFlight.status === 'review_required' ? inFlight.reason : null, 'reservation_in_flight');
  assert.equal(inFlightLedger.reserveInputs.length, 0);
  assert.equal(inFlightPlanner.calls.includes('planner'), false);
});

test('a corrupt injected ready request is caught after start and reconciled at the full reservation', async () => {
  const ledger = makeLedger();
  const planner = makePlanner({
    preflight: {
      status: 'ready',
      capability: INVESTIGATION_PLAN_CAPABILITY,
      request: { ...requestBase, actionMenu: [null] },
    },
  });
  const result = await makeExecutor({ ledger: ledger.repository, planner: planner.planner }).executor.plan(makeProposal());

  assert.deepEqual(result, { status: 'review_required', reason: 'planner_failed', checkpoint: ledger.finalCheckpoint });
  assert.deepEqual(ledger.calls, ['getLatest', 'getInFlight', 'reserve', 'start', 'reconcile']);
  assert.equal(planner.calls.filter((call) => call === 'planner').length, 1);
  assert.equal(ledger.reconcileInputs.length, 1);
  assert.deepEqual(ledger.reconcileInputs[0], {
    datasetKind: 'synthetic',
    investigationId: 'investigation_reasoning_step',
    reservationId: 'reservation_reasoning_step_1',
    expectedCheckpointVersion: 3,
    outcome: 'failed',
    actualActiveSeconds: 9,
    actualModelTokens: 80,
    finishedAt: timestamp,
  });
});

test('invalid proposal, invalid trusted limits, and failed L2 preflight do not reserve', async () => {
  for (const input of [
    { proposal: { ...makeProposal(), unexpected: 'extra' }, maxActiveSeconds: 9, maxModelTokens: 80, reason: 'invalid_proposal' },
    { proposal: makeProposal(), maxActiveSeconds: 61, maxModelTokens: 80, reason: 'invalid_limits' },
    { proposal: makeProposal(), maxActiveSeconds: 9, maxModelTokens: 12_001, reason: 'invalid_limits' },
  ]) {
    const ledger = makeLedger();
    const planner = makePlanner();
    const executor = createReasoningStepExecutor({
      ledger: ledger.repository,
      planner: planner.planner,
      maxActiveSeconds: input.maxActiveSeconds,
      maxModelTokens: input.maxModelTokens,
      clock: makeClock(),
      timer: new FakeTimer(),
    });
    const result = await executor.plan(input.proposal);
    assert.equal(result.status, 'review_required');
    if (result.status === 'review_required') assert.equal(result.reason, input.reason);
    assert.equal(ledger.reserveInputs.length, 0);
  }

  const ledger = makeLedger();
  const planner = makePlanner({ preflightError: true });
  const executor = makeExecutor({ ledger: ledger.repository, planner: planner.planner }).executor;
  const result = await executor.plan(makeProposal());
  assert.deepEqual(result, { status: 'review_required', reason: 'planner_preflight_rejected' });
  assert.equal(ledger.reserveInputs.length, 0);
  assert.equal(planner.calls.includes('planner'), false);
});

test('reservation and start replays or denials never invoke the planner', async () => {
  const reserveReplay = makeLedger({
    reserveResult: (checkpoint) => ({ reservation: makeReservation(), checkpoint, mayInvoke: false, replayed: true }),
  });
  const reservePlanner = makePlanner();
  const reserveResult = await makeExecutor({ ledger: reserveReplay.repository, planner: reservePlanner.planner }).executor.plan(makeProposal());
  assert.deepEqual(reserveResult, { status: 'replayed', checkpoint: reserveReplay.reservationCheckpoint });
  assert.equal(reserveReplay.calls.includes('start'), false);
  assert.equal(reservePlanner.calls.includes('planner'), false);

  const startReplay = makeLedger({
    startResult: (checkpoint) => ({ reservation: makeReservation({ status: 'started', startedAt: timestamp }), checkpoint, mayInvoke: false, replayed: true }),
  });
  const startPlanner = makePlanner();
  const startResult = await makeExecutor({ ledger: startReplay.repository, planner: startPlanner.planner }).executor.plan(makeProposal());
  assert.deepEqual(startResult, { status: 'replayed', checkpoint: startReplay.reservationCheckpoint });
  assert.equal(startPlanner.calls.includes('planner'), false);

  const deniedStart = makeLedger({
    startResult: (checkpoint) => ({ reservation: makeReservation(), checkpoint, mayInvoke: false, replayed: false }),
  });
  const deniedPlanner = makePlanner();
  const deniedResult = await makeExecutor({ ledger: deniedStart.repository, planner: deniedPlanner.planner }).executor.plan(makeProposal());
  assert.deepEqual(deniedResult, { status: 'review_required', reason: 'start_not_authorized', checkpoint: deniedStart.reservationCheckpoint });
  assert.equal(deniedPlanner.calls.includes('planner'), false);
});

test('valid abstention reconciles usage before stopping the case for moderator review', async () => {
  const ledger = makeLedger();
  const planner = makePlanner({ result: successfulOutcome(abstainedPlan()) });
  const result = await makeExecutor({ ledger: ledger.repository, planner: planner.planner }).executor.plan(makeProposal());

  assert.deepEqual(ledger.calls, ['getLatest', 'getInFlight', 'reserve', 'start', 'reconcile', 'terminate']);
  assert.equal(ledger.reconcileInputs[0]?.outcome, 'succeeded');
  assert.equal(ledger.reconcileInputs[0]?.actualModelTokens, usage.totalTokens);
  assert.equal(ledger.reconcileInputs[0]?.modelRun?.model_version, usage.modelVersion);
  assert.deepEqual(ledger.terminateInputs[0], {
    datasetKind: 'synthetic',
    investigationId: 'investigation_reasoning_step',
    expectedCheckpointVersion: 4,
    status: 'stopped_for_review',
    stopReason: 'awaiting_moderator',
    completedAt: timestamp,
  });
  assert.deepEqual(result, {
    status: 'review_required',
    reason: 'planner_abstained',
    checkpoint: ledger.stoppedCheckpoint,
    usage,
  });
});

test('provider errors, malformed plans and invalid usage reconcile full reserved budgets without retry', async () => {
  const malformedUsage = { inputTokens: 80, outputTokens: 1, totalTokens: 81, modelVersion: usage.modelVersion, promptVersion: usage.promptVersion };
  const cases = [
    { name: 'provider error', planner: makePlanner({ error: true }) },
    { name: 'typed provider error', planner: makePlanner({ result: { status: 'provider_error', capability: INVESTIGATION_PLAN_CAPABILITY } }) },
    { name: 'missing usage', planner: makePlanner({ result: { status: 'succeeded', capability: INVESTIGATION_PLAN_CAPABILITY, value: proposedPlan(), usage: undefined } }) },
    { name: 'over-cap usage', planner: makePlanner({ result: successfulOutcome(proposedPlan(), malformedUsage) }) },
    { name: 'invalid plan', planner: makePlanner({ result: successfulOutcome({ ...proposedPlan(), actionName: 'unregistered_action' }) }) },
  ];
  for (const scenario of cases) {
    const ledger = makeLedger();
    const result = await makeExecutor({ ledger: ledger.repository, planner: scenario.planner.planner }).executor.plan(makeProposal());
    assert.equal(result.status, 'review_required', scenario.name);
    if (result.status === 'review_required') assert.equal(result.reason, 'planner_failed', scenario.name);
    assert.equal(scenario.planner.calls.filter((call) => call === 'planner').length, 1, scenario.name);
    assert.equal(ledger.reconcileInputs.length, 1, scenario.name);
    assert.deepEqual(ledger.reconcileInputs[0], {
      datasetKind: 'synthetic',
      investigationId: 'investigation_reasoning_step',
      reservationId: 'reservation_reasoning_step_1',
      expectedCheckpointVersion: 3,
      outcome: 'failed',
      actualActiveSeconds: 9,
      actualModelTokens: 80,
      finishedAt: timestamp,
    }, scenario.name);
  }
});

test('timeout aborts the planner signal, charges full reservation and discards a late result', async () => {
  const ledger = makeLedger();
  const timer = new FakeTimer();
  let lateResolve: ((value: unknown) => void) | undefined;
  let signal: AbortSignal | undefined;
  const planner = makePlanner({
    onCall: (callSignal) => {
      signal = callSignal;
      timer.fire();
    },
    result: new Promise((resolve) => { lateResolve = resolve; }),
  });
  const result = await makeExecutor({ ledger: ledger.repository, planner: planner.planner, timer }).executor.plan(makeProposal());
  assert.deepEqual(result, { status: 'review_required', reason: 'planner_timed_out', checkpoint: ledger.finalCheckpoint });
  assert.equal(signal?.aborted, true);
  assert.equal(planner.calls.filter((call) => call === 'planner').length, 1);
  assert.equal(ledger.reconcileInputs.length, 1);
  assert.equal(ledger.reconcileInputs[0]?.outcome, 'timed_out');
  assert.equal(ledger.reconcileInputs[0]?.actualActiveSeconds, 9);
  assert.equal(ledger.reconcileInputs[0]?.actualModelTokens, 80);
  assert.equal(ledger.reconcileInputs[0]?.modelRun, undefined);
  lateResolve?.(successfulOutcome());
});

test('a delayed timer callback cannot allow a result at the reserved deadline', async () => {
  const ledger = makeLedger();
  const clock = makeClock();
  const timer = new FakeTimer();
  let signal: AbortSignal | undefined;
  const planner = makePlanner({
    onCall: (callSignal) => {
      signal = callSignal;
      clock.advance(9_000);
    },
  });
  const result = await makeExecutor({ ledger: ledger.repository, planner: planner.planner, clock, timer }).executor.plan(makeProposal());

  assert.deepEqual(result, { status: 'review_required', reason: 'planner_timed_out', checkpoint: ledger.finalCheckpoint });
  assert.equal(signal?.aborted, true);
  assert.equal(ledger.reconcileInputs[0]?.outcome, 'timed_out');
  assert.equal(ledger.reconcileInputs[0]?.actualActiveSeconds, 9);
  assert.equal(ledger.reconcileInputs[0]?.actualModelTokens, 80);
});

test('timer setup failure and start acknowledgement uncertainty make no planner call', async () => {
  const timerLedger = makeLedger();
  const timerPlanner = makePlanner();
  const timerFailure = await makeExecutor({
    ledger: timerLedger.repository,
    planner: timerPlanner.planner,
    timer: new FakeTimer(true),
  }).executor.plan(makeProposal());
  assert.deepEqual(timerFailure, { status: 'review_required', reason: 'timer_unavailable', checkpoint: timerLedger.finalCheckpoint });
  assert.equal(timerPlanner.calls.includes('planner'), false);
  assert.equal(timerLedger.reconcileInputs[0]?.outcome, 'failed');
  assert.equal(timerLedger.reconcileInputs[0]?.actualModelTokens, 80);

  const uncertainLedger = makeLedger({ startError: new Error('private start acknowledgement') });
  const uncertainPlanner = makePlanner();
  const uncertain = await makeExecutor({ ledger: uncertainLedger.repository, planner: uncertainPlanner.planner }).executor.plan(makeProposal());
  assert.deepEqual(uncertain, { status: 'review_required', reason: 'ledger_state_uncertain', checkpoint: uncertainLedger.reservationCheckpoint });
  assert.equal(uncertainPlanner.calls.includes('planner'), false);
  assert.equal(uncertainLedger.reconcileInputs.length, 0);
});

test('reservation denials and uncertain reconciliation do not repeat the planner call', async () => {
  const deniedLedger = makeLedger({ reserveError: new InvestigationLedgerError('budget_exhausted') });
  const deniedPlanner = makePlanner();
  const denied = await makeExecutor({ ledger: deniedLedger.repository, planner: deniedPlanner.planner }).executor.plan(makeProposal());
  assert.deepEqual(denied, { status: 'review_required', reason: 'budget_exhausted', checkpoint: makeCheckpoint(2) });
  assert.equal(deniedPlanner.calls.includes('planner'), false);

  const uncertainLedger = makeLedger({ reconcileError: new Error('commit acknowledgement uncertain') });
  const uncertainPlanner = makePlanner();
  const uncertain = await makeExecutor({ ledger: uncertainLedger.repository, planner: uncertainPlanner.planner }).executor.plan(makeProposal());
  assert.deepEqual(uncertain, { status: 'review_required', reason: 'reconciliation_uncertain' });
  assert.equal(uncertainPlanner.calls.filter((call) => call === 'planner').length, 1);
  assert.equal(uncertainLedger.reconcileInputs.length, 1);
});

test('optional telemetry decorates only ledger writes and preserves planner behavior', async () => {
  const records: TelemetryRecord[] = [];
  const sink: TelemetrySink = { record(record) { records.push(record); } };
  const ledger = makeLedger();
  const planner = makePlanner();
  const result = await makeExecutor({ ledger: ledger.repository, planner: planner.planner, telemetry: sink }).executor.plan(makeProposal());
  assert.equal(result.status, 'proposed');
  assert.deepEqual(records.map((record) => record.eventName === 'l3_ledger_operation' ? record.operation : 'other'), [
    'reserve_action', 'start_action', 'reconcile_action',
  ]);
  assert.equal(JSON.stringify(records).includes('investigation_reasoning_step'), false);
  assert.equal(JSON.stringify(records).includes('synthetic_search'), false);
});
