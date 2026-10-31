import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { createTestDatabase, type TestDatabase } from "../../db/test/harness.js";
import { applyMigrations, readMigrations } from "../../db/src/migrations.js";
import {
  createJobRunner,
  classifyJobError,
  calculateBackoffMs,
} from "../src/job-runner.js";
import { createSqlIncidentRepository } from "../../db/src/incident-repository.js";
import { createMockInterpreterAgent, createMockCorrelatorAgent, createFailingAgent } from "./mock-agents.js";

describe("Durable AI Job Worker", () => {
  let db: TestDatabase;

  before(async () => {
    db = await createTestDatabase();
    const migrations = await readMigrations(new URL("../../db/migrations/", import.meta.url));
    await applyMigrations(db.executor, migrations);
  });

  after(async () => {
    await db?.close();
  });

  describe("Error Classification & Backoff", () => {
    it("classifies error types into standard failure codes", () => {
      assert.equal(classifyJobError(new Error("Request timed out after 30s")), "model_timeout");
      assert.equal(classifyJobError(new Error("NineRouter API 500 Internal Server Error")), "model_failed");
      assert.equal(classifyJobError(new Error("ZodError: Invalid schema output")), "invalid_output");
      assert.equal(classifyJobError(new Error("syntax error at or near 'SELECT'")), "db_error");
      assert.equal(classifyJobError(new Error("Unexpected system error")), "workflow_execution_failed");
    });

    it("calculates exponential backoff with a 60s cap", () => {
      assert.equal(calculateBackoffMs(0), 1_000);
      assert.equal(calculateBackoffMs(1), 2_000);
      assert.equal(calculateBackoffMs(2), 4_000);
      assert.equal(calculateBackoffMs(3), 8_000);
      assert.equal(calculateBackoffMs(10), 60_000);
    });
  });

  describe("Job Execution Lifecycle with PGlite", () => {
    it("claims pending job, runs Mastra workflow, and marks completed", async () => {
      const incidentRepo = createSqlIncidentRepository(db.executor);

      // Seed prerequisite trace, source, and report revision in database
      const traceId = "trace-job-test-01";
      const sourceId = "source-job-test";
      const revisionId = "rev-job-001";
      const dummyHash = "0000000000000000000000000000000000000000000000000000000000000000";

      await db.executor.execute(`
        INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
        VALUES ('${traceId}', 'synthetic', now(), 'succeeded', '{}'::jsonb)
        ON CONFLICT (trace_id) DO NOTHING;

        INSERT INTO waspada.source_registry
          (source_id, trace_id, registry_version, display_name, source_kind, remit,
           access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
           approval_status, health_status, auto_acquisition_enabled, auto_publication_policy)
        VALUES ('${sourceId}', '${traceId}', 1, 'Laporan Lapangan', 'other', ARRAY['system'], 'manual_fixture',
                ARRAY[]::text[], ARRAY[]::text[], ARRAY['public'], 'active', 'approved', 'healthy', false, 'never')
        ON CONFLICT (source_id) DO NOTHING;

        INSERT INTO waspada.report_revisions
          (dataset_kind, report_revision_id, trace_id, source_id, canonical_url, content_hash, permitted_text, permitted_text_hash, normalization_version, retrieved_at, revision_status, record_json)
        VALUES ('synthetic', '${revisionId}', '${traceId}', '${sourceId}', 'https://waspada.jakarta.go.id/source', '${dummyHash}', 'Pohon tumbang menutup Jalan Sudirman dekat Halte Tosari pada malam hari.', '${dummyHash}', 'v1', now(), 'unreviewed', '{}'::jsonb)
        ON CONFLICT (dataset_kind, report_revision_id) DO NOTHING;
      `);

      // Enqueue job
      const job = await incidentRepo.enqueueAiJob({
        jobId: "ai-job-test-001",
        datasetKind: "synthetic",
        reportRevisionId: revisionId,
        traceId,
      });
      assert.equal(job.status, "pending");

      // Create runner with explicit mock agents
      const runner = createJobRunner({
        executor: db.executor,
        agentOverrides: {
          interpreter: createMockInterpreterAgent({
            summary: "Pohon tumbang menutup Jalan Sudirman dekat Halte Tosari",
            incidentType: "pohon_tumbang",
            severity: "medium",
          }),
          correlator: createMockCorrelatorAgent(),
        },
      });

      // Process job
      const processed = await runner.processNextJob("synthetic");
      assert.equal(processed, true);

      // Verify job status in database is completed
      const checkRes = await db.executor.query<{ status: string; finished_at: string }>(
        `SELECT status, finished_at FROM waspada.ai_jobs WHERE job_id = 'ai-job-test-001'`,
      );
      assert.equal(checkRes.rows.length, 1);
      assert.equal(checkRes.rows[0].status, "completed");
      assert.ok(checkRes.rows[0].finished_at);
    });

    it("handles provider failure gracefully, enters retry, and preserves raw report without fabricating proposals", async () => {
      const incidentRepo = createSqlIncidentRepository(db.executor);
      const traceId = "trace-job-fail-01";
      const sourceId = "source-job-fail";
      const revisionId = "rev-job-fail-001";
      const dummyHash = "2222222222222222222222222222222222222222222222222222222222222222";

      await db.executor.execute(`
        INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
        VALUES ('${traceId}', 'synthetic', now(), 'succeeded', '{}'::jsonb)
        ON CONFLICT (trace_id) DO NOTHING;

        INSERT INTO waspada.source_registry
          (source_id, trace_id, registry_version, display_name, source_kind, remit,
           access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
           approval_status, health_status, auto_acquisition_enabled, auto_publication_policy)
        VALUES ('${sourceId}', '${traceId}', 1, 'Sumber Pengujian', 'other', ARRAY['system'], 'manual_fixture',
                ARRAY[]::text[], ARRAY[]::text[], ARRAY['public'], 'active', 'approved', 'healthy', false, 'never')
        ON CONFLICT (source_id) DO NOTHING;

        INSERT INTO waspada.report_revisions
          (dataset_kind, report_revision_id, trace_id, source_id, canonical_url, content_hash, permitted_text, permitted_text_hash, normalization_version, retrieved_at, revision_status, record_json)
        VALUES ('synthetic', '${revisionId}', '${traceId}', '${sourceId}', 'https://waspada.jakarta.go.id/source-fail', '${dummyHash}', 'Laporan penting tetapi model AI sedang offline.', '${dummyHash}', 'v1', now(), 'unreviewed', '{}'::jsonb)
        ON CONFLICT (dataset_kind, report_revision_id) DO NOTHING;
      `);

      await incidentRepo.enqueueAiJob({
        jobId: "ai-job-fail-001",
        datasetKind: "synthetic",
        reportRevisionId: revisionId,
        traceId,
      });

      // Runner with failing interpreter
      const runner = createJobRunner({
        executor: db.executor,
        agentOverrides: {
          interpreter: createFailingAgent(new Error("NineRouter 502 Bad Gateway")),
        },
      });

      const processed = await runner.processNextJob("synthetic");
      assert.equal(processed, false, "Should return false on provider failure");

      // Verify job is in retry
      const jobRecord = await runner.getJob("ai-job-fail-001");
      assert.ok(jobRecord);
      assert.equal(jobRecord.status, "retry");
      assert.equal(jobRecord.lastFailureCode, "model_failed");
      assert.equal(jobRecord.attemptCount, 1);

      // Verify raw report is preserved
      const revCheck = await db.executor.query<{ report_revision_id: string }>(
        `SELECT report_revision_id FROM waspada.report_revisions WHERE report_revision_id = '${revisionId}'`,
      );
      assert.equal(revCheck.rows.length, 1);

      // Verify NO proposals were fabricated
      const propCheck = await db.executor.query<{ proposal_id: string }>(
        `SELECT proposal_id FROM waspada.event_proposals WHERE dataset_kind = 'synthetic' AND trace_id = '${traceId}'`,
      );
      assert.equal(propCheck.rows.length, 0, "No proposal should be created on provider failure");
    });
  });
});
