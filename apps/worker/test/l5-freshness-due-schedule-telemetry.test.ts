import assert from "node:assert/strict";
import test from "node:test";
import type { TransactionalSqlExecutor } from "../../db/src/sql.js";
import type {
  FreshnessDueEvaluator,
  FreshnessDueEvaluatorCounts,
  FreshnessDueEvaluatorResult,
} from "../src/layers/l4-application-integration/freshness-due-evaluator.js";
import {
  consoleTelemetry,
  FRESHNESS_DUE_SCHEDULE_EVENT_NAME,
  type FreshnessDueScheduleTelemetryCounts,
  type TelemetryRecord,
  type TelemetrySink,
} from "../src/layers/l5-evaluation-monitoring/telemetry.js";
import {
  createFreshnessDueScheduleRuntime,
  FreshnessDueScheduleRuntimeError,
  type FreshnessDueScheduleRuntime,
} from "../src/runtime/freshness-due-schedule-runtime.js";
import { handleFreshnessDueScheduleTrigger } from "../src/runtime/freshness-due-schedule-trigger.js";
import worker from "../src/index.js";
import type { WorkerEnvironment } from "../src/layers/l4-application-integration/api.js";

const scheduledTime = Date.parse("2026-10-01T00:00:00.123Z");
const connectionString =
  "postgresql://freshness-user:freshness-secret@freshness-hyperdrive.example.invalid/waspada?sslmode=require";
const completedCounts: FreshnessDueEvaluatorCounts = {
  written: 1,
  replayed: 1,
  noChange: 1,
  conflicts: 0,
  failures: 0,
};

interface HarnessOptions {
  readonly beginStatus?: "open" | "succeeded" | "failed";
  readonly beginError?: unknown;
  readonly finalizeError?: unknown;
  readonly result?: FreshnessDueEvaluatorResult;
  readonly evaluatorError?: unknown;
  readonly telemetry?: TelemetrySink;
}

function createHarness(options: HarnessOptions = {}): {
  readonly runtime: FreshnessDueScheduleRuntime;
  readonly records: TelemetryRecord[];
  readonly finalizationCounts: unknown[];
  readonly runnerCalls: number;
  readonly evaluatorCalls: number;
} {
  const records: TelemetryRecord[] = [];
  const finalizationCounts: unknown[] = [];
  let runnerCalls = 0;
  let evaluatorCalls = 0;
  const telemetry = options.telemetry ?? { record(record: TelemetryRecord) { records.push(record); } };
  const executor: TransactionalSqlExecutor = {
    async execute() {},
    async query<Row extends object>(statement: string, parameters: readonly unknown[] = []) {
      if (statement.includes("begin_freshness_due_evaluation_run")) {
        if (options.beginError !== undefined) throw options.beginError;
        return {
          rows: [{ run_status: options.beginStatus ?? "open" }] as unknown as readonly Row[],
        };
      }
      if (statement.includes("finalize_freshness_due_evaluation_run")) {
        if (options.finalizeError !== undefined) throw options.finalizeError;
        finalizationCounts.push(JSON.parse(String(parameters[4])));
        return { rows: [{ run_status: parameters[3] }] as unknown as readonly Row[] };
      }
      throw new Error("unexpected fake SQL statement");
    },
    async transaction<Result>(work: (transaction: import("../../db/src/sql.js").SqlExecutor) => Promise<Result>) {
      return work(executor);
    },
  };
  const evaluator: FreshnessDueEvaluator = {
    async evaluate() {
      evaluatorCalls += 1;
      if (options.evaluatorError !== undefined) throw options.evaluatorError;
      return options.result ?? { outcome: "completed", counts: completedCounts, nextCursor: null };
    },
  };
  const runtime = createFreshnessDueScheduleRuntime({
    datasetMode: "live",
    schedulerEnabled: "true",
    freshnessWriterConnectionString: connectionString,
  }, {
    withTransactionalSqlExecutor: async (_connection, operation) => {
      runnerCalls += 1;
      return operation(executor);
    },
    createEvaluator: () => evaluator,
    clock: () => scheduledTime + 1_000,
    telemetry,
  });
  assert.ok(runtime);
  return {
    runtime,
    records,
    finalizationCounts,
    get runnerCalls() { return runnerCalls; },
    get evaluatorCalls() { return evaluatorCalls; },
  };
}

function onlyFreshnessRecord(records: readonly TelemetryRecord[]) {
  const freshnessRecords = records.filter((record) => record.eventName === FRESHNESS_DUE_SCHEDULE_EVENT_NAME);
  assert.equal(freshnessRecords.length, 1);
  return freshnessRecords[0]!;
}

test("completed active runs emit one closed event with validated evaluator counts", async () => {
  const harness = createHarness();
  await harness.runtime.schedule(scheduledTime);

  const record = onlyFreshnessRecord(harness.records);
  if (record.outcome !== "completed") assert.fail("expected a completed telemetry event");
  assert.deepEqual(Object.keys(record).sort(), ["counts", "durationMs", "eventName", "outcome"]);
  assert.equal(record.eventName, FRESHNESS_DUE_SCHEDULE_EVENT_NAME);
  assert.deepEqual(record.counts, completedCounts);
  assert.ok(Number.isFinite(record.durationMs));
  assert.ok(record.durationMs >= 0);
  assert.equal(harness.records.length, 1);
  assert.equal(harness.runnerCalls, 1);
  assert.equal(harness.evaluatorCalls, 1);
});

test("retry results emit a failed event with the validated evaluator summary", async () => {
  const retryCounts: FreshnessDueEvaluatorCounts = {
    written: 2,
    replayed: 1,
    noChange: 0,
    conflicts: 1,
    failures: 3,
  };
  const harness = createHarness({
    result: { outcome: "retry", counts: retryCounts, resumeCursor: null },
  });
  await harness.runtime.schedule(scheduledTime);

  const record = onlyFreshnessRecord(harness.records);
  if (record.outcome !== "failed") assert.fail("expected a failed telemetry event");
  assert.deepEqual(record.counts, retryCounts);
  assert.equal(harness.finalizationCounts.length, 1);
  assert.deepEqual(harness.finalizationCounts[0], retryCounts);
});

test("terminal trace replays emit one count-free event and skip evaluation", async () => {
  for (const beginStatus of ["succeeded", "failed"] as const) {
    const harness = createHarness({ beginStatus });
    await harness.runtime.schedule(scheduledTime);

    const record = onlyFreshnessRecord(harness.records);
    assert.equal(record.outcome, "terminal_replay");
    assert.deepEqual(Object.keys(record).sort(), ["durationMs", "eventName", "outcome"]);
    assert.ok(Number.isFinite(record.durationMs));
    assert.ok(record.durationMs >= 0);
    assert.equal(harness.evaluatorCalls, 0);
    assert.equal(harness.finalizationCounts.length, 0);
  }
});

test("unexpected evaluator failures use the trace fallback but omit invented telemetry counts", async () => {
  const harness = createHarness({ evaluatorError: new Error("private source and driver details") });
  await harness.runtime.schedule(scheduledTime);

  const record = onlyFreshnessRecord(harness.records);
  assert.equal(record.outcome, "failed");
  assert.deepEqual(Object.keys(record).sort(), ["durationMs", "eventName", "outcome"]);
  assert.deepEqual(harness.finalizationCounts, [{
    written: 0,
    replayed: 0,
    noChange: 0,
    conflicts: 0,
    failures: 1,
  }]);
  assert.doesNotMatch(JSON.stringify(record), /private source|driver details/u);
});

test("runtime failures keep the fixed error when telemetry sinks throw", async () => {
  const records: TelemetryRecord[] = [];
  const marker = "SQL=select source-secret password=driver-secret";
  const harness = createHarness({
    beginError: new Error(marker),
    telemetry: {
      record(record) {
        records.push(record);
        throw new Error("telemetry sink failed");
      },
    },
  });

  await assert.rejects(
    harness.runtime.schedule(scheduledTime),
    (error: unknown) => error instanceof FreshnessDueScheduleRuntimeError
      && error.code === "SCHEDULE_FAILED"
      && error.message === "The scheduled freshness evaluation could not be completed.",
  );
  const record = onlyFreshnessRecord(records);
  assert.equal(record.outcome, "failed");
  assert.deepEqual(Object.keys(record).sort(), ["durationMs", "eventName", "outcome"]);
  assert.doesNotMatch(JSON.stringify(record), /source-secret|driver-secret|telemetry sink failed/u);
});

test("a throwing telemetry sink cannot change a completed trace or start another run", async () => {
  const records: TelemetryRecord[] = [];
  const harness = createHarness({
    telemetry: {
      record(record) {
        records.push(record);
        throw new Error("telemetry sink failed");
      },
    },
  });

  await assert.doesNotReject(harness.runtime.schedule(scheduledTime));
  const record = onlyFreshnessRecord(records);
  assert.equal(record.outcome, "completed");
  assert.equal(harness.runnerCalls, 1);
  assert.equal(harness.evaluatorCalls, 1);
  assert.equal(harness.finalizationCounts.length, 1);
});

test("a later runtime failure retains validated counts and emits only the fixed failure", async () => {
  const harness = createHarness({ finalizeError: new Error("SQL=finalize source-secret") });

  await assert.rejects(
    harness.runtime.schedule(scheduledTime),
    (error: unknown) => error instanceof FreshnessDueScheduleRuntimeError
      && error.code === "SCHEDULE_FAILED"
      && error.message === "The scheduled freshness evaluation could not be completed.",
  );
  const record = onlyFreshnessRecord(harness.records);
  if (record.outcome !== "failed") assert.fail("expected a failed telemetry event");
  assert.deepEqual(record.counts, completedCounts);
  assert.doesNotMatch(JSON.stringify(record), /SQL=finalize|source-secret/u);
});

test("invalid schedule time emits one failed summary while preserving the fixed validation error", async () => {
  const harness = createHarness();
  await assert.rejects(
    harness.runtime.schedule(Number.NaN),
    (error: unknown) => error instanceof FreshnessDueScheduleRuntimeError
      && error.code === "INVALID_SCHEDULED_TIME"
      && error.message === "The scheduled freshness timestamp is invalid.",
  );

  const record = onlyFreshnessRecord(harness.records);
  assert.equal(record.outcome, "failed");
  assert.deepEqual(Object.keys(record).sort(), ["durationMs", "eventName", "outcome"]);
  assert.equal(harness.runnerCalls, 0);
});

test("telemetry clock failures use a finite zero duration and do not change runtime success", async () => {
  const harness = createHarness();
  const originalNow = Date.now;
  Date.now = () => { throw new Error("clock failure"); };
  try {
    await harness.runtime.schedule(scheduledTime);
  } finally {
    Date.now = originalNow;
  }

  const record = onlyFreshnessRecord(harness.records);
  assert.equal(record.outcome, "completed");
  assert.equal(record.durationMs, 0);
  assert.equal(harness.runnerCalls, 1);
});

test("console serializer emits only the closed allowlist and rejects malformed counts or extra fields", () => {
  const logs: unknown[] = [];
  const serializedFailureCounts: FreshnessDueScheduleTelemetryCounts = {
    written: 2,
    replayed: 1,
    noChange: 0,
    conflicts: 1,
    failures: 3,
  };
  const originalLog = console.log;
  console.log = ((...args: unknown[]) => { logs.push(args[0]); }) as typeof console.log;
  try {
    consoleTelemetry.record({
      eventName: FRESHNESS_DUE_SCHEDULE_EVENT_NAME,
      outcome: "completed",
      durationMs: 4.5,
      counts: { written: 100, replayed: 0, noChange: 0, conflicts: 0, failures: 0 },
    });
    consoleTelemetry.record({
      eventName: FRESHNESS_DUE_SCHEDULE_EVENT_NAME,
      outcome: "failed",
      durationMs: 4,
      counts: serializedFailureCounts,
    });
    consoleTelemetry.record({
      eventName: FRESHNESS_DUE_SCHEDULE_EVENT_NAME,
      outcome: "terminal_replay",
      durationMs: 3,
    });
    consoleTelemetry.record({
      eventName: FRESHNESS_DUE_SCHEDULE_EVENT_NAME,
      outcome: "failed",
      durationMs: 4,
      counts: { written: 101, replayed: 0, noChange: 0, conflicts: 0, failures: 0 },
    } as unknown as TelemetryRecord);
    consoleTelemetry.record({
      eventName: FRESHNESS_DUE_SCHEDULE_EVENT_NAME,
      outcome: "failed",
      durationMs: 4,
      counts: { written: -1, replayed: 0, noChange: 0, conflicts: 0, failures: 0 },
    } as unknown as TelemetryRecord);
    consoleTelemetry.record({
      eventName: FRESHNESS_DUE_SCHEDULE_EVENT_NAME,
      outcome: "failed",
      durationMs: 4,
      counts: { written: 1.5, replayed: 0, noChange: 0, conflicts: 0, failures: 0 },
    } as unknown as TelemetryRecord);
    consoleTelemetry.record({
      eventName: FRESHNESS_DUE_SCHEDULE_EVENT_NAME,
      outcome: "failed",
      durationMs: 4,
      counts: { written: 60, replayed: 40, noChange: 1, conflicts: 0, failures: 0 },
    } as unknown as TelemetryRecord);
    for (const durationMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      consoleTelemetry.record({
        eventName: FRESHNESS_DUE_SCHEDULE_EVENT_NAME,
        outcome: "failed",
        durationMs,
      } as unknown as TelemetryRecord);
    }
    consoleTelemetry.record({
      eventName: FRESHNESS_DUE_SCHEDULE_EVENT_NAME,
      outcome: "terminal_replay",
      durationMs: 4,
      counts: completedCounts,
    } as unknown as TelemetryRecord);
    consoleTelemetry.record({
      eventName: FRESHNESS_DUE_SCHEDULE_EVENT_NAME,
      outcome: "completed",
      durationMs: 4,
      counts: completedCounts,
      scheduledTime: "scheduled-time-secret",
      runId: "run-id-secret",
      sourceId: "source-id-secret",
      error: "driver-secret",
    } as unknown as TelemetryRecord);
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(logs, [
    {
      event_name: FRESHNESS_DUE_SCHEDULE_EVENT_NAME,
      outcome: "completed",
      duration_ms: 4.5,
      counts: { written: 100, replayed: 0, no_change: 0, conflicts: 0, failures: 0 },
    },
    {
      event_name: FRESHNESS_DUE_SCHEDULE_EVENT_NAME,
      outcome: "failed",
      duration_ms: 4,
      counts: { written: 2, replayed: 1, no_change: 0, conflicts: 1, failures: 3 },
    },
    {
      event_name: FRESHNESS_DUE_SCHEDULE_EVENT_NAME,
      outcome: "terminal_replay",
      duration_ms: 3,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(logs), /scheduled-time-secret|run-id-secret|source-id-secret|driver-secret/u);
});

test("disabled scheduled execution stays silent and trigger injection passes the shared sink", async () => {
  const logs: unknown[] = [];
  const originalLog = console.log;
  console.log = ((...args: unknown[]) => { logs.push(args[0]); }) as typeof console.log;
  try {
    await worker.scheduled(
      { scheduledTime },
      {
        DATASET_MODE: "demo",
        FRESHNESS_DUE_SCHEDULER_ENABLED: "true",
        FRESHNESS_DUE_HYPERDRIVE: undefined,
        HYPERDRIVE: { connectionString },
      },
    );
  } finally {
    console.log = originalLog;
  }
  assert.equal(logs.some((value) => (value as { event_name?: unknown } | undefined)?.event_name
    === FRESHNESS_DUE_SCHEDULE_EVENT_NAME), false);

  let receivedSink: TelemetrySink | undefined;
  await handleFreshnessDueScheduleTrigger(
    scheduledTime,
    {
      DATASET_MODE: "live",
      FRESHNESS_DUE_SCHEDULER_ENABLED: "true",
      FRESHNESS_DUE_HYPERDRIVE: { connectionString },
    } satisfies WorkerEnvironment,
    (_configuration, dependencies) => {
      receivedSink = dependencies?.telemetry;
      return undefined;
    },
    consoleTelemetry,
  );
  assert.equal(receivedSink, consoleTelemetry);
});
