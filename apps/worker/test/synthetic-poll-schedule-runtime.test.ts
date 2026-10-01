import assert from "node:assert/strict";
import test from "node:test";
import type { SqlExecutor } from "../../db/src/sql.js";
import {
  createSyntheticPollScheduleRuntime,
  SyntheticPollScheduleRuntimeError,
  type SyntheticPollScheduleSqlExecutorRunner,
} from "../src/runtime/synthetic-poll-schedule-runtime.js";
import { handleSyntheticPollScheduleTrigger } from "../src/runtime/synthetic-poll-schedule-trigger.js";
import worker from "../src/index.js";
import type { WorkerEnvironment } from "../src/layers/l4-application-integration/api.js";

const l1ConnectionString =
  "postgresql://l1-user:l1-secret@l1-hyperdrive.example.invalid/waspada?sslmode=require";
const publicConnectionString =
  "postgresql://reader-user:reader-secret@reader-hyperdrive.example.invalid/waspada?sslmode=require";
const scheduledTime = Date.parse("2026-10-01T00:00:00.123Z");

interface QueryCall {
  readonly statement: string;
  readonly parameters: readonly unknown[];
}

interface FakeSqlOptions {
  readonly namespace?: string;
  readonly failTraceCompletion?: boolean;
  readonly failDueRead?: boolean;
}

function createFakeSql(options: FakeSqlOptions = {}): {
  readonly executor: SqlExecutor;
  readonly executions: string[];
  readonly queries: QueryCall[];
} {
  const executions: string[] = [];
  const queries: QueryCall[] = [];
  const executor: SqlExecutor = {
    async execute(statement) {
      executions.push(statement);
    },
    async query<Row extends object>(statement: string, parameters: readonly unknown[] = []) {
      queries.push({ statement, parameters });
      if (statement.includes("FROM waspada.dataset_namespace_config")) {
        return { rows: [{ dataset_kind: options.namespace ?? "synthetic" }] as unknown as readonly Row[] };
      }
      if (statement.startsWith("INSERT INTO waspada.traces")) {
        return { rows: [{ trace_id: parameters[0] }] as unknown as readonly Row[] };
      }
      if (statement.includes("SELECT EXISTS")
        && statement.includes("FROM waspada.traces")) {
        return { rows: [{ found: true }] as unknown as readonly Row[] };
      }
      if (statement.includes("FROM waspada.source_registry")) {
        if (options.failDueRead) throw new Error("source=private-example password=driver-secret");
        return { rows: [] as readonly Row[] };
      }
      if (statement.startsWith("UPDATE waspada.traces")) {
        return {
          rows: options.failTraceCompletion
            ? []
            : [{ trace_id: parameters[0] }] as unknown as readonly Row[],
        };
      }
      throw new Error("unexpected SQL statement");
    },
  };
  return { executor, executions, queries };
}

test("runtime stays closed unless demo mode, exact enable string, and L1 connection are present", () => {
  let operations = 0;
  const withSqlExecutor: SyntheticPollScheduleSqlExecutorRunner = async (_connectionString, operation) => {
    operations += 1;
    return operation(createFakeSql().executor);
  };
  const disabledConfigurations = [
    { datasetMode: undefined, schedulerEnabled: "true", l1ConnectionString },
    { datasetMode: "live", schedulerEnabled: "true", l1ConnectionString },
    { datasetMode: "Demo", schedulerEnabled: "true", l1ConnectionString },
    { datasetMode: "demo", schedulerEnabled: "TRUE", l1ConnectionString },
    { datasetMode: "demo", schedulerEnabled: "true ", l1ConnectionString },
    { datasetMode: "demo", schedulerEnabled: "false", l1ConnectionString },
    { datasetMode: "demo", schedulerEnabled: "true", l1ConnectionString: undefined },
    { datasetMode: "demo", schedulerEnabled: "true", l1ConnectionString: "not-a-connection" },
    { datasetMode: "demo", schedulerEnabled: "true", l1ConnectionString: publicConnectionString.slice(0, 12) },
  ];

  for (const configuration of disabledConfigurations) {
    assert.equal(createSyntheticPollScheduleRuntime(configuration, { withSqlExecutor }), undefined);
  }
  assert.equal(operations, 0);
});

test("scheduled adapter uses only L1 binding and the platform scheduled epoch", async () => {
  let receivedConfiguration: unknown;
  let receivedTime: number | undefined;
  const expectedSummary = {
    candidateCount: 0,
    enqueuedCount: 0,
    existingCount: 0,
    notSchedulableCount: 0,
  };
  const environment: WorkerEnvironment = {
    DATASET_MODE: "demo",
    SYNTHETIC_POLL_SCHEDULER_ENABLED: "true",
    HYPERDRIVE: { connectionString: publicConnectionString },
    L1_HYPERDRIVE: { connectionString: l1ConnectionString },
  };
  const result = await handleSyntheticPollScheduleTrigger(
    scheduledTime,
    environment,
    (configuration) => {
      receivedConfiguration = configuration;
      return { async schedule(time) { receivedTime = time; return expectedSummary; } };
    },
  );

  assert.deepEqual(result, expectedSummary);
  assert.equal(receivedTime, scheduledTime);
  assert.deepEqual(receivedConfiguration, {
    datasetMode: "demo",
    schedulerEnabled: "true",
    l1ConnectionString,
  });

  const publicOnly = await handleSyntheticPollScheduleTrigger(
    scheduledTime,
    {
      DATASET_MODE: "demo",
      SYNTHETIC_POLL_SCHEDULER_ENABLED: "true",
      HYPERDRIVE: { connectionString: publicConnectionString },
    },
  );
  assert.equal(publicOnly, undefined);
});

test("Worker scheduled entrypoint remains disabled with checked-in demo configuration", async () => {
  await assert.doesNotReject(worker.scheduled(
    { scheduledTime },
    { DATASET_MODE: "demo" },
  ));
});

test("malformed platform epochs fail before opening a SQL client", async () => {
  const fake = createFakeSql();
  let operations = 0;
  const withSqlExecutor: SyntheticPollScheduleSqlExecutorRunner = async (_connectionString, operation) => {
    operations += 1;
    return operation(fake.executor);
  };
  const runtime = createSyntheticPollScheduleRuntime({
    datasetMode: "demo",
    schedulerEnabled: "true",
    l1ConnectionString,
  }, { withSqlExecutor });
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
      (error: unknown) => error instanceof SyntheticPollScheduleRuntimeError
        && error.code === "INVALID_SCHEDULED_TIME",
    );
  }
  assert.equal(operations, 0);
});

test("one transaction selects the L1 role, verifies namespace, schedules, and closes a count-only trace", async () => {
  const fake = createFakeSql();
  let operations = 0;
  let receivedConnectionString: string | undefined;
  const runtime = createSyntheticPollScheduleRuntime({
    datasetMode: "demo",
    schedulerEnabled: "true",
    l1ConnectionString,
  }, {
    withSqlExecutor: async (connectionString, operation) => {
      operations += 1;
      receivedConnectionString = connectionString;
      return operation(fake.executor);
    },
  });
  assert.ok(runtime);

  const summary = await runtime.schedule(scheduledTime);
  assert.deepEqual(summary, {
    candidateCount: 0,
    enqueuedCount: 0,
    existingCount: 0,
    notSchedulableCount: 0,
  });
  assert.equal(operations, 1);
  assert.equal(receivedConnectionString, l1ConnectionString);
  assert.deepEqual(fake.executions, [
    "BEGIN",
    "SET LOCAL ROLE waspada_l1_pipeline",
    "COMMIT",
  ]);

  const namespaceRead = fake.queries.find(({ statement }) =>
    statement.includes("FROM waspada.dataset_namespace_config"));
  assert.ok(namespaceRead);
  const traceInsert = fake.queries.find(({ statement }) =>
    statement.startsWith("INSERT INTO waspada.traces"));
  assert.ok(traceInsert);
  const traceId = traceInsert.parameters[0];
  assert.match(String(traceId), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
  assert.equal(traceInsert.parameters[1], "2026-10-01T00:00:00.123Z");
  assert.deepEqual(JSON.parse(String(traceInsert.parameters[2])), {
    trigger_kind: "scheduled_synthetic_source_poll",
  });

  const schedulerReads = fake.queries.filter(({ statement }) =>
    statement.includes("FROM waspada.traces") || statement.includes("FROM waspada.source_registry"));
  assert.equal(schedulerReads.length, 2);
  assert.deepEqual(schedulerReads[0]?.parameters, [traceId, "synthetic"]);
  assert.deepEqual(schedulerReads[1]?.parameters, [
    "2026-10-01T00:00:00.123Z", "synthetic", 100,
  ]);
  assert.equal(fake.executions.some((statement) => statement === "SET ROLE waspada_l1_pipeline"), false);

  const traceUpdate = fake.queries.find(({ statement }) =>
    statement.startsWith("UPDATE waspada.traces"));
  assert.ok(traceUpdate);
  assert.equal(traceUpdate.parameters[0], traceId);
  assert.equal(traceUpdate.parameters[1], "2026-10-01T00:00:00.123Z");
  assert.deepEqual(JSON.parse(String(traceUpdate.parameters[2])), {
    trigger_kind: "scheduled_synthetic_source_poll",
    candidate_count: 0,
    enqueued_count: 0,
    existing_count: 0,
    not_schedulable_count: 0,
  });
});

test("namespace mismatch and trace completion failure roll back with redacted errors", async () => {
  for (const options of [
    { namespace: "historical" },
    { failTraceCompletion: true },
  ]) {
    const fake = createFakeSql(options);
    let operations = 0;
    const runtime = createSyntheticPollScheduleRuntime({
      datasetMode: "demo",
      schedulerEnabled: "true",
      l1ConnectionString,
    }, {
      withSqlExecutor: async (_connectionString, operation) => {
        operations += 1;
        return operation(fake.executor);
      },
    });
    assert.ok(runtime);

    await assert.rejects(
      runtime.schedule(scheduledTime),
      (error: unknown) => error instanceof SyntheticPollScheduleRuntimeError
        && error.code === "SCHEDULE_FAILED"
        && !error.message.includes("historical")
        && !error.message.includes("trace"),
    );
    assert.equal(operations, 1);
    assert.equal(fake.executions.at(-1), "ROLLBACK");
    assert.equal(fake.executions.includes("COMMIT"), false);
    if ("namespace" in options && options.namespace === "historical") {
      assert.equal(fake.queries.some(({ statement }) => statement.startsWith("INSERT INTO waspada.traces")), false);
    }
  }
});

test("database diagnostics are redacted and execution failures are not retried", async () => {
  const fake = createFakeSql({ failDueRead: true });
  let operations = 0;
  const runtime = createSyntheticPollScheduleRuntime({
    datasetMode: "demo",
    schedulerEnabled: "true",
    l1ConnectionString,
  }, {
    withSqlExecutor: async (_connectionString, operation) => {
      operations += 1;
      return operation(fake.executor);
    },
  });
  assert.ok(runtime);

  await assert.rejects(
    runtime.schedule(scheduledTime),
    (error: unknown) => error instanceof SyntheticPollScheduleRuntimeError
      && error.code === "SCHEDULE_FAILED"
      && !error.message.includes("driver-secret")
      && !error.message.includes("private-example"),
  );
  assert.equal(operations, 1);
  assert.equal(fake.executions.at(-1), "ROLLBACK");
  assert.equal(fake.executions.includes("COMMIT"), false);
});


test("connection setup and client close failures return only the bounded runtime error", async () => {
  const connectFailure = createSyntheticPollScheduleRuntime({
    datasetMode: "demo",
    schedulerEnabled: "true",
    l1ConnectionString,
  }, {
    withSqlExecutor: async () => {
      throw new Error("connection password=adapter-secret");
    },
  });
  assert.ok(connectFailure);
  await assert.rejects(
    connectFailure.schedule(scheduledTime),
    (error: unknown) => error instanceof SyntheticPollScheduleRuntimeError
      && error.code === "SCHEDULE_FAILED"
      && !error.message.includes("adapter-secret"),
  );

  const fake = createFakeSql();
  let operations = 0;
  const closeFailure = createSyntheticPollScheduleRuntime({
    datasetMode: "demo",
    schedulerEnabled: "true",
    l1ConnectionString,
  }, {
    withSqlExecutor: async (_connectionString, operation) => {
      operations += 1;
      await operation(fake.executor);
      throw new Error("client close password=close-secret");
    },
  });
  assert.ok(closeFailure);
  await assert.rejects(
    closeFailure.schedule(scheduledTime),
    (error: unknown) => error instanceof SyntheticPollScheduleRuntimeError
      && error.code === "SCHEDULE_FAILED"
      && !error.message.includes("close-secret"),
  );
  assert.equal(operations, 1);
  assert.equal(fake.executions.at(-1), "COMMIT");
});
