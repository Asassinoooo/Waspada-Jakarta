import assert from "node:assert/strict";
import test from "node:test";
import type { TransactionalSqlExecutor } from "../../db/src/sql.js";
import {
  createFreshnessDueScheduleRuntime,
  FreshnessDueScheduleRuntimeError,
  type FreshnessDueScheduleTransactionalSqlExecutorRunner,
} from "../src/runtime/freshness-due-schedule-runtime.js";
import { handleFreshnessDueScheduleTrigger } from "../src/runtime/freshness-due-schedule-trigger.js";
import type {
  FreshnessDueEvaluator,
  FreshnessDueEvaluatorCounts,
  FreshnessDueEvaluatorResult,
} from "../src/layers/l4-application-integration/freshness-due-evaluator.js";
import worker from "../src/index.js";
import type { WorkerEnvironment } from "../src/layers/l4-application-integration/api.js";

const writerConnectionString =
  "postgresql://freshness-user:freshness-secret@freshness-hyperdrive.example.invalid/waspada?sslmode=require";
const publicConnectionString =
  "postgresql://reader-user:reader-secret@reader-hyperdrive.example.invalid/waspada?sslmode=require";
const l1ConnectionString =
  "postgresql://l1-user:l1-secret@l1-hyperdrive.example.invalid/waspada?sslmode=require";
const scheduledTime = Date.parse("2026-10-01T00:00:00.123Z");
const scheduledInstant = "2026-10-01T00:00:00.123Z";
const runId = "freshness-due:" + scheduledTime;
const zeroCounts: FreshnessDueEvaluatorCounts = {
  written: 0,
  replayed: 0,
  noChange: 0,
  conflicts: 0,
  failures: 0,
};

interface SqlCall {
  readonly kind: "execute" | "query";
  readonly statement: string;
  readonly parameters: readonly unknown[];
}

interface FakeSqlOptions {
  readonly beginStatus?: unknown;
  readonly beginError?: unknown;
  readonly finalizeStatus?: unknown;
  readonly finalizeError?: unknown;
  readonly resetError?: unknown;
}

function createFakeSql(options: FakeSqlOptions = {}): {
  readonly executor: TransactionalSqlExecutor;
  readonly calls: SqlCall[];
} {
  const calls: SqlCall[] = [];
  const executor: TransactionalSqlExecutor = {
    async execute(statement) {
      calls.push({ kind: "execute", statement, parameters: [] });
      if (statement === "RESET ROLE" && options.resetError !== undefined) throw options.resetError;
    },
    async query<Row extends object>(statement: string, parameters: readonly unknown[] = []) {
      calls.push({ kind: "query", statement, parameters });
      if (statement.includes("begin_freshness_due_evaluation_run")) {
        if (options.beginError !== undefined) throw options.beginError;
        return {
          rows: [{ run_status: options.beginStatus ?? "open" }] as unknown as readonly Row[],
        };
      }
      if (statement.includes("finalize_freshness_due_evaluation_run")) {
        if (options.finalizeError !== undefined) throw options.finalizeError;
        return {
          rows: [{ run_status: options.finalizeStatus ?? parameters[3] }] as unknown as readonly Row[],
        };
      }
      throw new Error("unexpected fake SQL: " + statement);
    },
    async transaction<Result>(work: (transaction: import("../../db/src/sql.js").SqlExecutor) => Promise<Result>) {
      return work(executor);
    },
  };
  return { executor, calls };
}

function makeEvaluator(
  evaluate: (request: unknown) => Promise<FreshnessDueEvaluatorResult> = async () => ({
    outcome: "completed",
    counts: zeroCounts,
    nextCursor: null,
  }),
): FreshnessDueEvaluator {
  return { evaluate };
}

function createRuntime(options: {
  readonly fake?: ReturnType<typeof createFakeSql>;
  readonly beginStatus?: unknown;
  readonly beginError?: unknown;
  readonly finalizeError?: unknown;
  readonly resetError?: unknown;
  readonly evaluator?: FreshnessDueEvaluator;
  readonly onEvaluatorFactory?: (executor: TransactionalSqlExecutor) => void;
  readonly runner?: FreshnessDueScheduleTransactionalSqlExecutorRunner;
  readonly clock?: () => number;
} = {}) {
  const fake = options.fake ?? createFakeSql({
    beginStatus: options.beginStatus,
    beginError: options.beginError,
    finalizeError: options.finalizeError,
    resetError: options.resetError,
  });
  let operations = 0;
  let receivedConnectionString: string | undefined;
  const runner: FreshnessDueScheduleTransactionalSqlExecutorRunner = options.runner
    ?? (async (connectionString, operation) => {
      operations += 1;
      receivedConnectionString = connectionString;
      return operation(fake.executor);
    });
  const runtime = createFreshnessDueScheduleRuntime({
    datasetMode: "live",
    schedulerEnabled: "true",
    freshnessWriterConnectionString: writerConnectionString,
  }, {
    withTransactionalSqlExecutor: runner,
    createEvaluator: (executor) => {
      options.onEvaluatorFactory?.(executor);
      return options.evaluator ?? makeEvaluator();
    },
    clock: options.clock ?? (() => scheduledTime + 5_000),
  });
  assert.ok(runtime);
  return {
    runtime,
    fake,
    get operations() { return operations; },
    get receivedConnectionString() { return receivedConnectionString; },
  };
}

function queryCalls(fake: ReturnType<typeof createFakeSql>, fragment: string): SqlCall[] {
  return fake.calls.filter((call) => call.kind === "query" && call.statement.includes(fragment));
}

test("runtime stays inactive unless exact live mode, exact opt-in, and a valid dedicated connection are present", () => {
  let operations = 0;
  const withTransactionalSqlExecutor: FreshnessDueScheduleTransactionalSqlExecutorRunner =
    async (_connectionString, operation) => {
      operations += 1;
      return operation(createFakeSql().executor);
    };
  for (const configuration of [
    { datasetMode: "demo", schedulerEnabled: "true", freshnessWriterConnectionString: writerConnectionString },
    { datasetMode: "Live", schedulerEnabled: "true", freshnessWriterConnectionString: writerConnectionString },
    { datasetMode: "live", schedulerEnabled: "TRUE", freshnessWriterConnectionString: writerConnectionString },
    { datasetMode: "live", schedulerEnabled: "true ", freshnessWriterConnectionString: writerConnectionString },
    { datasetMode: "live", schedulerEnabled: "false", freshnessWriterConnectionString: writerConnectionString },
    { datasetMode: "live", schedulerEnabled: "true", freshnessWriterConnectionString: undefined },
    { datasetMode: "live", schedulerEnabled: "true", freshnessWriterConnectionString: "bad-connection" },
  ]) {
    assert.equal(createFreshnessDueScheduleRuntime(configuration, { withTransactionalSqlExecutor }), undefined);
  }
  assert.equal(operations, 0);
});

test("scheduled adapter passes only the dedicated freshness binding and platform timestamp", async () => {
  let receivedConfiguration: unknown;
  let receivedTime: number | undefined;
  const environment: WorkerEnvironment = {
    DATASET_MODE: "live",
    FRESHNESS_DUE_SCHEDULER_ENABLED: "true",
    FRESHNESS_DUE_HYPERDRIVE: { connectionString: writerConnectionString },
    HYPERDRIVE: { connectionString: publicConnectionString },
    L1_HYPERDRIVE: { connectionString: l1ConnectionString },
  };
  await handleFreshnessDueScheduleTrigger(
    scheduledTime,
    environment,
    (configuration) => {
      receivedConfiguration = configuration;
      return { async schedule(time) { receivedTime = time; } };
    },
  );
  assert.equal(receivedTime, scheduledTime);
  assert.deepEqual(receivedConfiguration, {
    datasetMode: "live",
    schedulerEnabled: "true",
    freshnessWriterConnectionString: writerConnectionString,
  });

  await handleFreshnessDueScheduleTrigger(
    scheduledTime,
    {
      DATASET_MODE: "live",
      FRESHNESS_DUE_SCHEDULER_ENABLED: "true",
      HYPERDRIVE: { connectionString: publicConnectionString },
      L1_HYPERDRIVE: { connectionString: l1ConnectionString },
    },
  );
});

test("default Worker scheduling remains dormant in demo mode with reader connections present", async () => {
  await assert.doesNotReject(worker.scheduled(
    { scheduledTime },
    {
      DATASET_MODE: "demo",
      FRESHNESS_DUE_SCHEDULER_ENABLED: "true",
      FRESHNESS_DUE_HYPERDRIVE: undefined,
      HYPERDRIVE: { connectionString: publicConnectionString },
      L1_HYPERDRIVE: { connectionString: l1ConnectionString },
    },
  ));
});

test("invalid platform timestamps fail before opening a client", async () => {
  let operations = 0;
  const runtime = createFreshnessDueScheduleRuntime({
    datasetMode: "live",
    schedulerEnabled: "true",
    freshnessWriterConnectionString: writerConnectionString,
  }, {
    withTransactionalSqlExecutor: async (_connectionString, operation) => {
      operations += 1;
      return operation(createFakeSql().executor);
    },
  });
  assert.ok(runtime);

  for (const malformed of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    253402300800000,
    Number.MAX_SAFE_INTEGER,
  ]) {
    await assert.rejects(
      runtime.schedule(malformed),
      (error: unknown) => error instanceof FreshnessDueScheduleRuntimeError
        && error.code === "INVALID_SCHEDULED_TIME",
    );
  }
  assert.equal(operations, 0);
});

test("slot identity is stable and one role-scoped client calls begin, one page, finalize, then reset", async () => {
  const fake = createFakeSql();
  const evaluationRequests: unknown[] = [];
  const runtimeState = createRuntime({
    fake,
    evaluator: makeEvaluator(async (request) => {
      evaluationRequests.push(request);
      return {
        outcome: "completed",
        counts: { written: 1, replayed: 0, noChange: 2, conflicts: 0, failures: 0 },
        nextCursor: { eventId: "next-event", eventVersion: 1, target: { kind: "event_claim_set" } },
      };
    }),
  });

  await runtimeState.runtime.schedule(scheduledTime);
  await runtimeState.runtime.schedule(scheduledTime);

  const begins = queryCalls(fake, "begin_freshness_due_evaluation_run");
  const finalizations = queryCalls(fake, "finalize_freshness_due_evaluation_run");
  assert.equal(begins.length, 2);
  assert.deepEqual(begins.map((call) => call.parameters), [
    [runId, scheduledInstant],
    [runId, scheduledInstant],
  ]);
  assert.deepEqual(evaluationRequests, [
    {
      datasetKind: "live",
      now: scheduledInstant,
      limit: 100,
      cursor: null,
      traceId: runId,
      evaluationRunId: runId,
    },
    {
      datasetKind: "live",
      now: scheduledInstant,
      limit: 100,
      cursor: null,
      traceId: runId,
      evaluationRunId: runId,
    },
  ]);
  assert.equal(finalizations.length, 2);
  assert.deepEqual(JSON.parse(String(finalizations[0]?.parameters[4])), {
    written: 1,
    replayed: 0,
    noChange: 2,
    conflicts: 0,
    failures: 0,
  });
  assert.deepEqual(
    fake.calls.filter((call) => call.kind === "execute").map((call) => call.statement),
    ["SET ROLE waspada_l4_freshness_writer", "RESET ROLE", "SET ROLE waspada_l4_freshness_writer", "RESET ROLE"],
  );
  assert.deepEqual(
    fake.calls.filter((call) => call.kind === "query").map((call) =>
      call.statement.includes("begin_freshness_due_evaluation_run")
        ? "begin"
        : call.statement.includes("finalize_freshness_due_evaluation_run") ? "finalize" : "unexpected"),
    ["begin", "finalize", "begin", "finalize"],
  );
  assert.deepEqual(
    fake.calls.map((call) => call.kind === "execute"
      ? call.statement
      : call.statement.includes("begin_freshness_due_evaluation_run") ? "begin" : "finalize"),
    [
      "SET ROLE waspada_l4_freshness_writer",
      "begin",
      "finalize",
      "RESET ROLE",
      "SET ROLE waspada_l4_freshness_writer",
      "begin",
      "finalize",
      "RESET ROLE",
    ],
  );
  for (const finalize of finalizations) {
    assert.equal(finalize.parameters[0], runId);
    assert.equal(finalize.parameters[1], scheduledInstant);
    assert.equal(finalize.parameters[2], new Date(scheduledTime + 5_000).toISOString());
    assert.equal(finalize.parameters[3], "succeeded");
  }
  assert.equal(runtimeState.receivedConnectionString, writerConnectionString);
  assert.equal(runtimeState.operations, 2);
  assert.equal(fake.calls.some((call) => /(?:INSERT|UPDATE)\s+waspada\.traces/iu.test(call.statement)), false);
});

test("terminal trace replay skips evaluation and finalization", async () => {
  for (const terminalStatus of ["succeeded", "failed"] as const) {
    const fake = createFakeSql({ beginStatus: terminalStatus });
    let evaluatorCreations = 0;
    const runtimeState = createRuntime({
      fake,
      onEvaluatorFactory() { evaluatorCreations += 1; },
    });

    await runtimeState.runtime.schedule(scheduledTime);

    assert.equal(evaluatorCreations, 0);
    assert.equal(queryCalls(fake, "begin_freshness_due_evaluation_run").length, 1);
    assert.equal(queryCalls(fake, "finalize_freshness_due_evaluation_run").length, 0);
    assert.deepEqual(fake.calls.filter((call) => call.kind === "execute").map((call) => call.statement), [
      "SET ROLE waspada_l4_freshness_writer",
      "RESET ROLE",
    ]);
  }
});

test("retry result finalizes failed with the evaluator's exact closed count summary", async () => {
  const fake = createFakeSql();
  const retryCounts = { written: 2, replayed: 1, noChange: 0, conflicts: 1, failures: 3 };
  const runtimeState = createRuntime({
    fake,
    evaluator: makeEvaluator(async () => ({
      outcome: "retry",
      counts: retryCounts,
      resumeCursor: null,
    })),
  });

  await runtimeState.runtime.schedule(scheduledTime);

  const finalization = queryCalls(fake, "finalize_freshness_due_evaluation_run")[0];
  assert.ok(finalization);
  assert.equal(finalization.parameters[3], "failed");
  assert.deepEqual(JSON.parse(String(finalization.parameters[4])), retryCounts);
});

test("run-start failures stay content-free and role cleanup preserves the first error", async () => {
  const firstFailure = new Error("SQL=select private source password=driver-secret");
  const cleanupFailure = new Error("cleanup role failure password=cleanup-secret");
  const fake = createFakeSql({ beginError: firstFailure, resetError: cleanupFailure });
  let runnerObserved: unknown;
  const runner: FreshnessDueScheduleTransactionalSqlExecutorRunner = async (_connectionString, operation) => {
    try {
      return await operation(fake.executor);
    } catch (error) {
      runnerObserved = error;
      throw error;
    }
  };
  const runtimeState = createRuntime({ fake, runner });

  await assert.rejects(
    runtimeState.runtime.schedule(scheduledTime),
    (error: unknown) => error instanceof FreshnessDueScheduleRuntimeError
      && error.code === "SCHEDULE_FAILED"
      && error.message === "The scheduled freshness evaluation could not be completed."
      && !error.message.includes("private source")
      && !error.message.includes("driver-secret")
      && !error.message.includes("cleanup-secret"),
  );
  assert.equal(runnerObserved, firstFailure);
  assert.equal(fake.calls.some((call) => call.kind === "execute" && call.statement === "RESET ROLE"), true);
});

test("unexpected evaluator errors close the opened trace with a bounded failed summary", async () => {
  const fake = createFakeSql();
  const runtimeState = createRuntime({
    fake,
    evaluator: makeEvaluator(async () => { throw new Error("source=private SQL=select secret"); }),
  });

  await runtimeState.runtime.schedule(scheduledTime);

  const finalization = queryCalls(fake, "finalize_freshness_due_evaluation_run")[0];
  assert.ok(finalization);
  assert.equal(finalization.parameters[3], "failed");
  assert.deepEqual(JSON.parse(String(finalization.parameters[4])), {
    written: 0,
    replayed: 0,
    noChange: 0,
    conflicts: 0,
    failures: 1,
  });
});
