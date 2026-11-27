import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { createTestDatabase } from "../../apps/db/test/harness.js";
import { applyMigrations, readMigrations } from "../../apps/db/src/migrations.js";
import { createSqlIncidentRepository } from "../../apps/db/src/incident-repository.js";
import { createEventProposalWriter } from "../../apps/db/src/event-proposal-writer.js";
import { createRepositoryPorts } from "../../apps/db/src/ports.js";
import { createSqlEvidenceChunkRepository } from "../../apps/db/src/evidence-chunks.js";
import {
  convertInboundEventToRevision,
  type InboundIncidentEvent,
} from "../../apps/worker/src/layers/l1-data-knowledge/webhook-ingest.js";
import { assessProposalSourceGate } from "../../apps/worker/src/layers/l4-application-integration/publication-policy.js";
import { createJobRunner } from "../../apps/intelligence/src/job-runner.js";
import {
  createMockInterpreterAgent,
  createMockCorrelatorAgent,
} from "../../apps/intelligence/test/mock-agents.js";
import { createAccountStore } from "../../apps/db/src/accounts.js";
import type { WorkerEnvironment } from "../../apps/worker/src/layers/l4-application-integration/api.js";
import { hashPassword } from "../../apps/worker/src/accounts/password.js";
import { generateServiceKey } from "../../apps/worker/src/security/service-key.js";
import { startUnifiedServer } from "./harness.js";

/** Synthetic fixture for this local journey only. It is not a real credential. */
const e2eModeratorUsername = "e2e.moderator";
const e2eModeratorPassword = "sandi-uji-e2e-2026";

/**
 * Synthetic source for this journey, not a real outlet. Its registry row has the same shape as the approved rows that
 * tools/live-sources-seed.ts writes: approved, active, auto-acquisition on, and public_display in reuse_basis. Without
 * it the publish gate (WJ-INT-02B, checkSourcePublicDisplay) answers 403 PUBLICATION_NOT_AUTHORIZED.
 */
const e2eSourceId = "source-synthetic-e2e";
const e2eSourceTraceId = "trace-seed-e2e-synthetic-source";
/**
 * The publishable report (Step 6b). Its public link lives under example.org, a reserved domain (RFC 2606), so no real
 * page is linked. The webhook report never has a public link: intake stores a webhook:// canonical URL (NFR-07 A4).
 */
const e2eRevisionTraceId = "trace-e2e-https-revision";
const e2ePublicLinkOrigin = "https://e2e.example.org";

/** The grounded interpreter and correlator outputs for one report. The verbatim quote is the same for every report. */
function groundedAgentOverrides(chunkId: string, reportRevisionId: string) {
  return {
    interpreter: createMockInterpreterAgent({
      summary: "Pohon tumbang besar menimpa tiang listrik di Jalan HR Rasuna Said depan Kemenkes",
      incidentType: "fallen_tree_hazard",
      severity: "high",
      location: {
        label: "Jalan HR Rasuna Said",
        approximateCoordinates: [106.832, -6.224],
        precision: "exact",
      },
      impacts: ["road_obstruction", "power_outage", "traffic_gridlock"],
      evidence: [
        {
          chunkId,
          exactQuote: "Pohon tumbang besar menimpa tiang listrik di Jalan HR Rasuna Said depan Kemenkes",
          supports: "Pohon tumbang menimpa tiang listrik dan menutup jalan",
        },
      ],
      confidence: "high",
    }),
    correlator: createMockCorrelatorAgent({
      decision: "new_incident",
      candidateIncidentId: null,
      reasoning: "Distinct physical tree fall hazard with no prior active candidate.",
      supportingEvidence: [
        {
          reportRevisionId,
          quote: "Pohon tumbang besar menimpa tiang listrik di Jalan HR Rasuna Said depan Kemenkes",
          relevance: "Physical obstruction location",
        },
      ],
    }),
  };
}

async function main() {
  console.log("==================================================================");
  console.log("  Waspada Jakarta: End-to-End Playwright Browser Journey");
  console.log("==================================================================");

  // 1. Initialize Test Database & Run Migrations (every file in apps/db/migrations)
  console.log("\n[Step 1] Initializing PostgreSQL test instance and applying migrations...");
  const db = await createTestDatabase();
  const migrations = await readMigrations(new URL("../../apps/db/migrations/", import.meta.url));
  await applyMigrations(db.executor, migrations);
  await createAccountStore(db.executor, "demo").createPasswordAccount({
    datasetMode: "demo",
    username: e2eModeratorUsername,
    passwordHash: await hashPassword(e2eModeratorPassword),
    displayName: "Moderator E2E",
    role: "moderator",
    now: new Date().toISOString(),
    reason: "Synthetic end-to-end fixture",
  });
  console.log(`  Applied ${migrations.length} migrations.`);

  // Approved synthetic source, so the publish gate can grant public display for the proposal's source_id.
  await db.executor.query(
    `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
     VALUES ($1, 'synthetic', now(), 'succeeded', '{"seed": "e2e_synthetic_source"}'::jsonb)
     ON CONFLICT DO NOTHING`,
    [e2eSourceTraceId],
  );
  await db.executor.query(
    `INSERT INTO waspada.source_registry (
       source_id, trace_id, registry_version, display_name, source_kind, remit,
       access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
       approval_status, health_status, auto_acquisition_enabled, auto_publication_policy,
       polling_interval_seconds
     ) VALUES (
       $1, $2, 1, 'Sumber sintetis E2E (fiktif)', 'newsroom', ARRAY['news', 'incidents'],
       'api', ARRAY[]::text[], ARRAY[]::text[],
       ARRAY['model_triage', 'model_description', 'retain_title', 'retain_description', 'retain_derived', 'public_display'],
       'active', 'approved', 'healthy', true, 'never', 600
     )
     ON CONFLICT (source_id) DO NOTHING`,
    [e2eSourceId, e2eSourceTraceId],
  );
  console.log(`  Seeded approved synthetic source '${e2eSourceId}' with a public_display grant.`);

  const incidentRepo = createSqlIncidentRepository(db.executor);
  const proposalWriter = createEventProposalWriter(db.executor);

  // 2. Start Local Unified HTTP Server (Web App + Worker Backend)
  console.log("\n[Step 2] Launching unified test server bridging Worker and Web UI...");
  // Random per run. The origin is set once the port is known, and accounts use the synthetic dataset.
  const webhookServiceKey = generateServiceKey();
  const env: WorkerEnvironment = {
    DATASET_MODE: "synthetic",
    AUTH_ENABLED: "true",
    AUTH_APP_ORIGIN: "http://127.0.0.1:0",
    INTERNAL_SERVICE_KEY: generateServiceKey(),
    WEBHOOK_SERVICE_KEY: webhookServiceKey,
    SQL_EXECUTOR: db.executor,
  };

  const distDir = path.resolve(process.cwd(), "apps/web/dist");
  assert.ok(fs.existsSync(distDir), "apps/web/dist must exist (run npm run build:web)");

  const server = await startUnifiedServer({ distDir, env });
  const baseUrl = server.baseUrl;
  console.log(`  Unified test server running on ${baseUrl}`);

  let browser: Browser | null = null;

  try {
    // 3. Submit Synthetic Source Report via /api/v1/ingestion/events
    console.log("\n[Step 3] Submitting synthetic source report to webhook ingestion endpoint...");
    const reportTimestamp = "2026-10-31T15:00:00Z";
    const reportText =
      "Pohon tumbang besar menimpa tiang listrik di Jalan HR Rasuna Said depan Kemenkes menyebabkan kemacetan parah dan pemadaman listrik lokal.";
    const reportPayload = {
      source_id: e2eSourceId,
      title: "Pohon Tumbang Menimpa Tiang Listrik di Rasuna Said",
      text: reportText,
      category: "fallen_tree_hazard",
      severity: "high",
      location_hint: "Jalan HR Rasuna Said, Kuningan",
      coordinates: [106.832, -6.224],
      timestamp: reportTimestamp,
    };

    const ingestRes = await fetch(`${baseUrl}/api/v1/ingestion/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-service-key": webhookServiceKey },
      body: JSON.stringify(reportPayload),
    });

    assert.equal(ingestRes.status, 201, `Ingestion returned status ${ingestRes.status}`);
    const ingestJson = (await ingestRes.json()) as { ok: boolean; report_revision_id: string };
    assert.equal(ingestJson.ok, true);
    const revisionId = ingestJson.report_revision_id;
    console.log(`  Ingested revision ID: ${revisionId}`);

    // 4. Verify Durable Revision & AI Job in PostgreSQL
    console.log("\n[Step 4] Verifying durable report revision and pending AI job in database...");
    const revCheck = await db.executor.query<{ report_revision_id: string; permitted_text: string }>(
      `SELECT report_revision_id, permitted_text FROM waspada.report_revisions WHERE dataset_kind = 'synthetic' AND report_revision_id = $1`,
      [revisionId],
    );
    assert.equal(revCheck.rows.length, 1, "Report revision must be stored in waspada.report_revisions");
    assert.ok(revCheck.rows[0].permitted_text.includes(reportText), "Permitted text must contain report text");

    const chunkCheck = await db.executor.query<{ chunk_id: string }>(
      `SELECT chunk_id FROM waspada.evidence_chunks WHERE dataset_kind = 'synthetic' AND report_revision_id = $1`,
      [revisionId],
    );
    assert.ok(chunkCheck.rows.length > 0, "Evidence chunks must be stored in waspada.evidence_chunks");
    const chunkId = chunkCheck.rows[0].chunk_id;
    console.log(`  Verified revision and chunk '${chunkId}' in PostgreSQL.`);

    const jobCheck = await db.executor.query<{ job_id: string; status: string; trace_id: string }>(
      `SELECT job_id, status, trace_id FROM waspada.ai_jobs WHERE dataset_kind = 'synthetic' AND report_revision_id = $1`,
      [revisionId],
    );
    assert.equal(jobCheck.rows.length, 1, "AI job must be enqueued in waspada.ai_jobs");
    assert.equal(jobCheck.rows[0].status, "pending", "Job status must be pending");
    const jobId = jobCheck.rows[0].job_id;
    const traceId = jobCheck.rows[0].trace_id;
    console.log(`  Verified pending AI job '${jobId}' with trace '${traceId}'.`);

    // 5. Execute Mastra Worker Processing
    console.log("\n[Step 5] Executing Mastra worker with grounded AI agents...");
    const runner = createJobRunner({
      executor: db.executor,
      agentOverrides: groundedAgentOverrides(chunkId, revisionId),
    });

    const processed = await runner.processNextJob("synthetic");
    assert.equal(processed, true, "Worker must process the AI job successfully");

    // 6. Verify Incident & Correlation Decision in PostgreSQL
    console.log("\n[Step 6] Verifying persistent incident and correlation decision in database...");
    const incidentCheck = await incidentRepo.getIncidentForReport("synthetic", revisionId);
    assert.ok(incidentCheck, "Incident must be created and linked to report");
    const incidentId = incidentCheck.incidentId;
    assert.equal(incidentCheck.incidentType, "fallen_tree_hazard");
    assert.equal(incidentCheck.severity, "high");
    console.log(`  Created Incident: ID=${incidentId}, Type='${incidentCheck.incidentType}', Severity=${incidentCheck.severity}`);

    const decisionCheck = await db.executor.query<{ decision_id: string; decision: string; target_incident_id: string }>(
      `SELECT decision_id, decision, target_incident_id FROM waspada.incident_correlation_decisions WHERE dataset_kind = 'synthetic' AND report_revision_id = $1`,
      [revisionId],
    );
    assert.equal(decisionCheck.rows.length, 1);
    const decisionId = decisionCheck.rows[0].decision_id;
    assert.equal(decisionCheck.rows[0].decision, "new_incident");
    console.log(`  Recorded Decision: ID=${decisionId}, Decision=${decisionCheck.rows[0].decision}`);

    // Verify Proposal in PostgreSQL
    const proposalCheck = await proposalWriter.readPendingProposals("synthetic");
    const matchingProposal = proposalCheck.find((p) => p.incident_type === "fallen_tree_hazard");
    assert.ok(matchingProposal, "Proposal must exist in moderation queue");
    const proposalId = matchingProposal.proposal_id;
    assert.equal(matchingProposal.severity, "high");
    assert.deepEqual(matchingProposal.impacts, ["road_obstruction", "power_outage", "traffic_gridlock"]);
    console.log(`  Grounded Proposal: ID=${proposalId}, Impacts=${matchingProposal.impacts?.join(", ")}`);

    // 6b. Publishable report. The webhook report keeps its webhook:// link and is refused at publication (Step 8).
    // The same synthetic source gets a second report with a public https link, written through the store functions
    // that intake uses: the revision port, the evidence chunk repository and the AI job queue.
    console.log("\n[Step 6b] Writing a publishable synthetic report with a public https link...");
    await db.executor.query(
      `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
       VALUES ($1, 'synthetic', now(), 'succeeded', '{"seed": "e2e_https_revision"}'::jsonb)
       ON CONFLICT DO NOTHING`,
      [e2eRevisionTraceId],
    );
    const linkedNow = new Date().toISOString();
    const linkedEvent: InboundIncidentEvent = {
      ...reportPayload,
      severity: "high",
      coordinates: [106.832, -6.224],
      timestamp: linkedNow,
    };
    const linked = await convertInboundEventToRevision(linkedEvent, linkedNow);
    const linkedRevisionId = linked.report_revision_id;
    const publicLink = `${e2ePublicLinkOrigin}/laporan/${linkedRevisionId}`;
    await createRepositoryPorts(db.executor).reportRevisions.create({
      datasetKind: "synthetic",
      reportRevisionId: linkedRevisionId,
      traceId: e2eRevisionTraceId,
      sourceId: e2eSourceId,
      canonicalUrl: publicLink,
      sourceRevisionKey: null,
      contentHash: linked.permitted_text_hash,
      permittedText: linked.permitted_text,
      permittedTextHash: linked.permitted_text_hash,
      normalizationVersion: "v1",
      publishedAt: linked.published_at,
      observedAt: null,
      retrievedAt: linked.retrieved_at,
      validFrom: null,
      validUntil: null,
      supersedesId: null,
      revisionStatus: "unreviewed",
      recordJson: {},
      triageRequired: false,
    });
    await createSqlEvidenceChunkRepository(db.executor).persist({
      datasetKind: "synthetic",
      traceId: e2eRevisionTraceId,
      reportRevisionId: linkedRevisionId,
      permittedTextHash: linked.permitted_text_hash,
      normalizationVersion: "v1",
      chunks: linked.chunks.map((chunk) => ({
        chunkId: `chk-${linkedRevisionId}-${chunk.chunk_index}`,
        reportRevisionId: linkedRevisionId,
        permittedTextHash: linked.permitted_text_hash,
        normalizationVersion: "v1",
        spanStart: chunk.span_start,
        spanEnd: chunk.span_end,
        offsetUnit: "unicode_code_points" as const,
        chunkTextHash: createHash("sha256").update(chunk.text).digest("hex"),
        text: chunk.text,
        chunkerVersion: "v1",
      })),
    });
    await incidentRepo.enqueueAiJob({
      jobId: `job-e2e-https-${linkedRevisionId}`,
      datasetKind: "synthetic",
      reportRevisionId: linkedRevisionId,
      traceId: e2eRevisionTraceId,
    });
    console.log(`  Stored revision '${linkedRevisionId}' with public link ${publicLink} and queued its AI job.`);

    const linkedChunks = await db.executor.query<{ chunk_id: string }>(
      `SELECT chunk_id FROM waspada.evidence_chunks WHERE dataset_kind = 'synthetic' AND report_revision_id = $1 ORDER BY span_start`,
      [linkedRevisionId],
    );
    assert.ok(linkedChunks.rows.length > 0, "Publishable report must have evidence chunks");
    const linkedRunner = createJobRunner({
      executor: db.executor,
      agentOverrides: groundedAgentOverrides(linkedChunks.rows[0].chunk_id, linkedRevisionId),
    });
    assert.equal(await linkedRunner.processNextJob("synthetic"), true, "Worker must process the publishable report's AI job");

    const linkedProposal = (await proposalWriter.readPendingProposals("synthetic")).find((p) =>
      p.report_revision_ids?.includes(linkedRevisionId),
    );
    assert.ok(linkedProposal, "Proposal for the publishable report must exist in moderation queue");
    const linkedProposalId = linkedProposal.proposal_id;
    console.log(`  Grounded Proposal for the publishable report: ID=${linkedProposalId}`);

    // 7. Launch Real Chromium Browser Journey via Playwright
    console.log("\n[Step 7] Launching Chromium browser to execute moderation & publication journey...");
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

    const context = await browser.newContext();
    // Sign in through the real account API. The response's Set-Cookie lands in this browser context.
    const login = await context.request.post(`${baseUrl}/api/v1/auth/login`, {
      headers: { Origin: baseUrl, "X-Waspada-Request": "1" },
      data: { username: e2eModeratorUsername, password: e2eModeratorPassword },
    });
    assert.equal(login.status(), 200, "the seeded moderator signs in through /api/v1/auth/login");

    const page = await context.newPage();

    // Navigate to Moderation Queue (/#tinjau-bukti)
    console.log(`  Navigating to ${baseUrl}/#tinjau-bukti...`);
    await page.goto(`${baseUrl}/#tinjau-bukti`, { waitUntil: "domcontentloaded" });

    // Verify Proposal appears in Moderation Queue UI
    console.log("  Verifying proposal card in moderation queue UI...");
    const proposalCard = page.locator(`button[data-proposal-id="${proposalId}"]`).first();
    await proposalCard.waitFor({ state: "visible", timeout: 10_000 });

    // Click proposal card to inspect detail
    await proposalCard.click();
    console.log("  Selected proposal card. Inspecting details...");

    // Inspect incident type, impacts, and evidence quote in UI
    const detailPanel = page.locator(".details-column, .review-case-heading").first();
    await detailPanel.waitFor({ state: "visible", timeout: 5_000 });

    const pageText = await page.textContent("body");
    assert.ok(pageText?.includes("fallen_tree_hazard") || pageText?.includes("Pohon tumbang"), "UI must display incident type / title");
    assert.ok(pageText?.includes("road obstruction") || pageText?.includes("power outage") || pageText?.includes("road_obstruction"), "UI must display impacts");
    assert.ok(pageText?.includes("tiang listrik") || pageText?.includes("menimpa tiang"), "UI must display verbatim evidence quote");
    console.log("  Verified open-ended incident type, impacts, and verbatim evidence quotes in UI.");

    // 8. The webhook-only report is refused: its link is webhook://, and the publish gate never shows that (NFR-07 A4).
    console.log("\n[Step 8] Approving the webhook-only report (refusal expected)...");
    const approveBtn = page.locator('button[data-action="approve"]').first();
    await approveBtn.waitFor({ state: "visible", timeout: 5_000 });
    await approveBtn.click();

    // Confirm modal action
    const confirmModalBtn = page.locator('button[data-action="modal-confirm"]').first();
    await confirmModalBtn.waitFor({ state: "visible", timeout: 5_000 });
    const refusedResponse = page.waitForResponse(
      (response) => response.request().method() === "POST" && response.url().endsWith(`/api/v1/moderation/proposals/${proposalId}/publish`),
    );
    await confirmModalBtn.click();
    const refused = await refusedResponse;
    assert.equal(refused.status(), 403, "the webhook-only report must be refused with HTTP 403");
    assert.equal((await refused.json() as { code?: string }).code, "publication_not_authorized");
    await page.getByText("publication_not_authorized").first().waitFor({ state: "visible", timeout: 5_000 });

    const refusalReasons = assessProposalSourceGate(matchingProposal, {
      publicDisplaySourceIds: new Set([e2eSourceId]),
      revokedSourceIds: new Set<string>(),
      linkedInvestigationStatus: null,
    });
    assert.deepEqual(refusalReasons, ["claim_source_link_missing"], "the only gate reason is the missing public https link");
    const refusedDecisions = await db.executor.query<{ decision_id: string }>(
      `SELECT decision_id FROM waspada.publication_decisions WHERE dataset_kind = 'synthetic' AND proposal_id = $1`,
      [proposalId],
    );
    assert.equal(refusedDecisions.rows.length, 0, "a refused proposal records no publication decision");
    console.log(`  webhook-only report refused (NFR-07 A4), expected: publication_not_authorized, gate reason ${refusalReasons.join(", ")}.`);

    // 8b. The publishable report goes through the same moderator approval and must be published.
    console.log("\n[Step 8b] Approving the publishable report...");
    await page.reload({ waitUntil: "domcontentloaded" });
    const linkedCard = page.locator(`button[data-proposal-id="${linkedProposalId}"]`).first();
    await linkedCard.waitFor({ state: "visible", timeout: 10_000 });
    await linkedCard.click();
    await detailPanel.waitFor({ state: "visible", timeout: 5_000 });
    await approveBtn.waitFor({ state: "visible", timeout: 5_000 });
    await approveBtn.click();
    await confirmModalBtn.waitFor({ state: "visible", timeout: 5_000 });
    const publishedResponse = page.waitForResponse(
      (response) => response.request().method() === "POST" && response.url().endsWith(`/api/v1/moderation/proposals/${linkedProposalId}/publish`),
    );
    await confirmModalBtn.click();
    const published = await publishedResponse;
    assert.equal(published.status(), 200, "the publishable report must be published (HTTP 200)");
    console.log("  Publication accepted (HTTP 200). Awaiting publication transition...");

    // Wait for publication completion in UI
    await page.waitForTimeout(1_000);

    // 9. Verify Resulting Public Event and Map Representation (/#peta)
    console.log("\n[Step 9] Navigating to public map view (/#peta)...");
    await page.goto(`${baseUrl}/#peta`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1_000);

    const mapContainer = page.locator(".incident-map-container, .interactive-map-panel, #root").first();
    await mapContainer.waitFor({ state: "visible", timeout: 5_000 });

    const publicPageText = await page.textContent("body");
    assert.ok(
      publicPageText?.includes("Pohon tumbang") || publicPageText?.includes("Rasuna Said"),
      "Public view must display published event",
    );
    console.log("  Verified public event representation on map view.");

    // 10. Verify Publication Decision in Database
    console.log("\n[Step 10] Verifying publication decision record in database...");
    const pubCheck = await db.executor.query<{
      decision_id: string;
      proposal_id: string;
      event_id: string;
    }>(
      `SELECT pd.decision_id, pd.proposal_id, pd.event_id
       FROM waspada.publication_decisions pd
       WHERE pd.dataset_kind = 'synthetic' AND pd.proposal_id = $1`,
      [linkedProposalId],
    );
    assert.equal(pubCheck.rows.length, 1, "the publishable report must have exactly one publication decision");
    const publicEventId = pubCheck.rows[0].event_id || `evt-${linkedProposalId}`;
    console.log(`  Authoritative Publication Decision: ID=${pubCheck.rows[0].decision_id}, Event=${publicEventId}`);

    // 11. Final Verification & Captured ID Summary
    console.log("\n==================================================================");
    console.log("  CAPTURED TEST EXECUTION LINEAGE IDENTIFIERS");
    console.log("==================================================================");
    console.table([
      { Entity: "Report Revision (webhook, refused)", ID: revisionId },
      { Entity: "AI Job", ID: jobId },
      { Entity: "Trace", ID: traceId },
      { Entity: "Incident", ID: incidentId },
      { Entity: "Correlation Decision", ID: decisionId },
      { Entity: "Moderation Proposal (webhook, refused)", ID: proposalId },
      { Entity: "Report Revision (public link)", ID: linkedRevisionId },
      { Entity: "Moderation Proposal (published)", ID: linkedProposalId },
      { Entity: "Public Event", ID: publicEventId },
    ]);
    console.log("==================================================================");
    console.log("  Playwright Browser Journey: FULL END-TO-END PASSED");
    console.log("==================================================================\n");
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    server.close();
    await db.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error("\n[E2E Browser Journey FAILED]:", err);
  process.exit(1);
});
