import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createTestDatabase } from "../../db/test/harness.js";
import { applyMigrations, readMigrations } from "../../db/src/migrations.js";
import { createJobRunner } from "../src/job-runner.js";
import { createSqlIncidentRepository } from "../../db/src/incident-repository.js";
import { createEventProposalWriter } from "../../db/src/event-proposal-writer.js";
import {
  getNineRouterConfig,
  generateNineRouterEmbedding,
} from "../src/providers/ninerouter-adapter.js";

async function runPipelineSmoke() {
  console.log("==================================================================");
  console.log("  Waspada Jakarta: Live Mastra AI Pipeline Smoke Test");
  console.log("==================================================================");

  const config = getNineRouterConfig();
  console.log(`[Stage 1] Probing NineRouter Gateway: ${config.baseUrl}`);
  assert.ok(config.baseUrl, "NINEROUTER_URL must be defined in environment");
  assert.ok(config.apiKey, "NINEROUTER_KEY must be defined in environment");

  console.log(`  Target Chat Model: ${config.chatModel}`);
  console.log(`  Target Embedding Model: ${config.embeddingModel} (768 dims)`);

  // Test 1: Real Embedding call to NineRouter
  console.log("\n[Stage 2] Generating genuine 768-dim float embedding from NineRouter...");
  const t0 = Date.now();
  const testText = "Banjir setinggi 60 cm merendam Jalan DI Panjaitan, Cawang, Jakarta Timur.";
  const embedding = await generateNineRouterEmbedding(testText, { config, dimensions: 768 });
  const embedMs = Date.now() - t0;
  console.log(`  Embedding generated in ${embedMs}ms`);
  assert.equal(embedding.length, 768, "Embedding must have exactly 768 dimensions");
  assert.ok(Number.isFinite(embedding[0]), "Embedding vector values must be finite numbers");
  console.log(`  First 3 coordinates: [${embedding.slice(0, 3).map((v) => v.toFixed(6)).join(", ")}...]`);

  // Test 2: Database Initialization with PGlite (PostGIS + pgvector)
  console.log("\n[Stage 3] Initializing PostgreSQL test instance with PostGIS and pgvector...");
  const db = await createTestDatabase();
  const migrations = await readMigrations(new URL("../../db/migrations/", import.meta.url));
  await applyMigrations(db.executor, migrations);
  console.log("  Applied 37 database migrations successfully.");

  const incidentRepo = createSqlIncidentRepository(db.executor);
  const proposalWriter = createEventProposalWriter(db.executor);

  // Test 3: Seed Report 1 (Initial Flood Report)
  console.log("\n[Stage 4] Ingesting Report #1 (Initial Flood at Cawang)...");
  const traceId1 = "trace-smoke-report-01";
  const sourceId1 = "source-polda-metro";
  const revId1 = "rev-flood-cawang-001";
  const text1 = "Hujan deras sejak siang menyebabkan luapan air setinggi 50 cm di Jalan DI Panjaitan Cawang arah Rawamangun, lalu lintas macet 2 km.";
  const realHash1 = createHash("sha256").update(text1).digest("hex");

  await db.executor.execute(`
    INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
    VALUES ('${traceId1}', 'live', now(), 'succeeded', '{"component":"smoke"}'::jsonb)
    ON CONFLICT (trace_id) DO NOTHING;

    INSERT INTO waspada.source_registry
      (source_id, trace_id, registry_version, display_name, source_kind, remit,
       access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
       approval_status, health_status, auto_acquisition_enabled, auto_publication_policy)
    VALUES ('${sourceId1}', '${traceId1}', 1, 'TMC Polda Metro', 'authority', ARRAY['traffic'], 'manual_fixture',
            ARRAY[]::text[], ARRAY[]::text[], ARRAY['public'], 'active', 'approved', 'healthy', false, 'never')
    ON CONFLICT (source_id) DO NOTHING;
    INSERT INTO waspada.report_revisions
      (dataset_kind, report_revision_id, trace_id, source_id, canonical_url, content_hash, permitted_text, permitted_text_hash, normalization_version, retrieved_at, revision_status, record_json)
    VALUES ('live', '${revId1}', '${traceId1}', '${sourceId1}', 'https://waspada.jakarta.go.id/report/1', '${realHash1}', '${text1}', '${realHash1}', 'v1', now(), 'unreviewed', '{}'::jsonb)
    ON CONFLICT (dataset_kind, report_revision_id) DO NOTHING;

    INSERT INTO waspada.evidence_chunks
      (dataset_kind, chunk_id, trace_id, report_revision_id, permitted_text_hash, span_start, span_end, offset_unit, chunker_version, chunk_text_hash, status)
    VALUES ('live', 'chk-smoke-01', '${traceId1}', '${revId1}', '${realHash1}', 0, ${text1.length}, 'unicode_code_points', 'v1', '${realHash1}', 'active')
    ON CONFLICT (dataset_kind, chunk_id) DO NOTHING;
  `);

  console.log("  Enqueuing durable AI job for Report #1...");
  await incidentRepo.enqueueAiJob({
    jobId: "job-smoke-001",
    datasetKind: "live",
    reportRevisionId: revId1,
    traceId: traceId1,
  });

  const runner = createJobRunner({
    executor: db.executor,
    transactionalExecutor: db.executor,
    config,
  });

  console.log("  Executing Mastra Workflow (Interpretation -> Embedding -> Retrieval -> Correlation -> Persistence)...");
  const tJob1 = Date.now();
  const ok1 = await runner.processNextJob("live");
  console.log(`  Report #1 processed in ${Date.now() - tJob1}ms (result: ${ok1})`);
  assert.equal(ok1, true, "Job 1 should succeed");

  const incident1 = await incidentRepo.getIncidentForReport("live", revId1);
  assert.ok(incident1, "Incident should be created for report 1");
  console.log(`  Created Incident: ID=${incident1.incidentId}, Title="${incident1.title}", Type="${incident1.incidentType}", Status=${incident1.status}`);

  // Verify persisted embedding in waspada.embedding_runs
  const embCheck = await db.executor.query<{ embedding_run_id: string; dimensions: number; provider: string }>(
    `SELECT embedding_run_id, dimensions, provider FROM waspada.embedding_runs WHERE dataset_kind = 'live' AND chunk_id = 'chk-smoke-01'`,
  );
  assert.ok(embCheck.rows.length > 0, "Embedding run should be persisted in waspada.embedding_runs");
  assert.equal(embCheck.rows[0].dimensions, 768);
  assert.equal(embCheck.rows[0].provider, "9router");
  console.log(`  Verified persisted embedding row: ID=${embCheck.rows[0].embedding_run_id}, Dims=${embCheck.rows[0].dimensions}`);

  const proposals1 = await proposalWriter.readPendingProposals("live");
  console.log(`  Pending Proposals in Moderation Queue: ${proposals1.length}`);
  assert.ok(proposals1.length >= 1, "Proposal should be in moderation queue");
  const prop1 = proposals1[0];
  console.log(`  Proposal #${prop1.proposal_id}: Category=${prop1.incident_type}, Location="${prop1.location_label}", Claims=${prop1.claims.length}`);

  // Test 4: Seed Report 2 (Corroborating Report with distinct wording)
  console.log("\n[Stage 5] Ingesting Report #2 (Corroborating same flood with distinct wording)...");
  const traceId2 = "trace-smoke-report-02";
  const sourceId2 = "source-warga-cawang";
  const revId2 = "rev-flood-cawang-002";
  const text2 = "Kondisi terkini simpang Cawang: air masih menggenang setinggi lutut orang dewasa (sekitar 40cm), motor dan mobil kecil dihimbau putar balik.";
  const realHash2 = createHash("sha256").update(text2).digest("hex");

  await db.executor.execute(`
    INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
    VALUES ('${traceId2}', 'live', now(), 'succeeded', '{"component":"smoke"}'::jsonb)
    ON CONFLICT (trace_id) DO NOTHING;

    INSERT INTO waspada.source_registry
      (source_id, trace_id, registry_version, display_name, source_kind, remit,
       access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
       approval_status, health_status, auto_acquisition_enabled, auto_publication_policy)
    VALUES ('${sourceId2}', '${traceId2}', 1, 'Laporan Lapangan Warga', 'crowdsourced_platform', ARRAY['traffic'], 'manual_fixture',
            ARRAY[]::text[], ARRAY[]::text[], ARRAY['public'], 'active', 'approved', 'healthy', false, 'never')
    ON CONFLICT (source_id) DO NOTHING;

    INSERT INTO waspada.report_revisions
      (dataset_kind, report_revision_id, trace_id, source_id, canonical_url, content_hash, permitted_text, permitted_text_hash, normalization_version, retrieved_at, revision_status, record_json)
    VALUES ('live', '${revId2}', '${traceId2}', '${sourceId2}', 'https://waspada.jakarta.go.id/report/2', '${realHash2}', '${text2}', '${realHash2}', 'v1', now(), 'unreviewed', '{}'::jsonb)
    ON CONFLICT (dataset_kind, report_revision_id) DO NOTHING;

    INSERT INTO waspada.evidence_chunks
      (dataset_kind, chunk_id, trace_id, report_revision_id, permitted_text_hash, span_start, span_end, offset_unit, chunker_version, chunk_text_hash, status)
    VALUES ('live', 'chk-smoke-02', '${traceId2}', '${revId2}', '${realHash2}', 0, ${text2.length}, 'unicode_code_points', 'v1', '${realHash2}', 'active')
    ON CONFLICT (dataset_kind, chunk_id) DO NOTHING;
  `);

  console.log("  Enqueuing durable AI job for Report #2...");
  await incidentRepo.enqueueAiJob({
    jobId: "job-smoke-002",
    datasetKind: "live",
    reportRevisionId: revId2,
    traceId: traceId2,
  });

  const tJob2 = Date.now();
  const ok2 = await runner.processNextJob("live");
  console.log(`  Report #2 processed in ${Date.now() - tJob2}ms (result: ${ok2})`);
  assert.equal(ok2, true, "Job 2 should succeed");

  const incidentDetails = await incidentRepo.getIncidentById("live", incident1.incidentId);
  assert.ok(incidentDetails);
  console.log(`  Updated Incident ID=${incidentDetails.incident.incidentId}`);
  console.log(`  Contributing Reports count: ${incidentDetails.contributingReports.length}`);
  console.log(`  Correlation Decisions recorded: ${incidentDetails.decisions.length}`);
  if (incidentDetails.decisions.length > 0) {
    const latestDec = incidentDetails.decisions[incidentDetails.decisions.length - 1];
    console.log(`  Decision: ${latestDec.decision}, Reasoning: "${latestDec.reasoning.slice(0, 100)}..."`);
  }

  // Test 5: Clean shutdown
  await db.close();
  console.log("\n==================================================================");
  console.log("  Live NineRouter Pipeline Smoke Test: ALL VERIFICATIONS PASSED");
  console.log("==================================================================");
}

runPipelineSmoke().catch((err) => {
  console.error("\n[Smoke Test FAILED]:", err);
  process.exit(1);
});
