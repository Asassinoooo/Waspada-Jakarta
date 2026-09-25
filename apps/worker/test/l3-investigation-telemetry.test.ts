import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  BudgetCounters,
  BudgetLedgerRecord,
  CreateInvestigationInput,
  InvestigationCheckpointRecord,
  InvestigationLedgerRepository,
  LedgerOperationResult,
  ReconcileActionInput,
  ReservationOperationResult,
  ReservationRecord,
  ReserveActionInput,
} from '../../db/src/investigation-ledger.js';
import {
  createTelemetryInvestigationLedgerRepository,
} from '../src/layers/l3-investigation/telemetry.js';
import {
  L3_LEDGER_OPERATION_EVENT_NAME,
  consoleTelemetry,
  type L3LedgerOperation,
  type TelemetryRecord,
  type TelemetrySink,
} from '../src/layers/l5-evaluation-monitoring/telemetry.js';

const timestamp = '2026-09-26T00:00:00.000Z';
const privateMarkers = [
  'trace-secret-marker',
  'investigation-secret-marker',
  'candidate-secret-marker',
  'context-secret-marker',
  'checkpoint-secret-marker',
  'reservation-secret-marker',
  'question-secret-marker',
  'tool-name-secret-marker',
  'model-secret-marker',
  'prompt-secret-marker',
];

const checkpoint = makeCheckpoint();
const ledgerResult: LedgerOperationResult = { checkpoint, replayed: false };
const reservation = makeReservation();
const reservationResult: ReservationOperationResult = {
  reservation,
  checkpoint,
  mayInvoke: false,
  replayed: false,
};

const createInput: CreateInvestigationInput = {
  datasetKind: 'synthetic',
  investigationId: 'investigation-secret-marker',
  traceId: 'trace-secret-marker',
  candidateId: 'candidate-secret-marker',
  contextId: 'context-secret-marker',
  eventId: null,
  eventVersion: null,
  questions: ['question-secret-marker'],
  policyVersion: 'policy-secret-marker',
  limits: {
    toolAttempts: 5,
    reasoningTurns: 4,
    activeSeconds: 60,
    modelTokens: 12_000,
  },
  requestedAt: timestamp,
};

const reserveInput: ReserveActionInput = {
  datasetKind: 'synthetic',
  investigationId: 'investigation-secret-marker',
  reservationId: 'reservation-secret-marker',
  expectedCheckpointVersion: 1,
  actionKind: 'tool',
  actionName: 'tool-name-secret-marker',
  reservedActiveSeconds: 5,
  reservedModelTokens: 0,
  reservedAt: timestamp,
};

const startInput: Parameters<InvestigationLedgerRepository['startAction']>[0] = {
  datasetKind: 'synthetic',
  investigationId: 'investigation-secret-marker',
  reservationId: 'reservation-secret-marker',
  startedAt: timestamp,
};

const reconcileInput: ReconcileActionInput = {
  datasetKind: 'synthetic',
  investigationId: 'investigation-secret-marker',
  reservationId: 'reservation-secret-marker',
  expectedCheckpointVersion: 1,
  outcome: 'succeeded',
  actualActiveSeconds: 4,
  actualModelTokens: 0,
  finishedAt: timestamp,
};

const reconcileInterruptedInput: Parameters<InvestigationLedgerRepository['reconcileInterrupted']>[0] = {
  datasetKind: 'synthetic',
  investigationId: 'investigation-secret-marker',
  reservationId: 'reservation-secret-marker',
  expectedCheckpointVersion: 1,
  finishedAt: timestamp,
};

const releaseInput: Parameters<InvestigationLedgerRepository['releaseUninvoked']>[0] = {
  datasetKind: 'synthetic',
  investigationId: 'investigation-secret-marker',
  reservationId: 'reservation-secret-marker',
  expectedCheckpointVersion: 1,
  releasedAt: timestamp,
};

const pauseInput: Parameters<InvestigationLedgerRepository['pause']>[0] = {
  datasetKind: 'synthetic',
  investigationId: 'investigation-secret-marker',
  expectedCheckpointVersion: 1,
  pausedAt: timestamp,
};

const resumeInput: Parameters<InvestigationLedgerRepository['resume']>[0] = {
  datasetKind: 'synthetic',
  investigationId: 'investigation-secret-marker',
  expectedCheckpointVersion: 1,
  resumedAt: timestamp,
  contextId: 'context-secret-marker',
};

const terminateInput: Parameters<InvestigationLedgerRepository['terminate']>[0] = {
  datasetKind: 'synthetic',
  investigationId: 'investigation-secret-marker',
  expectedCheckpointVersion: 1,
  status: 'stopped_for_review',
  stopReason: 'material_conflict',
  completedAt: timestamp,
};

const writeOperations: Array<{
  operation: L3LedgerOperation;
  invoke: (repository: InvestigationLedgerRepository) => Promise<unknown>;
  expected: unknown;
}> = [
  { operation: 'create', invoke: (repository) => repository.create(createInput), expected: checkpoint },
  { operation: 'reserve_action', invoke: (repository) => repository.reserveAction(reserveInput), expected: reservationResult },
  { operation: 'start_action', invoke: (repository) => repository.startAction(startInput), expected: reservationResult },
  { operation: 'reconcile_action', invoke: (repository) => repository.reconcileAction(reconcileInput), expected: ledgerResult },
  {
    operation: 'reconcile_interrupted',
    invoke: (repository) => repository.reconcileInterrupted(reconcileInterruptedInput),
    expected: ledgerResult,
  },
  { operation: 'release_uninvoked', invoke: (repository) => repository.releaseUninvoked(releaseInput), expected: ledgerResult },
  { operation: 'pause', invoke: (repository) => repository.pause(pauseInput), expected: ledgerResult },
  { operation: 'resume', invoke: (repository) => repository.resume(resumeInput), expected: ledgerResult },
  { operation: 'terminate', invoke: (repository) => repository.terminate(terminateInput), expected: ledgerResult },
];

test('write transitions record only a bounded lifecycle and consumed-budget summary', async () => {
  for (const { operation, invoke, expected } of writeOperations) {
    const records: TelemetryRecord[] = [];
    const wrapped = createTelemetryInvestigationLedgerRepository(makeRepository(), recorder(records));
    const result = await invoke(wrapped);

    assert.strictEqual(result, expected);
    assert.equal(records.length, 1);
    const record = records[0];
    assert.ok(record);
    if (record.eventName !== L3_LEDGER_OPERATION_EVENT_NAME || record.outcome !== 'success') {
      assert.fail('expected one L3 ledger success record');
    }
    assert.deepEqual(Object.keys(record).sort(), [
      'caseStatus',
      'consumedActiveSeconds',
      'consumedModelTokens',
      'consumedReasoningTurns',
      'consumedToolAttempts',
      'durationMs',
      'eventName',
      'operation',
      'outcome',
      'stopReason',
    ]);
    assert.equal(record.operation, operation);
    assert.equal(record.caseStatus, 'open');
    assert.equal(record.stopReason, null);
    assert.equal(record.consumedToolAttempts, 2);
    assert.equal(record.consumedReasoningTurns, 1);
    assert.equal(record.consumedActiveSeconds, 7.25);
    assert.equal(record.consumedModelTokens, 31);
    assert.ok(Number.isFinite(record.durationMs));
    assert.ok(record.durationMs >= 0);

    const serialized = JSON.stringify(record);
    for (const marker of privateMarkers) assert.ok(!serialized.includes(marker), marker);
  }
});

test('success summaries retain the closed checkpoint status and stop reason', async () => {
  const terminalCheckpoint = makeCheckpoint({
    case_status: 'stopped_for_review',
    stop_reason: 'material_conflict',
  });
  const records: TelemetryRecord[] = [];
  const wrapped = createTelemetryInvestigationLedgerRepository(
    makeRepository({
      terminate: async () => ({ checkpoint: terminalCheckpoint, replayed: false }),
    }),
    recorder(records),
  );

  const result = await wrapped.terminate(terminateInput);

  assert.strictEqual(result.checkpoint, terminalCheckpoint);
  assert.equal(records.length, 1);
  const record = records[0];
  assert.ok(record);
  if (record.eventName !== L3_LEDGER_OPERATION_EVENT_NAME || record.outcome !== 'success') {
    assert.fail('expected one L3 ledger success record');
  }
  assert.equal(record.caseStatus, 'stopped_for_review');
  assert.equal(record.stopReason, 'material_conflict');
});

test('read methods pass through their exact promises and emit no telemetry', async () => {
  const latestPromise = Promise.resolve(checkpoint);
  const inFlightPromise = Promise.resolve(reservation);
  const records: TelemetryRecord[] = [];
  const wrapped = createTelemetryInvestigationLedgerRepository(
    makeRepository({
      getLatest: () => latestPromise,
      getInFlightReservation: () => inFlightPromise,
    }),
    recorder(records),
  );

  assert.strictEqual(wrapped.getLatest('synthetic', 'investigation-secret-marker'), latestPromise);
  assert.strictEqual(wrapped.getInFlightReservation('synthetic', 'investigation-secret-marker'), inFlightPromise);
  await Promise.all([latestPromise, inFlightPromise]);
  assert.deepEqual(records, []);
});

test('repository errors and throwing sinks preserve the original error and result identity', async () => {
  const originalError = new Error('repository-private-marker');
  const sinkFailure = new Error('sink-private-marker');
  const errorRecords: TelemetryRecord[] = [];
  const failingRepository = makeRepository({
    create: async () => {
      throw originalError;
    },
  });
  const wrappedFailure = createTelemetryInvestigationLedgerRepository(failingRepository, {
    record(record) {
      errorRecords.push(record);
      throw sinkFailure;
    },
  });

  await assert.rejects(wrappedFailure.create(createInput), (error: unknown) => error === originalError);
  assert.equal(errorRecords.length, 1);
  const errorRecord = errorRecords[0];
  assert.ok(errorRecord);
  if (errorRecord.eventName !== L3_LEDGER_OPERATION_EVENT_NAME || errorRecord.outcome !== 'error') {
    assert.fail('expected one L3 ledger error record');
  }
  assert.deepEqual(Object.keys(errorRecord).sort(), ['durationMs', 'eventName', 'operation', 'outcome']);
  assert.equal(errorRecord.operation, 'create');
  assert.ok(Number.isFinite(errorRecord.durationMs));
  assert.ok(errorRecord.durationMs >= 0);
  assert.ok(!JSON.stringify(errorRecord).includes('repository-private-marker'));
  assert.ok(!JSON.stringify(errorRecord).includes('sink-private-marker'));

  const wrappedSuccess = createTelemetryInvestigationLedgerRepository(makeRepository(), {
    record() {
      throw sinkFailure;
    },
  });
  assert.strictEqual(await wrappedSuccess.create(createInput), checkpoint);
});

test('invalid checkpoint summaries are omitted without changing the repository result', async () => {
  const invalidCheckpoint = makeCheckpoint({
    budget: makeBudget({
      consumed: {
        ...makeBudget().consumed,
        tool_attempts: Number.POSITIVE_INFINITY,
      },
    }),
  });
  const records: TelemetryRecord[] = [];
  const wrapped = createTelemetryInvestigationLedgerRepository(
    makeRepository({ create: async () => invalidCheckpoint }),
    recorder(records),
  );

  assert.strictEqual(await wrapped.create(createInput), invalidCheckpoint);
  assert.deepEqual(records, []);
});

test('console telemetry emits exact L3 allowlists and drops forged properties or discriminators', () => {
  const writes: unknown[] = [];
  const originalLog = console.log;
  console.log = (...messages: unknown[]) => {
    writes.push(...messages);
  };

  try {
    consoleTelemetry.record({
      eventName: L3_LEDGER_OPERATION_EVENT_NAME,
      operation: 'pause',
      outcome: 'success',
      durationMs: 12.5,
      caseStatus: 'paused',
      stopReason: 'no_progress',
      consumedToolAttempts: 2,
      consumedReasoningTurns: 1,
      consumedActiveSeconds: 7.25,
      consumedModelTokens: 31,
      traceId: 'trace-secret-marker',
      question: 'question-secret-marker',
      toolName: 'tool-name-secret-marker',
    } as TelemetryRecord);
    consoleTelemetry.record({
      eventName: L3_LEDGER_OPERATION_EVENT_NAME,
      operation: 'resume',
      outcome: 'error',
      durationMs: 2,
      exception: 'model-secret-marker',
    } as TelemetryRecord);

    const invalidRecords = [
      {
        eventName: L3_LEDGER_OPERATION_EVENT_NAME,
        operation: 'private-operation',
        outcome: 'success',
        durationMs: 1,
        caseStatus: 'paused',
        stopReason: null,
        consumedToolAttempts: 0,
        consumedReasoningTurns: 0,
        consumedActiveSeconds: 0,
        consumedModelTokens: 0,
      },
      {
        eventName: L3_LEDGER_OPERATION_EVENT_NAME,
        operation: 'pause',
        outcome: 'private-outcome',
        durationMs: 1,
      },
      {
        eventName: L3_LEDGER_OPERATION_EVENT_NAME,
        operation: 'pause',
        outcome: 'success',
        durationMs: Number.POSITIVE_INFINITY,
        caseStatus: 'paused',
        stopReason: null,
        consumedToolAttempts: 0,
        consumedReasoningTurns: 0,
        consumedActiveSeconds: 0,
        consumedModelTokens: 0,
      },
      {
        eventName: L3_LEDGER_OPERATION_EVENT_NAME,
        operation: 'pause',
        outcome: 'success',
        durationMs: 1,
        caseStatus: 'private-status',
        stopReason: 'private-stop-reason',
        consumedToolAttempts: -1,
        consumedReasoningTurns: 0,
        consumedActiveSeconds: 0,
        consumedModelTokens: 0,
      },
      {
        eventName: L3_LEDGER_OPERATION_EVENT_NAME,
        operation: 'pause',
        outcome: 'success',
        durationMs: 1,
        caseStatus: 'paused',
        stopReason: null,
        consumedToolAttempts: 0,
        consumedReasoningTurns: 0,
        consumedActiveSeconds: Number.NEGATIVE_INFINITY,
        consumedModelTokens: 0,
      },
      {
        eventName: 'private-event-name',
        operation: 'pause',
        outcome: 'error',
        durationMs: 1,
      },
    ];
    for (const record of invalidRecords) consoleTelemetry.record(record as unknown as TelemetryRecord);
  } finally {
    console.log = originalLog;
  }

  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0], {
    event_name: 'l3_ledger_operation',
    operation: 'pause',
    outcome: 'success',
    duration_ms: 12.5,
    case_status: 'paused',
    stop_reason: 'no_progress',
    consumed_tool_attempts: 2,
    consumed_reasoning_turns: 1,
    consumed_active_seconds: 7.25,
    consumed_model_tokens: 31,
  });
  assert.deepEqual(writes[1], {
    event_name: 'l3_ledger_operation',
    operation: 'resume',
    outcome: 'error',
    duration_ms: 2,
  });
  for (const write of writes) {
    assert.equal(Object.getPrototypeOf(write), Object.prototype);
    const serialized = JSON.stringify(write);
    for (const marker of privateMarkers) assert.ok(!serialized.includes(marker), marker);
  }
});

function recorder(records: TelemetryRecord[]): TelemetrySink {
  return { record: (record) => records.push(record) };
}

function makeRepository(
  overrides: Partial<InvestigationLedgerRepository> = {},
): InvestigationLedgerRepository {
  const defaults: InvestigationLedgerRepository = {
    create: async () => checkpoint,
    getLatest: async () => checkpoint,
    getInFlightReservation: async () => reservation,
    reserveAction: async () => reservationResult,
    startAction: async () => reservationResult,
    reconcileAction: async () => ledgerResult,
    reconcileInterrupted: async () => ledgerResult,
    releaseUninvoked: async () => ledgerResult,
    pause: async () => ledgerResult,
    resume: async () => ledgerResult,
    terminate: async () => ledgerResult,
  };
  return { ...defaults, ...overrides };
}

function makeCheckpoint(overrides: Partial<InvestigationCheckpointRecord> = {}): InvestigationCheckpointRecord {
  return {
    schema_version: '2.0',
    trace_id: 'trace-secret-marker',
    record_type: 'InvestigationCheckpoint',
    dataset_kind: 'synthetic',
    checkpoint_id: 'checkpoint-secret-marker',
    investigation_id: 'investigation-secret-marker',
    checkpoint_version: 4,
    candidate_id: 'candidate-secret-marker',
    context_id: 'context-secret-marker',
    event_id: null,
    event_version: null,
    case_status: 'open',
    stop_reason: null,
    budget: makeBudget(),
    attempts: [{
      attempt_id: 'reservation-secret-marker',
      tool: 'tool-name-secret-marker',
      outcome: 'succeeded',
      started_at: timestamp,
      finished_at: timestamp,
    }],
    reasoning_runs: [{
      capability: 'reasoning',
      model_version: 'model-secret-marker',
      prompt_version: 'prompt-secret-marker',
      input_tokens: 20,
      output_tokens: 11,
    }],
    created_at: timestamp,
    updated_at: timestamp,
    completed_at: null,
    ...overrides,
  };
}

function makeBudget(overrides?: Partial<BudgetLedgerRecord>): BudgetLedgerRecord {
  const consumed = {
    tool_attempts: 2,
    reasoning_turns: 1,
    active_seconds: 7.25,
    model_tokens: 31,
  };
  const zero: BudgetLedgerRecord['reserved'] = {
    tool_attempts: 0,
    reasoning_turns: 0,
    active_seconds: 0,
    model_tokens: 0,
  };
  return {
    policy_version: 'policy-secret-marker',
    limits: {
      tool_attempts: 5,
      reasoning_turns: 4,
      active_seconds: 60,
      model_tokens: 12_000,
    },
    consumed,
    reserved: zero,
    ...overrides,
  };
}

function makeReservation(): ReservationRecord {
  const zero: BudgetCounters = {
    toolAttempts: 0,
    reasoningTurns: 0,
    activeSeconds: 0,
    modelTokens: 0,
  };
  return {
    datasetKind: 'synthetic',
    reservationId: 'reservation-secret-marker',
    investigationId: 'investigation-secret-marker',
    actionKind: 'tool',
    actionName: 'tool-name-secret-marker',
    expectedCheckpointVersion: 1,
    reserved: { ...zero, toolAttempts: 1, activeSeconds: 5 },
    status: 'reserved',
    outcome: null,
    actual: { activeSeconds: 0, modelTokens: 0 },
    createdAt: timestamp,
    startedAt: null,
    finishedAt: null,
    reconciledCheckpointVersion: null,
  };
}
