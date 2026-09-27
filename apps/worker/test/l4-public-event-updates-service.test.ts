import assert from "node:assert/strict";
import test from "node:test";
import type { HistoryEntry } from "../src/contracts/public-api.js";
import {
  createPublicEventUpdatesCursorCodec,
  PUBLIC_EVENT_UPDATES_CURSOR_TTL_MS,
} from "../src/layers/l4-application-integration/public-event-updates-cursor.js";
import {
  createPublicEventUpdatesService,
  PublicEventUpdatesServiceError,
  PUBLIC_EVENT_UPDATES_SERVICE_LIMITS,
  type PublicEventUpdatesReaderPort,
  type PublicEventUpdatesService,
} from "../src/layers/l4-application-integration/public-event-updates-service.js";

const nowAtIssue = Date.parse("2026-09-27T04:00:00.000Z");
const maxBigintSequence = "9223372036854775807";

interface Candidate {
  readonly datasetKind: unknown;
  readonly eventId: unknown;
  readonly eventVersion: unknown;
  readonly changeSequence: unknown;
  readonly changeType: unknown;
  readonly summary: unknown;
  readonly publishedAt: unknown;
}

interface ReaderCall {
  readonly afterSequence: string;
  readonly throughSequence: string;
  readonly limit: number;
}

interface ReaderFixture {
  readonly port: PublicEventUpdatesReaderPort;
  readonly calls: {
    readonly watermark: number;
    readonly candidates: ReaderCall[];
  };
}

async function generateTestKey(usages: KeyUsage[] = ["sign", "verify"]): Promise<CryptoKey> {
  return await globalThis.crypto.subtle.generateKey(
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

function createService(
  reader: PublicEventUpdatesReaderPort,
  key: CryptoKey,
  now: () => number,
): PublicEventUpdatesService {
  return createPublicEventUpdatesService({ reader, key, now });
}

function makeReader(
  watermark: unknown,
  candidateResult: unknown = { candidates: [], hasMore: false },
  errors: { watermark?: unknown; candidates?: unknown } = {},
): ReaderFixture {
  const calls = { watermark: 0, candidates: [] as ReaderCall[] };
  const port: PublicEventUpdatesReaderPort = {
    async readWatermark() {
      calls.watermark += 1;
      if (Object.hasOwn(errors, "watermark")) throw errors.watermark;
      return watermark;
    },
    async readCandidates(value: unknown) {
      if (typeof value !== "object" || value === null) throw new Error("invalid service input");
      const options = value as ReaderCall;
      calls.candidates.push({
        afterSequence: options.afterSequence,
        throughSequence: options.throughSequence,
        limit: options.limit,
      });
      if (Object.hasOwn(errors, "candidates")) throw errors.candidates;
      return typeof candidateResult === "function"
        ? (candidateResult as (options: ReaderCall) => unknown)(options)
        : candidateResult;
    },
  };
  return { port, calls };
}

function makeCandidate(
  changeSequence: unknown,
  overrides: Partial<Candidate> = {},
): Candidate {
  return {
    datasetKind: "live",
    eventId: "fictional-event-" + String(changeSequence),
    eventVersion: 1,
    changeSequence,
    changeType: "corrected",
    summary: "Authored fictional reviewed summary.",
    publishedAt: "2026-09-27T03:59:59.123456Z",
    ...overrides,
  };
}

async function makeCursor(key: CryptoKey, sequence: string, now: () => number): Promise<string> {
  return (await createPublicEventUpdatesCursorCodec({ key, now }).issue(sequence)).token;
}

async function assertServiceError(
  promise: Promise<unknown>,
  code: "INVALID_REQUEST" | "CURSOR_RESTART_REQUIRED" | "READER_READ_FAILED"
    | "READER_RESULT_INVALID" | "CURSOR_ISSUE_FAILED",
  sensitiveValues: readonly string[] = [],
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof PublicEventUpdatesServiceError);
    assert.equal(error.code, code);
    assert.equal(error.message.length < 120, true);
    for (const value of sensitiveValues) assert.equal(error.message.includes(value), false);
    return true;
  });
}

function assertHistoryEntry(value: unknown): asserts value is HistoryEntry {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.deepEqual(Object.keys(value as object).sort(), [
    "change_type", "changed_at", "event_id", "summary", "version",
  ]);
}

test("omitted cursor bootstraps to an empty page at the current watermark", async () => {
  const key = await generateTestKey();
  const watermark = "9007199254740993";
  const reader = makeReader(watermark);
  const service = createService(reader.port, key, () => nowAtIssue);

  const page = await service.read({ limit: 20 });

  assert.deepEqual(page.items, []);
  assert.deepEqual(Object.keys(page).sort(), [
    "checked_at", "cursor_expires_at", "items", "next_cursor",
  ]);
  assert.equal(page.checked_at, new Date(nowAtIssue).toISOString());
  assert.equal(page.cursor_expires_at, new Date(nowAtIssue + PUBLIC_EVENT_UPDATES_CURSOR_TTL_MS).toISOString());
  assert.equal(reader.calls.watermark, 1);
  assert.deepEqual(reader.calls.candidates, []);

  const decoded = await createPublicEventUpdatesCursorCodec({
    key,
    now: () => nowAtIssue,
  }).decode(page.next_cursor);
  assert.equal(decoded.sequence, watermark);
  assert.equal(decoded.expiresAt, page.cursor_expires_at);
});

test("projects all reviewed change labels through the exact HistoryEntry allowlist", async () => {
  const key = await generateTestKey();
  const cursor = await makeCursor(key, "0", () => nowAtIssue);
  const longUnicodeSummary = String.fromCodePoint(0x1f642).repeat(500);
  const candidates = [
    makeCandidate("1", { changeType: "published", summary: "Authored fictional initial publication." }),
    makeCandidate("2", { changeType: "corrected", summary: "Authored fictional correction." }),
    makeCandidate("3", { changeType: "impact_changed", summary: "Authored fictional impact change." }),
    makeCandidate("4", { changeType: "retracted", summary: longUnicodeSummary }),
  ];
  const reader = makeReader("10", { candidates, hasMore: false });
  const page = await createService(reader.port, key, () => nowAtIssue).read({ cursor });

  assert.deepEqual(page.items.map((item) => item.change_type), [
    "published", "corrected", "impact_changed", "retracted",
  ]);
  assert.equal(page.items[3]?.summary, longUnicodeSummary);
  assert.equal(Array.from(page.items[3]!.summary).length, 500);
  assert.equal(page.items[0]?.changed_at, candidates[0]?.publishedAt);
  assert.deepEqual(reader.calls.candidates, [{
    afterSequence: "0",
    throughSequence: "10",
    limit: PUBLIC_EVENT_UPDATES_SERVICE_LIMITS.defaultPageSize,
  }]);
  for (const item of page.items) assertHistoryEntry(item);
  assert.equal(JSON.stringify(page).includes("changeSequence"), false);
  assert.equal(JSON.stringify(page).includes("reviewer"), false);
  assert.equal((await createPublicEventUpdatesCursorCodec({ key, now: () => nowAtIssue })
    .decode(page.next_cursor)).sequence, "10",
  "a completed page advances over any non-public sequence gaps to the watermark");
});

test("continues a full page from the last candidate without converting sequences to numbers", async () => {
  const key = await generateTestKey();
  const afterSequence = "9007199254740993";
  const lastCandidateSequence = "9007199254740999";
  const watermark = "9007199254741005";
  const cursor = await makeCursor(key, afterSequence, () => nowAtIssue);
  const reader = makeReader(watermark, {
    candidates: [
      makeCandidate("9007199254740994"),
      makeCandidate(lastCandidateSequence),
    ],
    hasMore: true,
  });
  const page = await createService(reader.port, key, () => nowAtIssue).read({
    cursor,
    limit: 2,
  });

  assert.deepEqual(reader.calls.candidates, [{
    afterSequence,
    throughSequence: watermark,
    limit: 2,
  }]);
  assert.deepEqual(page.items.map((item) => item.event_id), [
    "fictional-event-9007199254740994",
    "fictional-event-9007199254740999",
  ]);
  assert.equal((await createPublicEventUpdatesCursorCodec({ key, now: () => nowAtIssue })
    .decode(page.next_cursor)).sequence, lastCandidateSequence);
});

test("advances an empty or short completed page to the watermark across sequence gaps", async () => {
  const key = await generateTestKey();
  const cursor = await makeCursor(key, "4", () => nowAtIssue);
  for (const candidates of [
    [],
    [makeCandidate("7")],
  ]) {
    const reader = makeReader(maxBigintSequence, { candidates, hasMore: false });
    const page = await createService(reader.port, key, () => nowAtIssue).read({
      cursor,
      limit: 2,
    });
    assert.equal((await createPublicEventUpdatesCursorCodec({ key, now: () => nowAtIssue })
      .decode(page.next_cursor)).sequence, maxBigintSequence);
  }
});

test("rejects malformed request bounds before making reader calls", async () => {
  const key = await generateTestKey();
  const reader = makeReader("10");
  const service = createService(reader.port, key, () => nowAtIssue);
  const invalidRequests: unknown[] = [
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
    { limit: "20" },
    { cursor: null },
    { cursor: 10 },
    { cursor: "" },
    { cursor: "x".repeat(2_049) },
    { cursor: "private-malformed-token" },
    { unexpected: "private-request-value" },
    [],
  ];

  for (const request of invalidRequests) {
    await assertServiceError(service.read(request), "INVALID_REQUEST", [
      "private-malformed-token",
      "private-request-value",
    ]);
  }
  assert.equal(reader.calls.watermark, 0);
  assert.deepEqual(reader.calls.candidates, []);
});

test("requires a fresh baseline for expired and ahead-of-watermark cursors", async () => {
  const key = await generateTestKey();
  const expiredCursor = await makeCursor(key, "5", () => nowAtIssue);
  const expiration = nowAtIssue + PUBLIC_EVENT_UPDATES_CURSOR_TTL_MS;
  const expiredReader = makeReader("10");
  await assertServiceError(
    createService(expiredReader.port, key, () => expiration).read({ cursor: expiredCursor }),
    "CURSOR_RESTART_REQUIRED",
  );
  assert.equal(expiredReader.calls.watermark, 0);
  assert.deepEqual(expiredReader.calls.candidates, []);

  const aheadCursor = await makeCursor(key, "11", () => nowAtIssue);
  const aheadReader = makeReader("10");
  await assertServiceError(
    createService(aheadReader.port, key, () => nowAtIssue).read({ cursor: aheadCursor }),
    "CURSOR_RESTART_REQUIRED",
  );
  assert.equal(aheadReader.calls.watermark, 1);
  assert.deepEqual(aheadReader.calls.candidates, []);
});

test("fails closed on malformed, unordered, oversized, or inconsistent reader candidates", async () => {
  const key = await generateTestKey();
  const cursor = await makeCursor(key, "0", () => nowAtIssue);
  const valid = makeCandidate("1");
  const tooLongSummary = String.fromCodePoint(0x1f642).repeat(501);
  const invalidPages: unknown[] = [
    { candidates: [valid], hasMore: false, private_note: "private row details" },
    { candidates: [{ ...valid, reviewerId: "reviewer-fixture" }], hasMore: false },
    { candidates: [{ ...valid, datasetKind: "synthetic" }], hasMore: false },
    { candidates: [{ ...valid, eventId: "event sensitive/private" }], hasMore: false },
    { candidates: [{ ...valid, eventVersion: "1" }], hasMore: false },
    { candidates: [{ ...valid, changeSequence: 1 }], hasMore: false },
    { candidates: [{ ...valid, changeSequence: "0" }], hasMore: false },
    { candidates: [{ ...valid, changeSequence: "11" }], hasMore: false },
    { candidates: [makeCandidate("2"), makeCandidate("2")], hasMore: false },
    { candidates: [makeCandidate("2"), makeCandidate("1")], hasMore: false },
    { candidates: [{ ...valid, changeType: "held" }], hasMore: false },
    { candidates: [{ ...valid, summary: "   " }], hasMore: false },
    { candidates: [{ ...valid, summary: tooLongSummary }], hasMore: false },
    { candidates: [{ ...valid, publishedAt: "not-a-timestamp" }], hasMore: false },
    { candidates: [{ ...valid, publishedAt: "2026-02-30T03:59:59Z" }], hasMore: false },
    { candidates: [valid], hasMore: "false" },
    { candidates: [], hasMore: true },
    { candidates: [valid, makeCandidate("2")], hasMore: false },
  ];

  for (const candidateResult of invalidPages) {
    const reader = makeReader("10", candidateResult);
    await assertServiceError(
      createService(reader.port, key, () => nowAtIssue).read({ cursor, limit: 1 }),
      "READER_RESULT_INVALID",
      ["private row details", "reviewer-fixture", "event sensitive/private"],
    );
  }
});

test("rejects malformed watermark and reader failures with fixed redacted errors", async () => {
  const key = await generateTestKey();
  const invalidWatermarks: unknown[] = [0, "00", "-1", "9223372036854775808"];
  for (const watermark of invalidWatermarks) {
    const reader = makeReader(watermark);
    await assertServiceError(
      createService(reader.port, key, () => nowAtIssue).read(),
      "READER_RESULT_INVALID",
      ["9223372036854775808"],
    );
  }

  const watermarkFailure = makeReader("10", undefined, {
    watermark: new Error("database private failure marker"),
  });
  await assertServiceError(
    createService(watermarkFailure.port, key, () => nowAtIssue).read(),
    "READER_READ_FAILED",
    ["database private failure marker"],
  );

  const cursor = await makeCursor(key, "0", () => nowAtIssue);
  const candidateFailure = makeReader("10", undefined, {
    candidates: new Error("candidate private failure marker"),
  });
  await assertServiceError(
    createService(candidateFailure.port, key, () => nowAtIssue).read({ cursor }),
    "READER_READ_FAILED",
    ["candidate private failure marker"],
  );
});

test("maps cursor signing and clock failures without leaking details", async () => {
  const verifyOnlyKey = await generateTestKey(["verify"]);
  const reader = makeReader("10");
  await assertServiceError(
    createService(reader.port, verifyOnlyKey, () => nowAtIssue).read(),
    "CURSOR_ISSUE_FAILED",
  );

  const badClockReader = makeReader("10");
  await assertServiceError(
    createService(badClockReader.port, await generateTestKey(), () => Number.NaN).read(),
    "CURSOR_ISSUE_FAILED",
  );
});
