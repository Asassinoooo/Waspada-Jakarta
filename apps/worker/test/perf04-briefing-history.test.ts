import assert from "node:assert/strict";
import test from "node:test";
import { createPublicBriefingCandidateRepository } from "../../db/src/public-briefing-candidates.js";
import { createPublicEventHistoryDisclosureRepository } from "../../db/src/public-event-history-disclosure.js";
import { createPublicEventHistoryRepository } from "../../db/src/public-event-history.js";
import { createPublicEventSnapshotRepository } from "../../db/src/public-event-snapshot.js";
import { createPublicProjectionLookupRepository } from "../../db/src/public-projection-lookups.js";
import type { SqlExecutor } from "../../db/src/sql.js";
import type { BriefingRequest, BriefingResponse, EventView } from "../src/contracts/public-api.js";
import { projectPublicBriefing } from "../src/layers/l4-application-integration/public-briefing-projection.js";
import { createPublicEventHistoryProjectionService } from "../src/layers/l4-application-integration/public-event-history-projection-service.js";
import { createPublicEventProjectionService } from "../src/layers/l4-application-integration/public-event-projection-service.js";
import {
  createPublicBriefingRuntime,
  PublicBriefingRuntimeError,
  type PublicBriefingSqlExecutorRunner,
} from "../src/runtime/public-briefing-runtime.js";
import {
  createPublicEventHistoryRuntime,
  type PublicEventHistorySqlExecutorRunner,
} from "../src/runtime/public-event-history-runtime.js";
import { PUBLIC_READ_MEMO_LIMITS } from "../src/runtime/public-read-memo.js";

/**
 * PERF-04 (23 Nov 2026): the briefing reads every candidate with one batch of snapshot and lookup statements, and the
 * briefing and history routes answer a repeated request from a small in-isolate memo. Every row below is an authored
 * fictional fixture. The database is a fake executor that answers the production statements by shape, so no network
 * or PGlite instance is used. The pre-PERF-04 briefing shape (one read per candidate) is rebuilt in this file as the
 * reference, and the batch output must equal it byte for byte.
 */

const testConnectionString = "postgresql://test-user:test-password@hyperdrive.example.invalid/waspada?sslmode=require";
const clockStart = Date.parse("2026-11-23T03:00:00.000Z");
const generatedAt = "2026-11-23T03:00:00.000Z";
const BEGIN = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY";
const AUTOMATIC_REVIEWER_ID = "agent:auto-publisher";

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

function hashFor(index: number): string {
  return index.toString(16).padStart(64, "0");
}

// ---------------------------------------------------------------------------------------------------------------------
// Briefing fixtures: candidates, exact snapshots, impacts, scope names and source attributions.
// ---------------------------------------------------------------------------------------------------------------------

interface BriefingEventFixture {
  readonly eventId: string;
  readonly version: number;
  readonly candidateRow: Record<string, unknown>;
  readonly snapshotRow: Record<string, unknown>;
  readonly impactRows: readonly Record<string, unknown>[];
}

/** Event i is published at minute i, so the candidate order (newest first) is the reverse of the index order. */
function briefingFixture(index: number): BriefingEventFixture {
  const eventId = `event-perf04-${pad(index)}`;
  const version = 3;
  const hasImpact = index % 3 === 0;
  const hasLabel = index === 1;
  const impactId = `impact-perf04-${pad(index)}`;
  const claimId = `claim-perf04-${pad(index)}`;
  const firstPublishedAt = `2026-09-20T00:${pad(index)}:00.000000Z`;
  const category = index % 2 === 0 ? "crime_personal_security" : "transport_road_incidents";
  const place = `place-perf04-${pad(index % 4)}`;
  const scope = {
    place_ids: hasLabel ? [] : [place],
    service_ids: [],
    institution_ids: [],
    audience_ids: [],
    geometry_ids: [],
  };
  const eventRecord: Record<string, unknown> = {
    schema_version: "2.0",
    trace_id: `trace-perf04-private-${pad(index)}`,
    record_type: "Event",
    dataset_kind: "live",
    event_id: eventId,
    version,
    supersedes_version: version - 1,
    title: `Pemberitahuan fiktif PERF-04 ${pad(index)}`,
    summary: "Keterangan fiktif untuk pengujian PERF-04.",
    category,
    tags: [],
    lifecycle: "ongoing",
    freshness: {
      status: "current",
      evaluated_at: "2026-11-23T02:55:00Z",
      review_due_at: null,
      basis: "manual_review",
    },
    event_time: { start: "2026-11-22", end: null, precision: "date" },
    validity: { valid_from: null, valid_until: null },
    scope,
    claims: [{
      claim_id: claimId,
      text: "Klaim fiktif PERF-04 yang didukung sumber uji.",
      event_time: { start: null, end: null, precision: "unknown" },
      validity: { valid_from: null, valid_until: null },
      scope,
      qualifiers: [],
      support: [{
        report_revision_id: `revision-perf04-${pad(index)}`,
        permitted_text_hash: hashFor(index),
        span_start: 1,
        span_end: 20,
        offset_unit: "unicode_code_points",
        relation: "supports",
      }],
      contradictions: [],
      context_evidence: [],
      origin_ids: [`origin-perf04-private-${pad(index)}`],
      evidence_label: "attributed_report",
    }],
    impact_refs: hasImpact ? [{ impact_id: impactId, version: 2 }] : [],
    publication_status: "published",
    withdrawal_reason: null,
    publication_decision_id: `decision-perf04-private-${pad(index)}`,
    published_at: `2026-09-20T00:${pad(index)}:00Z`,
    withdrawn_at: null,
  };
  const impactRows = hasImpact
    ? [{
      dataset_kind: "live",
      event_id: eventId,
      event_version: version,
      impact_id: impactId,
      impact_version: 2,
      record_json: {
        schema_version: "2.0",
        trace_id: `trace-impact-perf04-private-${pad(index)}`,
        record_type: "Impact",
        dataset_kind: "live",
        impact_id: impactId,
        version: 2,
        event_id: eventId,
        event_version: version,
        impact_type: "facility_closure",
        title: `Dampak fiktif PERF-04 ${pad(index)}`,
        description: "Dampak fiktif untuk pengujian PERF-04.",
        lifecycle: "ongoing",
        freshness: {
          status: "needs_update",
          evaluated_at: "2026-11-23T02:56:00Z",
          review_due_at: null,
          basis: "unknown",
        },
        event_time: { start: null, end: null, precision: "unknown" },
        validity: { valid_from: null, valid_until: null },
        scope: {
          place_ids: [],
          service_ids: [],
          institution_ids: [`institution-perf04-${pad(index)}`],
          audience_ids: [],
          geometry_ids: [],
        },
        supporting_claim_ids: [claimId],
        published_at: "2026-11-23T02:56:00Z",
      },
    }]
    : [];
  return {
    eventId,
    version,
    candidateRow: {
      dataset_kind: "live",
      event_id: eventId,
      version,
      first_published_at: firstPublishedAt,
    },
    snapshotRow: {
      dataset_kind: "live",
      event_id: eventId,
      version,
      record_json: eventRecord,
      location_label_present: hasLabel,
      location_label: hasLabel ? "Menteng, Jakarta Pusat" : null,
    },
    impactRows,
  };
}

function briefingFixtures(count: number): BriefingEventFixture[] {
  return Array.from({ length: count }, (_, index) => briefingFixture(index));
}

/** Candidates are the closed reader's output: newest first, then event identifier order. */
function candidateRowsFor(fixtures: readonly BriefingEventFixture[]): Record<string, unknown>[] {
  return fixtures
    .map((fixture) => fixture.candidateRow)
    .sort((left, right) => String(right.first_published_at).localeCompare(String(left.first_published_at)));
}

interface BriefingFakeState {
  readonly statements: string[];
  operations: number;
  readonly events: ReadonlyMap<string, BriefingEventFixture>;
  readonly candidateRows: readonly Record<string, unknown>[];
  failCandidateReads: number;
}

function briefingState(count: number): BriefingFakeState {
  const fixtures = briefingFixtures(count);
  return {
    statements: [],
    operations: 0,
    events: new Map(fixtures.map((fixture) => [fixture.eventId, fixture])),
    candidateRows: candidateRowsFor(fixtures),
    failCandidateReads: 0,
  };
}

function identifiersOf(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

function briefingRows(state: BriefingFakeState, statement: string, parameters: readonly unknown[]): object[] {
  if (statement === BEGIN || statement === "COMMIT" || statement === "ROLLBACK") return [];
  if (statement.includes("WITH trim_characters AS")) {
    if (state.failCandidateReads > 0) {
      state.failCandidateReads -= 1;
      throw new Error("SYNTHETIC_PERF04_CANDIDATE_FAILURE");
    }
    return [...state.candidateRows];
  }
  if (statement.includes("FROM waspada.public_event_versions AS event")) {
    return identifiersOf(parameters[0]).flatMap((id) => {
      const fixture = state.events.get(id);
      return fixture === undefined ? [] : [fixture.snapshotRow];
    });
  }
  if (statement.includes("FROM waspada.public_event_impacts AS impact")) {
    return identifiersOf(parameters[0]).flatMap((id) => state.events.get(id)?.impactRows ?? []);
  }
  if (statement.includes("FROM waspada.public_scope_names AS names")) {
    const types = parameters[0] as readonly string[];
    const ids = parameters[1] as readonly string[];
    return ids.map((id, index) => ({ entity_type: types[index], id, display_name: id }));
  }
  if (statement.includes("FROM waspada.public_source_attributions AS attribution")) {
    const revisions = parameters[0] as readonly string[];
    const hashes = parameters[1] as readonly string[];
    const starts = parameters[2] as readonly number[];
    const ends = parameters[3] as readonly number[];
    return revisions.map((reportRevisionId, index) => ({
      dataset_kind: "live",
      report_revision_id: reportRevisionId,
      permitted_text_hash: hashes[index],
      span_start: starts[index],
      span_end: ends[index],
      offset_unit: "unicode_code_points",
      relation: "supports",
      public_use_approved: true,
      display_name: "Sumber fiktif PERF-04",
      url: "https://source.example.invalid/" + reportRevisionId,
      published_at: "2026-09-19T02:50:00Z",
      observed_at: null,
      retrieved_at: null,
      excerpt_public_use_approved: false,
      excerpt: null,
    }));
  }
  assert.fail("Unexpected SQL in the PERF-04 briefing test: " + statement);
}

function briefingExecutor(state: BriefingFakeState): SqlExecutor {
  return {
    async query<Row extends object>(statement: string, parameters: readonly unknown[] = []) {
      state.statements.push(statement);
      return { rows: briefingRows(state, statement, parameters) as unknown as readonly Row[] };
    },
    async execute() {
      assert.fail("The public briefing read must not execute write statements.");
    },
  };
}

function briefingRunner(state: BriefingFakeState): PublicBriefingSqlExecutorRunner {
  return async (connectionString, operation) => {
    assert.equal(connectionString, testConnectionString);
    state.operations += 1;
    return operation(briefingExecutor(state));
  };
}

function briefingRuntime(
  runner: PublicBriefingSqlExecutorRunner,
  options: { readonly now?: () => number; readonly readMemo?: boolean } = {},
) {
  const runtime = createPublicBriefingRuntime({
    datasetMode: "live",
    connectionString: testConnectionString,
  }, {
    withSqlExecutor: runner,
    now: options.now ?? (() => clockStart),
    ...(options.readMemo === undefined ? {} : { readMemo: options.readMemo }),
  });
  assert.ok(runtime, "the exact live briefing runtime is available");
  return runtime;
}

/** The pre-PERF-04 shape: one snapshot read and one lookup read for each candidate, all in one transaction. */
async function referenceBriefing(state: BriefingFakeState, request: BriefingRequest): Promise<string> {
  const executor = briefingExecutor(state);
  await executor.query(BEGIN);
  const candidates = await createPublicBriefingCandidateRepository(executor).read(request);
  const perEvent = createPublicEventProjectionService({
    snapshots: createPublicEventSnapshotRepository(executor),
    lookups: createPublicProjectionLookupRepository(executor),
  });
  const events: EventView[] = [];
  for (const candidate of candidates) {
    const result = await perEvent.read(candidate.eventId);
    if (result.kind !== "found" || result.event.version !== candidate.eventVersion) {
      throw new Error("the reference briefing expects every candidate to be found at its version");
    }
    events.push(result.event);
  }
  const response = projectPublicBriefing({ datasetMode: "live", request, events, generatedAt });
  await executor.query("COMMIT");
  return JSON.stringify(response);
}

function interestRequest(places: readonly string[], categories: BriefingRequest["interests"]["categories"] = []): BriefingRequest {
  return {
    interests: {
      places: [...places],
      services: [],
      institutions: [],
      audiences: [],
      categories: [...categories],
    },
  };
}

/** Mixed categories, a place that matches several events, and a label-only place match ("menteng"). */
const mixedRequest = interestRequest(
  ["place-perf04-00", "menteng", "place-perf04-02"],
  ["crime_personal_security"],
);

// ---------------------------------------------------------------------------------------------------------------------
// History fixtures: the candidate page and the exact-version review metadata.
// ---------------------------------------------------------------------------------------------------------------------

const historyEventId = "event-perf04-history-01";

function historyRecord(version: number): Record<string, unknown> {
  return {
    schema_version: "2.0",
    trace_id: `trace-perf04-history-${pad(version)}`,
    record_type: "Event",
    dataset_kind: "live",
    event_id: historyEventId,
    version,
    supersedes_version: version === 1 ? null : version - 1,
    title: `Peristiwa fiktif PERF-04 versi ${version}`,
    summary: "Ringkasan fiktif PERF-04.",
    category: "transport_road_incidents",
    tags: [],
    lifecycle: "ongoing",
    freshness: {
      status: "current",
      evaluated_at: "2026-11-23T02:00:00Z",
      review_due_at: null,
      basis: "manual_review",
    },
    event_time: { start: null, end: null, precision: "unknown" },
    validity: { valid_from: null, valid_until: null },
    scope: { place_ids: [], service_ids: [], institution_ids: [], audience_ids: [], geometry_ids: [] },
    claims: [],
    impact_refs: [],
    publication_status: "published",
    withdrawal_reason: null,
    publication_decision_id: `decision-perf04-history-${pad(version)}`,
    published_at: `2026-11-20T03:${pad(version)}:00Z`,
    withdrawn_at: null,
  };
}

interface HistoryFakeState {
  readonly statements: string[];
  operations: number;
  /** The current public version, or null when the event is not public. */
  currentVersion: number | null;
  /** Ascending versions that have history rows. */
  historyVersions: number[];
  /** A corrected version whose reviewer is the automatic publisher, so the page keeps its automatic flag. */
  automaticVersion: number | null;
}

function historyState(currentVersion: number | null, historyVersions: readonly number[], automaticVersion: number | null = null): HistoryFakeState {
  return {
    statements: [],
    operations: 0,
    currentVersion,
    historyVersions: [...historyVersions],
    automaticVersion,
  };
}

function historyRows(state: HistoryFakeState, statement: string, parameters: readonly unknown[]): object[] {
  if (state.currentVersion === null) return [];
  const current = state.currentVersion;
  const afterVersion = parameters[1] as number;
  const probeLimit = parameters[2] as number;
  const page = state.historyVersions
    .filter((version) => version > afterVersion && version <= current)
    .slice(0, probeLimit);
  const currentColumns = {
    current_dataset_kind: "live",
    current_event_id: historyEventId,
    current_version: current,
  };

  if (statement.includes("public_event_history_review_metadata")) {
    if (page.length === 0) {
      return [{
        ...currentColumns,
        candidate_dataset_kind: null,
        candidate_event_id: null,
        candidate_version: null,
        review_dataset_kind: null,
        review_event_id: null,
        review_event_version: null,
        review_status: null,
        change_type: null,
        summary: null,
        reviewer_id: null,
        reviewed_at: null,
      }];
    }
    return page.map((version) => ({
      ...currentColumns,
      candidate_dataset_kind: "live",
      candidate_event_id: historyEventId,
      candidate_version: version,
      review_dataset_kind: "live",
      review_event_id: historyEventId,
      review_event_version: version,
      review_status: "approved",
      change_type: version === 1 ? "published" : "corrected",
      summary: `Ringkasan fiktif PERF-04 versi ${version}.`,
      reviewer_id: version === state.automaticVersion ? AUTOMATIC_REVIEWER_ID : `reviewer-perf04-${pad(version)}`,
      reviewed_at: `2026-11-20T04:${pad(version)}:30Z`,
    }));
  }
  if (statement.includes("FROM waspada.public_event_history_versions AS history")) {
    if (page.length === 0) {
      return [{
        ...currentColumns,
        current_record_json: historyRecord(current),
        dataset_kind: null,
        event_id: null,
        version: null,
        record_json: null,
      }];
    }
    return page.map((version) => ({
      ...currentColumns,
      current_record_json: historyRecord(current),
      dataset_kind: "live",
      event_id: historyEventId,
      version,
      record_json: historyRecord(version),
    }));
  }
  assert.fail("Unexpected SQL in the PERF-04 history test: " + statement);
}

function historyExecutor(state: HistoryFakeState): SqlExecutor {
  return {
    async query<Row extends object>(statement: string, parameters: readonly unknown[] = []) {
      state.statements.push(statement);
      return { rows: historyRows(state, statement, parameters) as unknown as readonly Row[] };
    },
    async execute() {
      assert.fail("A public history read must not execute a statement.");
    },
  };
}

function historyRunner(state: HistoryFakeState): PublicEventHistorySqlExecutorRunner {
  return async (connectionString, operation) => {
    assert.equal(connectionString, testConnectionString);
    state.operations += 1;
    return operation(historyExecutor(state));
  };
}

function historyRuntime(
  runner: PublicEventHistorySqlExecutorRunner,
  options: { readonly now?: () => number; readonly readMemo?: boolean } = {},
) {
  const runtime = createPublicEventHistoryRuntime({
    datasetMode: "live",
    connectionString: testConnectionString,
  }, {
    withSqlExecutor: runner,
    now: options.now ?? (() => clockStart),
    ...(options.readMemo === undefined ? {} : { readMemo: options.readMemo }),
  });
  assert.ok(runtime, "the exact live history runtime is available");
  return runtime;
}

/** The direct service over the same repositories: the page shape before the PERF-04 memo. */
async function directHistoryPage(state: HistoryFakeState, limit: number, afterVersion: number | null): Promise<string> {
  const executor = historyExecutor(state);
  const service = createPublicEventHistoryProjectionService({
    candidates: createPublicEventHistoryRepository(executor),
    disclosures: createPublicEventHistoryDisclosureRepository(executor),
  });
  return JSON.stringify(await service.read(historyEventId, { limit, afterVersion }));
}

// ---------------------------------------------------------------------------------------------------------------------
// Briefing tests
// ---------------------------------------------------------------------------------------------------------------------

test("PERF-04 briefing: one batch read keeps the SQL statement count constant for 1, 3 and 12 candidates", async (t) => {
  const batched = new Map<number, number>();
  const reference = new Map<number, number>();
  for (const size of [1, 3, 12]) {
    const state = briefingState(size);
    await briefingRuntime(briefingRunner(state)).read(mixedRequest);
    batched.set(size, state.statements.length);
    assert.equal(state.operations, 1, "one request-scoped operation");

    const oldState = briefingState(size);
    await referenceBriefing(oldState, mixedRequest);
    reference.set(size, oldState.statements.length);
  }

  t.diagnostic(`PERF-04 briefing SQL statements (BEGIN and COMMIT included): batched 1 candidate ${batched.get(1)}, `
    + `3 candidates ${batched.get(3)}, 12 candidates ${batched.get(12)}; per-candidate reference 1 candidate ${reference.get(1)}, `
    + `3 candidates ${reference.get(3)}, 12 candidates ${reference.get(12)}`);
  assert.equal(batched.get(1), batched.get(3));
  assert.equal(batched.get(3), batched.get(12));
  // BEGIN, the candidate read, one snapshot read, one impact read, one scope-name read, one attribution read, COMMIT.
  assert.equal(batched.get(12), 7);
  assert.ok(reference.get(12)! > batched.get(12)!, "the per-candidate reference needs more statements");
});

test("PERF-04 briefing: the batched body equals the per-candidate reference byte for byte, in candidate order", async () => {
  const state = briefingState(12);
  const batched = JSON.stringify(await briefingRuntime(briefingRunner(state)).read(mixedRequest));
  const reference = await referenceBriefing(briefingState(12), mixedRequest);
  assert.equal(batched, reference);

  const response = JSON.parse(batched) as BriefingResponse;
  // Newest first: the even events match the category, event 01 only through its location label, and the odd events
  // in the places 1 and 3 match nothing. Event 11 is excluded for the same reason.
  assert.deepEqual(response.items.map((item) => item.event.event_id), [
    "event-perf04-10",
    "event-perf04-08",
    "event-perf04-06",
    "event-perf04-04",
    "event-perf04-02",
    "event-perf04-01",
    "event-perf04-00",
  ]);
  assert.deepEqual(response.items.find((item) => item.event.event_id === "event-perf04-01")?.relevance_reasons, [
    "Nama tempat ini disebut di laporan (perkiraan, bukan konfirmasi)",
  ]);
  assert.equal(response.items.find((item) => item.event.event_id === "event-perf04-01")?.event.location_display, "whole_view");
  assert.ok(response.items.some((item) => item.event.impacts.length === 1), "an impact survives the batch path");
  assert.equal(response.generated_at, generatedAt);
});

test("PERF-04 briefing: a repeat of the same normalised request is served from the memo with no SQL", async () => {
  const state = briefingState(3);
  const runner = briefingRunner(state);
  let nowMs = clockStart;
  const now = () => nowMs;

  // A new runtime per request, as the Worker builds them, still shares the module-level memo for the same runner.
  const first = await briefingRuntime(runner, { now, readMemo: true }).read(interestRequest(["place-perf04-00", "menteng"]));
  const statementsAfterFirst = state.statements.length;
  assert.equal(state.operations, 1);

  const variant = interestRequest(["  menteng ", "place-perf04-00", "menteng", ""]);
  const second = await briefingRuntime(runner, { now, readMemo: true }).read(variant);

  assert.equal(state.statements.length, statementsAfterFirst, "the memo hit runs no statement");
  assert.equal(state.operations, 1, "the memo hit opens no SQL client");
  assert.equal(JSON.stringify(second), JSON.stringify(first), "the stored body is returned unchanged");
  // The variant is also what a fresh read of the same request gives, so the key does not change the answer.
  assert.equal(JSON.stringify(second), await referenceBriefing(briefingState(3), variant));
});

test("PERF-04 briefing: a memo entry is served until 30 s and is then re-read with a new generated_at", async () => {
  const state = briefingState(2);
  const runner = briefingRunner(state);
  let nowMs = clockStart;
  const runtime = () => briefingRuntime(runner, { now: () => nowMs, readMemo: true });
  const request = interestRequest(["place-perf04-00"]);

  const first = await runtime().read(request);
  assert.equal(state.operations, 1);

  nowMs = clockStart + PUBLIC_READ_MEMO_LIMITS.ttlMs - 1;
  const beforeExpiry = await runtime().read(request);
  assert.equal(state.operations, 1, "still inside the TTL");
  assert.equal(beforeExpiry.generated_at, first.generated_at);

  nowMs = clockStart + PUBLIC_READ_MEMO_LIMITS.ttlMs;
  const afterExpiry = await runtime().read(request);
  assert.equal(state.operations, 2, "the entry expires at exactly the TTL and SQL is read again");
  assert.equal(afterExpiry.generated_at, "2026-11-23T03:00:30.000Z");
});

test("PERF-04 briefing: a failed read is not memoised, and the next successful read is stored", async () => {
  const state = briefingState(2);
  state.failCandidateReads = 1;
  const runtime = briefingRuntime(briefingRunner(state), { readMemo: true });
  const request = interestRequest(["place-perf04-00"]);

  await assert.rejects(runtime.read(request), (error: unknown) =>
    error instanceof PublicBriefingRuntimeError && error.code === "READ_FAILED");
  assert.equal(state.operations, 1);

  const body = await runtime.read(request);
  assert.equal(state.operations, 2, "the failure was not stored, so the retry reads SQL");
  assert.ok(body.items.length > 0);

  await runtime.read(request);
  assert.equal(state.operations, 2, "the successful body is stored");
});

test("PERF-04 briefing: an injected executor bypasses the memo unless a test opts in", async () => {
  const state = briefingState(2);
  const runtime = briefingRuntime(briefingRunner(state));
  const request = interestRequest(["place-perf04-00"]);
  await runtime.read(request);
  await runtime.read(request);
  assert.equal(state.operations, 2, "both reads reach the injected executor");
});

test("PERF-04 memo: the oldest entry is evicted once more than 200 are stored", async () => {
  const state = briefingState(1);
  const runtime = briefingRuntime(briefingRunner(state), { readMemo: true });
  const requestFor = (index: number) => interestRequest(["place-perf04-evict-" + pad(index, 3)]);

  for (let index = 0; index <= PUBLIC_READ_MEMO_LIMITS.maxEntries; index += 1) {
    await runtime.read(requestFor(index));
  }
  assert.equal(state.operations, PUBLIC_READ_MEMO_LIMITS.maxEntries + 1);

  await runtime.read(requestFor(PUBLIC_READ_MEMO_LIMITS.maxEntries));
  assert.equal(state.operations, PUBLIC_READ_MEMO_LIMITS.maxEntries + 1, "the newest entry is still stored");

  await runtime.read(requestFor(0));
  assert.equal(state.operations, PUBLIC_READ_MEMO_LIMITS.maxEntries + 2, "the oldest entry was evicted");
});

// ---------------------------------------------------------------------------------------------------------------------
// History tests
// ---------------------------------------------------------------------------------------------------------------------

test("PERF-04 history: the page reads the same number of statements for 1, 3 and 12 versions", async (t) => {
  const counts: number[] = [];
  for (const [versions, limit] of [[1, 1], [3, 3], [12, 12]] as const) {
    const history = Array.from({ length: versions }, (_, index) => index + 1);
    const state = historyState(versions, history);
    const runtime = historyRuntime(historyRunner(state));
    const result = await runtime.read(historyEventId, new URLSearchParams({ limit: String(limit) }));
    assert.equal(result.kind, "found");
    if (result.kind !== "found") throw new Error("expected a found page");
    assert.equal(result.page.data.length, limit);
    assert.equal(state.operations, 1);
    counts.push(state.statements.length);
  }
  t.diagnostic(`PERF-04 history SQL statements per page for 1, 3 and 12 versions: ${counts.join(", ")}`);
  assert.deepEqual(counts, [2, 2, 2]);
});

test("PERF-04 history: every page of a walk equals the direct service page, and keeps the automatic flag", async () => {
  const state = historyState(7, [1, 2, 3, 4, 5, 6, 7], 4);
  const runtime = historyRuntime(historyRunner(state));
  const walked: string[] = [];
  let cursor: string | null = null;
  do {
    const search = new URLSearchParams({ limit: "3", ...(cursor === null ? {} : { cursor }) });
    const result = await runtime.read(historyEventId, search);
    if (result.kind !== "found") throw new Error("expected a found page");
    const direct = await directHistoryPage(
      historyState(7, [1, 2, 3, 4, 5, 6, 7], 4),
      3,
      cursor === null ? null : Number(cursor),
    );
    assert.equal(JSON.stringify(result), direct);
    walked.push(...result.page.data.map((entry) => String(entry.version)));
    cursor = result.page.page.next_cursor;
  } while (cursor !== null);

  assert.deepEqual(walked, ["1", "2", "3", "4", "5", "6", "7"]);
  const firstPage = JSON.parse(await directHistoryPage(historyState(7, [1, 2, 3, 4, 5, 6, 7], 4), 3, null)) as {
    kind: string;
    page: { data: Array<Record<string, unknown>>; page: { next_cursor: string | null } };
  };
  assert.equal(firstPage.page.page.next_cursor, "3");
  assert.equal(firstPage.page.data[0]?.automatic, undefined, "a published version carries no automatic flag");
  const automaticEntry = JSON.parse(await directHistoryPage(historyState(7, [1, 2, 3, 4, 5, 6, 7], 4), 3, 3)) as {
    page: { data: Array<Record<string, unknown>> };
  };
  assert.equal(automaticEntry.page.data[0]?.automatic, true, "the automatic correction keeps its flag");
});

test("PERF-04 history: a found page is memoised, a hit opens no SQL client, and a missing event is not memoised", async () => {
  const state = historyState(null, []);
  const runner = historyRunner(state);
  let nowMs = clockStart;
  const runtime = () => historyRuntime(runner, { now: () => nowMs, readMemo: true });
  const search = new URLSearchParams({ limit: "2" });

  const missing = await runtime().read(historyEventId, search);
  assert.deepEqual(missing, { kind: "missing" });
  assert.equal(state.operations, 1);

  state.currentVersion = 3;
  state.historyVersions = [1, 2, 3];
  const found = await runtime().read(historyEventId, search);
  assert.equal(found.kind, "found");
  assert.equal(state.operations, 2, "the missing result was not stored, so the event is read again");

  const statementsBeforeHit = state.statements.length;
  const hit = await runtime().read(historyEventId, search);
  assert.equal(state.operations, 2, "the memo hit opens no SQL client");
  assert.equal(state.statements.length, statementsBeforeHit);
  assert.equal(JSON.stringify(hit), JSON.stringify(found));

  await runtime().read(historyEventId, new URLSearchParams({ limit: "1" }));
  assert.equal(state.operations, 3, "a different page request is a different memo key");

  nowMs = clockStart + PUBLIC_READ_MEMO_LIMITS.ttlMs;
  await runtime().read(historyEventId, search);
  assert.equal(state.operations, 4, "the page is read again once the TTL has passed");
});

test("PERF-04 history: an injected executor bypasses the memo unless a test opts in", async () => {
  const state = historyState(3, [1, 2, 3]);
  const runtime = historyRuntime(historyRunner(state));
  await runtime.read(historyEventId, new URLSearchParams({ limit: "2" }));
  await runtime.read(historyEventId, new URLSearchParams({ limit: "2" }));
  assert.equal(state.operations, 2);
});
