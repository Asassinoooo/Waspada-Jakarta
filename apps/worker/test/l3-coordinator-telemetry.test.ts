import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  InvestigationCoordinator,
  InvestigationCoordinatorAdvanceInput,
  InvestigationCoordinatorOutcome,
} from '../src/layers/l3-investigation/contracts.js';
import { createTelemetryInvestigationCoordinator } from '../src/layers/l3-investigation/coordinator-telemetry.js';
import {
  L3_COORDINATOR_ADVANCE_EVENT_NAME,
  consoleTelemetry,
  type L3CoordinatorAdvanceOutcome,
  type TelemetryRecord,
  type TelemetrySink,
} from '../src/layers/l5-evaluation-monitoring/telemetry.js';

const input = {
  kind: 'sufficient_context',
  investigationId: null,
  context: 'input-secret-marker',
  persistedRecord: 'input-secret-marker',
} as unknown as InvestigationCoordinatorAdvanceInput;

test('each valid coordinator status emits one closed outcome and preserves result identity', async () => {
  for (const status of ['continue', 'sufficient_context', 'review_required'] as const) {
    const result = makeOutcome(status);
    const records: TelemetryRecord[] = [];
    let calls = 0;
    const times = [10, 17.5];
    const coordinator: InvestigationCoordinator = {
      advance: (received) => {
        calls += 1;
        assert.strictEqual(received, input);
        return Promise.resolve(result);
      },
    };

    const decorated = createTelemetryInvestigationCoordinator(
      coordinator,
      recorder(records),
      () => times.shift() ?? 17.5,
    );
    const actual = await decorated.advance(input);

    assert.strictEqual(actual, result);
    assert.equal(calls, 1);
    assert.equal(records.length, 1);
    const record = coordinatorRecord(records[0]);
    assert.deepEqual(record, {
      eventName: L3_COORDINATOR_ADVANCE_EVENT_NAME,
      outcome: status,
      durationMs: 7.5,
    });
    assert.deepEqual(Object.keys(record).sort(), ['durationMs', 'eventName', 'outcome']);
    const serialized = JSON.stringify(record);
    for (const marker of [
      'input-secret-marker',
      'review-reason-secret-marker',
      'checkpoint-secret-marker',
      'context-secret-marker',
    ]) {
      assert.ok(!serialized.includes(marker), marker);
    }
  }
});

test('preserves the closed advance-review-pending outcome in telemetry', async () => {
  const result = {
    status: 'review_required',
    reason: 'advance_review_pending',
    checkpoint: { privateCheckpoint: 'checkpoint-secret-marker' },
  } as unknown as InvestigationCoordinatorOutcome;
  const records: TelemetryRecord[] = [];
  const decorated = createTelemetryInvestigationCoordinator({
    advance: async () => result,
  }, recorder(records), tickingClock());

  assert.strictEqual(await decorated.advance(input), result);
  assert.equal(records.length, 1);
  assert.deepEqual(coordinatorRecord(records[0]), {
    eventName: L3_COORDINATOR_ADVANCE_EVENT_NAME,
    outcome: 'review_required',
    durationMs: 1,
  });
});

test('a thrown coordinator error is rethrown by identity with one error record', async () => {
  const originalError = new Error('coordinator-private-marker');
  const records: TelemetryRecord[] = [];
  let calls = 0;
  const decorated = createTelemetryInvestigationCoordinator({
    advance: () => {
      calls += 1;
      return Promise.reject(originalError);
    },
  }, recorder(records), tickingClock());

  await assert.rejects(decorated.advance(input), (error: unknown) => error === originalError);

  assert.equal(calls, 1);
  assert.equal(records.length, 1);
  assert.deepEqual(coordinatorRecord(records[0]), {
    eventName: L3_COORDINATOR_ADVANCE_EVENT_NAME,
    outcome: 'error',
    durationMs: 1,
  });
  assert.ok(!JSON.stringify(records[0]).includes('coordinator-private-marker'));
});

test('malformed runtime outcomes are summarized as error and returned unchanged', async () => {
  const throwingStatus = new Proxy({}, {
    getOwnPropertyDescriptor() {
      throw new Error('status-access-secret-marker');
    },
  });
  const extraOutcomeField = {
    ...makeOutcome('continue'),
    traceId: 'trace-secret-marker',
  };
  const malformed: unknown[] = [
    null,
    { status: 'future_status', reason: 'private-marker' },
    { status: 'continue', checkpoint: {}, context: {} },
    { status: 'continue', checkpoint: {}, context: {}, persistedRecord: undefined },
    { status: 'sufficient_context', context: null, persistedRecord: {} },
    { status: 'review_required' },
    { status: 'review_required', reason: 'future_reason' },
    extraOutcomeField,
    Object.defineProperty({}, 'status', { get: () => 'continue' }),
    throwingStatus,
  ];

  for (const value of malformed) {
    const records: TelemetryRecord[] = [];
    const returned = value as InvestigationCoordinatorOutcome;
    const decorated = createTelemetryInvestigationCoordinator({
      advance: async () => returned,
    }, recorder(records), tickingClock());

    assert.strictEqual(await decorated.advance(input), returned);
    assert.equal(records.length, 1);
    assert.deepEqual(coordinatorRecord(records[0]), {
      eventName: L3_COORDINATOR_ADVANCE_EVENT_NAME,
      outcome: 'error',
      durationMs: 1,
    });
  }
});

test('invalid and failed clock readings produce a safe zero duration', async () => {
  const result = makeOutcome('sufficient_context');
  const clockCases: Array<() => number> = [
    (() => {
      const values = [5, 4];
      return () => values.shift() ?? 4;
    })(),
    (() => {
      const values = [1, Number.POSITIVE_INFINITY];
      return () => values.shift() ?? Number.POSITIVE_INFINITY;
    })(),
    () => {
      throw new Error('clock-secret-marker');
    },
  ];

  for (const clock of clockCases) {
    const records: TelemetryRecord[] = [];
    let calls = 0;
    const decorated = createTelemetryInvestigationCoordinator({
      advance: async () => {
        calls += 1;
        return result;
      },
    }, recorder(records), clock);

    assert.strictEqual(await decorated.advance(input), result);
    assert.equal(calls, 1);
    assert.equal(coordinatorRecord(records[0]).durationMs, 0);
  }
});

test('elapsed duration accepts a finite negative clock origin', async () => {
  const records: TelemetryRecord[] = [];
  const times = [-5, 4];
  const result = makeOutcome('continue');
  const decorated = createTelemetryInvestigationCoordinator({
    advance: async () => result,
  }, recorder(records), () => times.shift() ?? 4);

  assert.strictEqual(await decorated.advance(input), result);
  assert.equal(coordinatorRecord(records[0]).durationMs, 9);
});

test('sink failures preserve the exact result and original coordinator error', async () => {
  const sinkFailure = new Error('sink-secret-marker');
  const throwingSink: TelemetrySink = { record() { throw sinkFailure; } };
  const result = makeOutcome('continue');
  const successful = createTelemetryInvestigationCoordinator({
    advance: async () => result,
  }, throwingSink, tickingClock());
  assert.strictEqual(await successful.advance(input), result);

  const originalError = new Error('coordinator-secret-marker');
  const failing = createTelemetryInvestigationCoordinator({
    advance: async () => { throw originalError; },
  }, throwingSink, tickingClock());
  await assert.rejects(failing.advance(input), (error: unknown) => error === originalError);
});

test('console telemetry logs only exact coordinator fields and drops forged records', () => {
  const writes: unknown[] = [];
  const originalLog = console.log;
  console.log = (...messages: unknown[]) => writes.push(...messages);
  try {
    consoleTelemetry.record({
      eventName: L3_COORDINATOR_ADVANCE_EVENT_NAME,
      outcome: 'review_required',
      durationMs: 12.5,
    });
    consoleTelemetry.record({
      eventName: L3_COORDINATOR_ADVANCE_EVENT_NAME,
      outcome: 'continue',
      durationMs: 1,
      reviewReason: 'review-reason-secret-marker',
    } as TelemetryRecord);
    consoleTelemetry.record(Object.defineProperty({
      eventName: L3_COORDINATOR_ADVANCE_EVENT_NAME,
      outcome: 'continue',
      durationMs: 2,
    }, Symbol('forged'), { value: 'private-marker', enumerable: true }) as TelemetryRecord);
    consoleTelemetry.record({
      eventName: L3_COORDINATOR_ADVANCE_EVENT_NAME,
      outcome: 'private-outcome',
      durationMs: 1,
    } as unknown as TelemetryRecord);
    consoleTelemetry.record({
      eventName: 'private-event-name',
      outcome: 'error',
      durationMs: 1,
    } as unknown as TelemetryRecord);
    consoleTelemetry.record({
      eventName: L3_COORDINATOR_ADVANCE_EVENT_NAME,
      outcome: 'error',
      durationMs: Number.NaN,
    });
  } finally {
    console.log = originalLog;
  }

  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], {
    event_name: L3_COORDINATOR_ADVANCE_EVENT_NAME,
    outcome: 'review_required',
    duration_ms: 12.5,
  });
  assert.equal(Object.getPrototypeOf(writes[0]), Object.prototype);
  assert.deepEqual(Object.keys(writes[0] as object).sort(), ['duration_ms', 'event_name', 'outcome']);
});

test('the default telemetry sink remains silent', async () => {
  const writes: unknown[] = [];
  const originalLog = console.log;
  console.log = (...messages: unknown[]) => writes.push(...messages);
  try {
    const result = makeOutcome('continue');
    const decorated = createTelemetryInvestigationCoordinator({
      advance: async () => result,
    });
    assert.strictEqual(await decorated.advance(input), result);
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(writes, []);
});

function coordinatorRecord(record: TelemetryRecord | undefined): {
  eventName: string;
  outcome: L3CoordinatorAdvanceOutcome;
  durationMs: number;
} {
  assert.ok(record);
  if (record.eventName !== L3_COORDINATOR_ADVANCE_EVENT_NAME) {
    assert.fail('expected one coordinator advance record');
  }
  return record;
}

function recorder(records: TelemetryRecord[]): TelemetrySink {
  return { record: (record) => records.push(record) };
}

function tickingClock(): () => number {
  let now = 0;
  return () => ++now;
}

function makeOutcome(
  status: 'continue' | 'sufficient_context' | 'review_required',
): InvestigationCoordinatorOutcome {
  const context = { privateContext: 'context-secret-marker' };
  const persistedRecord = { privateRecord: 'persisted-secret-marker' };
  if (status === 'continue') {
    return {
      status,
      checkpoint: { privateCheckpoint: 'checkpoint-secret-marker' },
      context,
      persistedRecord,
    } as unknown as InvestigationCoordinatorOutcome;
  }
  if (status === 'sufficient_context') {
    return { status, context, persistedRecord } as unknown as InvestigationCoordinatorOutcome;
  }
  return {
    status,
    reason: 'invalid_context',
    checkpoint: { privateCheckpoint: 'checkpoint-secret-marker' },
  } as unknown as InvestigationCoordinatorOutcome;
}
