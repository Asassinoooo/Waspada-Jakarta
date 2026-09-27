import assert from "node:assert/strict";
import test from "node:test";
import type { BriefingInterests, BriefingRequest, EventView, PublicScope } from "../src/contracts/public-api.js";
import {
  projectPublicBriefing,
  PublicBriefingProjectionError,
  type PublicBriefingProjectionErrorCode,
} from "../src/layers/l4-application-integration/public-briefing-projection.js";

const generatedAt = "2026-09-27T03:00:00.000Z";

// These fictional EventViews exercise only the deterministic projection. They
// are authored test data, not live records or claims about Jakarta.
function emptyScope(): PublicScope {
  return { places: [], services: [], institutions: [], audiences: [] };
}

function makeEvent(
  eventId: string,
  options: {
    category?: EventView["category"];
    scope?: PublicScope;
    claimScope?: PublicScope;
    impactScope?: PublicScope;
    lifecycle?: EventView["lifecycle"];
    freshnessStatus?: EventView["freshness"]["status"];
  } = {},
): EventView {
  const claimScope = options.claimScope ?? emptyScope();
  const impactScope = options.impactScope ?? emptyScope();
  return {
    event_id: eventId,
    version: 3,
    title: "Pemberitahuan fiktif",
    summary: "Ringkasan fiktif untuk pengujian proyeksi.",
    category: options.category ?? "transport_road_incidents",
    tags: [{ namespace: "topic", value: "fictional_notice" }],
    lifecycle: options.lifecycle ?? "resolved",
    freshness: {
      status: options.freshnessStatus ?? "expired",
      evaluated_at: "2026-09-26T12:00:00Z",
      review_due_at: null,
      basis: "manual_review",
    },
    event_time: { start: "2026-09-25", end: null, precision: "date" },
    validity: { valid_from: null, valid_until: null },
    scope: options.scope ?? emptyScope(),
    claims: [{
      claim_id: `${eventId}-claim`,
      text: "Klaim fiktif.",
      event_time: { start: null, end: null, precision: "unknown" },
      validity: { valid_from: null, valid_until: null },
      scope: claimScope,
      qualifiers: [],
      evidence_label: "issuer_notice",
      sources: [{
        display_name: "Sumber Fiktif",
        url: "https://source.invalid/notice",
        published_at: null,
        observed_at: "2026-09-25T03:00:00Z",
        excerpt: null,
      }],
    }],
    impacts: [{
      impact_id: `${eventId}-impact`,
      version: 1,
      impact_type: "transport_service_disruption",
      title: "Dampak fiktif",
      description: "Dampak fiktif untuk pengujian.",
      lifecycle: "ongoing",
      freshness: {
        status: "needs_update",
        evaluated_at: "2026-09-26T12:00:00Z",
        review_due_at: null,
        basis: "unknown",
      },
      event_time: { start: null, end: null, precision: "unknown" },
      validity: { valid_from: null, valid_until: null },
      scope: impactScope,
    }],
    published_at: "2026-09-25T03:01:00Z",
  };
}

function makeRequest(overrides: Partial<BriefingInterests> = {}): BriefingRequest {
  return {
    interests: {
      places: [],
      services: [],
      institutions: [],
      audiences: [],
      categories: [],
      ...overrides,
    },
  };
}

function project(request: unknown, events: unknown, datasetMode?: unknown, timestamp?: unknown) {
  return projectPublicBriefing({
    datasetMode: arguments.length >= 3 ? datasetMode : "live",
    request,
    events,
    generatedAt: arguments.length >= 4 ? timestamp : generatedAt,
  });
}

function assertProjectionError(run: () => unknown, code: PublicBriefingProjectionErrorCode): void {
  assert.throws(run, (error: unknown) => error instanceof PublicBriefingProjectionError && error.code === code);
}

test("matches all five dimensions exactly across event, claim, and impact public scopes", () => {
  const event = makeEvent("event-all-dimensions", {
    category: "disasters_weather",
    scope: { ...emptyScope(), institutions: ["Dinas Fiktif"] },
    claimScope: { ...emptyScope(), places: ["Kebayoran Baru"] },
    impactScope: { ...emptyScope(), services: ["Rute Fiktif 7"], audiences: ["Pengguna Kampus"] },
  });

  const response = project(makeRequest({
    categories: ["disasters_weather"],
    places: ["  kEBAYORAN bARU  "],
    services: ["rute fiktif 7"],
    institutions: ["DINAS FIKTIF"],
    audiences: ["pengguna kampus"],
  }), [event]);

  assert.equal(response.generated_at, generatedAt);
  assert.deepEqual(response.items, [{
    event,
    relevance_reasons: [
      "Sesuai kategori yang Anda ikuti",
      "Mencakup tempat yang Anda ikuti",
      "Mencakup layanan yang Anda ikuti",
      "Mencakup instansi yang Anda ikuti",
      "Mencakup kelompok yang Anda ikuti",
    ],
  }]);
});

test("returns no matches for substring-only interests and for empty interests", () => {
  const event = makeEvent("event-exact-scope", {
    scope: { ...emptyScope(), places: ["Kebayoran Baru"] },
  });

  assert.deepEqual(project(makeRequest({ places: ["Kebayoran"] }), [event]).items, []);
  assert.deepEqual(project(makeRequest(), [event]).items, []);
});

test("deduplicates reasons when several exact interests match the same dimension", () => {
  const event = makeEvent("event-deduplicated-reason", {
    scope: { ...emptyScope(), places: ["Kebayoran Baru", "Pondok Fiktif"] },
  });
  const response = project(makeRequest({ places: ["Kebayoran Baru", "Pondok Fiktif", "kebayoran baru"] }), [event]);

  assert.deepEqual(response.items[0]?.relevance_reasons, ["Mencakup tempat yang Anda ikuti"]);
});

test("preserves event order, event values, and lifecycle/freshness without filtering", () => {
  const first = makeEvent("event-first", { category: "crime_personal_security", lifecycle: "resolved", freshnessStatus: "expired" });
  const skipped = makeEvent("event-skipped", { category: "disasters_weather", lifecycle: "ongoing", freshnessStatus: "current" });
  const last = makeEvent("event-last", { category: "crime_personal_security", lifecycle: "cancelled", freshnessStatus: "needs_update" });
  const response = project(makeRequest({ categories: ["crime_personal_security"] }), [first, skipped, last]);

  assert.deepEqual(response.items.map((item) => item.event.event_id), ["event-first", "event-last"]);
  assert.strictEqual(response.items[0]?.event, first);
  assert.strictEqual(response.items[1]?.event, last);
  assert.equal(response.items[0]?.event.lifecycle, "resolved");
  assert.equal(response.items[0]?.event.freshness.status, "expired");
  assert.equal(response.items[1]?.event.lifecycle, "cancelled");
  assert.equal(response.items[1]?.event.freshness.status, "needs_update");
});

test("uses fixed reasons without copying preference text into explanations", () => {
  const interest = "Kelurahan Fiktif 99";
  const event = makeEvent("event-fixed-reason", {
    scope: { ...emptyScope(), places: [interest] },
  });
  const reasons = project(makeRequest({ places: [interest] }), [event]).items[0]?.relevance_reasons ?? [];

  assert.deepEqual(reasons, ["Mencakup tempat yang Anda ikuti"]);
  assert.ok(reasons.every((reason) => !reason.includes(interest)));
});

test("rejects every mode other than exact live", () => {
  for (const mode of ["demo", "historical", "Live", "live ", "staging", undefined]) {
    assertProjectionError(() => project(makeRequest(), [], mode), "DATASET_MODE_UNSUPPORTED");
  }
});

test("rejects malformed, oversized, open, duplicate-category, or non-enum interests", () => {
  const valid = makeRequest();
  assertProjectionError(() => project({ ...valid, extra: true }, []), "REQUEST_INVALID");
  assertProjectionError(() => project({ interests: { places: [] } }, []), "REQUEST_INVALID");
  assertProjectionError(() => project(makeRequest({ places: Array.from({ length: 31 }, (_, index) => `Tempat ${index}`) }), []), "REQUEST_INVALID");
  assertProjectionError(() => project(makeRequest({ services: ["x".repeat(129)] }), []), "REQUEST_INVALID");
  assertProjectionError(() => project(makeRequest({ categories: ["crime_personal_security", "crime_personal_security"] }), []), "REQUEST_INVALID");
  assertProjectionError(() => project({ interests: { ...valid.interests, extra: [] } }, []), "REQUEST_INVALID");
  assertProjectionError(() => project({ interests: { ...valid.interests, categories: ["unlisted_category"] } }, []), "REQUEST_INVALID");
});

test("rejects invalid pages, overflow, duplicate event IDs, and malformed projections atomically", () => {
  assertProjectionError(() => project(makeRequest(), "not-an-array"), "EVENT_PAGE_INVALID");
  assertProjectionError(() => project(makeRequest(), Array.from({ length: 101 }, (_, index) => makeEvent(`event-overflow-${index}`))), "EVENT_PAGE_LIMIT_EXCEEDED");

  const duplicate = makeEvent("event-duplicate");
  assertProjectionError(() => project(makeRequest(), [duplicate, makeEvent("event-duplicate")]), "DUPLICATE_EVENT_ID");

  const validMatch = makeEvent("event-before-malformed", { category: "crime_personal_security" });
  const missingField = { ...makeEvent("event-malformed") } as Record<string, unknown>;
  delete missingField.summary;
  assertProjectionError(() => project(makeRequest({ categories: ["crime_personal_security"] }), [validMatch, missingField]), "EVENT_INVALID");

  const invalidTimestamp = makeEvent("event-invalid-time", { category: "crime_personal_security" });
  invalidTimestamp.freshness.evaluated_at = "2026-02-30T12:00:00Z";
  assertProjectionError(() => project(makeRequest(), [invalidTimestamp]), "EVENT_INVALID");
});

test("rejects invalid server generation timestamps", () => {
  for (const timestamp of [undefined, "yesterday", "2026-02-30T03:00:00Z", "2026-09-27T03:00:00"]) {
    assertProjectionError(() => project(makeRequest(), [], "live", timestamp), "GENERATED_AT_INVALID");
  }
});

test("keeps response and item allowlists within the existing bounds", () => {
  const events = Array.from({ length: 100 }, (_, index) => makeEvent(`event-bounded-${index}`, {
    category: "crime_personal_security",
    scope: { ...emptyScope(), places: ["Tempat Fiktif"] },
    claimScope: { ...emptyScope(), services: ["Layanan Fiktif"] },
    impactScope: { ...emptyScope(), audiences: ["Kelompok Fiktif"] },
  }));
  const response = project(makeRequest({
    categories: ["crime_personal_security"],
    places: ["Tempat Fiktif"],
    services: ["Layanan Fiktif"],
    audiences: ["Kelompok Fiktif"],
  }), events);

  assert.deepEqual(Object.keys(response).sort(), ["generated_at", "items"]);
  assert.equal(response.items.length, 100);
  for (const item of response.items) {
    assert.deepEqual(Object.keys(item).sort(), ["event", "relevance_reasons"]);
    assert.ok(item.relevance_reasons.length >= 1 && item.relevance_reasons.length <= 10);
    assert.ok(item.relevance_reasons.every((reason) => reason.length <= 200));
    assert.deepEqual(Object.keys(item.event).sort(), [
      "category", "claims", "event_id", "event_time", "freshness", "impacts", "lifecycle",
      "published_at", "scope", "summary", "tags", "title", "validity", "version",
    ]);
  }
});
