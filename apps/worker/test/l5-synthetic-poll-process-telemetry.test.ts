import assert from "node:assert/strict";
import test from "node:test";
import {
  consoleTelemetry,
  isSyntheticSourcePollProcessTelemetryRecord,
  SYNTHETIC_SOURCE_POLL_PROCESS_EVENT_NAME,
  type SyntheticSourcePollProcessTelemetryRecord,
  type TelemetryRecord,
} from "../src/layers/l5-evaluation-monitoring/telemetry.js";

function captureConsoleLogs(run: () => void): unknown[] {
  const logs: unknown[] = [];
  const originalLog = console.log;
  console.log = ((...args: unknown[]) => { logs.push(args[0]); }) as typeof console.log;
  try {
    run();
  } finally {
    console.log = originalLog;
  }
  return logs;
}

test("console telemetry serializes all fixed processor outcomes and completed-only counts", () => {
  const records: SyntheticSourcePollProcessTelemetryRecord[] = [
    { eventName: SYNTHETIC_SOURCE_POLL_PROCESS_EVENT_NAME, outcome: "idle", durationMs: 0 },
    { eventName: SYNTHETIC_SOURCE_POLL_PROCESS_EVENT_NAME, outcome: "not_eligible", durationMs: 1.5 },
    { eventName: SYNTHETIC_SOURCE_POLL_PROCESS_EVENT_NAME, outcome: "lost_lease", durationMs: 2 },
    {
      eventName: SYNTHETIC_SOURCE_POLL_PROCESS_EVENT_NAME,
      outcome: "completed",
      durationMs: 3.25,
      empty: false,
      reportCount: 2,
      evidenceReferenceCount: 3,
      chunkCount: 4,
      geometryCount: 1,
    },
    { eventName: SYNTHETIC_SOURCE_POLL_PROCESS_EVENT_NAME, outcome: "failed", durationMs: 4 },
    {
      eventName: SYNTHETIC_SOURCE_POLL_PROCESS_EVENT_NAME,
      outcome: "completed",
      durationMs: 5,
      empty: true,
      reportCount: 0,
      evidenceReferenceCount: 0,
      chunkCount: 0,
      geometryCount: 0,
    },
  ];

  const logs = captureConsoleLogs(() => {
    for (const record of records) consoleTelemetry.record(record);
  });

  for (const record of records) assert.equal(isSyntheticSourcePollProcessTelemetryRecord(record), true);
  assert.deepEqual(logs, [
    {
      event_name: SYNTHETIC_SOURCE_POLL_PROCESS_EVENT_NAME,
      outcome: "idle",
      duration_ms: 0,
    },
    {
      event_name: SYNTHETIC_SOURCE_POLL_PROCESS_EVENT_NAME,
      outcome: "not_eligible",
      duration_ms: 1.5,
    },
    {
      event_name: SYNTHETIC_SOURCE_POLL_PROCESS_EVENT_NAME,
      outcome: "lost_lease",
      duration_ms: 2,
    },
    {
      event_name: SYNTHETIC_SOURCE_POLL_PROCESS_EVENT_NAME,
      outcome: "completed",
      duration_ms: 3.25,
      empty: false,
      report_count: 2,
      evidence_reference_count: 3,
      chunk_count: 4,
      geometry_count: 1,
    },
    {
      event_name: SYNTHETIC_SOURCE_POLL_PROCESS_EVENT_NAME,
      outcome: "failed",
      duration_ms: 4,
    },
    {
      event_name: SYNTHETIC_SOURCE_POLL_PROCESS_EVENT_NAME,
      outcome: "completed",
      duration_ms: 5,
      empty: true,
      report_count: 0,
      evidence_reference_count: 0,
      chunk_count: 0,
      geometry_count: 0,
    },
  ]);

  for (const [index, record] of logs.entries()) {
    assert.equal(typeof record, "object");
    const serialized = record as Record<string, unknown>;
    assert.equal(serialized.event_name, SYNTHETIC_SOURCE_POLL_PROCESS_EVENT_NAME);
    assert.ok(Number.isFinite(serialized.duration_ms));
    assert.ok((serialized.duration_ms as number) >= 0);
    assert.equal(Object.keys(serialized).includes("outcome"), true);
    if (index === 3 || index === 5) {
      assert.deepEqual(Object.keys(serialized).sort(), [
        "chunk_count",
        "duration_ms",
        "empty",
        "event_name",
        "evidence_reference_count",
        "geometry_count",
        "outcome",
        "report_count",
      ]);
    } else {
      assert.deepEqual(Object.keys(serialized).sort(), ["duration_ms", "event_name", "outcome"]);
    }
  }
});

test("console telemetry rejects malformed, unbounded, and forged records without leaking markers", () => {
  const marker = "source-id-secret report-text-secret https://private.example.invalid";
  const invalidRecords: unknown[] = [
    {
      eventName: SYNTHETIC_SOURCE_POLL_PROCESS_EVENT_NAME,
      outcome: "provider_error",
      durationMs: 1,
    },
    {
      eventName: SYNTHETIC_SOURCE_POLL_PROCESS_EVENT_NAME,
      outcome: "idle",
      durationMs: Number.NaN,
    },
    {
      eventName: SYNTHETIC_SOURCE_POLL_PROCESS_EVENT_NAME,
      outcome: "failed",
      durationMs: -1,
      queueOutcome: "retry",
    },
    {
      eventName: SYNTHETIC_SOURCE_POLL_PROCESS_EVENT_NAME,
      outcome: "completed",
      durationMs: 1,
      empty: false,
      reportCount: 501,
      evidenceReferenceCount: 0,
      chunkCount: 0,
      geometryCount: 0,
    },
    {
      eventName: SYNTHETIC_SOURCE_POLL_PROCESS_EVENT_NAME,
      outcome: "completed",
      durationMs: 1,
      empty: false,
      reportCount: 1.5,
      evidenceReferenceCount: 0,
      chunkCount: 0,
      geometryCount: 0,
    },
    {
      eventName: SYNTHETIC_SOURCE_POLL_PROCESS_EVENT_NAME,
      outcome: "completed",
      durationMs: 1,
      empty: false,
      reportCount: 1,
      evidenceReferenceCount: 1_000_001,
      chunkCount: 0,
      geometryCount: 0,
    },
    {
      eventName: SYNTHETIC_SOURCE_POLL_PROCESS_EVENT_NAME,
      outcome: "completed",
      durationMs: 1,
      empty: false,
      reportCount: 1,
      evidenceReferenceCount: 0,
      chunkCount: 1_025,
      geometryCount: 0,
    },
    {
      eventName: SYNTHETIC_SOURCE_POLL_PROCESS_EVENT_NAME,
      outcome: "completed",
      durationMs: 1,
      empty: false,
      reportCount: 1,
      evidenceReferenceCount: 0,
      chunkCount: 0,
      geometryCount: 2,
    },
    {
      eventName: SYNTHETIC_SOURCE_POLL_PROCESS_EVENT_NAME,
      outcome: "completed",
      durationMs: 1,
      empty: true,
      reportCount: 1,
      evidenceReferenceCount: 0,
      chunkCount: 0,
      geometryCount: 0,
    },
    {
      eventName: SYNTHETIC_SOURCE_POLL_PROCESS_EVENT_NAME,
      outcome: "completed",
      durationMs: 1,
      empty: false,
      reportCount: 1,
      evidenceReferenceCount: 0,
      chunkCount: 0,
      geometryCount: 0,
      sourceId: marker,
      fixtureText: marker,
      candidateId: marker,
    },
  ];
  const symbolForgery = {
    eventName: SYNTHETIC_SOURCE_POLL_PROCESS_EVENT_NAME,
    outcome: "idle",
    durationMs: 1,
  };
  Object.defineProperty(symbolForgery, Symbol("private_marker"), { value: marker, enumerable: true });
  const hiddenForgery = {
    eventName: SYNTHETIC_SOURCE_POLL_PROCESS_EVENT_NAME,
    outcome: "idle",
    durationMs: 1,
  };
  Object.defineProperty(hiddenForgery, "sourceId", { value: marker, enumerable: false });
  invalidRecords.push(symbolForgery, hiddenForgery);

  const logs = captureConsoleLogs(() => {
    for (const record of invalidRecords) consoleTelemetry.record(record as TelemetryRecord);
  });

  for (const record of invalidRecords) assert.equal(isSyntheticSourcePollProcessTelemetryRecord(record), false);
  assert.deepEqual(logs, []);
  assert.doesNotMatch(JSON.stringify(logs), /source-id-secret|report-text-secret|private\.example/u);
});
