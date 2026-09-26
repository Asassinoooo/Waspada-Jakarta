import assert from "node:assert/strict";
import test from "node:test";
import type { EventView } from "../src/contracts/public-api.js";
import {
  createPublicEventListProjectionService,
  PublicEventListProjectionServiceError,
  type PublicEventListCandidateReadOptions,
  type PublicEventListCursor,
} from "../src/layers/l4-application-integration/public-event-list-projection-service.js";
import type { PublicEventProjectionReadResult } from "../src/layers/l4-application-integration/public-event-projection-service.js";

type RecordValue = Record<string, unknown>;

const firstTime = "2026-09-27T03:00:00.000000Z";
const olderTime = "2026-09-26T03:00:00.000000Z";
const oldestTime = "2026-09-25T03:00:00.000000Z";
const eventA = "event-list-synthetic-a";
const eventB = "event-list-synthetic-b";
const eventC = "event-list-synthetic-c";

/**
 * These authored records are fictional contract fixtures only. They do not
 * represent a real event, publication, source, or public attribution.
 */
function makeEventView(eventId: string, version = 1): EventView {
  return {
    event_id: eventId,
    version,
    title: "Fictional public event fixture",
    summary: "An authored EventView for composition tests.",
    category: "disasters_weather",
    tags: [],
    lifecycle: "ongoing",
    freshness: {
      status: "current",
      evaluated_at: firstTime,
      review_due_at: null,
      basis: "manual_review",
    },
    event_time: { start: null, end: null, precision: "unknown" },
    validity: { valid_from: null, valid_until: null },
    scope: { places: [], services: [], institutions: [], audiences: [] },
    claims: [],
    impacts: [],
    published_at: firstTime,
  };
}

function makeCandidate(
  eventId: string,
  firstPublishedAt: string,
  eventVersion = 1,
  recordJson: unknown = { private_marker: "CANDIDATE_RECORD_SECRET" },
): RecordValue {
  return { eventId, eventVersion, firstPublishedAt, recordJson };
}

function makePage(candidates: readonly unknown[], nextCursor: unknown = null): RecordValue {
  return { candidates, nextCursor };
}

function cursorFor(candidate: RecordValue): PublicEventListCursor {
  return {
    firstPublishedAt: candidate.firstPublishedAt as string,
    eventId: candidate.eventId as string,
  };
}

function createService(
  candidateResult: unknown,
  project: (eventId: unknown) => unknown | Promise<unknown> = (eventId) => ({
    kind: "found",
    event: makeEventView(String(eventId)),
  }),
  onCandidateRead?: (options: PublicEventListCandidateReadOptions) => void,
) {
  return createPublicEventListProjectionService({
    candidates: {
      async read(options) {
        onCandidateRead?.(options);
        return candidateResult;
      },
    },
    projections: {
      async read(eventId) {
        return await project(eventId) as PublicEventProjectionReadResult;
      },
    },
  });
}

async function assertServiceError(
  promise: Promise<unknown>,
  code: PublicEventListProjectionServiceError["code"],
  sensitiveValues: readonly string[] = [],
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof PublicEventListProjectionServiceError);
    assert.equal(error.code, code);
    for (const value of sensitiveValues) assert.equal(error.message.includes(value), false);
    return true;
  });
}

test("projects a candidate page in order and preserves its exact continuation cursor", async () => {
  const candidates = [
    makeCandidate(eventA, firstTime, 2),
    makeCandidate(eventB, firstTime, 1),
    makeCandidate(eventC, olderTime, 4),
  ];
  const nextCursor = cursorFor(candidates[2]!);
  const inputCursor = { firstPublishedAt: "2026-09-28T03:00:00.000000Z", eventId: "event-list-anchor" };
  let readerOptions: PublicEventListCandidateReadOptions | undefined;
  const projectedIds: unknown[] = [];
  const service = createService(
    makePage(candidates, nextCursor),
    (eventId) => {
      projectedIds.push(eventId);
      const version = eventId === eventA ? 5 : eventId === eventC ? 6 : 1;
      return { kind: "found", event: makeEventView(String(eventId), version) };
    },
    (options) => { readerOptions = options; },
  );

  const result = await service.read({ limit: 3, cursor: inputCursor });

  assert.deepEqual(readerOptions, { limit: 3, cursor: inputCursor });
  assert.deepEqual(projectedIds, [eventA, eventB, eventC]);
  assert.deepEqual(result.events.map((event) => [event.event_id, event.version]), [
    [eventA, 5],
    [eventB, 1],
    [eventC, 6],
  ]);
  assert.deepEqual(result.nextCursor, nextCursor);
  assert.deepEqual(Object.keys(result).sort(), ["events", "nextCursor"]);
  assert.equal(JSON.stringify(result).includes("CANDIDATE_RECORD_SECRET"), false);
  for (const event of result.events) {
    assert.deepEqual(Object.keys(event).sort(), [
      "category", "claims", "event_id", "event_time", "freshness", "impacts",
      "lifecycle", "published_at", "scope", "summary", "tags", "title", "validity", "version",
    ]);
  }
});

test("defaults to 20, accepts the maximum page size, and returns empty end pages", async () => {
  let defaultOptions: PublicEventListCandidateReadOptions | undefined;
  const defaultResult = await createService(
    makePage([], null),
    undefined,
    (options) => { defaultOptions = options; },
  ).read();
  assert.deepEqual(defaultOptions, { limit: 20 });
  assert.deepEqual(defaultResult, { events: [], nextCursor: null });

  let maxOptions: PublicEventListCandidateReadOptions | undefined;
  const maxResult = await createService(
    makePage([], null),
    undefined,
    (options) => { maxOptions = options; },
  ).read({ limit: 100 });
  assert.deepEqual(maxOptions, { limit: 100 });
  assert.deepEqual(maxResult, { events: [], nextCursor: null });
});

test("omits candidates that become unavailable while retaining candidate cursor progress", async () => {
  const candidates = [
    makeCandidate(eventA, firstTime),
    makeCandidate(eventB, olderTime),
  ];
  const nextCursor = cursorFor(candidates[1]!);
  const result = await createService(
    makePage(candidates, nextCursor),
    (eventId) => eventId === eventB
      ? { kind: "missing" }
      : { kind: "found", event: makeEventView(String(eventId), 2) },
  ).read({ limit: 2 });

  assert.deepEqual(result.events.map((event) => event.event_id), [eventA]);
  assert.deepEqual(result.nextCursor, nextCursor);
});

test("rejects closed request violations before calling either injected port", async () => {
  let candidateCalls = 0;
  let projectionCalls = 0;
  const service = createPublicEventListProjectionService({
    candidates: { async read() { candidateCalls += 1; return makePage([]); } },
    projections: {
      async read() {
        projectionCalls += 1;
        return { kind: "missing" };
      },
    },
  });
  const invalidRequests: unknown[] = [
    null,
    [],
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
    { limit: "2" },
    { unexpected: true },
    { filters: null },
    { filters: { unexpected: true } },
    { filters: { category: "not-a-category" } },
    { filters: { lifecycle: "unsafe" } },
    { filters: { freshness: "stale" } },
    { filters: { from: "2026-02-30T03:00:00Z" } },
    { filters: { from: "2026-01-01T00:00:00Z", to: "2025-12-31T23:59:59Z" } },
    { filters: { from: "2026-01-01T00:00:00Z", to: "2026-04-01T00:00:00.000001Z" } },
    { filters: { q: "x".repeat(121) } },
    { filters: { place_id: "x".repeat(129) } },
    { cursor: null },
    { cursor: { firstPublishedAt: firstTime, eventId: eventA, extra: true } },
    { cursor: { firstPublishedAt: "2026-02-30T03:00:00.000000Z", eventId: eventA } },
    { cursor: { firstPublishedAt: firstTime, eventId: "invalid id" } },
  ];

  for (const request of invalidRequests) {
    await assertServiceError(service.read(request), "INVALID_REQUEST");
  }
  assert.equal(candidateCalls, 0);
  assert.equal(projectionCalls, 0);
});

test("normalizes valid filters before candidate reads and treats blank text filters as absent", async () => {
  const candidate = makeCandidate(eventA, firstTime, 1);
  let readerOptions: PublicEventListCandidateReadOptions | undefined;
  const service = createService(
    makePage([candidate]),
    (eventId) => ({ kind: "found", event: makeEventView(String(eventId)) }),
    (options) => { readerOptions = options; },
  );

  const result = await service.read({
    filters: {
      category: "disasters_weather",
      lifecycle: "ongoing",
      freshness: "needs_update",
      from: "2026-01-01T00:00:00Z",
      to: "2026-04-01T00:00:00Z",
      q: "  STORM Notice  ",
      place_id: " place-alpha ",
    },
  });
  assert.deepEqual(readerOptions, {
    limit: 20,
    filters: {
      category: "disasters_weather",
      lifecycle: "ongoing",
      freshness: "needs_update",
      from: "2026-01-01T00:00:00Z",
      to: "2026-04-01T00:00:00Z",
      q: "storm notice",
      place_id: "place-alpha",
    },
  });
  assert.deepEqual(result.events.map(({ version }) => version), [1],
    "an exact 90-day interval is valid at the Layer 4 boundary");

  const blankReaderOptions: PublicEventListCandidateReadOptions[] = [];
  const blankResult = await createService(
    makePage([candidate]),
    (eventId) => ({ kind: "found", event: makeEventView(String(eventId), 2) }),
    (options) => { blankReaderOptions.push(options); },
  ).read({ filters: { q: "   ", place_id: "  " } });
  assert.deepEqual(blankReaderOptions, [{ limit: 20 }]);
  assert.deepEqual(blankResult.events.map(({ version }) => version), [2],
    "blank query/place filters are absent and do not trigger version-race rejection");
});

test("rejects malformed candidate pages before starting projection calls", async () => {
  const validA = makeCandidate(eventA, firstTime);
  const validB = makeCandidate(eventB, olderTime);
  const sameTimeA = makeCandidate(eventA, firstTime);
  const sameTimeB = makeCandidate(eventB, firstTime);
  const invalidPages: unknown[] = [
    { ...makePage([validA]), diagnostic: "private reader details" },
    { candidates: "not-an-array", nextCursor: null },
    makePage([{ ...validA, internal: "secret" }]),
    makePage([{ ...validA, eventId: "invalid id" }]),
    makePage([{ ...validA, eventVersion: 0 }]),
    makePage([{ ...validA, firstPublishedAt: "2026-02-30T03:00:00.000000Z" }]),
    makePage([{ eventId: eventA, eventVersion: 1, firstPublishedAt: firstTime }]),
    makePage([{ ...validA, recordJson: null }]),
    makePage([validA, { ...validA }]),
    makePage([validB, validA]),
    makePage([sameTimeB, sameTimeA]),
    makePage([validA], { firstPublishedAt: firstTime, eventId: eventB }),
    makePage([validA], { firstPublishedAt: "not-a-time", eventId: eventA }),
    makePage([validA, validB], cursorFor(validB)),
    makePage([validA, validB], { firstPublishedAt: oldestTime, eventId: eventC }),
    makePage([validA, validB]),
  ];

  for (const page of invalidPages) {
    let projectionCalls = 0;
    await assertServiceError(
      createService(page, () => {
        projectionCalls += 1;
        return { kind: "missing" };
      }).read({ limit: 1 }),
      "CANDIDATE_RESULT_INVALID",
      ["private reader details"],
    );
    assert.equal(projectionCalls, 0);
  }

  let shortPageProjectionCalls = 0;
  await assertServiceError(
    createService(
      makePage([validA], cursorFor(validA)),
      () => {
        shortPageProjectionCalls += 1;
        return { kind: "missing" };
      },
    ).read({ limit: 2 }),
    "CANDIDATE_RESULT_INVALID",
  );
  assert.equal(shortPageProjectionCalls, 0);

  let continuationProjectionCalls = 0;
  await assertServiceError(
    createService(
      makePage([makeCandidate(eventA, firstTime)]),
      () => {
        continuationProjectionCalls += 1;
        return { kind: "missing" };
      },
    ).read({ limit: 1, cursor: { firstPublishedAt: firstTime, eventId: eventA } }),
    "CANDIDATE_RESULT_INVALID",
  );
  assert.equal(continuationProjectionCalls, 0);
});

test("redacts candidate and projector port failures and never returns a partial page", async () => {
  const candidateFailure = createPublicEventListProjectionService({
    candidates: {
      async read() {
        throw new Error("private SQL content " + eventA);
      },
    },
    projections: { async read() { return { kind: "missing" }; } },
  });
  await assertServiceError(
    candidateFailure.read({ limit: 1 }),
    "CANDIDATE_READ_FAILED",
    [eventA, "private SQL content"],
  );

  const candidates = [
    makeCandidate(eventA, firstTime),
    makeCandidate(eventB, olderTime),
  ];
  const projectionFailure = createService(
    makePage(candidates, cursorFor(candidates[1]!)),
    (eventId) => {
      if (eventId === eventB) throw new Error("private projector details " + eventB);
      return { kind: "found", event: makeEventView(String(eventId)) };
    },
  );
  await assertServiceError(
    projectionFailure.read({ limit: 2 }),
    "PROJECTION_READ_FAILED",
    [eventB, "private projector details"],
  );
});

test("rejects mismatched, stale, or expanded projection results", async () => {
  const candidate = makeCandidate(eventA, firstTime, 2);
  const cases: unknown[] = [
    { kind: "found", event: makeEventView(eventB, 2) },
    { kind: "found", event: makeEventView(eventA, 1) },
    { kind: "found", event: { ...makeEventView(eventA, 2), recordJson: { secret: true } } },
    { kind: "found", event: makeEventView(eventA, 2), diagnostics: "private" },
    { kind: "missing", diagnostics: "private" },
  ];

  for (const projectionResult of cases) {
    await assertServiceError(
      createService(makePage([candidate]), () => projectionResult).read({ limit: 1 }),
      "PROJECTION_RESULT_INVALID",
    );
  }
});

test("fails a filtered page when a current projection advances beyond its candidate version", async () => {
  const candidate = makeCandidate(eventA, firstTime, 1);
  const service = createService(
    makePage([candidate]),
    (eventId) => ({ kind: "found", event: makeEventView(String(eventId), 2) }),
  );

  await assertServiceError(
    service.read({ filters: { place_id: "place-alpha" } }),
    "FILTERED_RESULT_CHANGED",
    [eventA],
  );
});

test("caps projector fan-out at four while retaining original candidate order", async () => {
  const candidates = Array.from({ length: 9 }, (_, index) => {
    const minute = String(9 - index).padStart(2, "0");
    return makeCandidate("event-concurrency-" + index, "2026-09-27T03:" + minute + ":00.000000Z");
  });
  let active = 0;
  let maximumActive = 0;
  const service = createService(
    makePage(candidates, cursorFor(candidates.at(-1)!)),
    async (eventId) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return { kind: "found", event: makeEventView(String(eventId)) };
    },
  );

  const result = await service.read({ limit: candidates.length });
  assert.equal(maximumActive, 4);
  assert.deepEqual(
    result.events.map((event) => event.event_id),
    candidates.map((candidate) => candidate.eventId),
  );
});
