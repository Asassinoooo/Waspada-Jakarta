import assert from "node:assert/strict";
import test from "node:test";
import { createModelCapabilityAdapter } from "../src/layers/l2-model-grounding/adapter.js";
import type {
  ExtractionRequest,
  ModelCapabilityAdapter,
  UntrustedModelProvider,
} from "../src/layers/l2-model-grounding/contracts.js";
import {
  InMemorySyntheticSourcePollFixtureCatalog,
  type FixtureJobRecord,
  type FixturePipelinePorts,
  type SyntheticFixture,
  type SyntheticReportManifest,
} from "../src/layers/l1-data-knowledge/synthetic-fixture-pipeline.js";
import {
  runSyntheticSourcePollJob,
  type SyntheticSourcePollClaimPort,
} from "../src/layers/l1-data-knowledge/synthetic-source-poll-runner.js";

const sourceId = "source-synthetic-poll";
const otherSourceId = "source-synthetic-other";
const fixtureUrl = "https://synthetic.invalid/polls/source-synthetic-poll";
const retrievedAt = "2026-09-29T04:00:00.000Z";
const transitionAt = "2026-09-29T04:01:00.000Z";
const permittedText = "Synthetic poll fixture: station entrance on Merdeka Street.";

test("claims once and persists only the exact source-ID fixture before acknowledgement", async () => {
  const events: string[] = [];
  const claims: string[] = [];
  const catalog = new InMemorySyntheticSourcePollFixtureCatalog([
    makeFixture(),
    makeFixture({ sourceId: otherSourceId, url: "https://synthetic.invalid/polls/other" }),
  ]);
  const ports = mockPorts(events);
  const result = await runSyntheticSourcePollJob({
    now: transitionAt,
    queue: queueWith(makeJob(), events, claims),
    catalog,
    pipelinePorts: ports,
  });

  assert.deepEqual(result, {
    outcome: "completed", empty: false, reportCount: 1,
    evidenceReferenceCount: 5, chunkCount: 1, geometryCount: 0,
  });
  assert.deepEqual(claims, [transitionAt]);
  assert.deepEqual(events, [
    "claim", "source", "revision", "lookup", "extract", "evidence", "evidence", "evidence",
    "evidence", "evidence", "chunks", "extraction", `complete:${transitionAt}`,
  ]);
  assert.equal(JSON.stringify(result).includes(fixtureUrl), false);
  assert.equal(JSON.stringify(result).includes(permittedText), false);
});

test("source catalog keys are exact and duplicate source IDs are rejected", () => {
  const fixture = makeFixture();
  const catalog = new InMemorySyntheticSourcePollFixtureCatalog([fixture]);
  assert.equal(catalog.lookupExactSourceId(sourceId), fixture);
  assert.equal(catalog.lookupExactSourceId(sourceId.toUpperCase()), null);
  assert.throws(
    () => new InMemorySyntheticSourcePollFixtureCatalog([fixture, { ...fixture, url: `${fixtureUrl}/duplicate` }]),
    /Duplicate synthetic fixture source ID/,
  );
});

test("returns idle after one claim without looking up a fixture", async () => {
  const events: string[] = [];
  const claims: string[] = [];
  const result = await runSyntheticSourcePollJob({
    now: transitionAt,
    queue: queueWith(null, events, claims),
    catalog: { lookupExactSourceId() { events.push("lookup"); return null; } },
    pipelinePorts: mockPorts(events),
  });

  assert.deepEqual(result, { outcome: "idle" });
  assert.deepEqual(claims, [transitionAt]);
  assert.deepEqual(events, []);
});

test("rejects invalid calendar timestamps before claiming", async () => {
  const events: string[] = [];
  const claims: string[] = [];
  const result = await runSyntheticSourcePollJob({
    now: "2026-02-30T04:01:00Z",
    queue: queueWith(makeJob(), events, claims),
    catalog: new InMemorySyntheticSourcePollFixtureCatalog([makeFixture()]),
    pipelinePorts: mockPorts(events),
  });

  assert.deepEqual(result, { outcome: "failed", code: "invalid_timestamp", queueOutcome: "not_claimed" });
  assert.deepEqual(claims, []);
  assert.deepEqual(events, []);
});

test("rejects live, historical, moderator, unleased, malformed and tokenless jobs before catalog lookup", async () => {
  const cases: Partial<FixtureJobRecord>[] = [
    { datasetKind: "live" },
    { datasetKind: "historical" },
    { jobKind: "moderator_submission", sourceId: null, submittedUrl: fixtureUrl },
    { status: "retry" },
    { sourceId: null },
    { sourceId: "bad/source/id" },
    { submittedUrl: fixtureUrl },
    { leaseToken: null },
    { leaseToken: "   " },
  ];

  for (const overrides of cases) {
    const events: string[] = [];
    const claims: string[] = [];
    const result = await runSyntheticSourcePollJob({
      now: transitionAt,
      queue: queueWith(makeJob(overrides), events, claims),
      catalog: { lookupExactSourceId() { events.push("lookup"); return makeFixture(); } },
      pipelinePorts: mockPorts(events),
    });
    assert.deepEqual(result, { outcome: "not_eligible", code: "job_not_eligible" });
    assert.deepEqual(claims, [transitionAt]);
    assert.deepEqual(events, ["claim"]);
  }
});

test("catalog miss uses a stable redacted terminal failure", async () => {
  const events: string[] = [];
  const result = await runSyntheticSourcePollJob({
    now: transitionAt,
    queue: queueWith(makeJob(), events, []),
    catalog: { lookupExactSourceId() { return null; } },
    pipelinePorts: mockPorts(events),
  });

  assert.deepEqual(result, { outcome: "failed", code: "fixture_not_found", queueOutcome: "terminal" });
  assert.deepEqual(events, ["claim", "fail:fixture_not_found:permanent"]);
  assert.equal(JSON.stringify(result).includes(fixtureUrl), false);
  assert.equal(JSON.stringify(result).includes(permittedText), false);
});

test("a fixture whose source identity differs from the claimed source fails before source reads or writes", async () => {
  const events: string[] = [];
  const result = await runSyntheticSourcePollJob({
    now: transitionAt,
    queue: queueWith(makeJob(), events, []),
    catalog: { lookupExactSourceId(requestedSourceId) {
      assert.equal(requestedSourceId, sourceId);
      return makeFixture({ sourceId: otherSourceId });
    } },
    pipelinePorts: mockPorts(events),
  });

  assert.deepEqual(result, { outcome: "failed", code: "fixture_not_found", queueOutcome: "terminal" });
  assert.deepEqual(events, ["claim", "fail:fixture_not_found:permanent"]);
});

test("registry read outages retry with a fixed code and disabled publication is required", async () => {
  const outageEvents: string[] = [];
  const outagePorts = mockPorts(outageEvents);
  outagePorts.sourceRegistry.findById = async () => { throw new Error(`${fixtureUrl} ${permittedText}`); };
  const outage = await runSyntheticSourcePollJob({
    now: transitionAt,
    queue: queueWith(makeJob(), outageEvents, []),
    catalog: new InMemorySyntheticSourcePollFixtureCatalog([makeFixture()]),
    pipelinePorts: outagePorts,
  });
  assert.deepEqual(outage, {
    outcome: "failed", code: "fixture_persistence_failed", queueOutcome: "retry",
  });
  assert.deepEqual(outageEvents, ["claim", "fail:fixture_persistence_failed:retryable"]);
  assert.equal(JSON.stringify(outage).includes(fixtureUrl), false);
  assert.equal(JSON.stringify(outage).includes(permittedText), false);

  const policyEvents: string[] = [];
  const policyPorts = mockPorts(policyEvents);
  policyPorts.sourceRegistry.findById = async () => ({
    sourceId, registryStatus: "active", pollingIntervalSeconds: 300,
    accessMethod: "api", approvalStatus: "approved", autoAcquisitionEnabled: true,
    autoPublicationPolicy: "approved_issuer_notice",
  });
  const policy = await runSyntheticSourcePollJob({
    now: transitionAt,
    queue: queueWith(makeJob(), policyEvents, []),
    catalog: new InMemorySyntheticSourcePollFixtureCatalog([makeFixture()]),
    pipelinePorts: policyPorts,
  });
  assert.deepEqual(policy, { outcome: "failed", code: "fixture_source_invalid", queueOutcome: "terminal" });
  assert.deepEqual(policyEvents, ["claim", "fail:fixture_source_invalid:permanent"]);
});

test("rejects a manifest whose source ID or canonical URL differs from its fixture", async () => {
  const original = makeFixture();
  const originalManifest = original.manifests.get("provider-feature-source-poll-1");
  assert.ok(originalManifest);
  const invalidFixture: SyntheticFixture = {
    ...original,
    manifests: new Map([[
      "provider-feature-source-poll-1",
      { ...originalManifest, sourceId: otherSourceId, canonicalUrl: `${fixtureUrl}/different` },
    ]]),
  };
  const events: string[] = [];
  const result = await runSyntheticSourcePollJob({
    now: transitionAt,
    queue: queueWith(makeJob(), events, []),
    catalog: { lookupExactSourceId() { return invalidFixture; } },
    pipelinePorts: mockPorts(events),
  });

  assert.deepEqual(result, { outcome: "failed", code: "fixture_manifest_invalid", queueOutcome: "terminal" });
  assert.deepEqual(events, ["claim", "source", "fail:fixture_manifest_invalid:permanent"]);
});

test("source registry poll checks fail closed when exact identity or eligibility fields are absent", async () => {
  const invalidSources = [
    {
      registryStatus: "active", pollingIntervalSeconds: 300, sourceId: otherSourceId,
      accessMethod: "api", approvalStatus: "approved", autoAcquisitionEnabled: true,
      autoPublicationPolicy: "never",
    },
    {
      sourceId, pollingIntervalSeconds: 300,
      accessMethod: "api", approvalStatus: "approved", autoAcquisitionEnabled: true,
      autoPublicationPolicy: "never",
    },
    {
      sourceId, registryStatus: "active", pollingIntervalSeconds: null,
      accessMethod: "api", approvalStatus: "approved", autoAcquisitionEnabled: true,
      autoPublicationPolicy: "never",
    },
  ] as const;

  for (const invalidSource of invalidSources) {
    const events: string[] = [];
    const ports = mockPorts(events);
    ports.sourceRegistry.findById = async () => {
      events.push("source");
      return invalidSource;
    };
    const result = await runSyntheticSourcePollJob({
      now: transitionAt,
      queue: queueWith(makeJob(), events, []),
      catalog: new InMemorySyntheticSourcePollFixtureCatalog([makeFixture()]),
      pipelinePorts: ports,
    });
    assert.deepEqual(result, { outcome: "failed", code: "fixture_source_invalid", queueOutcome: "terminal" });
    assert.deepEqual(events, ["claim", "source", "fail:fixture_source_invalid:permanent"]);
  }
});

test("an authored empty feed completes after source validation without record or publication writes", async () => {
  const events: string[] = [];
  const fixture = makeFixture({ geoJson: JSON.stringify({ type: "FeatureCollection", features: [] }), manifests: new Map() });
  const result = await runSyntheticSourcePollJob({
    now: transitionAt,
    queue: queueWith(makeJob(), events, []),
    catalog: new InMemorySyntheticSourcePollFixtureCatalog([fixture]),
    pipelinePorts: mockPorts(events),
  });

  assert.deepEqual(result, {
    outcome: "completed", empty: true, reportCount: 0,
    evidenceReferenceCount: 0, chunkCount: 0, geometryCount: 0,
  });
  assert.deepEqual(events, ["claim", "source", `complete:${transitionAt}`]);
  assert.equal(JSON.stringify(result).toLowerCase().includes("safe"), false);
});

test("a lost completion lease is reported without a second queue transition", async () => {
  const events: string[] = [];
  const result = await runSyntheticSourcePollJob({
    now: transitionAt,
    queue: queueWith(makeJob(), events, []),
    catalog: new InMemorySyntheticSourcePollFixtureCatalog([makeFixture()]),
    pipelinePorts: mockPorts(events, { completeOutcome: "not_owned" }),
  });

  assert.deepEqual(result, { outcome: "lost_lease", code: "lease_not_owned" });
  assert.equal(events.at(-1), `complete:${transitionAt}`);
  assert.equal(events.some((event) => event.startsWith("fail:")), false);
});

function queueWith(
  job: FixtureJobRecord | null,
  events: string[],
  claims: string[],
): SyntheticSourcePollClaimPort {
  return {
    async claimDueSyntheticSourcePoll(now) {
      claims.push(now);
      if (job) events.push("claim");
      return job;
    },
  };
}

function mockPorts(
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
      async findById(requestedSourceId) {
        events.push("source");
        assert.equal(requestedSourceId, sourceId);
        return {
          sourceId,
          registryStatus: "active",
          pollingIntervalSeconds: 300,
          accessMethod: "api",
          approvalStatus: "approved",
          autoAcquisitionEnabled: true,
          autoPublicationPolicy: "never",
        };
      },
    },
    modelAdapter: createTestModelAdapter(events),
    reportRevisions: {
      async create(input) {
        events.push("revision");
        assert.equal(input.sourceId, sourceId);
        assert.equal(input.canonicalUrl, fixtureUrl);
      },
      async createEvidenceReference() { events.push("evidence"); return "evidence-source-poll"; },
    },
    extractionResults: {
      async createOrVerify(record) { events.push("extraction"); return record; },
      async findByCandidateId() { events.push("lookup"); return { outcome: "not_found" }; },
    },
    evidenceChunks: { async persist() { events.push("chunks"); } },
    geometryWriter: { async persist() { events.push("geometry"); } },
  };
}

function createTestModelAdapter(events: string[]): Pick<ModelCapabilityAdapter, "extract"> {
  const provider: UntrustedModelProvider = {
    async classify() { throw new Error("unused synthetic classification"); },
    async extract(request: ExtractionRequest) {
      events.push("extract");
      const report = request.data.report;
      const relations = ["supports", "contradicts", "updates", "context"] as const;
      return {
        output: {
          category: "transport_road_incidents",
          tags: [],
          eventTime: { start: null, end: null, precision: "unknown" },
          scope: { placeIds: [], serviceIds: [], institutionIds: [], audienceIds: [], geometryIds: [] },
          evidence: relations.map((relation, index) => ({
            reportRevisionId: report.reportRevisionId,
            permittedTextHash: report.permittedTextHash,
            spanStart: index * 4,
            spanEnd: index * 4 + 3,
            offsetUnit: "unicode_code_points",
            relation,
          })),
          unknownFields: ["event_time"],
        },
        usage: { inputTokens: 14, outputTokens: 7 },
      };
    },
    async embed() { throw new Error("unused synthetic embedding"); },
    async reason() { throw new Error("unused synthetic reasoning"); },
  };
  return createModelCapabilityAdapter(provider, {
    extraction: {
      provider: "synthetic-source-poll-test",
      modelVersion: "synthetic-extractor-v1",
      promptVersion: "fixture-extraction-v1",
    },
  });
}

function makeJob(overrides: Partial<FixtureJobRecord> = {}): FixtureJobRecord {
  return {
    jobId: "job-source-poll-1",
    datasetKind: "synthetic",
    jobKind: "source_poll",
    traceId: "trace-source-poll-1",
    sourceId,
    submittedUrl: null,
    status: "leased",
    leaseToken: "lease-source-poll-token",
    ...overrides,
  };
}

function makeFixture(input: {
  readonly sourceId?: string;
  readonly url?: string;
  readonly geoJson?: string;
  readonly manifests?: ReadonlyMap<string, SyntheticReportManifest>;
} = {}): SyntheticFixture {
  const fixtureSourceId = input.sourceId ?? sourceId;
  const url = input.url ?? fixtureUrl;
  const manifest = makeManifest(fixtureSourceId, url);
  return {
    url,
    geoJson: input.geoJson ?? JSON.stringify({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        id: "provider-feature-source-poll-1",
        properties: { created_at: "2026-09-29T03:59:00Z" },
        geometry: { type: "Point", coordinates: [106.8272, -6.1754] },
      }],
    }),
    retrievedAt,
    sourceId: fixtureSourceId,
    manifests: input.manifests ?? new Map([["provider-feature-source-poll-1", manifest]]),
  };
}

function makeManifest(fixtureSourceId: string, url: string): SyntheticReportManifest {
  return {
    candidateId: "candidate-source-poll-authored-1",
    reportRevisionId: "revision-source-poll-authored-1",
    sourceId: fixtureSourceId,
    canonicalUrl: url,
    contentHash: "d".repeat(64),
    permittedText,
    publishedAt: null,
    observedAt: retrievedAt,
    validFrom: null,
    validUntil: null,
    supersedesId: null,
    supportSpans: [{ spanStart: 0, spanEnd: Array.from(permittedText).length }],
  };
}
