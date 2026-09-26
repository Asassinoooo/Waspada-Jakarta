import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemorySyntheticFixtureCatalog,
  type FixtureJobRecord,
  type FixturePipelinePorts,
  type SyntheticFixture,
  type SyntheticReportManifest,
} from "../src/layers/l1-data-knowledge/synthetic-fixture-pipeline.js";
import {
  runSyntheticFixtureJob,
  type SyntheticFixtureClaimPort,
} from "../src/layers/l1-data-knowledge/synthetic-fixture-runner.js";

const fixtureUrl = "https://synthetic.invalid/moderator/runner-fixture";
const retrievedAt = "2026-09-25T03:00:00.000Z";
const transitionAt = "2026-09-25T03:01:00.000Z";
const permittedText = "Synthetic runner fixture: station entrance on Merdeka Street.";

test("claims once, passes the same time through, and persists before acknowledging", async () => {
  const events: string[] = [];
  const claims: string[] = [];
  const ports = mockPipelinePorts(events);
  const result = await runSyntheticFixtureJob({
    now: transitionAt,
    queue: queueWith(makeJob(), events, claims),
    catalog: new InMemorySyntheticFixtureCatalog([makeFixture()]),
    pipelinePorts: ports,
  });

  assert.deepEqual(result, {
    outcome: "completed", empty: false, reportCount: 1,
    evidenceReferenceCount: 1, chunkCount: 1, geometryCount: 0,
  });
  assert.deepEqual(claims, [transitionAt]);
  assert.deepEqual(events, [
    "claim", "source", "revision", "evidence", "chunks", `complete:${transitionAt}`,
  ]);
  assert.deepEqual(Object.keys(result).sort(), [
    "chunkCount", "empty", "evidenceReferenceCount", "geometryCount", "outcome", "reportCount",
  ]);
  assert.equal(JSON.stringify(result).includes(fixtureUrl), false);
  assert.equal(JSON.stringify(result).includes(permittedText), false);
});

test("returns idle after one empty claim without looking up or processing a fixture", async () => {
  const events: string[] = [];
  const claims: string[] = [];
  const result = await runSyntheticFixtureJob({
    now: transitionAt,
    queue: queueWith(null, events, claims),
    catalog: { lookupExact() { events.push("lookup"); return null; } },
    pipelinePorts: mockPipelinePorts(events),
  });

  assert.deepEqual(result, { outcome: "idle" });
  assert.deepEqual(claims, [transitionAt]);
  assert.deepEqual(events, []);
});

test("rejects a non-RFC-3339 time before claiming", async () => {
  const events: string[] = [];
  const claims: string[] = [];
  const result = await runSyntheticFixtureJob({
    now: "2026-02-30 03:01:00",
    queue: queueWith(makeJob(), events, claims),
    catalog: new InMemorySyntheticFixtureCatalog([makeFixture()]),
    pipelinePorts: mockPipelinePorts(events),
  });

  assert.deepEqual(result, {
    outcome: "failed", code: "invalid_timestamp", queueOutcome: "not_claimed",
  });
  assert.deepEqual(claims, []);
  assert.deepEqual(events, []);
});

test("redacts queue exceptions into a stable claim failure", async () => {
  const secret = `${fixtureUrl} private request body`;
  const claims: string[] = [];
  const result = await runSyntheticFixtureJob({
    now: transitionAt,
    queue: {
      async claimDueSyntheticModeratorSubmission(now) {
        claims.push(now);
        throw new Error(secret);
      },
    },
    catalog: new InMemorySyntheticFixtureCatalog([makeFixture()]),
    pipelinePorts: mockPipelinePorts([]),
  });

  assert.deepEqual(result, {
    outcome: "failed", code: "queue_claim_failed", queueOutcome: "not_claimed",
  });
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(claims, [transitionAt]);
});

test("propagates a fixture miss through the existing terminal queue path", async () => {
  const events: string[] = [];
  const result = await runSyntheticFixtureJob({
    now: transitionAt,
    queue: queueWith(makeJob({ submittedUrl: `${fixtureUrl}/missing` }), events, []),
    catalog: new InMemorySyntheticFixtureCatalog([makeFixture()]),
    pipelinePorts: mockPipelinePorts(events),
  });

  assert.deepEqual(result, {
    outcome: "failed", code: "fixture_not_found", queueOutcome: "terminal",
  });
  assert.deepEqual(events, ["claim", "fail:fixture_not_found:permanent"]);
  assert.equal(JSON.stringify(result).includes(fixtureUrl), false);
});

test("propagates persistence errors through the existing retry path without completing", async () => {
  const events: string[] = [];
  const ports = mockPipelinePorts(events);
  ports.reportRevisions.create = async () => {
    events.push("revision");
    throw new Error(`${fixtureUrl} ${permittedText}`);
  };
  const result = await runSyntheticFixtureJob({
    now: transitionAt,
    queue: queueWith(makeJob(), events, []),
    catalog: new InMemorySyntheticFixtureCatalog([makeFixture()]),
    pipelinePorts: ports,
  });

  assert.deepEqual(result, {
    outcome: "failed", code: "fixture_persistence_failed", queueOutcome: "retry",
  });
  assert.deepEqual(events, ["claim", "source", "revision", "fail:fixture_persistence_failed:retryable"]);
  assert.equal(JSON.stringify(result).includes(fixtureUrl), false);
  assert.equal(JSON.stringify(result).includes(permittedText), false);
});

test("reports a lost lease without issuing another transition", async () => {
  const events: string[] = [];
  const ports = mockPipelinePorts(events, { completeOutcome: "not_owned" });
  const result = await runSyntheticFixtureJob({
    now: transitionAt,
    queue: queueWith(makeJob(), events, []),
    catalog: new InMemorySyntheticFixtureCatalog([makeFixture()]),
    pipelinePorts: ports,
  });

  assert.deepEqual(result, { outcome: "lost_lease", code: "lease_not_owned" });
  assert.equal(events.at(-1), `complete:${transitionAt}`);
  assert.equal(events.some((event) => event.startsWith("fail:")), false);
});

test("does not process a job outside the queue's synthetic moderator scope", async () => {
  const events: string[] = [];
  const claims: string[] = [];
  const result = await runSyntheticFixtureJob({
    now: transitionAt,
    queue: queueWith(makeJob({ datasetKind: "live", jobKind: "source_poll" }), events, claims),
    catalog: { lookupExact() { events.push("lookup"); return makeFixture(); } },
    pipelinePorts: mockPipelinePorts(events),
  });

  assert.deepEqual(result, { outcome: "not_eligible", code: "job_not_eligible" });
  assert.deepEqual(claims, [transitionAt]);
  assert.deepEqual(events, ["claim"]);
});

function queueWith(
  job: FixtureJobRecord | null,
  events: string[],
  claims: string[],
): SyntheticFixtureClaimPort {
  return {
    async claimDueSyntheticModeratorSubmission(now) {
      claims.push(now);
      if (job) events.push("claim");
      return job;
    },
  };
}

function mockPipelinePorts(
  events: string[],
  options: { readonly completeOutcome?: "updated" | "not_owned" } = {},
): FixturePipelinePorts {
  return {
    acquisitionJobs: {
      async complete(_dataset, _jobId, _leaseToken, now) {
        events.push(`complete:${now}`);
        return { outcome: options.completeOutcome ?? "updated" };
      },
      async fail(_dataset, _jobId, _leaseToken, input) {
        events.push(`fail:${input.failureCode}:${input.disposition}`);
        return {
          outcome: "updated",
          job: { status: input.disposition === "permanent" ? "terminal" : "retry" },
        };
      },
    },
    sourceRegistry: {
      async findById() {
        events.push("source");
        return {
          accessMethod: "manual_fixture",
          approvalStatus: "approved",
          autoAcquisitionEnabled: false,
          autoPublicationPolicy: "never",
        };
      },
    },
    reportRevisions: {
      async create() { events.push("revision"); },
      async createEvidenceReference() { events.push("evidence"); return "evidence-runner"; },
    },
    evidenceChunks: { async persist() { events.push("chunks"); } },
    geometryWriter: { async persist() { events.push("geometry"); } },
  };
}

function makeJob(overrides: Partial<FixtureJobRecord> = {}): FixtureJobRecord {
  return {
    jobId: "job-runner-1",
    datasetKind: "synthetic",
    jobKind: "moderator_submission",
    traceId: "trace-runner-1",
    sourceId: null,
    submittedUrl: fixtureUrl,
    status: "leased",
    leaseToken: "lease-runner-token",
    ...overrides,
  };
}

function makeFixture(): SyntheticFixture {
  const manifest: SyntheticReportManifest = {
    reportRevisionId: "revision-runner-1",
    sourceId: "source-runner-fixture",
    canonicalUrl: fixtureUrl,
    contentHash: "c".repeat(64),
    permittedText,
    publishedAt: null,
    observedAt: null,
    validFrom: null,
    validUntil: null,
    supersedesId: null,
    supportSpans: [{ spanStart: 0, spanEnd: Array.from(permittedText).length }],
  };
  return {
    url: fixtureUrl,
    geoJson: JSON.stringify({
      type: "FeatureCollection",
      features: [{ type: "Feature", id: "runner-feature-1", properties: {}, geometry: null }],
    }),
    retrievedAt,
    sourceId: "source-runner-fixture",
    manifests: new Map([["runner-feature-1", manifest]]),
  };
}
