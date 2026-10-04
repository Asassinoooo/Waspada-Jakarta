import assert from "node:assert/strict";
import test from "node:test";
import type { SqlExecutor, TransactionalSqlExecutor } from "../../db/src/sql.js";
import type { ModelCapabilityAdapter } from "../src/layers/l2-model-grounding/contracts.js";
import type { SyntheticSourcePollFixtureCatalog } from "../src/layers/l1-data-knowledge/synthetic-fixture-pipeline.js";
import {
  createSyntheticSourcePollProcessRuntime,
  SyntheticSourcePollProcessRuntimeError,
  type SyntheticSourcePollProcessRuntimeDependencies,
} from "../src/runtime/synthetic-source-poll-process-runtime.js";
import { handleSyntheticSourcePollProcessTrigger } from "../src/runtime/synthetic-source-poll-process-trigger.js";
import type { WorkerEnvironment } from "../src/layers/l4-application-integration/api.js";

const l1ConnectionString =
  "postgresql://l1-user:l1-secret@l1-hyperdrive.example.invalid/waspada?sslmode=require";
const publicConnectionString =
  "postgresql://reader-user:reader-secret@reader-hyperdrive.example.invalid/waspada?sslmode=require";
const scheduledTime = Date.parse("2026-10-04T00:00:00.123Z");

const catalog: SyntheticSourcePollFixtureCatalog = {
  lookupExactSourceId() { return null; },
};
const modelAdapter: Pick<ModelCapabilityAdapter, "extract"> = {
  async extract() { throw new Error("the empty queue must not invoke extraction"); },
};
const dependencies: SyntheticSourcePollProcessRuntimeDependencies = {
  catalog,
  modelAdapter,
};

interface FakeSqlOptions {
  readonly failClaim?: boolean;
  readonly failSetRole?: boolean;
  readonly failResetRole?: boolean;
}

function createFakeSql(options: FakeSqlOptions = {}) {
  const executions: string[] = [];
  const queries: Array<{ statement: string; parameters: readonly unknown[] }> = [];
  let transactionCount = 0;
  const executor: TransactionalSqlExecutor = {
    async execute(statement) {
      executions.push(statement);
      if ((statement === "SET ROLE waspada_l1_pipeline" && options.failSetRole)
        || (statement === "RESET ROLE" && options.failResetRole)) {
        throw new Error("driver-password=private-error");
      }
    },
    async query<Row extends object>(statement: string, parameters: readonly unknown[] = []) {
      queries.push({ statement, parameters });
      if (statement.includes("WITH due_job")) {
        if (options.failClaim) throw new Error("postgres://private-connection?password=secret");
        return { rows: [] as readonly Row[] };
      }
      throw new Error("unexpected SQL query");
    },
    async transaction<Result>(work: (transaction: SqlExecutor) => Promise<Result>) {
      transactionCount += 1;
      return work(executor);
    },
  };
  return { executor, executions, queries, get transactionCount() { return transactionCount; } };
}

function createRuntime(
  injected: SyntheticSourcePollProcessRuntimeDependencies = dependencies,
  sql = createFakeSql(),
) {
  let connectionCount = 0;
  let receivedConnectionString: string | undefined;
  const runtime = createSyntheticSourcePollProcessRuntime({
    datasetMode: "demo",
    processorEnabled: "true",
    l1ConnectionString,
  }, {
    ...injected,
    withTransactionalSqlExecutor: async (connectionString, operation) => {
      connectionCount += 1;
      receivedConnectionString = connectionString;
      return operation(sql.executor);
    },
  });
  return {
    runtime,
    sql,
    get connectionCount() { return connectionCount; },
    get receivedConnectionString() { return receivedConnectionString; },
  };
}

test("runtime stays closed unless exact demo gates, dedicated L1 SQL, catalog, and extractor are present", () => {
  let opened = 0;
  const withSql = async <Result>(
    _connectionString: string,
    operation: (executor: TransactionalSqlExecutor) => Promise<Result>,
  ) => {
    opened += 1;
    return operation(createFakeSql().executor);
  };
  const base = { datasetMode: "demo", processorEnabled: "true", l1ConnectionString };
  const disabledConfigurations = [
    { ...base, datasetMode: "Demo" },
    { ...base, datasetMode: "live" },
    { ...base, processorEnabled: "TRUE" },
    { ...base, processorEnabled: "true " },
    { ...base, processorEnabled: "false" },
    { ...base, l1ConnectionString: undefined },
    { ...base, l1ConnectionString: "not-a-connection" },
    { ...base, l1ConnectionString: publicConnectionString.slice(0, 12) },
  ];

  for (const configuration of disabledConfigurations) {
    assert.equal(createSyntheticSourcePollProcessRuntime(configuration, {
      catalog,
      modelAdapter,
      withTransactionalSqlExecutor: withSql,
    }), undefined);
  }
  assert.equal(createSyntheticSourcePollProcessRuntime(base, {
    modelAdapter,
    withTransactionalSqlExecutor: withSql,
  }), undefined);
  assert.equal(createSyntheticSourcePollProcessRuntime(base, {
    catalog,
    withTransactionalSqlExecutor: withSql,
  }), undefined);
  assert.equal(createSyntheticSourcePollProcessRuntime(base, {
    catalog: {} as SyntheticSourcePollFixtureCatalog,
    modelAdapter,
    withTransactionalSqlExecutor: withSql,
  }), undefined);
  assert.equal(createSyntheticSourcePollProcessRuntime(base, {
    catalog,
    modelAdapter: {} as Pick<ModelCapabilityAdapter, "extract">,
    withTransactionalSqlExecutor: withSql,
  }), undefined);
  assert.equal(opened, 0);
});

test("trigger only reads L1_HYPERDRIVE and stays dormant without injected processor capabilities", async () => {
  let opened = 0;
  const withSql = async <Result>(
    _connectionString: string,
    operation: (executor: TransactionalSqlExecutor) => Promise<Result>,
  ) => {
    opened += 1;
    return operation(createFakeSql().executor);
  };
  const environment: WorkerEnvironment = {
    DATASET_MODE: "demo",
    SYNTHETIC_POLL_PROCESSOR_ENABLED: "true",
    HYPERDRIVE: { connectionString: publicConnectionString },
    L1_HYPERDRIVE: { connectionString: l1ConnectionString },
  };

  assert.equal(await handleSyntheticSourcePollProcessTrigger(scheduledTime, environment), undefined);
  assert.equal(await handleSyntheticSourcePollProcessTrigger(
    scheduledTime,
    { ...environment, L1_HYPERDRIVE: undefined },
    { ...dependencies, withTransactionalSqlExecutor: withSql },
  ), undefined);
  assert.equal(opened, 0);
});

test("validates platform epochs before opening SQL and reports a fixed error", async () => {
  const sql = createFakeSql();
  const setup = createRuntime(dependencies, sql);
  assert.ok(setup.runtime);

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
      setup.runtime.process(malformed),
      (error: unknown) => error instanceof SyntheticSourcePollProcessRuntimeError
        && error.code === "INVALID_SCHEDULED_TIME"
        && error.message === "The scheduled synthetic poll timestamp is invalid.",
    );
  }
  assert.equal(setup.connectionCount, 0);
  assert.equal(sql.queries.length, 0);
  assert.equal(sql.executions.length, 0);
});

test("claims through one L1-scoped request and performs at most one source-poll claim", async () => {
  const setup = createRuntime();
  assert.ok(setup.runtime);

  assert.deepEqual(await setup.runtime.process(scheduledTime), { outcome: "idle" });
  assert.equal(setup.connectionCount, 1);
  assert.equal(setup.receivedConnectionString, l1ConnectionString);
  assert.deepEqual(setup.sql.executions, ["SET ROLE waspada_l1_pipeline", "RESET ROLE"]);
  assert.equal(setup.sql.queries.length, 1);
  assert.equal(setup.sql.queries[0]?.parameters[0], "2026-10-04T00:00:00.123Z");
  assert.match(setup.sql.queries[0]?.statement ?? "", /job\.dataset_kind = 'synthetic' AND job\.job_kind = 'source_poll'/u);
  assert.match(setup.sql.queries[0]?.statement ?? "", /LIMIT 1/u);
  assert.equal(setup.sql.transactionCount, 0);
});

test("role reset is attempted on failure and cleanup does not replace a bounded runner failure", async () => {
  const sql = createFakeSql({ failClaim: true, failResetRole: true });
  const setup = createRuntime(dependencies, sql);
  assert.ok(setup.runtime);

  const result = await setup.runtime.process(scheduledTime);
  assert.deepEqual(result, {
    outcome: "failed",
    code: "queue_claim_failed",
    queueOutcome: "not_claimed",
  });
  assert.deepEqual(sql.executions, ["SET ROLE waspada_l1_pipeline", "RESET ROLE"]);
  assert.equal(JSON.stringify(result).includes("secret"), false);

  const clientCloseSql = createFakeSql({ failClaim: true });
  const clientCloseRuntime = createSyntheticSourcePollProcessRuntime({
    datasetMode: "demo",
    processorEnabled: "true",
    l1ConnectionString,
  }, {
    ...dependencies,
    withTransactionalSqlExecutor: async (_connectionString, operation) => {
      await operation(clientCloseSql.executor);
      throw new Error("client.end failed with private credentials");
    },
  });
  assert.ok(clientCloseRuntime);
  assert.deepEqual(await clientCloseRuntime.process(scheduledTime), {
    outcome: "failed",
    code: "queue_claim_failed",
    queueOutcome: "not_claimed",
  });
  assert.deepEqual(clientCloseSql.executions, ["SET ROLE waspada_l1_pipeline", "RESET ROLE"]);
});

test("role setup, cleanup, and client failures expose only fixed redacted errors", async () => {
  const setupFailure = createRuntime(dependencies, createFakeSql({ failSetRole: true, failResetRole: true }));
  assert.ok(setupFailure.runtime);
  await assert.rejects(
    setupFailure.runtime.process(scheduledTime),
    (error: unknown) => error instanceof SyntheticSourcePollProcessRuntimeError
      && error.code === "PROCESS_FAILED"
      && error.message === "The synthetic source poll could not be completed."
      && !error.message.includes("secret"),
  );
  assert.deepEqual(setupFailure.sql.executions, ["SET ROLE waspada_l1_pipeline", "RESET ROLE"]);

  const cleanupFailure = createRuntime(dependencies, createFakeSql({ failResetRole: true }));
  assert.ok(cleanupFailure.runtime);
  await assert.rejects(
    cleanupFailure.runtime.process(scheduledTime),
    (error: unknown) => error instanceof SyntheticSourcePollProcessRuntimeError
      && error.code === "PROCESS_FAILED"
      && !error.message.includes("l1-secret"),
  );

  const clientFailure = createSyntheticSourcePollProcessRuntime({
    datasetMode: "demo",
    processorEnabled: "true",
    l1ConnectionString,
  }, {
    ...dependencies,
    withTransactionalSqlExecutor: async () => {
      throw new Error(`${l1ConnectionString} private-driver-detail`);
    },
  });
  assert.ok(clientFailure);
  await assert.rejects(
    clientFailure.process(scheduledTime),
    (error: unknown) => error instanceof SyntheticSourcePollProcessRuntimeError
      && error.code === "PROCESS_FAILED"
      && error.message === "The synthetic source poll could not be completed."
      && !error.message.includes("l1-secret")
      && !error.message.includes("private-driver-detail"),
  );
});
