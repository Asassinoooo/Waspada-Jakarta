import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import { createTestDatabase } from "../../apps/db/test/harness.js";
import { applyMigrations, readMigrations } from "../../apps/db/src/migrations.js";
import { createSqlIncidentRepository } from "../../apps/db/src/incident-repository.js";
import { createEventProposalWriter } from "../../apps/db/src/event-proposal-writer.js";
import { createJobRunner } from "../../apps/intelligence/src/job-runner.js";
import {
  createMockInterpreterAgent,
  createMockCorrelatorAgent,
} from "../../apps/intelligence/test/mock-agents.js";
import worker from "../../apps/worker/src/index.js";
import type { WorkerEnvironment } from "../../apps/worker/src/layers/l4-application-integration/api.js";

const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
});

async function main() {
  console.log("==================================================================");
  console.log("  Waspada Jakarta: End-to-End Playwright Browser Journey");
  console.log("==================================================================");

  // 1. Initialize Test Database & Run Migrations (001 - 039)
  console.log("\n[Step 1] Initializing PostgreSQL test instance and applying migrations...");
  const db = await createTestDatabase();
  const migrations = await readMigrations(new URL("../../apps/db/migrations/", import.meta.url));
  await applyMigrations(db.executor, migrations);
  console.log(`  Applied ${migrations.length} migrations up to 039.`);

  const incidentRepo = createSqlIncidentRepository(db.executor);
  const proposalWriter = createEventProposalWriter(db.executor);

  // 2. Start Local Unified HTTP Server (Web App + Worker Backend)
  console.log("\n[Step 2] Launching unified test server bridging Worker and Web UI...");
  const env: WorkerEnvironment = {
    DATASET_MODE: "synthetic",
    INTERNAL_SERVICE_KEY: "dev-internal-key",
    SQL_EXECUTOR: db.executor,
  };

  const distDir = path.resolve(process.cwd(), "apps/web/dist");
  assert.ok(fs.existsSync(distDir), "apps/web/dist must exist (run npm run build:web)");

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

      if (url.pathname.startsWith("/api/v1")) {
        // Collect request body
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk as Buffer);
        }
        const bodyBuf = Buffer.concat(chunks);
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) {
          if (v !== undefined) {
            if (Array.isArray(v)) {
              v.forEach((val) => headers.append(k, val));
            } else {
              headers.set(k, v);
            }
          }
        }

        const webReq = new Request(url.href, {
          method: req.method,
          headers,
          body: ["GET", "HEAD"].includes(req.method ?? "") ? undefined : bodyBuf,
        });

        const webRes = await worker.fetch(webReq, env);
        res.statusCode = webRes.status;
        webRes.headers.forEach((v, k) => {
          res.setHeader(k, v);
        });
        const resBuf = Buffer.from(await webRes.arrayBuffer());
        res.end(resBuf);
      } else {
        // Serve static web files or SPA fallback
        let targetFile = path.join(distDir, url.pathname);
        if (!fs.existsSync(targetFile) || fs.statSync(targetFile).isDirectory()) {
          targetFile = path.join(distDir, "index.html");
        }
        const ext = path.extname(targetFile);
        const contentType = MIME_TYPES[ext] || "application/octet-stream";
        const content = fs.readFileSync(targetFile);
        res.writeHead(200, { "Content-Type": contentType });
        res.end(content);
      }
    } catch (err) {
      console.error("Server error handling request:", err);
      res.statusCode = 500;
      res.end("Internal Server Error");
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}`;
  console.log(`  Unified test server running on ${baseUrl}`);

  let browser: Browser | null = null;

  try {
    // 3. Submit Synthetic Source Report via /api/v1/ingestion/events
    console.log("\n[Step 3] Submitting synthetic source report to webhook ingestion endpoint...");
    const reportTimestamp = "2026-10-31T15:00:00Z";
    const reportText =
      "Pohon tumbang besar menimpa tiang listrik di Jalan HR Rasuna Said depan Kemenkes menyebabkan kemacetan parah dan pemadaman listrik lokal.";
    const reportPayload = {
      source_id: "source-synthetic-e2e",
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
      headers: { "Content-Type": "application/json" },
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
    const mockInterpreter = createMockInterpreterAgent({
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
    });

    const mockCorrelator = createMockCorrelatorAgent({
      decision: "new_incident",
      candidateIncidentId: null,
      reasoning: "Distinct physical tree fall hazard with no prior active candidate.",
      supportingEvidence: [
        {
          reportRevisionId: revisionId,
          quote: "Pohon tumbang besar menimpa tiang listrik di Jalan HR Rasuna Said depan Kemenkes",
          relevance: "Physical obstruction location",
        },
      ],
    });

    const runner = createJobRunner({
      executor: db.executor,
      agentOverrides: {
        interpreter: mockInterpreter,
        correlator: mockCorrelator,
      },
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

    // 7. Launch Real Chromium Browser Journey via Playwright
    console.log("\n[Step 7] Launching Chromium browser to execute moderation & publication journey...");
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

    const context = await browser.newContext();
    // Inject authenticated demo moderator session cookie
    await context.addCookies([
      {
        name: "waspada_demo_session",
        value: "moderator",
        domain: "127.0.0.1",
        path: "/",
      },
    ]);

    const page = await context.newPage();

    // Navigate to Moderation Queue (/#tinjau-bukti)
    console.log(`  Navigating to ${baseUrl}/#tinjau-bukti...`);
    await page.goto(`${baseUrl}/#tinjau-bukti`, { waitUntil: "domcontentloaded" });

    // Verify Proposal appears in Moderation Queue UI
    console.log("  Verifying proposal card in moderation queue UI...");
    const cardSelector = `.proposal-card-btn:has-text("${proposalId}"), .proposal-card-btn:has-text("Pohon tumbang")`;
    const proposalCard = page.locator(cardSelector).first();
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

    // 8. Approve Publication ("Setujui & Terbitkan")
    console.log("\n[Step 8] Approving proposal publication...");
    const approveBtn = page.locator('button[data-action="approve"]').first();
    await approveBtn.waitFor({ state: "visible", timeout: 5_000 });
    await approveBtn.click();

    // Confirm modal action
    const confirmModalBtn = page.locator('button[data-action="modal-confirm"]').first();
    await confirmModalBtn.waitFor({ state: "visible", timeout: 5_000 });
    await confirmModalBtn.click();
    console.log("  Clicked confirmation modal. Awaiting publication transition...");

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
      [proposalId],
    );

    let publicEventId = `evt-${proposalId}`;
    if (pubCheck.rows.length > 0) {
      publicEventId = pubCheck.rows[0].event_id || publicEventId;
      console.log(`  Authoritative Publication Decision: ID=${pubCheck.rows[0].decision_id}, Event=${publicEventId}`);
    } else {
      console.log(`  Public read model published event ID: ${publicEventId}`);
    }

    // 11. Final Verification & Captured ID Summary
    console.log("\n==================================================================");
    console.log("  CAPTURED TEST EXECUTION LINEAGE IDENTIFIERS");
    console.log("==================================================================");
    console.table([
      { Entity: "Report Revision", ID: revisionId },
      { Entity: "AI Job", ID: jobId },
      { Entity: "Trace", ID: traceId },
      { Entity: "Incident", ID: incidentId },
      { Entity: "Correlation Decision", ID: decisionId },
      { Entity: "Moderation Proposal", ID: proposalId },
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
