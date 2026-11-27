import assert from "node:assert/strict";
import test from "node:test";
import type { HistoryEntry } from "../src/contracts/public-api.js";
import {
  createPublicEventHistoryProjectionService,
} from "../src/layers/l4-application-integration/public-event-history-projection-service.js";

/**
 * HIST-UI-01 fixtures. Every value is authored fiction for the history change boundary. None is a real event, review,
 * source, or publication, and none is a rights or factuality claim.
 */
const eventId = "event-hist-ui-01";
const privateMarkers = [
  "trace-hist-ui-private-marker",
  "decision-hist-ui-private-marker",
  "moderator-hist-ui-private-marker",
] as const;

type RecordValue = Record<string, unknown>;

interface RecordOverrides {
  readonly title?: string;
  readonly summary?: string;
  readonly category?: string;
  readonly lifecycle?: string;
  readonly freshnessStatus?: string;
  readonly eventTime?: RecordValue;
  readonly validity?: RecordValue;
  readonly placeIds?: readonly string[];
  readonly claimCount?: number;
  readonly impactCount?: number;
}

interface Version {
  readonly version: number;
  readonly record: RecordValue;
  readonly changeType?: string;
}

interface ScopeNameRow {
  readonly entityType: string;
  readonly id: string;
  readonly displayName: string;
}

interface PageOptions {
  readonly afterVersion?: number;
  readonly previous?: Version | null;
  readonly scopeNames?: readonly ScopeNameRow[];
}

function makeRecord(version: number, overrides: RecordOverrides = {}): RecordValue {
  return {
    schema_version: "2.0",
    trace_id: privateMarkers[0],
    record_type: "Event",
    dataset_kind: "live",
    event_id: eventId,
    version,
    supersedes_version: version === 1 ? null : version - 1,
    title: overrides.title ?? "Judul fiktif awal",
    summary: overrides.summary ?? "Ringkasan fiktif awal untuk proyeksi riwayat.",
    category: overrides.category ?? "transport_road_incidents",
    tags: [],
    lifecycle: overrides.lifecycle ?? "ongoing",
    freshness: {
      status: overrides.freshnessStatus ?? "current",
      evaluated_at: "2026-11-20T03:00:00Z",
      review_due_at: null,
      basis: "manual_review",
    },
    event_time: overrides.eventTime ?? { start: null, end: null, precision: "unknown" },
    validity: overrides.validity ?? { valid_from: null, valid_until: null },
    scope: {
      place_ids: [...(overrides.placeIds ?? ["place-hist-a"])],
      service_ids: [],
      institution_ids: [],
      audience_ids: [],
      geometry_ids: [],
    },
    claims: Array.from({ length: overrides.claimCount ?? 1 }, (_, index) => ({
      claim_id: "claim-hist-ui-" + (index + 1),
      text: "Klaim fiktif untuk proyeksi riwayat.",
    })),
    impact_refs: Array.from({ length: overrides.impactCount ?? 0 }, (_, index) => ({
      impact_id: "impact-hist-ui-" + (index + 1),
      version: 1,
    })),
    publication_status: "published",
    withdrawal_reason: null,
    publication_decision_id: privateMarkers[1] + "-" + version,
    published_at: "2026-11-20T03:" + String(version).padStart(2, "0") + ":00Z",
    withdrawn_at: null,
  };
}

function disclosureVersion(item: Version): RecordValue {
  return {
    datasetKind: "live",
    eventId,
    eventVersion: item.version,
    disclosure: {
      datasetKind: "live",
      eventId,
      eventVersion: item.version,
      reviewStatus: "approved",
      changeType: item.changeType ?? (item.version === 1 ? "published" : "corrected"),
      summary: "Ringkasan tinjauan fiktif untuk versi " + item.version + ".",
      reviewerId: privateMarkers[2],
      reviewedAt: "2026-11-20T08:00:00Z",
    },
  };
}

/** Approved names for the default place IDs. A scope ID with no approved name omits that entry's changes. */
const placeNames: readonly ScopeNameRow[] = [
  { entityType: "place", id: "place-hist-a", displayName: "Kemang Fiktif" },
  { entityType: "place", id: "place-hist-b", displayName: "Menteng Fiktif" },
  { entityType: "place", id: "place-hist-c", displayName: "Tebet Fiktif" },
];

/** Runs the L4 history projection over fake ports that hold exactly the given versions and page context. */
async function readEntries(versions: readonly Version[], options: PageOptions = {}): Promise<HistoryEntry[]> {
  const candidatePage = {
    kind: "found",
    page: {
      eventId,
      versions: versions.map((item) => ({
        datasetKind: "live",
        eventId,
        eventVersion: item.version,
        recordJson: item.record,
      })),
      nextAfterVersion: null,
      previousVersion: options.previous === null || options.previous === undefined
        ? null
        : {
          datasetKind: "live",
          eventId,
          eventVersion: options.previous.version,
          recordJson: options.previous.record,
        },
      scopeNames: options.scopeNames ?? placeNames,
    },
  };
  const disclosurePage = {
    kind: "found",
    page: {
      eventId,
      versions: versions.map((item) => disclosureVersion(item)),
      coverageComplete: true,
      nextAfterVersion: null,
    },
  };
  const service = createPublicEventHistoryProjectionService({
    candidates: { async read() { return candidatePage; } },
    disclosures: { async read() { return disclosurePage; } },
  });
  const result = await service.read(eventId, { afterVersion: options.afterVersion ?? null });
  assert.equal(result.kind, "found");
  if (result.kind !== "found") throw new Error("expected a found page");
  return [...result.page.data];
}

test("HIST-UI-01: version 1 and an unchanged version carry no changes field", async () => {
  const [first] = await readEntries([{ version: 1, record: makeRecord(1) }]);
  assert.deepEqual(Object.keys(first ?? {}), ["event_id", "version", "change_type", "changed_at", "summary"]);

  // The publication decision and the published time differ, but neither is a compared public value.
  const entries = await readEntries([
    { version: 1, record: makeRecord(1) },
    { version: 2, record: makeRecord(2) },
  ]);
  assert.equal(entries[1]?.version, 2);
  assert.equal(Object.hasOwn(entries[1] ?? {}, "changes"), false);
});

test("HIST-UI-01: a title and lifecycle change emits exactly those two changes", async () => {
  const entries = await readEntries([
    { version: 1, record: makeRecord(1) },
    { version: 2, record: makeRecord(2, { title: "Judul fiktif diperbarui", lifecycle: "resolved" }) },
  ]);
  assert.deepEqual(entries[1]?.changes, [
    { field: "title", before: "Judul fiktif awal", after: "Judul fiktif diperbarui" },
    { field: "lifecycle", before: "ongoing", after: "resolved" },
  ]);
});

test("HIST-UI-01: added and removed places are shown by their public display names", async () => {
  const entries = await readEntries([
    { version: 1, record: makeRecord(1, { placeIds: ["place-hist-a", "place-hist-b"] }) },
    { version: 2, record: makeRecord(2, { placeIds: ["place-hist-b", "place-hist-c"] }) },
  ], { scopeNames: placeNames });
  assert.deepEqual(entries[1]?.changes, [
    { field: "places", added: ["Tebet Fiktif"], removed: ["Kemang Fiktif"] },
  ]);
});

test("HIST-UI-01: claims and impacts are reported as counts only", async () => {
  const entries = await readEntries([
    { version: 1, record: makeRecord(1, { claimCount: 1, impactCount: 0 }) },
    { version: 2, record: makeRecord(2, { claimCount: 3, impactCount: 2 }) },
  ]);
  assert.deepEqual(entries[1]?.changes, [
    { field: "claims", before_count: 1, after_count: 3 },
    { field: "impacts", before_count: 0, after_count: 2 },
  ]);
});

test("HIST-UI-01: every field that differs is listed in the documented order", async () => {
  const entries = await readEntries([
    { version: 1, record: makeRecord(1) },
    {
      version: 2,
      record: makeRecord(2, {
        title: "Judul fiktif diperbarui",
        summary: "Ringkasan fiktif diperbarui.",
        category: "disasters_weather",
        lifecycle: "resolved",
        freshnessStatus: "needs_update",
        eventTime: { start: "2026-11-20", end: null, precision: "date" },
        validity: { valid_from: "2026-11-20T00:00:00Z", valid_until: null },
        placeIds: ["place-hist-b"],
        claimCount: 2,
        impactCount: 1,
      }),
    },
  ], { scopeNames: placeNames });
  assert.deepEqual((entries[1]?.changes ?? []).map((change) => change.field), [
    "title", "summary", "category", "lifecycle", "freshness", "event_time", "validity",
    "places", "claims", "impacts",
  ]);
  assert.deepEqual(entries[1]?.changes?.find((change) => change.field === "event_time"), {
    field: "event_time",
    before: null,
    after: "date 2026-11-20 -",
  });
});

test("HIST-UI-01: event time and validity use the documented text form", async () => {
  const entries = await readEntries([
    { version: 1, record: makeRecord(1) },
    {
      version: 2,
      record: makeRecord(2, {
        eventTime: { start: "2026-11-20T08:00:00+07:00", end: null, precision: "exact" },
        validity: { valid_from: null, valid_until: "2026-11-21T00:00:00Z" },
      }),
    },
  ]);
  assert.deepEqual(entries[1]?.changes, [
    { field: "event_time", before: null, after: "exact 2026-11-20T08:00:00+07:00 -" },
    { field: "validity", before: null, after: "- 2026-11-21T00:00:00Z" },
  ]);
});

test("HIST-UI-01: changes never carry trace, decision, reviewer, claim, impact or raw place identifiers", async () => {
  const entries = await readEntries([
    { version: 1, record: makeRecord(1, { claimCount: 1 }) },
    {
      version: 2,
      record: makeRecord(2, {
        title: "Judul fiktif diperbarui",
        placeIds: ["place-hist-b"],
        claimCount: 2,
        impactCount: 1,
      }),
    },
  ], { scopeNames: placeNames });
  const serialized = JSON.stringify(entries);

  assert.ok(entries[1]?.changes && entries[1].changes.length > 0, "the fixture has changes to inspect");
  for (const marker of privateMarkers) {
    assert.equal(serialized.includes(marker), false, "the output must not contain " + marker);
  }
  for (const forbidden of ["trace_id", "publication_decision_id", "reviewer", "claim-hist-ui", "impact-hist-ui", "place-hist-", "Klaim fiktif"]) {
    assert.equal(serialized.includes(forbidden), false, "the output must not contain " + forbidden);
  }
});

test("HIST-UI-01: a retracted entry keeps its existing shape", async () => {
  const entries = await readEntries([
    { version: 1, record: makeRecord(1) },
    { version: 2, record: makeRecord(2, { title: "Judul fiktif ditarik" }), changeType: "retracted" },
  ]);
  assert.equal(entries[1]?.change_type, "retracted");
  assert.equal(Object.hasOwn(entries[1] ?? {}, "changes"), false);
});

test("HIST-UI-01: a difference that the public text repair removes is not reported", async () => {
  const entries = await readEntries([
    { version: 1, record: makeRecord(1, { summary: "Ringkasan fiktif.." }) },
    { version: 2, record: makeRecord(2, { summary: "Ringkasan fiktif." }) },
  ]);
  assert.equal(Object.hasOwn(entries[1] ?? {}, "changes"), false);
});

test("HIST-UI-01: each scope list is sorted by display name and capped at 20 names", async () => {
  const addedIds = Array.from({ length: 25 }, (_, index) => "place-hist-n" + String(index + 1).padStart(2, "0"));
  const scopeNames: ScopeNameRow[] = [
    { entityType: "place", id: "place-hist-000", displayName: "Nama Lama" },
    ...addedIds.map((id, index) => ({
      entityType: "place",
      id,
      displayName: "Nama Baru " + String(index + 1).padStart(2, "0"),
    })),
  ];
  const entries = await readEntries([
    { version: 1, record: makeRecord(1, { placeIds: ["place-hist-000"] }) },
    { version: 2, record: makeRecord(2, { placeIds: addedIds }) },
  ], { scopeNames });
  const places = entries[1]?.changes?.find((change) => change.field === "places");
  assert.ok(places !== undefined && "added" in places, "the places change is present");
  assert.deepEqual(places.added, Array.from({ length: 20 }, (_, index) => "Nama Baru " + String(index + 1).padStart(2, "0")));
  assert.deepEqual(places.removed, ["Nama Lama"]);
});

test("HIST-UI-01: the first entry of a later page is compared with the reader's previous published version", async () => {
  const versions: Version[] = [
    { version: 1, record: makeRecord(1) },
    { version: 2, record: makeRecord(2, { title: "Judul fiktif kedua" }) },
    { version: 3, record: makeRecord(3, { title: "Judul fiktif kedua", lifecycle: "resolved" }) },
  ];
  const whole = await readEntries(versions);
  const laterPage = await readEntries(versions.slice(1), { afterVersion: 1, previous: versions[0] });
  assert.deepEqual(laterPage, whole.slice(1), "a page boundary does not change any entry");

  // Version 2 was withdrawn, so the nearest published version before version 3 is version 1.
  const afterWithdrawn = await readEntries([{ version: 3, record: makeRecord(3, { title: "Judul fiktif ketiga" }) }], {
    afterVersion: 2,
    previous: versions[0],
  });
  assert.deepEqual(afterWithdrawn[0]?.changes, [
    { field: "title", before: "Judul fiktif awal", after: "Judul fiktif ketiga" },
  ]);

  // With no previous published version on the page boundary, the first entry has nothing to compare with.
  const noPrevious = await readEntries([versions[1] as Version], { afterVersion: 1, previous: null });
  assert.equal(Object.hasOwn(noPrevious[0] ?? {}, "changes"), false);
});

test("HIST-UI-01 (a): an unresolved place name skips only the places diff and the title still shows", async () => {
  // Version 1 has a place with no approved name, which is how a proposal-scoped ID looks in older versions.
  const entries = await readEntries([
    { version: 1, record: makeRecord(1, { placeIds: ["place-hist-unnamed"] }) },
    { version: 2, record: makeRecord(2, { title: "Judul fiktif kedua", placeIds: ["place-hist-unnamed"] }) },
  ], { scopeNames: placeNames });
  assert.equal(entries.length, 2, "the page is still returned");
  assert.deepEqual(entries[1]?.changes, [
    { field: "title", before: "Judul fiktif awal", after: "Judul fiktif kedua" },
  ]);

  // An unresolved list on one side is skipped too, even when the other side is named.
  const named = await readEntries([
    { version: 1, record: makeRecord(1, { placeIds: ["place-hist-unnamed"] }) },
    { version: 2, record: makeRecord(2, { title: "Judul fiktif kedua", placeIds: ["place-hist-a"] }) },
  ], { scopeNames: placeNames });
  assert.deepEqual(named[1]?.changes, [
    { field: "title", before: "Judul fiktif awal", after: "Judul fiktif kedua" },
  ]);
});

test("HIST-UI-01: an unreadable scope skips only the scope diffs, and enum and count values still show", async () => {
  const entries = await readEntries([
    { version: 1, record: makeRecord(1) },
    { version: 2, record: { ...makeRecord(2, { lifecycle: "resolved", claimCount: 2 }), scope: "rusak" } },
  ]);
  assert.deepEqual(entries[1]?.changes, [
    { field: "lifecycle", before: "ongoing", after: "resolved" },
    { field: "claims", before_count: 1, after_count: 2 },
  ]);
});

test("HIST-UI-01: an unreadable text, enum or count value omits changes for the whole entry", async () => {
  const entries = await readEntries([
    { version: 1, record: makeRecord(1) },
    { version: 2, record: makeRecord(2, { title: "Judul fiktif kedua", lifecycle: "rusak" }) },
    { version: 3, record: makeRecord(3, { title: "Judul fiktif ketiga" }) },
  ]);
  assert.equal(Object.hasOwn(entries[1] ?? {}, "changes"), false, "the unreadable entry has no changes");
  assert.equal(Object.hasOwn(entries[2] ?? {}, "changes"), false, "the next entry has no readable previous version");
});

/** The summary change of one entry, asserted to be present. */
function summaryChangeOf(entry: HistoryEntry | undefined): { before: string | null; after: string | null } {
  const change = entry?.changes?.find((item) => item.field === "summary") as
    | { field: string; before: string | null; after: string | null }
    | undefined;
  assert.ok(change !== undefined, "a summary change is present");
  return change;
}

test("HIST-UI-01 (b): a summary before or after a change is capped at 600 characters at a word boundary", async () => {
  const longSummary = Array.from({ length: 150 }, (_, index) => "kata" + (index + 1)).join(" ");
  const entries = await readEntries([
    { version: 1, record: makeRecord(1, { summary: longSummary }) },
    { version: 2, record: makeRecord(2, { summary: "Ringkasan pendek." }) },
    { version: 3, record: makeRecord(3, { summary: longSummary + " lanjutan" }) },
  ]);

  // Version 2 shortens a long summary: the long side is capped, the short side is shown whole.
  const shrink = summaryChangeOf(entries[1]);
  assert.equal(shrink.after, "Ringkasan pendek.");
  assertCappedAtWordBoundary(shrink.before, longSummary);

  // Version 3 lengthens a short summary: the long side is capped.
  const grow = summaryChangeOf(entries[2]);
  assert.equal(grow.before, "Ringkasan pendek.");
  assertCappedAtWordBoundary(grow.after, longSummary + " lanjutan");

  // A text with no whitespace in reach is cut at the limit. A text of exactly the limit is not cut.
  const hard = await readEntries([
    { version: 1, record: makeRecord(1, { summary: "x".repeat(700) }) },
    { version: 2, record: makeRecord(2, { summary: "y".repeat(600) }) },
  ]);
  const hardChange = summaryChangeOf(hard[1]);
  assert.equal(hardChange.before, "x".repeat(599) + "…");
  assert.equal(hardChange.after, "y".repeat(600));
});

function assertCappedAtWordBoundary(shown: string | null, source: string): void {
  assert.notEqual(shown, null);
  const text = shown ?? "";
  assert.ok(Array.from(text).length <= 600, "at most 600 characters, the ellipsis included");
  assert.ok(text.endsWith("…"), "a cut text ends with an ellipsis");
  const prefix = text.slice(0, -1);
  assert.ok(source.startsWith(prefix), "the shown text is a prefix of the source");
  assert.equal(source.charAt(prefix.length), " ", "the cut falls on a word boundary");
  assert.ok(Array.from(text).length > 500, "the cut stays close to the limit");
}
