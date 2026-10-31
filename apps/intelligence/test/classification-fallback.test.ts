import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { createTestDatabase, type TestDatabase } from "../../db/test/harness.js";
import { applyMigrations, readMigrations } from "../../db/src/migrations.js";
import { createJobRunner } from "../src/job-runner.js";
import { createSqlIncidentRepository } from "../../db/src/incident-repository.js";
import { createEventProposalWriter } from "../../db/src/event-proposal-writer.js";
import {
  createMockInterpreterAgent,
  createMockCorrelatorAgent,
  createFailingAgent,
} from "./mock-agents.js";

describe("WJ-INT-01C: AI-First Classification and Safe Fallback Architecture", () => {
  let db: TestDatabase;

  before(async () => {
    db = await createTestDatabase();
    const migrations = await readMigrations(new URL("../../db/migrations/", import.meta.url));
    await applyMigrations(db.executor, migrations);
  });

  after(async () => {
    await db?.close();
  });

  it("preserves previously unseen incident types without coercing to legacy categories", async () => {
    const incidentRepo = createSqlIncidentRepository(db.executor);
    const proposalWriter = createEventProposalWriter(db.executor);

    const traceId = "trace-unseen-001";
    const sourceId = "source-unseen";
    const revisionId = "rev-unseen-pole-001";
    const dummyHash = "3333333333333333333333333333333333333333333333333333333333333333";
    const reportText = "Tiang listrik roboh melintang di Jalan Rasuna Said Kuningan setelah ditabrak truk tanah. Kabel menjuntai dan membahayakan pengendara.";

    await db.executor.execute(`
      INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
      VALUES ('${traceId}', 'synthetic', now(), 'succeeded', '{}'::jsonb)
      ON CONFLICT (trace_id) DO NOTHING;

      INSERT INTO waspada.source_registry
        (source_id, trace_id, registry_version, display_name, source_kind, remit,
         access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
         approval_status, health_status, auto_acquisition_enabled, auto_publication_policy)
      VALUES ('${sourceId}', '${traceId}', 1, 'Citizen Dispatch', 'other', ARRAY['safety'], 'manual_fixture',
              ARRAY[]::text[], ARRAY[]::text[], ARRAY['public'], 'active', 'approved', 'healthy', false, 'never')
      ON CONFLICT (source_id) DO NOTHING;

      INSERT INTO waspada.report_revisions
        (dataset_kind, report_revision_id, trace_id, source_id, canonical_url, content_hash, permitted_text, permitted_text_hash, normalization_version, retrieved_at, revision_status, record_json)
      VALUES ('synthetic', '${revisionId}', '${traceId}', '${sourceId}', 'https://waspada.jakarta.go.id/r/unseen', '${dummyHash}', '${reportText}', '${dummyHash}', 'v1', now(), 'unreviewed', '{}'::jsonb)
      ON CONFLICT (dataset_kind, report_revision_id) DO NOTHING;

      INSERT INTO waspada.evidence_chunks
        (dataset_kind, chunk_id, trace_id, report_revision_id, permitted_text_hash, span_start, span_end, offset_unit, chunker_version, chunk_text_hash, status)
      VALUES ('synthetic', 'chk-unseen-01', '${traceId}', '${revisionId}', '${dummyHash}', 0, ${reportText.length}, 'unicode_code_points', 'v1', '${dummyHash}', 'active')
      ON CONFLICT (dataset_kind, chunk_id) DO NOTHING;
    `);

    await incidentRepo.enqueueAiJob({
      jobId: "job-unseen-001",
      datasetKind: "synthetic",
      reportRevisionId: revisionId,
      traceId,
    });

    const mockInterpreter = createMockInterpreterAgent({
      summary: "Tiang listrik roboh melintang di Jalan Rasuna Said Kuningan",
      incidentType: "fallen_electrical_pole",
      severity: "high",
      location: {
        label: "Jl. HR Rasuna Said, Kuningan, Jakarta Selatan",
        approximateCoordinates: [106.831, -6.224],
        precision: "corridor",
      },
      impacts: ["road_obstruction", "power_hazard", "traffic_gridlock"],
      evidence: [
        {
          chunkId: "chk-unseen-01",
          exactQuote: "Tiang listrik roboh melintang di Jalan Rasuna Said",
          supports: "Tiang roboh menghalangi jalan",
        },
      ],
    });

    const runner = createJobRunner({
      executor: db.executor,
      agentOverrides: {
        interpreter: mockInterpreter,
        correlator: createMockCorrelatorAgent(),
      },
    });

    const processed = await runner.processNextJob("synthetic");
    assert.equal(processed, true);

    // 1. Verify incident in DB preserves open-ended incident_type
    const incident = await incidentRepo.getIncidentForReport("synthetic", revisionId);
    assert.ok(incident);
    assert.equal(incident.incidentType, "fallen_electrical_pole");
    assert.notEqual(incident.incidentType, "weather");
    assert.notEqual(incident.incidentType, "flood");
    assert.equal(incident.severity, "high");

    // 2. Verify proposal in DB preserves open-ended incident_type and multiple impacts
    const pending = await proposalWriter.readPendingProposals("synthetic");
    const proposal = pending.find((p) => p.incident_type === "fallen_electrical_pole");
    assert.ok(proposal);
    assert.equal(proposal.incident_type, "fallen_electrical_pole");
    assert.deepEqual(proposal.impacts, ["road_obstruction", "power_hazard", "traffic_gridlock"]);
    assert.equal(proposal.severity, "high");
  });

  it("handles AI provider failure safely: preserves raw report, enters retry, and creates zero fake proposals", async () => {
    const incidentRepo = createSqlIncidentRepository(db.executor);
    const traceId = "trace-failure-001";
    const sourceId = "source-failure";
    const revisionId = "rev-provider-down-001";
    const dummyHash = "4444444444444444444444444444444444444444444444444444444444444444";
    const reportText = "Terjadi kecelakaan beruntun melibatkan tiga bus di Jalan Gatot Subroto.";

    await db.executor.execute(`
      INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
      VALUES ('${traceId}', 'synthetic', now(), 'succeeded', '{}'::jsonb)
      ON CONFLICT (trace_id) DO NOTHING;

      INSERT INTO waspada.source_registry
        (source_id, trace_id, registry_version, display_name, source_kind, remit,
         access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
         approval_status, health_status, auto_acquisition_enabled, auto_publication_policy)
      VALUES ('${sourceId}', '${traceId}', 1, 'Polda Metro Feed', 'authority', ARRAY['traffic'], 'manual_fixture',
              ARRAY[]::text[], ARRAY[]::text[], ARRAY['public'], 'active', 'approved', 'healthy', false, 'never')
      ON CONFLICT (source_id) DO NOTHING;

      INSERT INTO waspada.report_revisions
        (dataset_kind, report_revision_id, trace_id, source_id, canonical_url, content_hash, permitted_text, permitted_text_hash, normalization_version, retrieved_at, revision_status, record_json)
      VALUES ('synthetic', '${revisionId}', '${traceId}', '${sourceId}', 'https://waspada.jakarta.go.id/r/down', '${dummyHash}', '${reportText}', '${dummyHash}', 'v1', now(), 'unreviewed', '{}'::jsonb)
      ON CONFLICT (dataset_kind, report_revision_id) DO NOTHING;
    `);

    await incidentRepo.enqueueAiJob({
      jobId: "job-fail-durable-001",
      datasetKind: "synthetic",
      reportRevisionId: revisionId,
      traceId,
    });

    const runner = createJobRunner({
      executor: db.executor,
      agentOverrides: {
        interpreter: createFailingAgent(new Error("NineRouter 503 Service Unavailable: upstream timeout")),
      },
    });

    // Run job: should fail safely without unhandled exception
    const result = await runner.processNextJob("synthetic");
    assert.equal(result, false);

    // Job must be in retry state with failure code
    const job = await runner.getJob("job-fail-durable-001");
    assert.ok(job);
    assert.equal(job.status, "retry");
    assert.ok(job.lastFailureCode === "model_failed" || job.lastFailureCode === "model_timeout");
    assert.equal(job.attemptCount, 1);

    // Raw report must still exist intact in DB
    const revCheck = await db.executor.query<{ report_revision_id: string }>(
      `SELECT report_revision_id FROM waspada.report_revisions WHERE report_revision_id = '${revisionId}'`,
    );
    assert.equal(revCheck.rows.length, 1);

    // ZERO proposals must be written to DB
    const propCheck = await db.executor.query<{ proposal_id: string }>(
      `SELECT proposal_id FROM waspada.event_proposals WHERE dataset_kind = 'synthetic' AND trace_id = '${traceId}'`,
    );
    assert.equal(propCheck.rows.length, 0, "Provider failure must never create a fabricated proposal");

    // ZERO incidents must be created in DB
    const incCheck = await db.executor.query<{ incident_id: string }>(
      `SELECT incident_id FROM waspada.incident_reports WHERE dataset_kind = 'synthetic' AND report_revision_id = '${revisionId}'`,
    );
    assert.equal(incCheck.rows.length, 0, "Provider failure must never create a fabricated incident");

    // Now test transition to needs_review when max attempts reached
    for (let i = 2; i <= 5; i++) {
      const claim = await incidentRepo.claimAiJob({ datasetKind: "synthetic", now: new Date(Date.now() + i * 120_000).toISOString() });
      if (claim) {
        await incidentRepo.failAiJob(claim.job.jobId, claim.leaseToken, "model_failed");
      }
    }

    const exhaustedJob = await runner.getJob("job-fail-durable-001");
    assert.ok(exhaustedJob);
    assert.equal(exhaustedJob.status, "needs_review");
    assert.equal(exhaustedJob.attemptCount, 5);

    // Job can be manually retried by administrator
    const retrySuccess = await runner.retryJob("job-fail-durable-001");
    assert.equal(retrySuccess, true);
    const retriedJob = await runner.getJob("job-fail-durable-001");
    assert.equal(retriedJob?.status, "pending");
    assert.equal(retriedJob?.attemptCount, 0);

    // Clean up job so subsequent tests don't pick it up
    await db.executor.execute(`DELETE FROM waspada.ai_jobs WHERE job_id = 'job-fail-durable-001'`);
  });

  it("distinguishes interpretation uncertainty from provider failure: creates investigating incident with null coordinates", async () => {
    const incidentRepo = createSqlIncidentRepository(db.executor);
    const traceId = "trace-uncertain-001";
    const sourceId = "source-uncertain";
    const revisionId = "rev-uncertain-001";
    const dummyHash = "5555555555555555555555555555555555555555555555555555555555555555";
    const reportText = "Ada genangan air cukup tinggi di salah satu jalan di Jakarta, pengendara harap hati-hati.";

    await db.executor.execute(`
      INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
      VALUES ('${traceId}', 'synthetic', now(), 'succeeded', '{}'::jsonb)
      ON CONFLICT (trace_id) DO NOTHING;

      INSERT INTO waspada.source_registry
        (source_id, trace_id, registry_version, display_name, source_kind, remit,
         access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
         approval_status, health_status, auto_acquisition_enabled, auto_publication_policy)
      VALUES ('${sourceId}', '${traceId}', 1, 'Social Monitor', 'other', ARRAY['safety'], 'manual_fixture',
              ARRAY[]::text[], ARRAY[]::text[], ARRAY['public'], 'active', 'approved', 'healthy', false, 'never')
      ON CONFLICT (source_id) DO NOTHING;

      INSERT INTO waspada.report_revisions
        (dataset_kind, report_revision_id, trace_id, source_id, canonical_url, content_hash, permitted_text, permitted_text_hash, normalization_version, retrieved_at, revision_status, record_json)
      VALUES ('synthetic', '${revisionId}', '${traceId}', '${sourceId}', 'https://waspada.jakarta.go.id/r/uncertain', '${dummyHash}', '${reportText}', '${dummyHash}', 'v1', now(), 'unreviewed', '{}'::jsonb)
      ON CONFLICT (dataset_kind, report_revision_id) DO NOTHING;
    `);

    await incidentRepo.enqueueAiJob({
      jobId: "job-uncertain-001",
      datasetKind: "synthetic",
      reportRevisionId: revisionId,
      traceId,
    });

    // AI outputs low confidence, unknown location, null coordinates, unknown event time
    const uncertainInterpreter = createMockInterpreterAgent({
      summary: "Genangan air dilaporkan di lokasi yang belum spesifik",
      incidentType: "genangan_air",
      severity: "unknown",
      location: {
        label: null,
        approximateCoordinates: null,
        precision: "unknown",
      },
      eventTime: {
        value: null,
        precision: "unknown",
      },
      evidence: [],
      uncertaintyNotes: ["Nama jalan tidak disebutkan dalam laporan", "Tinggi genangan tidak ada keterangan angka"],
      confidence: "low",
    });

    const runner = createJobRunner({
      executor: db.executor,
      agentOverrides: {
        interpreter: uncertainInterpreter,
        correlator: createMockCorrelatorAgent({
          decision: "new_incident",
          reasoning: "Meskipun lokasi tidak lengkap, laporan merupakan peristiwa baru",
        }),
      },
    });

    const processed = await runner.processNextJob("synthetic");
    assert.equal(processed, true, "Job with uncertain interpretation should succeed, not fail");

    // Incident must be investigating, not active
    const incident = await incidentRepo.getIncidentForReport("synthetic", revisionId);
    assert.ok(incident);
    assert.equal(incident.status, "investigating");
    assert.equal(incident.severity, "unknown");
    assert.equal(incident.coordinates, null);
    assert.equal(incident.locationLabel, null);
    assert.ok(incident.uncertaintyNotes.length >= 2);
  });

  it("distinguishes unresolved correlation: records unresolved relationship and keeps incident in investigating state", async () => {
    const incidentRepo = createSqlIncidentRepository(db.executor);
    const traceId = "trace-unresolved-001";
    const sourceId = "source-unresolved";
    const revisionId = "rev-unresolved-001";
    const dummyHash = "6666666666666666666666666666666666666666666666666666666666666666";
    const reportText = "Info air naik di terowongan cawang atau jatinegara, belum jelas titik pastinya.";

    await db.executor.execute(`
      INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
      VALUES ('${traceId}', 'synthetic', now(), 'succeeded', '{}'::jsonb)
      ON CONFLICT (trace_id) DO NOTHING;

      INSERT INTO waspada.source_registry
        (source_id, trace_id, registry_version, display_name, source_kind, remit,
         access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
         approval_status, health_status, auto_acquisition_enabled, auto_publication_policy)
      VALUES ('${sourceId}', '${traceId}', 1, 'Community Feed', 'other', ARRAY['safety'], 'manual_fixture',
              ARRAY[]::text[], ARRAY[]::text[], ARRAY['public'], 'active', 'approved', 'healthy', false, 'never')
      ON CONFLICT (source_id) DO NOTHING;

      INSERT INTO waspada.report_revisions
        (dataset_kind, report_revision_id, trace_id, source_id, canonical_url, content_hash, permitted_text, permitted_text_hash, normalization_version, retrieved_at, revision_status, record_json)
      VALUES ('synthetic', '${revisionId}', '${traceId}', '${sourceId}', 'https://waspada.jakarta.go.id/r/unres', '${dummyHash}', '${reportText}', '${dummyHash}', 'v1', now(), 'unreviewed', '{}'::jsonb)
      ON CONFLICT (dataset_kind, report_revision_id) DO NOTHING;
    `);

    await incidentRepo.enqueueAiJob({
      jobId: "job-unresolved-001",
      datasetKind: "synthetic",
      reportRevisionId: revisionId,
      traceId,
    });

    const runner = createJobRunner({
      executor: db.executor,
      agentOverrides: {
        interpreter: createMockInterpreterAgent({
          summary: "Informasi air naik di terowongan Cawang atau Jatinegara",
          incidentType: "genangan_air",
          severity: "medium",
          confidence: "medium",
        }),
        correlator: createMockCorrelatorAgent({
          decision: "unresolved",
          reasoning: "Tidak dapat dipastikan apakah ini insiden yang sama dengan banjir underpass Cawang atau genangan baru di Jatinegara",
          unresolvedQuestions: ["Apakah titik genangan berada di Underpass Cawang atau Jl. Otto Iskandardinata Jatinegara?"],
        }),
      },
    });

    const processed = await runner.processNextJob("synthetic");
    assert.equal(processed, true);

    const incident = await incidentRepo.getIncidentForReport("synthetic", revisionId);
    assert.ok(incident);
    assert.equal(incident.status, "investigating");

    // Link must be unresolved
    const reportLink = await db.executor.query<{ relationship: string }>(
      `SELECT relationship FROM waspada.incident_reports WHERE report_revision_id = '${revisionId}'`,
    );
    assert.equal(reportLink.rows[0].relationship, "unresolved");

    // Decision in audit trail must be unresolved
    const decisionRow = await db.executor.query<{ decision: string; reasoning: string }>(
      `SELECT decision, reasoning FROM waspada.incident_correlation_decisions WHERE report_revision_id = '${revisionId}'`,
    );
    assert.equal(decisionRow.rows[0].decision, "unresolved");
  });

  it("never fabricates quote evidence when AI extracts no verified quotes", async () => {
    const incidentRepo = createSqlIncidentRepository(db.executor);
    const proposalWriter = createEventProposalWriter(db.executor);
    const traceId = "trace-no-quotes-001";
    const sourceId = "source-no-quotes";
    const revisionId = "rev-no-quotes-001";
    const dummyHash = "7777777777777777777777777777777777777777777777777777777777777777";
    const reportText = "Pantauan CCTV menunjukkan kepadatan di simpang.";

    await db.executor.execute(`
      INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
      VALUES ('${traceId}', 'synthetic', now(), 'succeeded', '{}'::jsonb)
      ON CONFLICT (trace_id) DO NOTHING;

      INSERT INTO waspada.source_registry
        (source_id, trace_id, registry_version, display_name, source_kind, remit,
         access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
         approval_status, health_status, auto_acquisition_enabled, auto_publication_policy)
      VALUES ('${sourceId}', '${traceId}', 1, 'CCTV Feed', 'authority', ARRAY['traffic'], 'manual_fixture',
              ARRAY[]::text[], ARRAY[]::text[], ARRAY['public'], 'active', 'approved', 'healthy', false, 'never')
      ON CONFLICT (source_id) DO NOTHING;

      INSERT INTO waspada.report_revisions
        (dataset_kind, report_revision_id, trace_id, source_id, canonical_url, content_hash, permitted_text, permitted_text_hash, normalization_version, retrieved_at, revision_status, record_json)
      VALUES ('synthetic', '${revisionId}', '${traceId}', '${sourceId}', 'https://waspada.jakarta.go.id/r/cctv', '${dummyHash}', '${reportText}', '${dummyHash}', 'v1', now(), 'unreviewed', '{}'::jsonb)
      ON CONFLICT (dataset_kind, report_revision_id) DO NOTHING;
    `);

    await incidentRepo.enqueueAiJob({
      jobId: "job-no-quotes-001",
      datasetKind: "synthetic",
      reportRevisionId: revisionId,
      traceId,
    });

    const runner = createJobRunner({
      executor: db.executor,
      agentOverrides: {
        interpreter: createMockInterpreterAgent({
          summary: "Kepadatan di persimpangan terpantau CCTV",
          incidentType: "kepadatan_lalu_lintas",
          evidence: [], // Zero evidence quotes extracted by AI
        }),
        correlator: createMockCorrelatorAgent(),
      },
    });

    await runner.processNextJob("synthetic");

    const pending = await proposalWriter.readPendingProposals("synthetic");
    const proposal = pending.find((p) => p.incident_type === "kepadatan_lalu_lintas");
    assert.ok(proposal);
    assert.equal(proposal.claims.length, 1);
    // Quote text must be empty, NOT a fabricated slice of text
    assert.equal(proposal.claims[0].quote_text, "");
    assert.equal(proposal.claims[0].support_assessment, "uncertain");
  });
});
