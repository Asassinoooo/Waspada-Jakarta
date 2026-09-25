import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemorySyntheticFixtureCatalog,
  processSyntheticFixtureJob,
  type FixturePipelinePorts,
  type FixtureJobRecord,
  type SyntheticFixture,
  type SyntheticGeometryManifest,
  type SyntheticReportManifest,
} from "../src/layers/l1-data-knowledge/synthetic-fixture-pipeline.js";

const fixtureUrl = "https://synthetic.invalid/moderator/station-1";
const retrievedAt = "2026-09-25T03:00:00.000Z";
const transitionAt = "2026-09-25T03:01:00.000Z";
const permittedText = "Station entrance on Merdeka Street 🚉.";

test("resolves exact URL and persists caller-authored schema 2.0 data before completing", async () => {
  const events: string[] = [];
  const observed: { revision?: unknown; evidence: unknown[]; chunks?: unknown; geometry?: unknown } = { evidence: [] };
  const fixture = makeFixture();
  const ports = mockPorts(events, observed);

  const result = await processSyntheticFixtureJob({
    job: makeJob(),
    catalog: new InMemorySyntheticFixtureCatalog([fixture]),
    ports,
    transitionAt,
  });

  assert.deepEqual(result, {
    outcome: "completed",
    empty: false,
    reportCount: 1,
    evidenceReferenceCount: 1,
    chunkCount: 1,
    geometryCount: 1,
  });
  assert.deepEqual(events, ["source", "revision", "evidence", "chunks", "geometry", "complete"]);
  const revision = observed.revision as Record<string, unknown>;
  assert.equal(revision.datasetKind, "synthetic");
  assert.equal(revision.revisionStatus, "unreviewed");
  assert.equal(revision.traceId, "trace-fixture-job");
  assert.equal(revision.retrievedAt, retrievedAt);
  assert.equal(revision.publishedAt, "2026-09-24T10:00:00Z");
  const recordJson = revision.recordJson as Record<string, unknown>;
  assert.deepEqual(Object.keys(recordJson), [
    "schema_version", "trace_id", "record_type", "dataset_kind", "report_revision_id",
    "source_id", "canonical_url", "source_revision_key", "content_hash", "permitted_text",
    "permitted_text_hash", "normalization_version", "published_at", "observed_at",
    "retrieved_at", "validity", "supersedes_id", "revision_status",
  ]);
  assert.equal(recordJson.source_created_at, undefined);
  assert.equal(recordJson.provider_status, undefined);
  assert.equal(recordJson.report_type, undefined);
  assert.equal(recordJson.published_at, "2026-09-24T10:00:00Z");
  assert.equal(recordJson.source_revision_key, null);
  assert.equal(recordJson.observed_at, null);
  assert.equal(recordJson.retrieved_at, retrievedAt);
  assert.equal((observed.evidence[0] as { spanStart: number }).spanStart, 0);
  assert.equal((observed.geometry as { role: string }).role, "approximate_place");
  assert.deepEqual((observed.geometry as { geojson: unknown }).geojson, {
    type: "Point", coordinates: [106.8272, -6.1754],
  });
  assert.equal(events.includes("claim"), false);
});

test("fixture lookup is exact and an unknown URL fails with a redacted bounded code", async () => {
  const fixture = makeFixture();
  const catalog = new InMemorySyntheticFixtureCatalog([fixture]);
  assert.equal(catalog.lookupExact(fixtureUrl), fixture);
  assert.equal(catalog.lookupExact(`${fixtureUrl}/`), null);

  const events: string[] = [];
  const ports = mockPorts(events);
  const result = await processSyntheticFixtureJob({
    job: makeJob({ submittedUrl: `${fixtureUrl}/` }), catalog, ports, transitionAt,
  });

  assert.deepEqual(result, { outcome: "failed", code: "fixture_not_found", queueOutcome: "terminal" });
  assert.deepEqual(events, ["fail:fixture_not_found:permanent"]);
  assert.equal(JSON.stringify(result).includes(fixtureUrl), false);
});

test("accepts only an already-leased synthetic moderator submission with its lease token", async () => {
  const cases: Partial<FixtureJobRecord>[] = [
    { status: "pending" },
    { datasetKind: "live" },
    { datasetKind: "historical" },
    { jobKind: "source_poll" },
    { sourceId: "source-fixture" },
    { submittedUrl: null },
    { leaseToken: null },
    { leaseToken: "   " },
  ];
  for (const overrides of cases) {
    const events: string[] = [];
    const result = await processSyntheticFixtureJob({
      job: makeJob(overrides), catalog: new InMemorySyntheticFixtureCatalog([makeFixture()]),
      ports: mockPorts(events), transitionAt,
    });
    assert.deepEqual(result, { outcome: "not_eligible", code: "job_not_eligible" });
    assert.deepEqual(events, []);
  }
});

test("a valid empty FeatureCollection completes explicitly without writing records or all-clear state", async () => {
  const events: string[] = [];
  const fixture = makeFixture({ geoJson: '{"type":"FeatureCollection","features":[]}', manifests: new Map() });
  const result = await processSyntheticFixtureJob({
    job: makeJob(), catalog: new InMemorySyntheticFixtureCatalog([fixture]),
    ports: mockPorts(events), transitionAt,
  });

  assert.deepEqual(result, {
    outcome: "completed", empty: true, reportCount: 0, evidenceReferenceCount: 0, chunkCount: 0, geometryCount: 0,
  });
  assert.deepEqual(events, ["complete"]);
  assert.equal(JSON.stringify(result).toLowerCase().includes("clear"), false);
});

test("does not infer geometry when the parser has coordinates but the authored manifest has no mapping", async () => {
  const original = makeFixture();
  const manifest = original.manifests.get("provider-feature-17");
  assert.ok(manifest);
  const { geometry, ...withoutGeometry } = manifest;
  assert.ok(geometry);
  const fixture: SyntheticFixture = {
    ...original,
    manifests: new Map([["provider-feature-17", withoutGeometry]]),
  };
  const events: string[] = [];
  const result = await processSyntheticFixtureJob({
    job: makeJob(), catalog: new InMemorySyntheticFixtureCatalog([fixture]),
    ports: mockPorts(events), transitionAt,
  });

  assert.deepEqual(result, {
    outcome: "completed", empty: false, reportCount: 1,
    evidenceReferenceCount: 1, chunkCount: 1, geometryCount: 0,
  });
  assert.equal(events.includes("geometry"), false);
});

test("parse and catalog errors are redacted and acknowledged through the queue", async () => {
  const rawSensitive = "private fixture payload must never escape";
  const fixture = makeFixture({ geoJson: rawSensitive });
  const cases = [
    {
      catalog: new InMemorySyntheticFixtureCatalog([fixture]),
      expectedCode: "fixture_payload_invalid",
    },
    {
      catalog: { lookupExact() { throw new Error(`${fixtureUrl} ${rawSensitive}`); } },
      expectedCode: "fixture_catalog_failed",
    },
  ] as const;
  for (const item of cases) {
    const events: string[] = [];
    const result = await processSyntheticFixtureJob({
      job: makeJob(), catalog: item.catalog, ports: mockPorts(events), transitionAt,
    });
    assert.deepEqual(result, {
      outcome: "failed",
      code: item.expectedCode,
      queueOutcome: item.expectedCode === "fixture_catalog_failed" ? "retry" : "terminal",
    });
    assert.equal(JSON.stringify(result).includes(fixtureUrl), false);
    assert.equal(JSON.stringify(result).includes(rawSensitive), false);
  }
});

test("rejects manifest/geometry mappings that would infer a role or discard 3D coordinates", async () => {
  for (const overrides of [
    { geometryRole: "affected_area" as const },
    { geometryRole: "approximate_place" as const, position: [106.8, -6.1, 19] },
  ]) {
    const events: string[] = [];
    const fixture = makeFixture({ geometryRole: overrides.geometryRole, position: overrides.position });
    const result = await processSyntheticFixtureJob({
      job: makeJob(), catalog: new InMemorySyntheticFixtureCatalog([fixture]),
      ports: mockPorts(events), transitionAt,
    });
    assert.deepEqual(result, { outcome: "failed", code: "fixture_manifest_invalid", queueOutcome: "terminal" });
    assert.equal(events.some((event) => event === "geometry"), false);
  }
});

test("fails persistence with a stable retryable code and does not acknowledge completion", async () => {
  const events: string[] = [];
  const ports = mockPorts(events);
  ports.evidenceChunks.persist = async () => {
    events.push("chunks");
    throw new Error(`${fixtureUrl} contains sensitive text`);
  };
  const result = await processSyntheticFixtureJob({
    job: makeJob(), catalog: new InMemorySyntheticFixtureCatalog([makeFixture()]), ports, transitionAt,
  });

  assert.deepEqual(result, { outcome: "failed", code: "fixture_persistence_failed", queueOutcome: "retry" });
  assert.deepEqual(events, ["source", "revision", "evidence", "chunks", "fail:fixture_persistence_failed:retryable"]);
  assert.equal(JSON.stringify(result).includes(fixtureUrl), false);
});

test("does not overwrite a stale lease when completion is no longer owned", async () => {
  const events: string[] = [];
  const ports = mockPorts(events);
  ports.acquisitionJobs.complete = async () => {
    events.push("complete");
    return { outcome: "not_owned" };
  };
  const result = await processSyntheticFixtureJob({
    job: makeJob(), catalog: new InMemorySyntheticFixtureCatalog([makeFixture()]), ports, transitionAt,
  });

  assert.deepEqual(result, { outcome: "lost_lease", code: "lease_not_owned" });
  assert.equal(events.at(-1), "complete");
  assert.equal(events.some((event) => event.startsWith("fail:")), false);
});

test("does not issue a fail transition after an uncertain completion acknowledgement", async () => {
  const events: string[] = [];
  const ports = mockPorts(events);
  ports.acquisitionJobs.complete = async () => {
    events.push("complete");
    throw new Error(`${fixtureUrl} uncertain acknowledgement`);
  };
  const result = await processSyntheticFixtureJob({
    job: makeJob(), catalog: new InMemorySyntheticFixtureCatalog([makeFixture()]), ports, transitionAt,
  });

  assert.deepEqual(result, {
    outcome: "failed", code: "queue_acknowledgement_failed", queueOutcome: "not_acknowledged",
  });
  assert.equal(events.at(-1), "complete");
  assert.equal(events.some((event) => event.startsWith("fail:")), false);
  assert.equal(JSON.stringify(result).includes(fixtureUrl), false);
});

function makeJob(overrides: Partial<FixtureJobRecord> = {}): FixtureJobRecord {
  return {
    jobId: "job-fixture-1",
    datasetKind: "synthetic",
    jobKind: "moderator_submission",
    traceId: "trace-fixture-job",
    sourceId: null,
    submittedUrl: fixtureUrl,
    status: "leased",
    leaseToken: "lease-fixture-token",
    ...overrides,
  };
}

function makeFixture(input: {
  readonly geoJson?: string;
  readonly manifests?: ReadonlyMap<string | number, SyntheticReportManifest>;
  readonly geometryRole?: SyntheticGeometryManifest["role"];
  readonly position?: readonly number[];
} = {}): SyntheticFixture {
  const geometry = input.position ?? [106.8272, -6.1754];
  const geoJson = input.geoJson ?? JSON.stringify({
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      id: "provider-feature-17",
      properties: { status: "ignored", report_type: "ignored", created_at: "2024-01-02T03:04:05Z" },
      geometry: { type: "Point", coordinates: geometry },
    }],
  });
  const end = Array.from(permittedText).length;
  const manifest: SyntheticReportManifest = {
    reportRevisionId: "revision-authored-stable-1",
    sourceId: "source-fixture-manual",
    canonicalUrl: fixtureUrl,
    contentHash: "a".repeat(64),
    permittedText,
    publishedAt: "2026-09-24T10:00:00Z",
    observedAt: null,
    validFrom: null,
    validUntil: null,
    supersedesId: null,
    supportSpans: [{ spanStart: 0, spanEnd: end }],
    geometry: {
      geometryId: "geometry-authored-stable-1",
      role: input.geometryRole ?? "approximate_place",
      precisionM: null,
      precisionBasis: "moderator_generalization",
      displayLabel: "Synthetic station",
      supportSpans: [{ spanStart: 0, spanEnd: end }],
    },
  };
  return {
    url: fixtureUrl,
    geoJson,
    retrievedAt,
    sourceId: "source-fixture-manual",
    manifests: input.manifests ?? new Map([["provider-feature-17", manifest]]),
  };
}

function mockPorts(
  events: string[],
  observed: { revision?: unknown; evidence: unknown[]; chunks?: unknown; geometry?: unknown } = { evidence: [] },
): FixturePipelinePorts {
  return {
    acquisitionJobs: {
      async complete() {
        events.push("complete");
        return { outcome: "updated" };
      },
      async fail(_dataset, _jobId, _leaseToken, failure) {
        events.push(`fail:${failure.failureCode}:${failure.disposition}`);
        return { outcome: "updated", job: { status: failure.disposition === "permanent" ? "terminal" : "retry" } };
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
      async create(input) {
        events.push("revision");
        observed.revision = input;
      },
      async createEvidenceReference(input) {
        events.push("evidence");
        observed.evidence.push(input);
        return "evidence-1";
      },
    },
    evidenceChunks: {
      async persist(input) {
        events.push("chunks");
        observed.chunks = input;
      },
    },
    geometryWriter: {
      async persist(input) {
        events.push("geometry");
        observed.geometry = input;
      },
    },
  };
}
