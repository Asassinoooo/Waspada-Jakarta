import assert from "node:assert/strict";
import test from "node:test";
import type { EventView } from "../src/contracts/public-api.js";
import {
  createPublicEventListCursorCodec,
  type PublicEventListCursorCodec,
} from "../src/layers/l4-application-integration/public-event-list-cursor.js";
import {
  createPublicEventListPageService,
  PublicEventListPageServiceError,
  type PublicEventListPageServiceErrorCode,
} from "../src/layers/l4-application-integration/public-event-list-page-service.js";
import type {
  PublicEventListCursor,
  PublicEventListFilters,
  PublicEventListProjectionResult,
  PublicEventListProjectionService,
} from "../src/layers/l4-application-integration/public-event-list-projection-service.js";

const nowAtIssue = Date.parse("2026-09-27T04:00:00.000Z");
const nextKeyset: PublicEventListCursor = {
  firstPublishedAt: "2026-09-26T03:12:13.123456Z",
  eventId: "synthetic-list-event-01",
};
const currentKeyset: PublicEventListCursor = {
  firstPublishedAt: "2026-09-27T03:12:13.123456Z",
  eventId: "synthetic-list-event-02",
};

/** Fictional response data for service composition tests; never a live event. */
function makeEventView(eventId = "synthetic-list-event-01"): EventView {
  return {
    event_id: eventId,
    version: 1,
    title: "Synthetic public event fixture",
    summary: "Authored fictional projection for page-service tests.",
    category: "disasters_weather",
    tags: [],
    lifecycle: "ongoing",
    freshness: {
      status: "current",
      evaluated_at: "2026-09-27T03:00:00.000Z",
      review_due_at: null,
      basis: "manual_review",
    },
    event_time: { start: null, end: null, precision: "unknown" },
    validity: { valid_from: null, valid_until: null },
    scope: { places: [], services: [], institutions: [], audiences: [] },
    claims: [],
    impacts: [],
    published_at: "2026-09-27T03:00:00.000Z",
  };
}

async function generateTestKey(): Promise<CryptoKey> {
  return await globalThis.crypto.subtle.generateKey(
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function createCodec(key: CryptoKey, now: () => number, trace?: string[]): PublicEventListCursorCodec {
  const codec = createPublicEventListCursorCodec({ key, now });
  return {
    async issue(cursor, filters) {
      trace?.push("cursor.issue");
      return await codec.issue(cursor, filters);
    },
    async decode(token, filters) {
      trace?.push("cursor.decode");
      return await codec.decode(token, filters);
    },
  };
}

function makeProjection(
  read: (request: unknown) => PublicEventListProjectionResult | Promise<PublicEventListProjectionResult>,
): PublicEventListProjectionService {
  return {
    async read(request) {
      return await read(request);
    },
  };
}

async function assertPageError(
  promise: Promise<unknown>,
  code: PublicEventListPageServiceErrorCode,
  sensitiveValues: readonly string[] = [],
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof PublicEventListPageServiceError);
    assert.equal(error.code, code);
    assert.ok(error.message.length < 100);
    for (const value of sensitiveValues) {
      if (value.length > 0) assert.equal(error.message.includes(value), false);
    }
    return true;
  });
}

test("returns the exact EventPage envelope and null cursor fields on the first end page", async () => {
  const key = await generateTestKey();
  const trace: string[] = [];
  let requestSeen: unknown;
  const service = createPublicEventListPageService({
    cursorCodec: createCodec(key, () => nowAtIssue, trace),
    projection: makeProjection((request) => {
      trace.push("list.read");
      requestSeen = request;
      return {
        events: [makeEventView()],
        nextCursor: null,
        diagnostic: "INTERNAL_LIST_DETAIL_SECRET",
      } as PublicEventListProjectionResult;
    }),
  });

  const result = await service.read(new URLSearchParams("limit=5&category=disasters_weather"));

  assert.deepEqual(requestSeen, {
    limit: 5,
    filters: { category: "disasters_weather" },
  });
  assert.deepEqual(result, {
    data: [makeEventView()],
    page: { next_cursor: null, cursor_expires_at: null },
  });
  assert.deepEqual(Object.keys(result).sort(), ["data", "page"]);
  assert.deepEqual(Object.keys(result.page).sort(), ["cursor_expires_at", "next_cursor"]);
  assert.equal(JSON.stringify(result).includes("INTERNAL_LIST_DETAIL_SECRET"), false);
  assert.deepEqual(trace, ["list.read"]);
});

test("decodes before list reads and passes only the internal keyset on continuation", async () => {
  const key = await generateTestKey();
  const trace: string[] = [];
  const codec = createCodec(key, () => nowAtIssue, trace);
  const requests: unknown[] = [];
  const filters: PublicEventListFilters = {
    category: "disasters_weather",
    q: "Heavy rain",
    place_id: "place-synthetic-01",
  };
  const service = createPublicEventListPageService({
    cursorCodec: codec,
    projection: makeProjection((request) => {
      trace.push("list.read");
      requests.push(request);
      return requests.length === 1
        ? { events: [makeEventView()], nextCursor: nextKeyset }
        : { events: [makeEventView("synthetic-list-event-02")], nextCursor: null };
    }),
  });

  const first = await service.read(new URLSearchParams(
    "limit=10&category=disasters_weather&q=Heavy+rain&place_id=place-synthetic-01",
  ));
  const expectedExpiry = new Date(nowAtIssue + 15 * 60 * 1_000).toISOString();
  assert.equal(typeof first.page.next_cursor, "string");
  assert.equal(first.page.cursor_expires_at, expectedExpiry);
  assert.deepEqual(requests[0], { limit: 10, filters });
  assert.deepEqual(trace, ["list.read", "cursor.issue"]);

  trace.length = 0;
  const second = await service.read(new URLSearchParams({
    cursor: first.page.next_cursor!,
    limit: "25",
    category: "disasters_weather",
    q: "Heavy rain",
    place_id: "place-synthetic-01",
  }));

  assert.deepEqual(trace, ["cursor.decode", "list.read"]);
  assert.deepEqual(requests[1], { limit: 25, filters, cursor: nextKeyset });
  assert.equal(JSON.stringify(requests[1]).includes(first.page.next_cursor!), false);
  assert.deepEqual(second.page, { next_cursor: null, cursor_expires_at: null });
});

test("rejects invalid queries, malformed cursors, changed filters, and expired cursors before list reads", async () => {
  const key = await generateTestKey();
  let now = nowAtIssue;
  const codec = createCodec(key, () => now);
  const filters: PublicEventListFilters = { lifecycle: "ongoing", q: "synthetic search secret" };
  const issued = await createPublicEventListCursorCodec({ key, now: () => nowAtIssue })
    .issue(nextKeyset, filters);
  let listCalls = 0;
  const service = createPublicEventListPageService({
    cursorCodec: codec,
    projection: makeProjection(() => {
      listCalls += 1;
      return { events: [], nextCursor: null };
    }),
  });

  await assertPageError(
    service.read(new URLSearchParams("cursor=raw-cursor-secret&unexpected=private-query-secret")),
    "INVALID_REQUEST",
    ["raw-cursor-secret", "private-query-secret"],
  );
  await assertPageError(
    service.read(new URLSearchParams("cursor=malformed-token-secret")),
    "INVALID_REQUEST",
    ["malformed-token-secret"],
  );
  await assertPageError(
    service.read(new URLSearchParams({
      cursor: issued.token,
      lifecycle: "resolved",
      q: "synthetic search secret",
    })),
    "INVALID_REQUEST",
    [issued.token, "synthetic search secret"],
  );

  now = Date.parse(issued.expiresAt);
  await assertPageError(
    service.read(new URLSearchParams({ cursor: issued.token, lifecycle: "ongoing", q: "synthetic search secret" })),
    "INVALID_REQUEST",
    [issued.token, "synthetic search secret"],
  );
  assert.equal(listCalls, 0);
});

test("maps projection failures and cursor-issue failures to one redacted read error", async () => {
  const key = await generateTestKey();
  const baseCodec = createPublicEventListCursorCodec({ key, now: () => nowAtIssue });
  const projectionError = createPublicEventListPageService({
    cursorCodec: baseCodec,
    projection: makeProjection(async () => {
      throw new Error("private SQL and event detail");
    }),
  });
  await assertPageError(
    projectionError.read(new URLSearchParams()),
    "PUBLIC_EVENT_LIST_READ_FAILED",
    ["private SQL", "event detail"],
  );

  const issueError = createPublicEventListPageService({
    cursorCodec: {
      async issue() {
        throw new Error("private HMAC key failure");
      },
      async decode(token, filters) {
        return await baseCodec.decode(token, filters);
      },
    },
    projection: makeProjection(() => ({ events: [makeEventView()], nextCursor: currentKeyset })),
  });
  await assertPageError(
    issueError.read(new URLSearchParams("q=private-query-value")),
    "PUBLIC_EVENT_LIST_READ_FAILED",
    ["private HMAC key failure", "private-query-value"],
  );
});

test("passes empty typed filters and omits a decoded cursor on the first page", async () => {
  const key = await generateTestKey();
  let requestSeen: unknown;
  const service = createPublicEventListPageService({
    cursorCodec: createCodec(key, () => nowAtIssue),
    projection: makeProjection((request) => {
      requestSeen = request;
      return { events: [], nextCursor: null };
    }),
  });

  await service.read(new URLSearchParams());

  assert.deepEqual(requestSeen, { limit: 20, filters: {} });
});
