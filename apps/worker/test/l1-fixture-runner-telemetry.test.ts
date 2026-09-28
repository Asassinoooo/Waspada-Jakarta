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
import {
  L1_SYNTHETIC_FIXTURE_JOB_EVENT_NAME,
  consoleTelemetry,
  type TelemetryRecord,
  type TelemetrySink,
} from "../src/layers/l5-evaluation-monitoring/telemetry.js";
import { createModelCapabilityAdapter } from "../src/layers/l2-model-grounding/adapter.js";
import type {
  ExtractionRequest,
  UntrustedModelProvider,
} from "../src/layers/l2-model-grounding/contracts.js";

const fixtureUrl = "https://private-fixture.invalid/source/private-id";
const fixtureText = "PRIVATE_FIXTURE_TEXT marker near a synthetic station entrance.";
const timestamp = "2026-09-28T04:05:06.000Z";
const privacyMarker = "PRIVATE_RAW_EXCEPTION_payload_job_id_source_id_provider_timestamp";

test("records one bounded completed summary with counts and no fixture details", async () => {
  const records: TelemetryRecord[] = [];
  const events: string[] = [];
  const result = await runSyntheticFixtureJob(makeInput({
    events,
    telemetry: recordingSink(records),
  }));

  assert.deepEqual(result, {
    outcome: "completed",
    empty: false,
    reportCount: 1,
    evidenceReferenceCount: 5,
    chunkCount: 1,
    geometryCount: 0,
  });
  assert.deepEqual(events.slice(-1), [`complete:${timestamp}`]);
  assertOneRecord(records, "completed");
  assert.deepEqual(records[0], {
    eventName: L1_SYNTHETIC_FIXTURE_JOB_EVENT_NAME,
    outcome: "completed",
    durationMs: records[0]!.durationMs,
    empty: false,
    reportCount: 1,
    evidenceReferenceCount: 5,
    chunkCount: 1,
    geometryCount: 0,
  });
  assertPrivacySafe(records);
});

test("records empty completion with zero counts and does not imply all-clear", async () => {
  const records: TelemetryRecord[] = [];
  const events: string[] = [];
  const result = await runSyntheticFixtureJob(makeInput({
    events,
    fixture: makeFixture({ empty: true }),
    telemetry: recordingSink(records),
  }));

  assert.deepEqual(result, {
    outcome: "completed",
    empty: true,
    reportCount: 0,
    evidenceReferenceCount: 0,
    chunkCount: 0,
    geometryCount: 0,
  });
  assertOneRecord(records, "completed");
  if (records[0]!.eventName !== L1_SYNTHETIC_FIXTURE_JOB_EVENT_NAME || records[0]!.outcome !== "completed") {
    assert.fail("expected completed fixture telemetry");
  }
  assert.equal(records[0]!.empty, true);
  assert.equal(records[0]!.reportCount, 0);
  assert.equal(records[0]!.evidenceReferenceCount, 0);
  assert.equal(records[0]!.chunkCount, 0);
  assert.equal(records[0]!.geometryCount, 0);
});

test("records idle after a single empty queue claim", async () => {
  const records: TelemetryRecord[] = [];
  const events: string[] = [];
  const result = await runSyntheticFixtureJob(makeInput({
    events,
    job: null,
    telemetry: recordingSink(records),
  }));

  assert.deepEqual(result, { outcome: "idle" });
  assert.deepEqual(events, ["claim"]);
  assertOneRecord(records, "idle");
  assert.deepEqual(Object.keys(records[0]!).sort(), ["durationMs", "eventName", "outcome"]);
});

test("records not-eligible without completion counts", async () => {
  const records: TelemetryRecord[] = [];
  const events: string[] = [];
  const result = await runSyntheticFixtureJob(makeInput({
    events,
    job: makeJob({ datasetKind: "live", jobKind: "source_poll" }),
    telemetry: recordingSink(records),
  }));

  assert.deepEqual(result, { outcome: "not_eligible", code: "job_not_eligible" });
  assert.deepEqual(events, ["claim"]);
  assertOneRecord(records, "not_eligible");
  assert.deepEqual(Object.keys(records[0]!).sort(), ["durationMs", "eventName", "outcome"]);
});

test("records lost-lease while preserving the one completion transition", async () => {
  const records: TelemetryRecord[] = [];
  const events: string[] = [];
  const result = await runSyntheticFixtureJob(makeInput({
    events,
    completeOutcome: "not_owned",
    telemetry: recordingSink(records),
  }));

  assert.deepEqual(result, { outcome: "lost_lease", code: "lease_not_owned" });
  assert.equal(events.filter((event) => event.startsWith("complete:")).length, 1);
  assert.equal(events.some((event) => event.startsWith("fail:")), false);
  assertOneRecord(records, "lost_lease");
  assert.deepEqual(Object.keys(records[0]!).sort(), ["durationMs", "eventName", "outcome"]);
});

test("records failed without exception details and preserves the retry transition", async () => {
  const records: TelemetryRecord[] = [];
  const events: string[] = [];
  const result = await runSyntheticFixtureJob(makeInput({
    events,
    failRevisionWith: new Error(`${privacyMarker} ${fixtureUrl} ${fixtureText}`),
    telemetry: recordingSink(records),
  }));

  assert.deepEqual(result, {
    outcome: "failed",
    code: "fixture_persistence_failed",
    queueOutcome: "retry",
  });
  assert.deepEqual(events, ["claim", "source", "revision", "fail:fixture_persistence_failed:retryable"]);
  assertOneRecord(records, "failed");
  assert.deepEqual(Object.keys(records[0]!).sort(), ["durationMs", "eventName", "outcome"]);
  assertPrivacySafe(records);
  assert.equal(JSON.stringify(result).includes(privacyMarker), false);
});

test("a throwing sink cannot change completed or failed results and queue transitions", async () => {
  const completedRecords: TelemetryRecord[] = [];
  const completedEvents: string[] = [];
  const completed = await runSyntheticFixtureJob(makeInput({
    events: completedEvents,
    telemetry: recordingSink(completedRecords, true),
  }));

  assert.deepEqual(completed, {
    outcome: "completed",
    empty: false,
    reportCount: 1,
    evidenceReferenceCount: 5,
    chunkCount: 1,
    geometryCount: 0,
  });
  assert.equal(completedEvents.at(-1), `complete:${timestamp}`);
  assertOneRecord(completedRecords, "completed");

  const failedRecords: TelemetryRecord[] = [];
  const failedEvents: string[] = [];
  const failed = await runSyntheticFixtureJob(makeInput({
    events: failedEvents,
    failRevisionWith: new Error(privacyMarker),
    telemetry: recordingSink(failedRecords, true),
  }));

  assert.deepEqual(failed, {
    outcome: "failed",
    code: "fixture_persistence_failed",
    queueOutcome: "retry",
  });
  assert.deepEqual(failedEvents, ["claim", "source", "revision", "fail:fixture_persistence_failed:retryable"]);
  assertOneRecord(failedRecords, "failed");
  assertPrivacySafe(failedRecords);
});

test("defaults to no-op telemetry", async () => {
  const originalLog = console.log;
  const output: unknown[] = [];
  console.log = ((...values: unknown[]) => output.push(...values)) as typeof console.log;
  try {
    const result = await runSyntheticFixtureJob(makeInput({ job: null }));
    assert.deepEqual(result, { outcome: "idle" });
    assert.deepEqual(output, []);
  } finally {
    console.log = originalLog;
  }
});

test("ignores an invalid injected sink after completing the queue transition", async () => {
  const events: string[] = [];
  const result = await runSyntheticFixtureJob(makeInput({
    events,
    telemetry: { record: "invalid" } as unknown as TelemetrySink,
  }));

  assert.deepEqual(result, {
    outcome: "completed",
    empty: false,
    reportCount: 1,
    evidenceReferenceCount: 5,
    chunkCount: 1,
    geometryCount: 0,
  });
  assert.equal(events.at(-1), `complete:${timestamp}`);
});

test("console telemetry drops forged fields and rejects invalid fixture records", () => {
  const originalLog = console.log;
  const output: unknown[] = [];
  console.log = ((...values: unknown[]) => output.push(...values)) as typeof console.log;
  try {
    const forged = {
      eventName: L1_SYNTHETIC_FIXTURE_JOB_EVENT_NAME,
      outcome: "completed",
      durationMs: 12.5,
      empty: false,
      reportCount: 1,
      evidenceReferenceCount: 5,
      chunkCount: 1,
      geometryCount: 0,
      traceId: privacyMarker,
      jobId: privacyMarker,
      sourceId: privacyMarker,
      revisionId: privacyMarker,
      sourceUrl: fixtureUrl,
      rawPayload: fixtureText,
      timestamp,
      provider: privacyMarker,
      exception: privacyMarker,
      failureCode: privacyMarker,
      queueOutcome: "terminal",
    };
    consoleTelemetry.record(forged as unknown as TelemetryRecord);
    consoleTelemetry.record({
      ...forged,
      reportCount: -1,
    } as unknown as TelemetryRecord);
    consoleTelemetry.record({
      ...forged,
      durationMs: Number.POSITIVE_INFINITY,
    } as unknown as TelemetryRecord);
    consoleTelemetry.record({
      ...forged,
      evidenceReferenceCount: 1_000_001,
    } as unknown as TelemetryRecord);
    consoleTelemetry.record({
      ...forged,
      reportCount: 501,
    } as unknown as TelemetryRecord);
    consoleTelemetry.record({
      ...forged,
      chunkCount: 1_025,
    } as unknown as TelemetryRecord);
    consoleTelemetry.record({
      ...forged,
      outcome: "unexpected",
    } as unknown as TelemetryRecord);
    consoleTelemetry.record({
      ...forged,
      outcome: "idle",
      empty: false,
      reportCount: 1,
    } as unknown as TelemetryRecord);
    consoleTelemetry.record({
      eventName: L1_SYNTHETIC_FIXTURE_JOB_EVENT_NAME,
      outcome: "idle",
      durationMs: 1,
      traceId: privacyMarker,
      failureCode: privacyMarker,
      queueOutcome: "retry",
    } as unknown as TelemetryRecord);

    assert.equal(output.length, 2);
    const structured = output[0] as Record<string, unknown>;
    assert.deepEqual(Object.keys(structured).sort(), [
      "chunk_count",
      "duration_ms",
      "empty",
      "event_name",
      "evidence_reference_count",
      "geometry_count",
      "outcome",
      "report_count",
    ]);
    assert.equal(JSON.stringify(output).includes(privacyMarker), false);
    assert.equal(JSON.stringify(output).includes(fixtureUrl), false);
    assert.equal(JSON.stringify(output).includes(fixtureText), false);
    assert.deepEqual(structured, {
      event_name: L1_SYNTHETIC_FIXTURE_JOB_EVENT_NAME,
      outcome: "completed",
      duration_ms: 12.5,
      empty: false,
      report_count: 1,
      evidence_reference_count: 5,
      chunk_count: 1,
      geometry_count: 0,
    });
    const idleStructured = output[1] as Record<string, unknown>;
    assert.deepEqual(Object.keys(idleStructured).sort(), ["duration_ms", "event_name", "outcome"]);
    assert.deepEqual(idleStructured, {
      event_name: L1_SYNTHETIC_FIXTURE_JOB_EVENT_NAME,
      outcome: "idle",
      duration_ms: 1,
    });
  } finally {
    console.log = originalLog;
  }
});

function assertOneRecord(records: TelemetryRecord[], outcome: string): void {
  assert.equal(records.length, 1);
  const record = records[0]!;
  assert.equal(record.eventName, L1_SYNTHETIC_FIXTURE_JOB_EVENT_NAME);
  assert.equal(record.outcome, outcome);
  assert.ok(Number.isFinite(record.durationMs));
  assert.ok(record.durationMs >= 0);
}

function assertPrivacySafe(records: TelemetryRecord[]): void {
  const serialized = JSON.stringify(records);
  for (const marker of [
    fixtureUrl,
    fixtureText,
    privacyMarker,
    "job-private-id",
    "candidate-private-id",
    "source-private-id",
    "revision-private-id",
    "model-provider-private",
    timestamp,
  ]) {
    assert.equal(serialized.includes(marker), false, `telemetry included ${marker}`);
  }
}

function recordingSink(records: TelemetryRecord[], throws = false): TelemetrySink {
  return {
    record(record) {
      records.push(record);
      if (throws) throw new Error(privacyMarker);
    },
  };
}

interface InputOptions {
  readonly events?: string[];
  readonly job?: FixtureJobRecord | null;
  readonly fixture?: SyntheticFixture;
  readonly telemetry?: TelemetrySink;
  readonly completeOutcome?: "updated" | "not_owned";
  readonly failRevisionWith?: Error;
}

function makeInput(options: InputOptions = {}) {
  const events = options.events ?? [];
  const job = options.job === undefined ? makeJob() : options.job;
  return {
    now: timestamp,
    queue: queueWith(job, events),
    catalog: new InMemorySyntheticFixtureCatalog([options.fixture ?? makeFixture()]),
    pipelinePorts: makePipelinePorts(events, options),
    ...(options.telemetry ? { telemetry: options.telemetry } : {}),
  };
}

function queueWith(job: FixtureJobRecord | null, events: string[]): SyntheticFixtureClaimPort {
  return {
    async claimDueSyntheticModeratorSubmission() {
      events.push("claim");
      return job;
    },
  };
}

function makePipelinePorts(events: string[], options: InputOptions): FixturePipelinePorts {
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
    modelAdapter: createRunnerModelAdapter(events),
    reportRevisions: {
      async create() {
        events.push("revision");
        if (options.failRevisionWith) throw options.failRevisionWith;
      },
      async createEvidenceReference() {
        events.push("evidence");
        return "evidence-private-id";
      },
    },
    extractionResults: {
      async createOrVerify(record) {
        events.push("extraction");
        return record;
      },
      async findByCandidateId() { return { outcome: "not_found" }; },
    },
    evidenceChunks: {
      async persist() { events.push("chunks"); },
    },
    geometryWriter: {
      async persist() { events.push("geometry"); },
    },
  };
}

function makeJob(overrides: Partial<FixtureJobRecord> = {}): FixtureJobRecord {
  return {
    jobId: "job-private-id",
    datasetKind: "synthetic",
    jobKind: "moderator_submission",
    traceId: "trace-private-id",
    sourceId: null,
    submittedUrl: fixtureUrl,
    status: "leased",
    leaseToken: "lease-private-id",
    ...overrides,
  };
}

function makeFixture(options: { readonly empty?: boolean } = {}): SyntheticFixture {
  const manifest: SyntheticReportManifest = {
    candidateId: "candidate-private-id",
    reportRevisionId: "revision-private-id",
    sourceId: "source-private-id",
    canonicalUrl: fixtureUrl,
    contentHash: "c".repeat(64),
    permittedText: fixtureText,
    publishedAt: null,
    observedAt: null,
    validFrom: null,
    validUntil: null,
    supersedesId: null,
    supportSpans: [{ spanStart: 0, spanEnd: Array.from(fixtureText).length }],
  };
  return {
    url: fixtureUrl,
    geoJson: JSON.stringify({
      type: "FeatureCollection",
      features: options.empty ? [] : [{
        type: "Feature",
        id: "feature-private-id",
        properties: {},
        geometry: null,
      }],
    }),
    retrievedAt: timestamp,
    sourceId: "source-private-id",
    manifests: new Map(options.empty ? [] : [["feature-private-id", manifest]]),
  };
}

function createRunnerModelAdapter(events: string[]) {
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
            spanStart: index * 2,
            spanEnd: index * 2 + 1,
            offsetUnit: "unicode_code_points",
            relation,
          })),
          unknownFields: ["event_time"],
        },
        usage: { inputTokens: 10, outputTokens: 6 },
      };
    },
    async embed() { throw new Error("unused synthetic embedding"); },
    async reason() { throw new Error("unused synthetic reasoning"); },
  };
  return createModelCapabilityAdapter(provider, {
    extraction: {
      provider: "model-provider-private",
      modelVersion: "private-model-version",
      promptVersion: "private-prompt-version",
    },
  });
}
