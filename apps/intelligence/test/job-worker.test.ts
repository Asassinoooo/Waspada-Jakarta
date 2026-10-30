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
import { createEventProposalWriter } from "../../db/src/event-proposal-writer.js";

describe("Durable Job Processing Worker", () => {
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
    it("classifies error types into exact failure codes", () => {
      assert.equal(classifyJobError(new Error("Request aborted by timeout")), "model_timeout");
      assert.equal(classifyJobError(new Error("NineRouter 502 Bad Gateway")), "model_failed");
      assert.equal(classifyJobError(new Error("ZodError: Invalid type at summary")), "invalid_output");
      assert.equal(classifyJobError(new Error("syntax error at or near 'SELECT'")), "db_error");
      assert.equal(classifyJobError(new Error("some random failure")), "workflow_execution_failed");
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

      // Create runner with mock fallback enabled
      const runner = createJobRunner({
        executor: db.executor,
        fallbackMock: true,
      });

      // Process job
      const processed = await runner.processNextJob("synthetic");
      assert.equal(processed, true);

      // Verify job status in database is completed
      const checkRes = await db.executor.query<{ status: string; finished_at: string }>(
        `SELECT status, finished_at FROM waspada.ai_jobs WHERE job_id = 'ai-job-test-001'`,
      );
      assert.equal(checkRes.rows[0].status, "completed");
      assert.ok(checkRes.rows[0].finished_at);

      // Verify proposal was created in database
      const proposalWriter = createEventProposalWriter(db.executor);
      const pendingProposals = await proposalWriter.readPendingProposals("synthetic");
      assert.ok(pendingProposals.length >= 1);
    });

    it("handles failure and sets retry status when revision is missing", async () => {
      const incidentRepo = createSqlIncidentRepository(db.executor);

      await incidentRepo.enqueueAiJob({
        jobId: "ai-job-fail-test",
        datasetKind: "synthetic",
        reportRevisionId: "rev-non-existent",
      });

      const runner = createJobRunner({
        executor: db.executor,
        fallbackMock: true,
      });

      const processed = await runner.processNextJob("synthetic");
      assert.equal(processed, false);

      const checkRes = await db.executor.query<{ status: string; attempt_count: number; last_failure_code: string }>(
        `SELECT status, attempt_count, last_failure_code FROM waspada.ai_jobs WHERE job_id = 'ai-job-fail-test'`,
      );
      assert.equal(checkRes.rows[0].status, "retry");
      assert.equal(checkRes.rows[0].attempt_count, 1);
      assert.ok(checkRes.rows[0].last_failure_code);
    });
  });
});
