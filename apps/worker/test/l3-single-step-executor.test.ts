import assert from 'node:assert/strict';
import test from 'node:test';
import { InvestigationLedgerError } from '../../db/src/investigation-ledger.js';
import type {
  InvestigationCheckpointRecord,
  InvestigationLedgerRepository,
  ReconcileActionInput,
  ReservationOperationResult,
  ReservationRecord,
  ReserveActionInput,
} from '../../db/src/investigation-ledger.js';
import {
  createSingleStepExecutor,
  type InvestigationActionInputParseResult,
  type InvestigationActionRegistration,
  type SingleStepExecutorClock,
  type SingleStepExecutorTimer,
} from '../src/layers/l3-investigation/single-step-executor.js';
import type { TelemetryRecord, TelemetrySink } from '../src/layers/l5-evaluation-monitoring/telemetry.js';

const timestamp = '2026-09-26T00:00:00.000Z';
const actionName = 'synthetic_lookup';

test('orders reserve, start, one handler call, and reconcile with bounded success data', async () => {
  const calls: string[] = [];
  const ledger = makeLedger({ calls });
  const clock = makeClock();
  let handlerCalls = 0;
  const originalInput = { query: 'synthetic-query' };
  const inputSnapshot = structuredClone(originalInput);
  const executor = makeExecutor({
    ledger: ledger.repository,
    clock,
    calls,
    handler(input) {
      handlerCalls += 1;
      (input as { query: string }).query = 'handler-mutated-copy';
      clock.advance(1_250);
      return { status: 'succeeded', outputReferenceIds: ['evidence_ref_1'] };
    },
  });

  const result = await executor.execute(makeProposal(originalInput));

  assert.deepEqual(calls, ['reserve', 'start', 'handler', 'reconcile']);
  assert.equal(handlerCalls, 1);
  assert.deepEqual(originalInput, inputSnapshot);
  assert.deepEqual(ledger.reserveInputs[0], {
    datasetKind: 'synthetic',
    investigationId: 'investigation_synthetic',
    reservationId: 'reservation_synthetic_1',
    expectedCheckpointVersion: 2,
    actionKind: 'tool',
    actionName,
    reservedActiveSeconds: 7,
    reservedModelTokens: 0,
    reservedAt: timestamp,
  });
  assert.deepEqual(ledger.startInputs[0], {
    datasetKind: 'synthetic',
    investigationId: 'investigation_synthetic',
    reservationId: 'reservation_synthetic_1',
    startedAt: timestamp,
  });
  assert.deepEqual(ledger.reconcileInputs[0], {
    datasetKind: 'synthetic',
    investigationId: 'investigation_synthetic',
    reservationId: 'reservation_synthetic_1',
    expectedCheckpointVersion: 7,
    outcome: 'succeeded',
    actualActiveSeconds: 2,
    actualModelTokens: 0,
    finishedAt: timestamp,
  });
  assert.deepEqual(result, {
    status: 'executed',
    checkpoint: ledger.finalCheckpoint,
    receipt: { outcome: 'succeeded', outputReferenceIds: ['evidence_ref_1'] },
  });
});

test('rejects malformed, unknown, disabled, and action-invalid proposals before ledger access', async () => {
  const scenarios: Array<{
    readonly name: string;
    readonly proposal: unknown;
    readonly disabled?: boolean;
    readonly parseInput?: InvestigationActionRegistration['parseInput'];
    readonly expected: unknown;
  }> = [
    {
      name: 'malformed proposal',
      proposal: { ...makeProposal(), extra: 'private action payload' },
      expected: { status: 'review_required', reason: 'invalid_proposal' },
    },
    {
      name: 'unknown action',
      proposal: makeProposal(undefined, 'not_registered'),
      expected: { status: 'denied', reason: 'unknown_action' },
    },
    {
      name: 'disabled action',
      proposal: makeProposal(),
      disabled: true,
      expected: { status: 'denied', reason: 'action_disabled' },
    },
    {
      name: 'invalid action-specific input',
      proposal: makeProposal({ query: '' }),
      parseInput: () => ({ ok: false }),
      expected: { status: 'review_required', reason: 'invalid_action_input' },
    },
  ];

  for (const scenario of scenarios) {
    const ledger = makeLedger();
    let handlerCalls = 0;
    const executor = makeExecutor({
      ledger: ledger.repository,
      disabled: scenario.disabled,
      parseInput: scenario.parseInput,
      handler() {
        handlerCalls += 1;
        return { status: 'succeeded' };
      },
    });

    assert.deepEqual(await executor.execute(scenario.proposal), scenario.expected, scenario.name);
    assert.deepEqual(ledger.calls, [], scenario.name);
    assert.equal(handlerCalls, 0, scenario.name);
  }
});

test('ledger expected denials return closed review results without invoking the handler', async () => {
  const scenarios: Array<{
    readonly name: string;
    readonly latest: InvestigationCheckpointRecord | null;
    readonly reserveError: InvestigationLedgerError;
    readonly reason: string;
  }> = [
    {
      name: 'missing case',
      latest: null,
      reserveError: new InvestigationLedgerError('investigation_not_found'),
      reason: 'investigation_not_found',
    },
    {
      name: 'closed case',
      latest: makeCheckpoint(2, { case_status: 'completed' }),
      reserveError: new InvestigationLedgerError('invalid_state'),
      reason: 'investigation_not_open',
    },
    {
      name: 'stale version',
      latest: makeCheckpoint(3),
      reserveError: new InvestigationLedgerError('stale_checkpoint'),
      reason: 'stale_checkpoint',
    },
    {
      name: 'another reservation is active',
      latest: makeCheckpoint(2),
      reserveError: new InvestigationLedgerError('reservation_in_flight'),
      reason: 'reservation_in_flight',
    },
    {
      name: 'mismatched checkpoint identity is not returned',
      latest: makeCheckpoint(2, { dataset_kind: 'historical' }),
      reserveError: new InvestigationLedgerError('investigation_not_found'),
      reason: 'investigation_not_found',
    },
  ];

  for (const scenario of scenarios) {
    const ledger = makeLedger({ latestCheckpoint: scenario.latest, reserveError: scenario.reserveError });
    let handlerCalls = 0;
    const executor = makeExecutor({
      ledger: ledger.repository,
      handler() {
        handlerCalls += 1;
        return { status: 'succeeded' };
      },
    });

    const result = await executor.execute(makeProposal());
    const latestMatchesProposal = scenario.latest?.dataset_kind === 'synthetic'
      && scenario.latest.investigation_id === 'investigation_synthetic';
    assert.deepEqual(result, {
      status: 'review_required',
      reason: scenario.reason,
      ...(latestMatchesProposal ? { checkpoint: scenario.latest! } : {}),
    }, scenario.name);
    assert.deepEqual(ledger.calls, ['reserve', 'getLatest'], scenario.name);
    assert.equal(handlerCalls, 0, scenario.name);
  }
});

test('checkpoint lookup errors after an expected denial preserve identity', async () => {
  const error = new Error('synthetic checkpoint read failure');
  const ledger = makeLedger({
    latestCheckpoint: makeCheckpoint(3),
    latestError: error,
    reserveError: new InvestigationLedgerError('stale_checkpoint'),
  });
  let handlerCalls = 0;
  const executor = makeExecutor({
    ledger: ledger.repository,
    handler() {
      handlerCalls += 1;
      return { status: 'succeeded' };
    },
  });

  await assert.rejects(executor.execute(makeProposal()), (actual: unknown) => actual === error);
  assert.deepEqual(ledger.calls, ['reserve', 'getLatest']);
  assert.equal(handlerCalls, 0);
});

test('an exact in-flight reservation replay reaches the ledger after checkpoint advancement', async () => {
  const ledger = makeLedger({
    latestCheckpoint: makeCheckpoint(3),
    inFlightReservation: makeReservation(),
    reserveResult: (checkpoint) => ({
      reservation: makeReservation(),
      checkpoint,
      mayInvoke: false,
      replayed: true,
    }),
  });
  let handlerCalls = 0;
  const executor = makeExecutor({
    ledger: ledger.repository,
    handler() {
      handlerCalls += 1;
      return { status: 'succeeded' };
    },
  });

  const result = await executor.execute(makeProposal());

  assert.deepEqual(ledger.calls, ['reserve']);
  assert.equal(handlerCalls, 0);
  assert.deepEqual(result, { status: 'replayed', checkpoint: ledger.reservationCheckpoint });
  assert.equal(ledger.reserveInputs[0]?.reservationId, 'reservation_synthetic_1');
  assert.equal(ledger.reserveInputs[0]?.expectedCheckpointVersion, 2);
});

test('a completed reservation ID replay wins over a closed case and different in-flight reservation', async () => {
  const completedReservation: ReservationRecord = {
    ...makeReservation(),
    status: 'reconciled',
    outcome: 'succeeded',
    actual: { activeSeconds: 1, modelTokens: 0 },
    finishedAt: timestamp,
    reconciledCheckpointVersion: 3,
  };
  const ledger = makeLedger({
    latestCheckpoint: makeCheckpoint(3, { case_status: 'completed' }),
    inFlightReservation: makeReservation({ reservationId: 'reservation_other' }),
    reserveResult: (checkpoint) => ({
      reservation: completedReservation,
      checkpoint,
      mayInvoke: false,
      replayed: true,
    }),
  });
  let handlerCalls = 0;
  const executor = makeExecutor({
    ledger: ledger.repository,
    handler() {
      handlerCalls += 1;
      return { status: 'succeeded' };
    },
  });

  const result = await executor.execute(makeProposal());

  assert.deepEqual(ledger.calls, ['reserve']);
  assert.equal(handlerCalls, 0);
  assert.deepEqual(result, { status: 'replayed', checkpoint: ledger.reservationCheckpoint });
  assert.equal(ledger.reserveInputs[0]?.reservationId, completedReservation.reservationId);
  assert.equal(ledger.reserveInputs[0]?.expectedCheckpointVersion, 2);
});

test('a non-invocable or replayed start returns its checkpoint without invoking', async () => {
  for (const startResult of [
    { mayInvoke: false, replayed: false },
    { mayInvoke: false, replayed: true },
    { mayInvoke: true, replayed: true },
  ]) {
    const ledger = makeLedger({
      startResult: (checkpoint) => ({
        reservation: makeReservation({ status: startResult.replayed ? 'started' : 'reserved' }),
        checkpoint,
        ...startResult,
      }),
    });
    let handlerCalls = 0;
    const executor = makeExecutor({
      ledger: ledger.repository,
      handler() {
        handlerCalls += 1;
        return { status: 'succeeded' };
      },
    });

    const result = await executor.execute(makeProposal());
    assert.deepEqual(ledger.calls, ['reserve', 'start']);
    assert.equal(handlerCalls, 0);
    if (startResult.replayed) {
      assert.deepEqual(result, { status: 'replayed', checkpoint: ledger.startCheckpoint });
    } else {
      assert.deepEqual(result, {
        status: 'review_required',
        reason: 'start_not_authorized',
        checkpoint: ledger.startCheckpoint,
      });
    }
  }
});

test('reservation and start errors pass through unchanged and prevent invocation', async () => {
  for (const failingStage of ['reserve', 'start'] as const) {
    const error = new Error('synthetic private ledger failure');
    const ledger = makeLedger(failingStage === 'reserve'
      ? { reserveError: error }
      : { startError: error });
    let handlerCalls = 0;
    const executor = makeExecutor({
      ledger: ledger.repository,
      handler() {
        handlerCalls += 1;
        return { status: 'succeeded' };
      },
    });

    await assert.rejects(executor.execute(makeProposal()), (actual: unknown) => actual === error);
    assert.equal(handlerCalls, 0);
    assert.deepEqual(ledger.calls, failingStage === 'reserve'
      ? ['reserve']
      : ['reserve', 'start']);
  }
});

test('timeout aborts the handler and reconciles timed_out at the explicit maximum', async () => {
  const calls: string[] = [];
  const ledger = makeLedger({ calls });
  const timer = new FakeTimer();
  let signal: AbortSignal | undefined;
  let handlerCalls = 0;
  let resolveLate: ((value: unknown) => void) | undefined;
  let notifyStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  const executor = makeExecutor({
    ledger: ledger.repository,
    calls,
    timer,
    handler(_input, context) {
      handlerCalls += 1;
      signal = context.signal;
      notifyStarted?.();
      return new Promise((resolve) => {
        resolveLate = resolve;
      });
    },
  });

  const execution = executor.execute(makeProposal());
  await started;
  assert.equal(timer.lastDelayMs, 7_000);
  timer.fire();
  const result = await execution;
  resolveLate?.({ status: 'succeeded', outputReferenceIds: ['late_reference'] });
  await Promise.resolve();

  assert.equal(signal?.aborted, true);
  assert.equal(handlerCalls, 1);
  assert.deepEqual(calls, ['reserve', 'start', 'handler', 'reconcile']);
  assert.equal(ledger.reconcileInputs.length, 1);
  assert.equal(ledger.reconcileInputs[0]?.outcome, 'timed_out');
  assert.equal(ledger.reconcileInputs[0]?.actualActiveSeconds, 7);
  assert.deepEqual(result, {
    status: 'executed',
    checkpoint: ledger.finalCheckpoint,
    receipt: { outcome: 'timed_out', outputReferenceIds: [] },
  });
});

test('a synchronously fired deadline is reconciled without invoking the handler', async () => {
  const calls: string[] = [];
  const ledger = makeLedger({ calls });
  const timer = new FakeTimer({ fireImmediately: true });
  let handlerCalls = 0;
  const executor = makeExecutor({
    ledger: ledger.repository,
    calls,
    timer,
    handler() {
      handlerCalls += 1;
      return { status: 'succeeded' };
    },
  });

  const result = await executor.execute(makeProposal());

  assert.equal(handlerCalls, 0);
  assert.deepEqual(calls, ['reserve', 'start', 'reconcile']);
  assert.equal(ledger.reconcileInputs[0]?.outcome, 'timed_out');
  assert.equal(ledger.reconcileInputs[0]?.actualActiveSeconds, 7);
  assert.deepEqual(result, {
    status: 'executed',
    checkpoint: ledger.finalCheckpoint,
    receipt: { outcome: 'timed_out', outputReferenceIds: [] },
  });

  const reentrantCalls: string[] = [];
  const reentrantLedger = makeLedger({ calls: reentrantCalls });
  const reentrantTimer = new FakeTimer();
  const baseClock = makeClock();
  let firedFromClock = false;
  const reentrantClock: TestClock = {
    wallNow: baseClock.wallNow,
    monotonicNow() {
      if (!firedFromClock) {
        firedFromClock = true;
        reentrantTimer.fire();
      }
      return baseClock.monotonicNow();
    },
    advance: baseClock.advance,
  };
  let reentrantHandlerCalls = 0;
  const reentrantExecutor = makeExecutor({
    ledger: reentrantLedger.repository,
    calls: reentrantCalls,
    clock: reentrantClock,
    timer: reentrantTimer,
    handler() {
      reentrantHandlerCalls += 1;
      return { status: 'succeeded' };
    },
  });
  const reentrantResult = await reentrantExecutor.execute(makeProposal());
  assert.equal(reentrantHandlerCalls, 0);
  assert.deepEqual(reentrantCalls, ['reserve', 'start', 'reconcile']);
  assert.equal(reentrantLedger.reconcileInputs[0]?.outcome, 'timed_out');
  assert.deepEqual(reentrantResult, {
    status: 'executed',
    checkpoint: reentrantLedger.finalCheckpoint,
    receipt: { outcome: 'timed_out', outputReferenceIds: [] },
  });
});

test('exceptions and malformed handler receipts become generic full-reservation failures', async () => {
  const rawMarker = 'private source text https://secret.invalid/article';
  const outputs: Array<() => unknown> = [
    () => {
      throw new Error(rawMarker);
    },
    () => ({ status: 'succeeded', outputReferenceIds: ['source text'], arbitrary: rawMarker }),
    () => ({ status: 'succeeded', outputReferenceIds: [rawMarker] }),
  ];

  for (const output of outputs) {
    const ledger = makeLedger();
    const executor = makeExecutor({ ledger: ledger.repository, handler: output });
    const result = await executor.execute(makeProposal());

    assert.equal(ledger.reconcileInputs.length, 1);
    assert.equal(ledger.reconcileInputs[0]?.outcome, 'failed');
    assert.equal(ledger.reconcileInputs[0]?.actualActiveSeconds, 7);
    assert.equal(ledger.reconcileInputs[0]?.actualModelTokens, 0);
    assert.deepEqual(result, {
      status: 'executed',
      checkpoint: ledger.finalCheckpoint,
      receipt: { outcome: 'failed', outputReferenceIds: [] },
    });
    assert.equal(JSON.stringify(result).includes(rawMarker), false);
    assert.equal(JSON.stringify(ledger.reconcileInputs).includes(rawMarker), false);
  }
});

test('a handler failure observed after the monotonic deadline is classified as timed out', async () => {
  const calls: string[] = [];
  const ledger = makeLedger({ calls });
  const clock = makeClock();
  const executor = makeExecutor({
    ledger: ledger.repository,
    calls,
    clock,
    handler() {
      clock.advance(7_001);
      throw new Error('synthetic late failure');
    },
  });

  const result = await executor.execute(makeProposal());

  assert.deepEqual(calls, ['reserve', 'start', 'handler', 'reconcile']);
  assert.equal(ledger.reconcileInputs[0]?.outcome, 'timed_out');
  assert.equal(ledger.reconcileInputs[0]?.actualActiveSeconds, 7);
  assert.deepEqual(result, {
    status: 'executed',
    checkpoint: ledger.finalCheckpoint,
    receipt: { outcome: 'timed_out', outputReferenceIds: [] },
  });
});

test('reconciliation failures preserve the exact ledger error after one invocation', async () => {
  const error = new Error('synthetic private reconcile failure');
  const calls: string[] = [];
  const ledger = makeLedger({ calls, reconcileError: error });
  let handlerCalls = 0;
  const executor = makeExecutor({
    ledger: ledger.repository,
    calls,
    handler() {
      handlerCalls += 1;
      return { status: 'succeeded', outputReferenceIds: ['stable_ref_1'] };
    },
  });

  await assert.rejects(executor.execute(makeProposal()), (actual: unknown) => actual === error);
  assert.equal(handlerCalls, 1);
  assert.deepEqual(calls, ['reserve', 'start', 'handler', 'reconcile']);
  assert.equal(ledger.reconcileInputs.length, 1);
});

test('injected ledger telemetry records the three ledger transitions without executor duplicates', async () => {
  const ledger = makeLedger();
  const records: TelemetryRecord[] = [];
  const telemetry: TelemetrySink = { record: (record) => records.push(record) };
  const executor = makeExecutor({
    ledger: ledger.repository,
    telemetry,
    handler: () => ({ status: 'succeeded', outputReferenceIds: ['stable_ref_1'] }),
  });

  await executor.execute(makeProposal());

  assert.equal(records.length, 3);
  assert.deepEqual(records.map((record) => (
    record.eventName === 'l3_ledger_operation' ? record.operation : 'unexpected'
  )), ['reserve_action', 'start_action', 'reconcile_action']);
});

test('invalid registry entries fail closed at executor construction', () => {
  const invalidRegistrations = [
    [{ ...makeAction(), maxActiveSeconds: 0 }],
    [{ ...makeAction(), enabled: undefined }],
    [makeAction(), makeAction()],
  ];

  for (const registry of invalidRegistrations) {
    assert.throws(() => createSingleStepExecutor({
      ledger: makeLedger().repository,
      registry: registry as unknown as readonly InvestigationActionRegistration[],
      clock: makeClock(),
      timer: new FakeTimer(),
    }), { message: 'invalid_action_registry' });
  }
});

function makeExecutor(input: {
  readonly ledger: InvestigationLedgerRepository;
  readonly calls?: string[];
  readonly clock?: TestClock;
  readonly timer?: FakeTimer;
  readonly disabled?: boolean;
  readonly parseInput?: InvestigationActionRegistration['parseInput'];
  readonly handler?: InvestigationActionRegistration['handler'];
  readonly telemetry?: TelemetrySink;
}): ReturnType<typeof createSingleStepExecutor> {
  const calls = input.calls ?? [];
  const clock = input.clock ?? makeClock();
  const timer = input.timer ?? new FakeTimer();
  const handler = input.handler ?? (() => ({ status: 'succeeded' }));
  const action = makeAction({
    enabled: input.disabled !== true,
    parseInput: input.parseInput,
    handler: (value, context) => {
      calls.push('handler');
      return handler(value, context);
    },
  });
  return createSingleStepExecutor({
    ledger: input.ledger,
    registry: [action],
    clock,
    timer,
    ...(input.telemetry ? { telemetry: input.telemetry } : {}),
  });
}

function makeAction(overrides: {
  readonly enabled?: boolean;
  readonly maxActiveSeconds?: number;
  readonly parseInput?: InvestigationActionRegistration['parseInput'];
  readonly handler?: InvestigationActionRegistration['handler'];
  readonly calls?: string[];
} = {}): InvestigationActionRegistration {
  return {
    name: actionName,
    enabled: overrides.enabled ?? true,
    maxActiveSeconds: overrides.maxActiveSeconds ?? 7,
    parseInput: overrides.parseInput ?? parseSyntheticInput,
    handler: overrides.handler ?? (() => ({ status: 'succeeded' })),
  };
}

function parseSyntheticInput(value: unknown): InvestigationActionInputParseResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false };
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'query' || typeof (value as { query?: unknown }).query !== 'string'
    || (value as { query: string }).query.length === 0) return { ok: false };
  return { ok: true, value };
}

function makeProposal(input: unknown = { query: 'synthetic-query' }, name = actionName): Record<string, unknown> {
  return {
    datasetKind: 'synthetic',
    investigationId: 'investigation_synthetic',
    expectedCheckpointVersion: 2,
    reservationId: 'reservation_synthetic_1',
    reservedAt: timestamp,
    actionName: name,
    input,
  };
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
} = {}) {
  const calls = config.calls ?? [];
  const reserveInputs: ReserveActionInput[] = [];
  const startInputs: Array<Parameters<InvestigationLedgerRepository['startAction']>[0]> = [];
  const reconcileInputs: ReconcileActionInput[] = [];
  const latestCheckpoint = config.latestCheckpoint === undefined ? makeCheckpoint(2) : config.latestCheckpoint;
  const reservationCheckpoint = makeCheckpoint(7);
  const startCheckpoint = makeCheckpoint(7);
  const finalCheckpoint = makeCheckpoint(8);
  const repository: InvestigationLedgerRepository = {
    async create() {
      throw new Error('unexpected create');
    },
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
      return config.startResult?.(startCheckpoint) ?? {
        reservation: makeReservation({
          investigationId: input.investigationId,
          reservationId: input.reservationId,
          startedAt: input.startedAt,
          status: 'started',
        }),
        checkpoint: startCheckpoint,
        mayInvoke: true,
        replayed: false,
      };
    },
    async reconcileAction(input) {
      calls.push('reconcile');
      reconcileInputs.push(input);
      if (config.reconcileError) throw config.reconcileError;
      return { checkpoint: finalCheckpoint, replayed: false };
    },
    async reconcileInterrupted() {
      throw new Error('unexpected interrupted reconciliation');
    },
    async releaseUninvoked() {
      throw new Error('unexpected uninvoked release');
    },
    async pause() {
      throw new Error('unexpected pause');
    },
    async resume() {
      throw new Error('unexpected resume');
    },
    async terminate() {
      throw new Error('unexpected terminate');
    },
  };

  return {
    calls,
    reserveInputs,
    startInputs,
    reconcileInputs,
    reservationCheckpoint,
    startCheckpoint,
    finalCheckpoint,
    repository,
  };
}

function makeReservation(input: Partial<ReserveActionInput & { startedAt: string; status: 'reserved' | 'started' }> = {}): ReservationRecord {
  return {
    datasetKind: input.datasetKind ?? 'synthetic',
    reservationId: input.reservationId ?? 'reservation_synthetic_1',
    investigationId: input.investigationId ?? 'investigation_synthetic',
    actionKind: input.actionKind ?? 'tool',
    actionName: input.actionName ?? actionName,
    expectedCheckpointVersion: input.expectedCheckpointVersion ?? 2,
    reserved: {
      toolAttempts: 1,
      reasoningTurns: 0,
      activeSeconds: input.reservedActiveSeconds ?? 7,
      modelTokens: 0,
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
    trace_id: 'trace_synthetic',
    record_type: 'InvestigationCheckpoint',
    dataset_kind: 'synthetic',
    checkpoint_id: 'checkpoint_synthetic_' + version,
    investigation_id: 'investigation_synthetic',
    checkpoint_version: version,
    candidate_id: 'candidate_synthetic',
    context_id: 'context_synthetic',
    event_id: null,
    event_version: null,
    case_status: 'open',
    stop_reason: null,
    budget: {
      policy_version: 'policy_synthetic_v1',
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

interface TestClock extends SingleStepExecutorClock {
  advance(milliseconds: number): void;
}

function makeClock(): TestClock {
  let monotonic = 0;
  return {
    wallNow: () => timestamp,
    monotonicNow: () => monotonic,
    advance(milliseconds) {
      monotonic += milliseconds;
    },
  };
}

class FakeTimer implements SingleStepExecutorTimer {
  callback: (() => void) | undefined;
  lastDelayMs: number | undefined;

  constructor(private readonly options: { readonly fireImmediately?: boolean } = {}) {}

  setTimeout(callback: () => void, delayMs: number): unknown {
    this.callback = callback;
    this.lastDelayMs = delayMs;
    if (this.options.fireImmediately) callback();
    return callback;
  }

  clearTimeout(handle: unknown): void {
    if (handle === this.callback) this.callback = undefined;
  }

  fire(): void {
    this.callback?.();
  }
}
