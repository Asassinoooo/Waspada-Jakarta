import assert from "node:assert/strict";
import test from "node:test";
import {
  parsePublicEventListQuery,
  PublicEventListQueryError,
} from "../src/layers/l4-application-integration/public-event-list-query.js";

function assertInvalidQuery(search: URLSearchParams, sensitiveValues: readonly string[] = []): void {
  assert.throws(() => parsePublicEventListQuery(search), (error: unknown) => {
    assert.ok(error instanceof PublicEventListQueryError);
    assert.equal(error.code, "INVALID_QUERY");
    assert.equal(error.message, "The public event list query is invalid.");
    assert.ok(error.message.length < 100);
    for (const value of sensitiveValues) if (value.length > 0) assert.equal(error.message.includes(value), false);
    return true;
  });
}

test("empty and blank-text queries return bounded defaults and no effective filters", () => {
  assert.deepEqual(parsePublicEventListQuery(new URLSearchParams()), {
    limit: 20,
    cursorToken: null,
    filters: {},
  });
  assert.deepEqual(parsePublicEventListQuery(new URLSearchParams("limit=0001&q=+%09&place_id=%20")), {
    limit: 1,
    cursorToken: null,
    filters: {},
  });
});

test("parses each supported parameter without changing date or cursor strings", () => {
  const from = "2026-09-27T10:12:13.123456+07:00";
  const to = "2026-09-28T11:13:14-04:00";
  const cursor = " opaque token / preserved here ";
  const search = new URLSearchParams({
    cursor,
    limit: "100",
    category: "disasters_weather",
    lifecycle: "ongoing",
    freshness: "needs_update",
    from,
    to,
    q: "  BANJIR İNAN  ",
    place_id: "  jakarta-place-01  ",
  });
  const originalQuery = search.toString();

  assert.deepEqual(parsePublicEventListQuery(search), {
    limit: 100,
    cursorToken: cursor,
    filters: {
      category: "disasters_weather",
      lifecycle: "ongoing",
      freshness: "needs_update",
      from,
      to,
      q: "banjir i\u0307nan",
      place_id: "jakarta-place-01",
    },
  });
  assert.equal(search.toString(), originalQuery);
});

test("accepts every documented category, lifecycle, and freshness value", () => {
  const categories = [
    "crime_personal_security",
    "demonstrations_public_gatherings",
    "crowds_major_events",
    "violence_immediate_threats",
    "disasters_weather",
    "fires_infrastructure_hazards",
    "transport_road_incidents",
    "utilities_essential_services",
    "health_environmental_advisories",
    "group_specific_critical_notices",
  ];
  const lifecycles = ["planned", "ongoing", "resolved", "cancelled", "unknown"];
  const freshnessStatuses = ["current", "needs_update", "expired"];

  for (const category of categories) {
    assert.equal(parsePublicEventListQuery(new URLSearchParams({ category })).filters.category, category);
  }
  for (const lifecycle of lifecycles) {
    assert.equal(parsePublicEventListQuery(new URLSearchParams({ lifecycle })).filters.lifecycle, lifecycle);
  }
  for (const freshness of freshnessStatuses) {
    assert.equal(parsePublicEventListQuery(new URLSearchParams({ freshness })).filters.freshness, freshness);
  }
});

test("preserves date values for the accepted semantic validators", () => {
  const malformed = "not-an-rfc3339-time";
  assert.deepEqual(parsePublicEventListQuery(new URLSearchParams({ from: malformed })).filters, {
    from: malformed,
  });
});

test("rejects unknown and duplicate query parameters with one redacted error", () => {
  assertInvalidQuery(new URLSearchParams({ private_key: "sensitive-query-value" }), [
    "sensitive-query-value",
    "private_key",
  ]);
  assertInvalidQuery(new URLSearchParams("category=disasters_weather&category=ongoing"), [
    "disasters_weather",
    "ongoing",
  ]);
  assertInvalidQuery(new URLSearchParams("unknown=private-a&unknown=private-b"), [
    "private-a",
    "private-b",
  ]);
});

test("rejects values outside the documented enums", () => {
  assertInvalidQuery(new URLSearchParams({ category: "private-category-value" }), ["private-category-value"]);
  assertInvalidQuery(new URLSearchParams({ lifecycle: "private-lifecycle-value" }), ["private-lifecycle-value"]);
  assertInvalidQuery(new URLSearchParams({ freshness: "private-freshness-value" }), ["private-freshness-value"]);
});
test("rejects malformed and out-of-range page sizes", () => {
  for (const limit of ["", " ", "1.5", "1e2", "+1", "-1", "0", "101", "9007199254740992"]) {
    assertInvalidQuery(new URLSearchParams({ limit }));
  }
  assert.equal(parsePublicEventListQuery(new URLSearchParams({ limit: "1" })).limit, 1);
  assert.equal(parsePublicEventListQuery(new URLSearchParams({ limit: "100" })).limit, 100);
});

test("preserves opaque cursors and rejects blank or oversized tokens", () => {
  const opaque = "v999.not-a-real-token";
  assert.equal(parsePublicEventListQuery(new URLSearchParams({ cursor: opaque })).cursorToken, opaque);
  assertInvalidQuery(new URLSearchParams({ cursor: " \t " }), ["cursor"]);
  assertInvalidQuery(new URLSearchParams({ cursor: "x".repeat(2049) }), ["x".repeat(2049)]);
  assert.equal(parsePublicEventListQuery(new URLSearchParams({ cursor: "x".repeat(2048) })).cursorToken?.length, 2048);
});

test("normalizes trimmed text by Indonesian lowercase and enforces post-trim lengths", () => {
  assert.deepEqual(parsePublicEventListQuery(new URLSearchParams({ q: "   İSTANBUL   ", place_id: "  RW-01  " })).filters, {
    q: "i\u0307stanbul",
    place_id: "RW-01",
  });
  assert.equal(parsePublicEventListQuery(new URLSearchParams({ q: `${"a".repeat(120)}  ` })).filters.q?.length, 120);
  assert.equal(parsePublicEventListQuery(new URLSearchParams({ place_id: `${"p".repeat(128)}  ` })).filters.place_id?.length, 128);
  assertInvalidQuery(new URLSearchParams({ q: `${"private query ".repeat(9)}` }), ["private query"]);
  assertInvalidQuery(new URLSearchParams({ place_id: `${"private-place ".repeat(10)}` }), ["private-place"]);
});
