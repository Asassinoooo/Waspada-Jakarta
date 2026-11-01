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
      primaryCategory: "disasters_weather",
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

  describe("WJ-INT-02B fail-closed triage gate", () => {
    const gateHash = (n: number) => String(n).repeat(64).slice(0, 64);
    async function seedGatedRevision(input: {
      readonly key: string;
      readonly triageRequired: boolean;
      readonly sourceId?: string;
    }): Promise<{ traceId: string; sourceId: string; revisionId: string }> {
      const traceId = `trace-gate-${input.key}`;
      const sourceId = input.sourceId ?? `source-gate-${input.key}`;
      const revisionId = `rev-gate-${input.key}`;
      const dummyHash = gateHash(3);
      // WJ-INT-02B: gate behavior is a live-dataset behavior. Synthetic rows
      // bypass triage by design (042 backfill was over-broad; the flag on
      // synthetic rows is immutable history under the append-only trigger).
      await db.executor.execute(`
        INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
        VALUES ('${traceId}', 'live', now(), 'succeeded', '{}'::jsonb)
        ON CONFLICT (trace_id) DO NOTHING;

        INSERT INTO waspada.source_registry
          (source_id, trace_id, registry_version, display_name, source_kind, remit,
           access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
           approval_status, health_status, auto_acquisition_enabled, auto_publication_policy)
        VALUES ('${sourceId}', '${traceId}', 1, 'Gated Source', 'other', ARRAY['system'], 'manual_fixture',
                ARRAY[]::text[], ARRAY[]::text[], ARRAY['public'], 'active', 'approved', 'healthy', false, 'never')
        ON CONFLICT (source_id) DO NOTHING;

        INSERT INTO waspada.report_revisions
          (dataset_kind, report_revision_id, trace_id, source_id, canonical_url, content_hash, permitted_text, permitted_text_hash, normalization_version, retrieved_at, revision_status, record_json, triage_required)
        VALUES ('live', '${revisionId}', '${traceId}', '${sourceId}', 'https://live.invalid/${revisionId}', '${dummyHash}', 'Pohon tumbang menutup jalan.', '${dummyHash}', 'v1', now(), 'unreviewed', '{}'::jsonb, ${input.triageRequired})
        ON CONFLICT (dataset_kind, report_revision_id) DO NOTHING;
      `);
      return { traceId, sourceId, revisionId };
    }
    async function seedDecision(input: {
      readonly revisionId: string;
      readonly sourceId: string;
      readonly traceId: string;
      readonly disposition: "ingest" | "drop" | "uncertain";
    }): Promise<void> {
      const { recordTriageDecision, recordTriageAttempt } = await import("../../db/src/news-triage-store.js");
      const itemIdentityHash = gateHash(7);
      // WJ-INT-02B: the gate requires the decision/attempt content hash to
      // match the revision's stored content_hash (gateHash(3) in the seed).
      const contentHash = gateHash(3);
      await recordTriageDecision(db.executor, {
        datasetKind: "live",
        itemIdentityHash,
        sourceId: input.sourceId,
        traceId: input.traceId,
        disposition: input.disposition,
        jakartaScope: "dki_jakarta",
        actionability: "actionable",
        primaryCategory: "disasters_weather",
        incidentType: "pohon_tumbang",
        confidence: "high",
        reasonCodes: ["triage_v1_ingest"],
        modelStatus: "ok",
        reportRevisionId: input.revisionId,
        contentHash,
        attemptCount: 1,
      });
      await recordTriageAttempt(db.executor, {
        datasetKind: "live",
        itemIdentityHash,
        reportRevisionId: input.revisionId,
        sourceId: input.sourceId,
        traceId: input.traceId,
        disposition: input.disposition,
        jakartaScope: "dki_jakarta",
        actionability: "actionable",
        primaryCategory: "disasters_weather",
        incidentType: "pohon_tumbang",
        confidence: "high",
        reasonCodes: ["triage_v1_ingest"],
        modelStatus: "ok",
        contentHash,
      });
    }

    it("runs required-RSS revisions with decision-ingest and attempt-ingest", async () => {
      const incidentRepo = createSqlIncidentRepository(db.executor);
      const { traceId, revisionId, sourceId } = await seedGatedRevision({ key: "ok", triageRequired: true });
      await seedDecision({ revisionId, sourceId, traceId, disposition: "ingest" });
      await incidentRepo.enqueueAiJob({ jobId: "ai-job-gate-ok", datasetKind: "live", reportRevisionId: revisionId, traceId });
      const runner = createJobRunner({
        executor: db.executor,
        agentOverrides: {
          interpreter: createMockInterpreterAgent({
            summary: "Pohon tumbang menutup jalan",
            incidentType: "pohon_tumbang",
            severity: "medium",
            primaryCategory: "disasters_weather",
          }),
          correlator: createMockCorrelatorAgent(),
        },
      });
      assert.equal(await runner.processNextJob("live"), true);
      const check = await db.executor.query<{ status: string }>(
        `SELECT status FROM waspada.ai_jobs WHERE job_id = 'ai-job-gate-ok'`,
      );
      assert.equal(check.rows[0]?.status, "completed");
    });

    it("routes missing decision to needs_review without interpretation", async () => {
      const incidentRepo = createSqlIncidentRepository(db.executor);
      const { traceId, revisionId } = await seedGatedRevision({ key: "missing", triageRequired: true });
      await incidentRepo.enqueueAiJob({ jobId: "ai-job-gate-missing", datasetKind: "live", reportRevisionId: revisionId, traceId });
      const runner = createJobRunner({ executor: db.executor });
      assert.equal(await runner.processNextJob("live"), false);
      const check = await db.executor.query<{ status: string; last_failure_code: string | null }>(
        `SELECT status, last_failure_code FROM waspada.ai_jobs WHERE job_id = 'ai-job-gate-missing'`,
      );
      assert.equal(check.rows[0]?.status, "needs_review");
      assert.equal(check.rows[0]?.last_failure_code, "triage_decision_missing");
      const props = await db.executor.query<{ proposal_id: string }>(
        `SELECT proposal_id FROM waspada.event_proposals WHERE proposal_id = 'prop-${revisionId}'`,
      );
      assert.equal(props.rows.length, 0);
    });

    it("propagates triage lookup errors into the retry path", async () => {
      const incidentRepo = createSqlIncidentRepository(db.executor);
      const { traceId, revisionId } = await seedGatedRevision({ key: "throw", triageRequired: true });
      await incidentRepo.enqueueAiJob({ jobId: "ai-job-gate-throw", datasetKind: "live", reportRevisionId: revisionId, traceId });
      // Executor that throws only on the triage lookups; everything else passes through.
      const throwing = {
        query: async (stmt: string, params?: readonly unknown[]) => {
          if (typeof stmt === "string" && stmt.includes("news_triage_")) {
            throw new Error("simulated triage lookup failure");
          }
          return db.executor.query(stmt, params);
        },
        execute: (stmt: string) => db.executor.execute(stmt),
      };
      const runner = createJobRunner({ executor: throwing as unknown as typeof db.executor });
      assert.equal(await runner.processNextJob("live"), false);
      const check = await db.executor.query<{ status: string }>(
        `SELECT status FROM waspada.ai_jobs WHERE job_id = 'ai-job-gate-throw'`,
      );
      // Lookup error must NOT become needs_review or completed: retry path.
      assert.equal(check.rows[0]?.status, "retry");
    });

    it("routes held decisions to needs_review without interpretation", async () => {
      const incidentRepo = createSqlIncidentRepository(db.executor);
      const { traceId, revisionId, sourceId } = await seedGatedRevision({ key: "held", triageRequired: true });
      await seedDecision({ revisionId, sourceId, traceId, disposition: "uncertain" });
      await incidentRepo.enqueueAiJob({ jobId: "ai-job-gate-held", datasetKind: "live", reportRevisionId: revisionId, traceId });
      const runner = createJobRunner({ executor: db.executor });
      assert.equal(await runner.processNextJob("live"), false);
      const check = await db.executor.query<{ status: string; last_failure_code: string | null }>(
        `SELECT status, last_failure_code FROM waspada.ai_jobs WHERE job_id = 'ai-job-gate-held'`,
      );
      assert.equal(check.rows[0]?.status, "needs_review");
      assert.equal(check.rows[0]?.last_failure_code, "triage_decision_held");
    });

    it("runs explicitly untriaged structured revisions without a decision row", async () => {
      const incidentRepo = createSqlIncidentRepository(db.executor);
      const { traceId, revisionId } = await seedGatedRevision({ key: "plain", triageRequired: false });
      await incidentRepo.enqueueAiJob({ jobId: "ai-job-gate-plain", datasetKind: "live", reportRevisionId: revisionId, traceId });
      const runner = createJobRunner({
        executor: db.executor,
        agentOverrides: {
          interpreter: createMockInterpreterAgent({
            summary: "Laporan struktur tanpa triase",
            incidentType: "laporan_struktur",
            severity: "low",
            primaryCategory: "disasters_weather",
          }),
          correlator: createMockCorrelatorAgent(),
        },
      });
      assert.equal(await runner.processNextJob("live"), true);
      const check = await db.executor.query<{ status: string }>(
        `SELECT status FROM waspada.ai_jobs WHERE job_id = 'ai-job-gate-plain'`,
      );
      assert.equal(check.rows[0]?.status, "completed");
    });
  });
});
