import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFreshnessDueScheduleRuntime } from "../../worker/src/runtime/freshness-due-schedule-runtime.js";
import { applyMigrations, readMigrations } from "../src/migrations.js";
import { createTestDatabase } from "./harness.js";

const scheduleTime = Date.parse("2026-10-01T00:00:00.123Z");
const connectionString =
  "postgresql://freshness-user:freshness-secret@freshness-hyperdrive.example.invalid/waspada?sslmode=require";

describe("PGlite freshness due scheduled runtime composition", () => {
  it("closes an audited live run through migrations 024-026 without incident data", async () => {
    const database = await createTestDatabase();
    try {
      const migrations = await readMigrations(new URL("../migrations/", import.meta.url));
      const applied = await applyMigrations(database.executor, migrations);
      for (const version of [
        "024_freshness_transition_ledger",
        "025_freshness_current_public_overlay",
        "026_freshness_due_run_traces",
      ]) {
        assert.ok(applied.applied.includes(version), "expected migration " + version);
      }

      const runtime = createFreshnessDueScheduleRuntime({
        datasetMode: "live",
        schedulerEnabled: "true",
        freshnessWriterConnectionString: connectionString,
      }, {
        withTransactionalSqlExecutor: async (_connection, operation) => operation(database.executor),
        clock: () => scheduleTime - 10_000,
      });
      assert.ok(runtime);

      await runtime.schedule(scheduleTime);

      const traces = await database.executor.query<{
        readonly trace_id: string;
        readonly dataset_kind: string;
        readonly outcome: string;
        readonly started_at_ms: string;
        readonly ended_at_ms: string;
        readonly metadata: Record<string, unknown>;
      }>(
        "SELECT trace_id, dataset_kind, outcome,\n" +
        "       (extract(epoch FROM started_at) * 1000)::text AS started_at_ms,\n" +
        "       (extract(epoch FROM ended_at) * 1000)::text AS ended_at_ms,\n" +
        "       metadata\n" +
        "FROM waspada.traces\n" +
        "WHERE trace_id = $1",
        ["freshness-due:" + scheduleTime],
      );
      assert.equal(traces.rows.length, 1);
      const trace = traces.rows[0];
      assert.ok(trace);
      assert.equal(trace.trace_id, "freshness-due:" + scheduleTime);
      assert.equal(trace.dataset_kind, "live");
      assert.equal(trace.outcome, "succeeded");
      assert.equal(Number(trace.started_at_ms), scheduleTime);
      assert.ok(Number(trace.ended_at_ms) >= Number(trace.started_at_ms));
      assert.deepEqual(trace.metadata, {
        trigger: "freshness_due_evaluation",
        summary: { written: 0, replayed: 0, noChange: 0, conflicts: 0, failures: 0 },
      });

      const incidentCounts = await database.executor.query<{
        readonly event_versions: number;
        readonly impact_versions: number;
        readonly evidence_references: number;
        readonly freshness_transitions: number;
        readonly publication_decisions: number;
      }>(
        "SELECT\n" +
        "  (SELECT count(*)::integer FROM waspada.event_versions) AS event_versions,\n" +
        "  (SELECT count(*)::integer FROM waspada.impact_versions) AS impact_versions,\n" +
        "  (SELECT count(*)::integer FROM waspada.evidence_references) AS evidence_references,\n" +
        "  (SELECT count(*)::integer FROM waspada.freshness_transitions) AS freshness_transitions,\n" +
        "  (SELECT count(*)::integer FROM waspada.publication_decisions) AS publication_decisions",
      );
      assert.deepEqual(incidentCounts.rows, [{
        event_versions: 0,
        impact_versions: 0,
        evidence_references: 0,
        freshness_transitions: 0,
        publication_decisions: 0,
      }]);

      const role = await database.executor.query<{ readonly current_user: string }>(
        "SELECT current_user",
      );
      assert.notEqual(role.rows[0]?.current_user, "waspada_l4_freshness_writer");
    } finally {
      await database.close();
    }
  });
});
