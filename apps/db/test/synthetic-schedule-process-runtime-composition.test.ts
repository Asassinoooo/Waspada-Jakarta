import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createModelCapabilityAdapter } from "../../worker/src/layers/l2-model-grounding/adapter.js";
import type {
  ExtractionRequest,
  UntrustedModelProvider,
} from "../../worker/src/layers/l2-model-grounding/contracts.js";
import {
  InMemorySyntheticSourcePollFixtureCatalog,
  type SyntheticFixture,
  type SyntheticReportManifest,
} from "../../worker/src/layers/l1-data-knowledge/synthetic-fixture-pipeline.js";
import {
  createSyntheticPollScheduleRuntime,
  type SyntheticPollScheduleSqlExecutorRunner,
} from "../../worker/src/runtime/synthetic-poll-schedule-runtime.js";
import {
  createSyntheticSourcePollProcessRuntime,
  type SyntheticSourcePollProcessSqlExecutorRunner,
} from "../../worker/src/runtime/synthetic-source-poll-process-runtime.js";
import { applyMigrations, readMigrations } from "../src/migrations.js";
import { createTestDatabase, type TestDatabase } from "./harness.js";

const connectionString =
  "postgresql://l1-user:l1-password@hyperdrive.example.invalid/waspada?sslmode=require";
const scheduledTime = Date.parse("2026-10-08T15:30:00.000Z");
const sourceId = "schedule-process-composition-source";
const seedTraceId = "schedule-process-composition-seed-trace";
const fixtureText = "Synthetic notice describes a station entrance on Merdeka Street.";

describe("JOB-01-SYNTHETIC-SCHEDULE-AND-PROCESS-RUNTIME-PGLITE-CORE", () => {
  let database: TestDatabase;

  before(async () => {
    database = await createTestDatabase();
    const migrations = await readMigrations(new URL("../migrations/", import.meta.url));
    await applyMigrations(database.executor, migrations);

    await database.executor.query(
      "INSERT INTO waspada.dataset_namespace_config (singleton, dataset_kind) VALUES (true, 'synthetic')",
    );
    await database.executor.query(
      "INSERT INTO waspada.traces\n"
        + "  (trace_id, dataset_kind, started_at, outcome, metadata)\n"
        + "VALUES ($1, 'synthetic', '2026-10-08T14:00:00.000Z', 'open',\n"
        + "  '{\"fixture\":\"authored-composition-test\"}'::jsonb)",
      [seedTraceId],
    );
    await database.executor.query(
      "INSERT INTO waspada.source_registry\n"
        + "  (source_id, trace_id, registry_version, display_name, source_kind, remit,\n"
        + "   access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,\n"
        + "   approval_status, health_status, auto_acquisition_enabled, auto_publication_policy,\n"
        + "   polling_interval_seconds)\n"
        + "VALUES ($1, $2, 1, 'Authored scheduled composition source', 'authority',\n"
        + "   ARRAY['synthetic composition fixture'], 'manual_fixture', ARRAY['synthetic.invalid'],\n"
        + "   ARRAY['authored test fixture only'], ARRAY['authored fixture'], 'active', 'approved',\n"
        + "   'unknown', true, 'never', 300)",
      [sourceId, seedTraceId],
    );
  });

  after(async () => {
    await database?.close();
  });

  it("schedules and processes the same exact-source job with private L1 persistence only", async () => {
    let scheduleExecutorCalls = 0;
    const withSqlExecutor: SyntheticPollScheduleSqlExecutorRunner = async (_connection, operation) => {
      scheduleExecutorCalls += 1;
      return operation(database.executor);
    };
    const scheduleRuntime = createSyntheticPollScheduleRuntime({
      datasetMode: "demo",
      schedulerEnabled: "true",
      l1ConnectionString: connectionString,
    }, { withSqlExecutor });
    assert.ok(scheduleRuntime);

    const scheduled = await scheduleRuntime.schedule(scheduledTime);
    assert.deepEqual(scheduled, {
      candidateCount: 1,
      enqueuedCount: 1,
      existingCount: 0,
      notSchedulableCount: 0,
    });
    assert.equal(scheduleExecutorCalls, 1);

    const traceRows = await database.executor.query<{
      trace_id: string;
      dataset_kind: string;
      started_at: string;
      ended_at: string;
      outcome: string;
      metadata: Record<string, unknown>;
    }>(
      "SELECT trace_id, dataset_kind, started_at::text AS started_at,\n"
        + "       ended_at::text AS ended_at, outcome, metadata\n"
        + "FROM waspada.traces WHERE trace_id <> $1",
      [seedTraceId],
    );
    assert.equal(traceRows.rows.length, 1);
    const scheduledTrace = traceRows.rows[0];
    assert.ok(scheduledTrace);
    assert.equal(scheduledTrace.dataset_kind, "synthetic");
    assert.equal(Date.parse(scheduledTrace.started_at), scheduledTime);
    assert.equal(Date.parse(scheduledTrace.ended_at), scheduledTime);
    assert.equal(scheduledTrace.outcome, "succeeded");
    assert.deepEqual(scheduledTrace.metadata, {
      trigger_kind: "scheduled_synthetic_source_poll",
      candidate_count: 1,
      enqueued_count: 1,
      existing_count: 0,
      not_schedulable_count: 0,
    });

    const queuedRows = await database.executor.query<{
      job_id: string;
      dataset_kind: string;
      source_id: string;
      status: string;
      trace_id: string;
    }>(
      "SELECT job_id, dataset_kind, source_id, status, trace_id\n"
        + "FROM waspada.acquisition_jobs",
    );
    assert.equal(queuedRows.rows.length, 1);
    const queuedJob = queuedRows.rows[0];
    assert.ok(queuedJob);
    assert.equal(queuedJob.dataset_kind, "synthetic");
    assert.equal(queuedJob.source_id, sourceId);
    assert.equal(queuedJob.status, "pending");
    assert.equal(queuedJob.trace_id, scheduledTrace.trace_id);

    const fixture = makeFixture(sourceId, "scheduled-source");
    const decoyFixture = makeFixture("schedule-process-unrelated-decoy", "decoy-source");
    const catalog = new InMemorySyntheticSourcePollFixtureCatalog([fixture, decoyFixture]);
    let extractionCalls = 0;
    const provider: UntrustedModelProvider = {
      async classify() {
        throw new Error("classification must not be called");
      },
      async extract(request: ExtractionRequest) {
        extractionCalls += 1;
        assert.equal(request.data.report.reportRevisionId, "revision-scheduled-source");
        const relations = ["supports", "contradicts", "updates", "context"] as const;
        return {
          output: {
            category: "transport_road_incidents",
            tags: [],
            eventTime: { start: null, end: null, precision: "unknown" },
            scope: { placeIds: [], serviceIds: [], institutionIds: [], audienceIds: [], geometryIds: [] },
            evidence: relations.map((relation, index) => ({
              reportRevisionId: request.data.report.reportRevisionId,
              permittedTextHash: request.data.report.permittedTextHash,
              spanStart: index * 5,
              spanEnd: index * 5 + 4,
              offsetUnit: "unicode_code_points",
              relation,
            })),
            unknownFields: ["event_time"],
          },
          usage: { inputTokens: 18, outputTokens: 9 },
        };
      },
      async embed() {
        throw new Error("embedding must not be called");
      },
      async reason() {
        throw new Error("reasoning must not be called");
      },
    };
    const modelAdapter = createModelCapabilityAdapter(provider, {
      extraction: {
        provider: "synthetic-schedule-process-pglite-double",
        modelVersion: "fixed-extractor-v1",
        promptVersion: "fixed-fixture-v1",
      },
    });

    let processorExecutorCalls = 0;
    const withTransactionalSqlExecutor: SyntheticSourcePollProcessSqlExecutorRunner =
      async (_connection, operation) => {
        processorExecutorCalls += 1;
        return operation(database.executor);
      };
    const processRuntime = createSyntheticSourcePollProcessRuntime({
      datasetMode: "demo",
      processorEnabled: "true",
      l1ConnectionString: connectionString,
    }, {
      catalog,
      modelAdapter,
      withTransactionalSqlExecutor,
      monotonicNow: () => 0,
    });
    assert.ok(processRuntime);

    const processed = await processRuntime.process(scheduledTime);
    assert.deepEqual(processed, {
      outcome: "completed",
      empty: false,
      reportCount: 1,
      evidenceReferenceCount: 5,
      chunkCount: 1,
      geometryCount: 1,
    });
    assert.equal(processorExecutorCalls, 1);
    assert.equal(extractionCalls, 1);

    const completedJob = await database.executor.query<{
      dataset_kind: string;
      source_id: string;
      status: string;
      attempt_count: number;
      trace_id: string;
    }>(
      "SELECT dataset_kind, source_id, status, attempt_count, trace_id\n"
        + "FROM waspada.acquisition_jobs WHERE job_id = $1",
      [queuedJob.job_id],
    );
    assert.deepEqual(completedJob.rows[0], {
      dataset_kind: "synthetic",
      source_id: sourceId,
      status: "completed",
      attempt_count: 1,
      trace_id: scheduledTrace.trace_id,
    });

    const manifest = fixture.manifests.get("parser-feature-id");
    assert.ok(manifest);
    const geometryId = manifest.geometry?.geometryId;
    assert.ok(geometryId);
    const persistence = await database.executor.query<{
      reports: string;
      exact_source: string;
      trace_linked_report: string;
      evidence_references: string;
      extraction_results: string;
      extraction_links: string;
      chunks: string;
      geometries: string;
      decoy_reports: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM waspada.report_revisions
          WHERE dataset_kind = 'synthetic' AND report_revision_id = $1) AS reports,
         (SELECT count(*)::text FROM waspada.report_revisions
          WHERE dataset_kind = 'synthetic' AND report_revision_id = $1
            AND source_id = $2 AND canonical_url = $3) AS exact_source,
         (SELECT count(*)::text FROM waspada.report_revisions
          WHERE dataset_kind = 'synthetic' AND report_revision_id = $1
            AND trace_id = $4) AS trace_linked_report,
         (SELECT count(*)::text FROM waspada.evidence_references
          WHERE dataset_kind = 'synthetic' AND report_revision_id = $1) AS evidence_references,
         (SELECT count(*)::text FROM waspada.extraction_results
          WHERE dataset_kind = 'synthetic' AND candidate_id = $5) AS extraction_results,
         (SELECT count(*)::text FROM waspada.extraction_evidence
          WHERE dataset_kind = 'synthetic' AND candidate_id = $5) AS extraction_links,
         (SELECT count(*)::text FROM waspada.evidence_chunks
          WHERE dataset_kind = 'synthetic' AND report_revision_id = $1) AS chunks,
         (SELECT count(*)::text FROM waspada.geometries
          WHERE dataset_kind = 'synthetic' AND geometry_id = $6) AS geometries,
         (SELECT count(*)::text FROM waspada.report_revisions
          WHERE dataset_kind = 'synthetic' AND report_revision_id = $7) AS decoy_reports`,
      [manifest.reportRevisionId, sourceId, fixture.url, scheduledTrace.trace_id,
        manifest.candidateId, geometryId, "revision-decoy-source"],
    );
    assert.deepEqual(persistence.rows[0], {
      reports: "1",
      exact_source: "1",
      trace_linked_report: "1",
      evidence_references: "5",
      extraction_results: "1",
      extraction_links: "4",
      chunks: "1",
      geometries: "1",
      decoy_reports: "0",
    });

    const health = await database.executor.query<{
      health_status: string;
      last_checked_at: string;
      last_success_at: string;
    }>(
      "SELECT health_status, last_checked_at::text AS last_checked_at,\n"
        + "       last_success_at::text AS last_success_at\n"
        + "FROM waspada.source_registry WHERE source_id = $1",
      [sourceId],
    );
    assert.equal(health.rows[0]?.health_status, "healthy");
    assert.equal(Date.parse(health.rows[0]?.last_checked_at ?? ""), scheduledTime);
    assert.equal(Date.parse(health.rows[0]?.last_success_at ?? ""), scheduledTime);
    assert.equal(await currentUser(), "postgres");

    // A completed acquisition and persisted report do not establish Event lifecycle or publication.
    const publicWrites = await database.executor.query<{
      events: string;
      publications: string;
    }>(
      "SELECT\n"
        + "  (SELECT count(*)::text FROM waspada.event_versions WHERE dataset_kind = 'synthetic') AS events,\n"
        + "  (SELECT count(*)::text FROM waspada.publication_decisions WHERE dataset_kind = 'synthetic') AS publications",
    );
    assert.deepEqual(publicWrites.rows[0], { events: "0", publications: "0" });
  });

  async function currentUser(): Promise<string | undefined> {
    const result = await database.executor.query<{ current_user: string }>("SELECT current_user");
    return result.rows[0]?.current_user;
  }
});

function makeFixture(sourceId: string, suffix: string): SyntheticFixture {
  const url = `https://synthetic.invalid/notices/${suffix}`;
  const manifest: SyntheticReportManifest = {
    candidateId: `candidate-${suffix}`,
    reportRevisionId: `revision-${suffix}`,
    sourceId,
    canonicalUrl: url,
    contentHash: "a".repeat(64),
    permittedText: fixtureText,
    publishedAt: null,
    observedAt: "2026-10-08T15:25:00.000Z",
    validFrom: null,
    validUntil: null,
    supersedesId: null,
    supportSpans: [{ spanStart: 0, spanEnd: Array.from(fixtureText).length }],
    geometry: {
      geometryId: `geometry-${suffix}`,
      role: "approximate_place",
      precisionM: null,
      precisionBasis: "moderator_generalization",
      displayLabel: "Synthetic Merdeka Street station entrance",
      supportSpans: [{ spanStart: 0, spanEnd: Array.from(fixtureText).length }],
    },
  };
  return {
    sourceId,
    url,
    retrievedAt: "2026-10-08T15:30:00.000Z",
    geoJson: JSON.stringify({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        id: "parser-feature-id",
        properties: {
          status: "transient-only",
          report_type: "transient-only",
          created_at: "2026-10-08T15:25:00.000Z",
        },
        geometry: { type: "Point", coordinates: [106.8272, -6.1754] },
      }],
    }),
    manifests: new Map([["parser-feature-id", manifest]]),
  };
}
