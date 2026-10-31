import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { applyMigrations, readMigrations } from "../src/migrations.js";
import { createSqlIncidentRepository, type IncidentRepository } from "../src/incident-repository.js";
import { createTestDatabase, type TestDatabase } from "./harness.js";

describe("SqlIncidentRepository", () => {
  let db: TestDatabase;
  let repo: IncidentRepository;

  before(async () => {
    db = await createTestDatabase();
    const migrations = await readMigrations(new URL("../migrations/", import.meta.url));
    await applyMigrations(db.executor, migrations);
    repo = createSqlIncidentRepository(db.executor);
  });

  after(async () => {
    await db?.close();
  });

  describe("Incident Lifecycle", () => {
    it("creates, updates, and retrieves a persistent incident", async () => {
      const incident = await repo.createIncident({
        incidentId: "inc-flood-cawang-01",
        datasetKind: "synthetic",
        title: "Banjir Luapan Cawang",
        description: "Banjir setinggi 50 cm di Jalan DI Panjaitan",
        incidentType: "flood_inundation",
        status: "active",
        severity: "medium",
        locationLabel: "Jl. DI Panjaitan, Cawang, Jakarta Timur",
        coordinates: [106.871, -6.244],
        firstObservedAt: "2026-10-30T10:00:00.000Z",
        uncertaintyNotes: ["Penyebab genangan belum terkonfirmasi Dinas SDA"],
      });

      assert.equal(incident.incidentId, "inc-flood-cawang-01");
      assert.equal(incident.status, "active");
      assert.deepEqual(incident.coordinates, [106.871, -6.244]);
      assert.equal(incident.uncertaintyNotes.length, 1);

      // Update incident status and add discrepancy
      const updated = await repo.updateIncident({
        incidentId: "inc-flood-cawang-01",
        datasetKind: "synthetic",
        status: "monitoring",
        severity: "low",
        discrepancies: [{ field: "water_height", note: "Laporan warga 40cm vs BPBD 20cm" }],
        lastUpdatedAt: "2026-10-30T11:00:00.000Z",
      });

      assert.equal(updated.status, "monitoring");
      assert.equal(updated.severity, "low");
      assert.equal(updated.discrepancies.length, 1);

      // Retrieve by ID
      const fetched = await repo.getIncidentById("synthetic", "inc-flood-cawang-01");
      assert.ok(fetched);
      assert.equal(fetched.incident.title, "Banjir Luapan Cawang");
      assert.equal(fetched.incident.status, "monitoring");
    });

    it("links multiple reports and records correlation decisions", async () => {
      // Link initial report
      const link1 = await repo.linkReport({
        datasetKind: "synthetic",
        incidentId: "inc-flood-cawang-01",
        reportRevisionId: "rev-report-001",
        relationship: "primary_initial",
      });
      assert.equal(link1.relationship, "primary_initial");

      // Record correlation decision
      const decision = await repo.recordCorrelationDecision({
        decisionId: "dec-corr-001",
        datasetKind: "synthetic",
        reportRevisionId: "rev-report-002",
        decision: "same_incident",
        targetIncidentId: "inc-flood-cawang-01",
        reasoning: "Kedua laporan merujuk pada genangan air di lokasi Cawang pada rentang waktu yang sama.",
        evidenceQuotes: [{ reportRevisionId: "rev-report-002", quote: "Air naik 50cm di Cawang", relevance: "same location & depth" }],
      });
      assert.equal(decision.decision, "same_incident");

      // Link corroborating report with decision reference
      await repo.linkReport({
        datasetKind: "synthetic",
        incidentId: "inc-flood-cawang-01",
        reportRevisionId: "rev-report-002",
        relationship: "corroborating",
        correlationDecisionId: "dec-corr-001",
      });

      // Verify incident details contain contributing reports and decisions
      const full = await repo.getIncidentById("synthetic", "inc-flood-cawang-01");
      assert.ok(full);
      assert.equal(full.contributingReports.length, 2);
      assert.equal(full.decisions.length, 1);
      assert.equal(full.decisions[0].decisionId, "dec-corr-001");

      // Verify lookup by report revision
      const reportIncident = await repo.getIncidentForReport("synthetic", "rev-report-002");
      assert.ok(reportIncident);
      assert.equal(reportIncident.incidentId, "inc-flood-cawang-01");
    });

    it("lists active incidents", async () => {
      const active = await repo.listActiveIncidents("synthetic");
      assert.ok(active.length >= 1);
      assert.equal(active[0].incidentId, "inc-flood-cawang-01");
    });
  });

  describe("AI Job Durable Queue", () => {
    it("enqueues, claims with lease, renews, and completes jobs", async () => {
      const enqueued = await repo.enqueueAiJob({
        jobId: "job-ai-001",
        datasetKind: "synthetic",
        reportRevisionId: "rev-report-job-01",
        traceId: "trace-test-01",
      });
      assert.equal(enqueued.status, "pending");
      assert.equal(enqueued.attemptCount, 0);

      // Idempotent enqueue
      const reEnqueued = await repo.enqueueAiJob({
        jobId: "job-ai-001-dupe",
        datasetKind: "synthetic",
        reportRevisionId: "rev-report-job-01",
      });
      assert.equal(reEnqueued.jobId, "job-ai-001");

      // Claim job
      const claimed = await repo.claimAiJob({ datasetKind: "synthetic" });
      assert.ok(claimed);
      assert.equal(claimed.job.jobId, "job-ai-001");
      assert.equal(claimed.job.status, "leased");
      assert.equal(claimed.job.attemptCount, 1);
      assert.ok(claimed.leaseToken);

      // Renew lease
      const renewed = await repo.renewAiJob(claimed.job.jobId, claimed.leaseToken, 60_000);
      assert.equal(renewed, true);

      // Complete job
      const completed = await repo.completeAiJob(claimed.job.jobId, claimed.leaseToken);
      assert.equal(completed, true);

      // Once completed, no pending jobs remain
      const emptyClaim = await repo.claimAiJob({ datasetKind: "synthetic" });
      assert.equal(emptyClaim, null);
    });

    it("handles retries with backoff and marks needs_review at max attempts, supporting inspection and retry", async () => {
      await repo.enqueueAiJob({
        jobId: "job-ai-fail-001",
        datasetKind: "synthetic",
        reportRevisionId: "rev-report-job-fail",
      });

      // Claim attempt 1
      const claim1 = await repo.claimAiJob({ datasetKind: "synthetic" });
      assert.ok(claim1);
      assert.equal(claim1.job.attemptCount, 1);

      // Fail attempt 1 -> status: retry
      const fail1 = await repo.failAiJob(claim1.job.jobId, claim1.leaseToken, "provider_timeout", 0);
      assert.equal(fail1.status, "retry");
      assert.equal(fail1.attemptCount, 1);

      // Claim attempt 2
      const claim2 = await repo.claimAiJob({ datasetKind: "synthetic" });
      assert.ok(claim2);
      assert.equal(claim2.job.attemptCount, 2);

      // Fail attempt 2
      await repo.failAiJob(claim2.job.jobId, claim2.leaseToken, "provider_timeout", 0);

      // Claim attempt 3
      const claim3 = await repo.claimAiJob({ datasetKind: "synthetic" });
      assert.ok(claim3);
      assert.equal(claim3.job.attemptCount, 3);
      await repo.failAiJob(claim3.job.jobId, claim3.leaseToken, "provider_timeout", 0);

      // Claim attempt 4
      const claim4 = await repo.claimAiJob({ datasetKind: "synthetic" });
      assert.ok(claim4);
      assert.equal(claim4.job.attemptCount, 4);
      await repo.failAiJob(claim4.job.jobId, claim4.leaseToken, "provider_timeout", 0);

      // Claim attempt 5 (max)
      const claim5 = await repo.claimAiJob({ datasetKind: "synthetic" });
      assert.ok(claim5);
      assert.equal(claim5.job.attemptCount, 5);

      // Fail attempt 5 -> needs_review!
      const fail5 = await repo.failAiJob(claim5.job.jobId, claim5.leaseToken, "provider_timeout", 0);
      assert.equal(fail5.status, "needs_review");
      assert.equal(fail5.attemptCount, 5);

      // No more claims available while in needs_review
      const finalClaim = await repo.claimAiJob({ datasetKind: "synthetic" });
      assert.equal(finalClaim, null);

      // Inspect job
      const jobRecord = await repo.getAiJob("job-ai-fail-001");
      assert.ok(jobRecord);
      assert.equal(jobRecord.status, "needs_review");
      assert.equal(jobRecord.lastFailureCode, "provider_timeout");
      assert.equal(jobRecord.attemptCount, 5);

      // List needs_review jobs
      const reviewJobs = await repo.listAiJobs({ status: "needs_review", datasetKind: "synthetic" });
      assert.equal(reviewJobs.length, 1);
      assert.equal(reviewJobs[0].jobId, "job-ai-fail-001");

      // Manually retry job
      const retried = await repo.retryAiJob("job-ai-fail-001");
      assert.equal(retried, true);

      // Can now be claimed again with attemptCount reset to 0
      const claimAfterRetry = await repo.claimAiJob({ datasetKind: "synthetic" });
      assert.ok(claimAfterRetry);
      assert.equal(claimAfterRetry.job.jobId, "job-ai-fail-001");
      assert.equal(claimAfterRetry.job.attemptCount, 1);

      // Direct markAiJobNeedsReview test
      const marked = await repo.markAiJobNeedsReview(claimAfterRetry.job.jobId, claimAfterRetry.leaseToken, "manual_escalation");
      assert.equal(marked, true);
      const inspectedAfterMark = await repo.getAiJob("job-ai-fail-001");
      assert.equal(inspectedAfterMark?.status, "needs_review");
      assert.equal(inspectedAfterMark?.lastFailureCode, "manual_escalation");
    });
  });
});
