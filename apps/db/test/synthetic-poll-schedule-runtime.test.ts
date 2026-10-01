import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createSyntheticPollScheduleRuntime } from "../../worker/src/runtime/synthetic-poll-schedule-runtime.js";
import type { SyntheticPollScheduleSqlExecutorRunner } from "../../worker/src/runtime/synthetic-poll-schedule-runtime.js";
import { applyMigrations, readMigrations } from "../src/migrations.js";
import { createTestDatabase, type TestDatabase } from "./harness.js";
import type { SqlExecutor } from "../src/sql.js";

const connectionString =
  "postgresql://l1-user:l1-password@hyperdrive.example.invalid/waspada?sslmode=require";
const scheduledTime = Date.parse("2026-10-01T00:00:00.123Z");
const sourceId = "scheduled-runtime-synthetic-source";
const seedTraceId = "scheduled-runtime-seed-trace";

describe("JOB-01-SYNTHETIC-SCHEDULE-RUNTIME-CORE", () => {
  let database: TestDatabase;

  before(async () => {
    database = await createTestDatabase();
    const migrations = await readMigrations(new URL("../migrations/", import.meta.url));
    const result = await applyMigrations(database.executor, migrations);
    assert.ok(result.applied.includes("021_l1_scheduler_namespace_read"));

    await database.executor.query(
      "INSERT INTO waspada.dataset_namespace_config (singleton, dataset_kind) VALUES (true, 'synthetic')",
    );
    await database.executor.query(
      "INSERT INTO waspada.traces\n"
        + "  (trace_id, dataset_kind, started_at, outcome, metadata)\n"
        + "VALUES ($1, 'synthetic', '2026-09-30T23:00:00.000Z', 'open',\n"
        + "  '{\"fixture\":\"synthetic-only\"}'::jsonb)",
      [seedTraceId],
    );
    await database.executor.query(
      "INSERT INTO waspada.source_registry\n"
        + "  (source_id, trace_id, registry_version, display_name, source_kind, remit,\n"
        + "   access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,\n"
        + "   approval_status, health_status, auto_acquisition_enabled, auto_publication_policy,\n"
        + "   polling_interval_seconds)\n"
        + "VALUES ($1, $2, 1, 'Authored synthetic scheduler source', 'authority',\n"
        + "   ARRAY['synthetic scheduler fixture'], 'manual_fixture', ARRAY['synthetic.invalid'],\n"
        + "   ARRAY['synthetic only'], ARRAY['test fixture'], 'active', 'approved', 'unknown',\n"
        + "   true, 'never', 300)",
      [sourceId, seedTraceId],
    );
  });

  after(async () => {
    await database?.close();
  });

  it("runs the actual scheduler under L1 and limits trace and queue writes to synthetic", async () => {
    const withSqlExecutor: SyntheticPollScheduleSqlExecutorRunner = async (_connectionString, operation) =>
      operation(database.executor);
    const runtime = createSyntheticPollScheduleRuntime({
      datasetMode: "demo",
      schedulerEnabled: "true",
      l1ConnectionString: connectionString,
    }, { withSqlExecutor });
    assert.ok(runtime);

    const first = await runtime.schedule(scheduledTime);
    assert.deepEqual(first, {
      candidateCount: 1,
      enqueuedCount: 1,
      existingCount: 0,
      notSchedulableCount: 0,
    });

    const repeated = await runtime.schedule(scheduledTime);
    assert.deepEqual(repeated, {
      candidateCount: 0,
      enqueuedCount: 0,
      existingCount: 0,
      notSchedulableCount: 0,
    });

    const traces = await database.executor.query<{
      trace_id: string;
      dataset_kind: string;
      started_at: string;
      ended_at: string;
      outcome: string;
      metadata: Record<string, unknown>;
    }>(
      "SELECT trace_id, dataset_kind, started_at::text AS started_at,\n"
        + "       ended_at::text AS ended_at, outcome, metadata\n"
        + "FROM waspada.traces\n"
        + "WHERE trace_id <> $1\n"
        + "ORDER BY started_at, trace_id",
      [seedTraceId],
    );
    assert.equal(traces.rows.length, 2);
    for (const trace of traces.rows) {
      assert.match(trace.trace_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
      assert.equal(trace.dataset_kind, "synthetic");
      assert.equal(Date.parse(trace.started_at), scheduledTime);
      assert.equal(Date.parse(trace.ended_at), scheduledTime);
      assert.equal(trace.outcome, "succeeded");
    }
    const traceMetadata = traces.rows.map(({ metadata }) => metadata)
      .sort((left, right) => Number(left.candidate_count) - Number(right.candidate_count));
    assert.deepEqual(traceMetadata, [
      {
        trigger_kind: "scheduled_synthetic_source_poll",
        candidate_count: 0,
        enqueued_count: 0,
        existing_count: 0,
        not_schedulable_count: 0,
      },
      {
        trigger_kind: "scheduled_synthetic_source_poll",
        candidate_count: 1,
        enqueued_count: 1,
        existing_count: 0,
        not_schedulable_count: 0,
      },
    ]);

    const jobs = await database.executor.query<{
      dataset_kind: string;
      source_id: string;
      status: string;
      trace_id: string;
      idempotency_key: string;
    }>(
      "SELECT dataset_kind, source_id, status, trace_id, idempotency_key\n"
        + "FROM waspada.acquisition_jobs ORDER BY job_id",
    );
    assert.equal(jobs.rows.length, 1);
    const job = jobs.rows[0];
    assert.equal(job?.dataset_kind, "synthetic");
    assert.equal(job?.source_id, sourceId);
    assert.equal(job?.status, "pending");
    assert.ok(traces.rows.some(({ trace_id }) => trace_id === job?.trace_id));
    assert.match(job?.idempotency_key ?? "", /^source-poll:v1:[a-f0-9]{64}$/u);

    const source = await database.executor.query<{
      health_status: string;
      last_checked_at: string | null;
      last_success_at: string | null;
    }>(
      "SELECT health_status, last_checked_at::text AS last_checked_at,\n"
        + "       last_success_at::text AS last_success_at\n"
        + "FROM waspada.source_registry WHERE source_id = $1",
      [sourceId],
    );
    assert.deepEqual(source.rows[0], {
      health_status: "unknown",
      last_checked_at: null,
      last_success_at: null,
    });

    const publicationCounts = await database.executor.query<{
      events: string;
      decisions: string;
    }>(
      "SELECT\n"
        + "  (SELECT count(*)::text FROM waspada.event_versions WHERE dataset_kind = 'synthetic') AS events,\n"
        + "  (SELECT count(*)::text FROM waspada.publication_decisions WHERE dataset_kind = 'synthetic') AS decisions",
    );
    assert.deepEqual(publicationCounts.rows[0], { events: "0", decisions: "0" });
  });

  it("rolls back an enqueue when trace completion fails", async () => {
    const rollbackSourceId = "scheduled-runtime-rollback-source";
    await database.executor.query(
      "INSERT INTO waspada.source_registry\n"
        + "  (source_id, trace_id, registry_version, display_name, source_kind, remit,\n"
        + "   access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,\n"
        + "   approval_status, health_status, auto_acquisition_enabled, auto_publication_policy,\n"
        + "   polling_interval_seconds)\n"
        + "VALUES ($1, $2, 1, 'Authored rollback fixture', 'authority',\n"
        + "   ARRAY['synthetic rollback fixture'], 'manual_fixture', ARRAY['synthetic.invalid'],\n"
        + "   ARRAY['synthetic only'], ARRAY['test fixture'], 'active', 'approved', 'unknown',\n"
        + "   true, 'never', 300)",
      [rollbackSourceId, seedTraceId],
    );

    const beforeTraces = await database.executor.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM waspada.traces",
    );
    const beforeJobs = await database.executor.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM waspada.acquisition_jobs",
    );
    let observedEnqueue = false;
    let observedTraceCompletion = false;
    const failingExecutor: SqlExecutor = {
      async execute(statement) {
        await database.executor.execute(statement);
      },
      async query<Row extends object>(statement: string, parameters?: readonly unknown[]) {
        if (statement.startsWith("INSERT INTO waspada.acquisition_jobs")) {
          observedEnqueue = true;
        }
        if (statement.startsWith("UPDATE waspada.traces")) {
          observedTraceCompletion = true;
          return { rows: [] };
        }
        return database.executor.query<Row>(statement, parameters);
      },
    };
    const withSqlExecutor: SyntheticPollScheduleSqlExecutorRunner = async (_connectionString, operation) =>
      operation(failingExecutor);
    const runtime = createSyntheticPollScheduleRuntime({
      datasetMode: "demo",
      schedulerEnabled: "true",
      l1ConnectionString: connectionString,
    }, { withSqlExecutor });
    assert.ok(runtime);

    await assert.rejects(
      runtime.schedule(scheduledTime),
      (error: unknown) => error instanceof Error
        && error.message === "The synthetic scheduled poll could not be completed.",
    );
    assert.equal(observedEnqueue, true);
    assert.equal(observedTraceCompletion, true);

    const afterTraces = await database.executor.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM waspada.traces",
    );
    const afterJobs = await database.executor.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM waspada.acquisition_jobs",
    );
    assert.deepEqual(afterTraces.rows, beforeTraces.rows);
    assert.deepEqual(afterJobs.rows, beforeJobs.rows);
    const rollbackJobs = await database.executor.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM waspada.acquisition_jobs WHERE source_id = $1",
      [rollbackSourceId],
    );
    assert.deepEqual(rollbackJobs.rows, [{ count: "0" }]);
  });

  it("grants L1 only the namespace dataset read and forbids namespace mutation", async () => {
    const privileges = await database.executor.query<{
      l1_dataset_read: boolean;
      l1_singleton_read: boolean;
      l1_namespace_update: boolean;
      public_reader_read: boolean;
      l4_writer_read: boolean;
      l3_coordinator_read: boolean;
    }>(
      "SELECT\n"
        + "  has_column_privilege('waspada_l1_pipeline', 'waspada.dataset_namespace_config', 'dataset_kind', 'SELECT') AS l1_dataset_read,\n"
        + "  has_column_privilege('waspada_l1_pipeline', 'waspada.dataset_namespace_config', 'singleton', 'SELECT') AS l1_singleton_read,\n"
        + "  has_column_privilege('waspada_l1_pipeline', 'waspada.dataset_namespace_config', 'dataset_kind', 'UPDATE') AS l1_namespace_update,\n"
        + "  has_column_privilege('waspada_public_reader', 'waspada.dataset_namespace_config', 'dataset_kind', 'SELECT') AS public_reader_read,\n"
        + "  has_column_privilege('waspada_l4_publication_writer', 'waspada.dataset_namespace_config', 'dataset_kind', 'SELECT') AS l4_writer_read,\n"
        + "  has_column_privilege('waspada_l3_coordinator', 'waspada.dataset_namespace_config', 'dataset_kind', 'SELECT') AS l3_coordinator_read",
    );
    assert.deepEqual(privileges.rows, [{
      l1_dataset_read: true,
      l1_singleton_read: false,
      l1_namespace_update: false,
      public_reader_read: false,
      l4_writer_read: true,
      l3_coordinator_read: false,
    }]);

    await database.executor.execute("SET ROLE waspada_l1_pipeline");
    try {
      const namespace = await database.executor.query<{ dataset_kind: string }>(
        "SELECT dataset_kind FROM waspada.dataset_namespace_config",
      );
      assert.deepEqual(namespace.rows, [{ dataset_kind: "synthetic" }]);
      await assert.rejects(
        database.executor.query(
          "UPDATE waspada.dataset_namespace_config SET dataset_kind = 'live' WHERE singleton = true",
        ),
        /permission denied/i,
      );
    } finally {
      await database.executor.execute("RESET ROLE");
    }
  });

  it("rolls back namespace mismatch or absence before creating trace or queue rows", async () => {
    const withSqlExecutor: SyntheticPollScheduleSqlExecutorRunner = async (_connectionString, operation) =>
      operation(database.executor);
    const runtime = createSyntheticPollScheduleRuntime({
      datasetMode: "demo",
      schedulerEnabled: "true",
      l1ConnectionString: connectionString,
    }, { withSqlExecutor });
    assert.ok(runtime);

    const beforeTraces = await database.executor.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM waspada.traces",
    );
    const beforeJobs = await database.executor.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM waspada.acquisition_jobs",
    );

    for (const namespace of ["historical", "live", null] as const) {
      if (namespace === null) {
        await database.executor.execute("DELETE FROM waspada.dataset_namespace_config");
      } else {
        await database.executor.query(
          "UPDATE waspada.dataset_namespace_config SET dataset_kind = $1 WHERE singleton = true",
          [namespace],
        );
      }

      await assert.rejects(
        runtime.schedule(scheduledTime + 300_000),
        (error: unknown) => error instanceof Error
          && error.message === "The synthetic scheduled poll could not be completed.",
      );

      const afterTraces = await database.executor.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM waspada.traces",
      );
      const afterJobs = await database.executor.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM waspada.acquisition_jobs",
      );
      assert.deepEqual(afterTraces.rows, beforeTraces.rows);
      assert.deepEqual(afterJobs.rows, beforeJobs.rows);
    }
  });
});
