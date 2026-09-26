import assert from "node:assert/strict";
import test from "node:test";
import {
  createPublicEventHistoryProjectionService,
  PublicEventHistoryProjectionServiceError,
  type PublicEventHistoryProjectionReadOptions,
} from "../src/layers/l4-application-integration/public-event-history-projection-service.js";

type RecordValue = Record<string, unknown>;

const eventId = "event-synthetic-history-01";
const otherEventId = "event-synthetic-history-02";
const changeTypes = ["published", "corrected", "impact_changed", "retracted"] as const;

/**
 * These are authored fictional, live-shaped values for service-boundary tests.
 * They do not represent a real event, approval, source, or live publication.
 */
function makeEventRecord(
  version: number,
  publishedAt = "2026-09-2" + version + "T03:04:05+07:30",
  overrides: RecordValue = {},
): RecordValue {
  return {
    schema_version: "2.0",
    trace_id: "trace-synthetic-history-01",
    record_type: "Event",
    dataset_kind: "live",
    event_id: eventId,
    version,
    supersedes_version: version === 1 ? null : version - 1,
    title: "Fictional event history fixture",
    summary: "An authored fixture for the public history projection.",
    category: "disasters_weather",
    tags: [],
    lifecycle: "ongoing",
    freshness: {
      status: "current",
      evaluated_at: "2026-09-26T03:00:00Z",
      review_due_at: null,
      basis: "manual_review",
    },
    event_time: { start: null, end: null, precision: "unknown" },
    validity: { valid_from: null, valid_until: null },
    scope: {
      place_ids: ["place-synthetic-history"],
      service_ids: [],
      institution_ids: [],
      audience_ids: [],
      geometry_ids: [],
    },
    claims: [{
      claim_id: "claim-synthetic-history-01",
      text: "Fictional claim used only to shape a schema 2.0 event fixture.",
      event_time: { start: null, end: null, precision: "unknown" },
      validity: { valid_from: null, valid_until: null },
      scope: {
        place_ids: [],
        service_ids: [],
        institution_ids: [],
        audience_ids: [],
        geometry_ids: [],
      },
      qualifiers: [],
      support: [{
        report_revision_id: "revision-synthetic-history-01",
        permitted_text_hash: "a".repeat(64),
        span_start: 0,
        span_end: 10,
        offset_unit: "unicode_code_points",
        relation: "supports",
      }],
      contradictions: [],
      context_evidence: [],
      origin_ids: ["origin-synthetic-history-01"],
      evidence_label: "attributed_report",
    }],
    impact_refs: [],
    publication_status: "published",
    withdrawal_reason: null,
    publication_decision_id: "decision-synthetic-history-01",
    published_at: publishedAt,
    withdrawn_at: null,
    ...overrides,
  };
}

function makeCandidate(
  version: number,
  values: {
    eventId?: string;
    datasetKind?: string;
    recordJson?: RecordValue;
    recordOverrides?: RecordValue;
  } = {},
): RecordValue {
  return {
    datasetKind: values.datasetKind ?? "live",
    eventId: values.eventId ?? eventId,
    eventVersion: version,
    recordJson: values.recordJson ?? makeEventRecord(version, undefined, values.recordOverrides),
  };
}

function makeDisclosure(
  version: number,
  values: {
    eventId?: string;
    datasetKind?: string;
    disclosure?: RecordValue | null;
    reviewOverrides?: RecordValue;
  } = {},
): RecordValue {
  const disclosure = values.disclosure === null
    ? null
    : {
      datasetKind: values.datasetKind ?? "live",
      eventId: values.eventId ?? eventId,
      eventVersion: version,
      reviewStatus: "approved",
      changeType: "corrected",
      summary: "Fictional reviewed summary for version " + version + ".",
      reviewerId: "moderator-synthetic-01",
      reviewedAt: "2026-09-26T08:00:00Z",
      ...values.reviewOverrides,
    };
  return {
    datasetKind: values.datasetKind ?? "live",
    eventId: values.eventId ?? eventId,
    eventVersion: version,
    disclosure,
  };
}

function makeCandidateResult(
  versions: readonly unknown[],
  nextAfterVersion: number | null = null,
  pageOverrides: RecordValue = {},
): RecordValue {
  return {
    kind: "found",
    page: { eventId, versions, nextAfterVersion, ...pageOverrides },
  };
}

function makeDisclosureResult(
  versions: readonly unknown[],
  nextAfterVersion: number | null = null,
  coverageComplete = true,
  pageOverrides: RecordValue = {},
): RecordValue {
  return {
    kind: "found",
    page: { eventId, versions, coverageComplete, nextAfterVersion, ...pageOverrides },
  };
}

function createService(
  candidateResult: unknown,
  disclosureResult: unknown,
  onCandidate?: (eventId: string, options: PublicEventHistoryProjectionReadOptions) => void,
  onDisclosure?: (eventId: string, options: PublicEventHistoryProjectionReadOptions) => void,
) {
  return createPublicEventHistoryProjectionService({
    candidates: {
      async read(requestedEventId, options) {
        onCandidate?.(requestedEventId, options);
        return candidateResult;
      },
    },
    disclosures: {
      async read(requestedEventId, options) {
        onDisclosure?.(requestedEventId, options);
        return disclosureResult;
      },
    },
  });
}

async function assertProjectionError(
  promise: Promise<unknown>,
  code: PublicEventHistoryProjectionServiceError["code"],
  sensitiveValues: readonly string[] = [],
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof PublicEventHistoryProjectionServiceError);
    assert.equal(error.code, code);
    for (const value of sensitiveValues) assert.equal(error.message.includes(value), false);
    return true;
  });
}

test("projects bounded versions into only the unchanged HistoryPage allowlist", async () => {
  const candidates = [makeCandidate(1), makeCandidate(2)];
  const disclosures = [makeDisclosure(1), makeDisclosure(2, {
    reviewOverrides: {
      changeType: "impact_changed",
      reviewedAt: "2026-09-27T01:02:03Z",
      summary: "Fictional impact update approved by a test-only reviewer.",
    },
  })];
  let candidateCall: { eventId: string; options: PublicEventHistoryProjectionReadOptions } | undefined;
  let disclosureCall: { eventId: string; options: PublicEventHistoryProjectionReadOptions } | undefined;
  const service = createService(
    makeCandidateResult(candidates, 2),
    makeDisclosureResult(disclosures, 2),
    (requestedEventId, options) => { candidateCall = { eventId: requestedEventId, options }; },
    (requestedEventId, options) => { disclosureCall = { eventId: requestedEventId, options }; },
  );

  const result = await service.read(eventId, { limit: 2, afterVersion: null });
  assert.equal(result.kind, "found");
  if (result.kind !== "found") return;

  assert.deepEqual(candidateCall, { eventId, options: { limit: 2, afterVersion: null } });
  assert.deepEqual(disclosureCall, candidateCall);
  assert.deepEqual(result.page, {
    data: [
      {
        event_id: eventId,
        version: 1,
        change_type: "corrected",
        changed_at: "2026-09-21T03:04:05+07:30",
        summary: "Fictional reviewed summary for version 1.",
      },
      {
        event_id: eventId,
        version: 2,
        change_type: "impact_changed",
        changed_at: "2026-09-22T03:04:05+07:30",
        summary: "Fictional impact update approved by a test-only reviewer.",
      },
    ],
    page: { next_cursor: "2", cursor_expires_at: null },
  });
  assert.deepEqual(Object.keys(result.page).sort(), ["data", "page"]);
  assert.deepEqual(Object.keys(result.page.page).sort(), ["cursor_expires_at", "next_cursor"]);
  for (const entry of result.page.data) {
    assert.deepEqual(Object.keys(entry).sort(), [
      "change_type", "changed_at", "event_id", "summary", "version",
    ]);
    assert.equal("reviewerId" in entry, false);
    assert.equal("reviewedAt" in entry, false);
    assert.equal("recordJson" in entry, false);
  }
});

test("accepts each contract change type and a 500-code-point reviewed summary", async () => {
  const versions = changeTypes.map((_, index) => index + 1);
  const summary = "😀".repeat(500);
  const candidates = versions.map((version) => makeCandidate(version));
  const disclosures = versions.map((version, index) => makeDisclosure(version, {
    reviewOverrides: {
      changeType: changeTypes[index],
      summary: index === 0 ? summary : "Fictional summary " + version + ".",
    },
  }));
  const result = await createService(
    makeCandidateResult(candidates),
    makeDisclosureResult(disclosures),
  ).read(eventId, { limit: 4 });

  assert.equal(result.kind, "found");
  if (result.kind !== "found") return;
  assert.deepEqual(result.page.data.map((entry) => entry.change_type), changeTypes);
  assert.equal(result.page.data[0]?.summary, summary);
  assert.equal(Array.from(result.page.data[0]!.summary).length, 500);
  assert.equal(result.page.page.next_cursor, null);
  assert.equal(result.page.page.cursor_expires_at, null);
});

test("returns missing only from the candidate history reader", async () => {
  let disclosureCalls = 0;
  const service = createPublicEventHistoryProjectionService({
    candidates: { async read() { return { kind: "missing" }; } },
    disclosures: {
      async read() {
        disclosureCalls += 1;
        return makeDisclosureResult([]);
      },
    },
  });

  assert.deepEqual(await service.read(eventId), { kind: "missing" });
  assert.equal(disclosureCalls, 0);
});

test("a missing or incomplete review page fails closed for an existing event", async () => {
  const candidateResult = makeCandidateResult([makeCandidate(1)]);
  await assertProjectionError(
    createService(candidateResult, { kind: "missing" }).read(eventId),
    "DISCLOSURE_UNAVAILABLE",
  );
  await assertProjectionError(
    createService(
      candidateResult,
      makeDisclosureResult([makeDisclosure(1, { disclosure: null })], null, false),
    ).read(eventId),
    "DISCLOSURE_COVERAGE_INCOMPLETE",
  );
  await assertProjectionError(
    createService(
      candidateResult,
      makeDisclosureResult([makeDisclosure(1, { disclosure: null })]),
    ).read(eventId),
    "DISCLOSURE_COVERAGE_INCOMPLETE",
  );
});

test("held and revoked disclosure metadata is never projected", async () => {
  for (const reviewStatus of ["held", "revoked", "stale"]) {
    const result = makeDisclosure(1, { reviewOverrides: { reviewStatus } });
    await assertProjectionError(
      createService(
        makeCandidateResult([makeCandidate(1)]),
        makeDisclosureResult([result]),
      ).read(eventId),
      "DISCLOSURE_RESULT_INVALID",
    );
  }
});

test("rejects invalid identifiers and page bounds before calling either reader", async () => {
  let candidateCalls = 0;
  let disclosureCalls = 0;
  const service = createPublicEventHistoryProjectionService({
    candidates: { async read() { candidateCalls += 1; return { kind: "missing" }; } },
    disclosures: { async read() { disclosureCalls += 1; return { kind: "missing" }; } },
  });

  await assertProjectionError(service.read("invalid id"), "INVALID_EVENT_ID");
  await assertProjectionError(service.read(eventId, { limit: 0 }), "INVALID_PAGE");
  await assertProjectionError(service.read(eventId, { limit: 101 }), "INVALID_PAGE");
  await assertProjectionError(service.read(eventId, { afterVersion: 0 }), "INVALID_PAGE");
  await assertProjectionError(service.read(eventId, { afterVersion: "1" }), "INVALID_PAGE");
  await assertProjectionError(service.read(eventId, { limit: 2, unexpected: true }), "INVALID_PAGE");
  assert.equal(candidateCalls, 0);
  assert.equal(disclosureCalls, 0);
});

test("passes the same keyset boundary to both readers and serializes its next version token", async () => {
  let candidateOptions: PublicEventHistoryProjectionReadOptions | undefined;
  let disclosureOptions: PublicEventHistoryProjectionReadOptions | undefined;
  const service = createService(
    makeCandidateResult([makeCandidate(8)]),
    makeDisclosureResult([makeDisclosure(8)]),
    (_id, options) => { candidateOptions = options; },
    (_id, options) => { disclosureOptions = options; },
  );

  const result = await service.read(eventId, { limit: 3, afterVersion: 7 });
  assert.deepEqual(candidateOptions, { limit: 3, afterVersion: 7 });
  assert.deepEqual(disclosureOptions, candidateOptions);
  assert.equal(result.kind, "found");
  if (result.kind === "found") assert.equal(result.page.data[0]?.version, 8);
});

test("rejects mismatched event, version sequence, cursor, duplicates, and oversized pages", async () => {
  const oneCandidate = makeCandidateResult([makeCandidate(1)], 1);
  const oneDisclosure = makeDisclosureResult([makeDisclosure(1)], null);

  await assertProjectionError(
    createService(oneCandidate, oneDisclosure).read(eventId, { limit: 1 }),
    "PAGE_MISMATCH",
  );
  await assertProjectionError(
    createService(
      makeCandidateResult([makeCandidate(1), makeCandidate(2)]),
      makeDisclosureResult([makeDisclosure(1)]),
    ).read(eventId),
    "PAGE_MISMATCH",
  );
  await assertProjectionError(
    createService(
      makeCandidateResult([makeCandidate(1)]),
      makeDisclosureResult([makeDisclosure(1, { reviewOverrides: { eventVersion: 2 } })]),
    ).read(eventId),
    "DISCLOSURE_RESULT_INVALID",
  );
  await assertProjectionError(
    createService(
      makeCandidateResult([makeCandidate(1)], null, { unexpected: true }),
      makeDisclosureResult([makeDisclosure(1)]),
    ).read(eventId),
    "CANDIDATE_RESULT_INVALID",
  );
  await assertProjectionError(
    createService(
      makeCandidateResult([makeCandidate(1)]),
      makeDisclosureResult([makeDisclosure(1)], null, true, { unexpected: true }),
    ).read(eventId),
    "DISCLOSURE_RESULT_INVALID",
  );
  await assertProjectionError(
    createService(
      makeCandidateResult([makeCandidate(1)], null, { eventId: otherEventId }),
      makeDisclosureResult([makeDisclosure(1)]),
    ).read(eventId),
    "CANDIDATE_RESULT_INVALID",
  );
  await assertProjectionError(
    createService(
      makeCandidateResult([makeCandidate(1, { eventId: otherEventId })]),
      makeDisclosureResult([makeDisclosure(1)]),
    ).read(eventId),
    "CANDIDATE_RESULT_INVALID",
  );
  await assertProjectionError(
    createService(
      makeCandidateResult([makeCandidate(1), makeCandidate(2)], 2),
      makeDisclosureResult([makeDisclosure(1), makeDisclosure(2)], 2),
    ).read(eventId, { limit: 1 }),
    "CANDIDATE_RESULT_INVALID",
  );
  await assertProjectionError(
    createService(
      makeCandidateResult([makeCandidate(1)]),
      makeDisclosureResult([makeDisclosure(1), makeDisclosure(2)], 2),
    ).read(eventId, { limit: 1 }),
    "DISCLOSURE_RESULT_INVALID",
  );
  await assertProjectionError(
    createService(
      makeCandidateResult([makeCandidate(1)]),
      makeDisclosureResult([makeDisclosure(1)], null, true, { eventId: otherEventId }),
    ).read(eventId),
    "DISCLOSURE_RESULT_INVALID",
  );
  await assertProjectionError(
    createService(
      makeCandidateResult([makeCandidate(1), makeCandidate(1)]),
      makeDisclosureResult([makeDisclosure(1), makeDisclosure(1)]),
    ).read(eventId, { limit: 2 }),
    "CANDIDATE_RESULT_INVALID",
  );
  await assertProjectionError(
    createService(
      makeCandidateResult([makeCandidate(2), makeCandidate(1)]),
      makeDisclosureResult([makeDisclosure(2), makeDisclosure(1)]),
    ).read(eventId, { limit: 2 }),
    "CANDIDATE_RESULT_INVALID",
  );
  await assertProjectionError(
    createService(
      makeCandidateResult([makeCandidate(1), makeCandidate(2)], 2),
      makeDisclosureResult([makeDisclosure(1), makeDisclosure(1)], 1),
    ).read(eventId, { limit: 2 }),
    "DISCLOSURE_RESULT_INVALID",
  );
  await assertProjectionError(
    createService(
      makeCandidateResult([makeCandidate(1), makeCandidate(2)], 2),
      makeDisclosureResult([makeDisclosure(1), makeDisclosure(2)], 2),
    ).read(eventId, { limit: 1 }),
    "CANDIDATE_RESULT_INVALID",
  );
  await assertProjectionError(
    createService(
      makeCandidateResult([makeCandidate(1)], 2),
      makeDisclosureResult([makeDisclosure(1)], 1),
    ).read(eventId, { limit: 1 }),
    "CANDIDATE_RESULT_INVALID",
  );
});

test("rejects non-live, withdrawn, identity-mismatched, or malformed event records", async () => {
  const cases: Array<{ readonly candidate: RecordValue; readonly code: string }> = [
    { candidate: makeCandidate(1, { datasetKind: "synthetic" }), code: "CANDIDATE_RESULT_INVALID" },
    {
      candidate: makeCandidate(1, { recordOverrides: { dataset_kind: "historical" } }),
      code: "CANDIDATE_RESULT_INVALID",
    },
    {
      candidate: makeCandidate(1, { recordOverrides: { publication_status: "withdrawn" } }),
      code: "CANDIDATE_RESULT_INVALID",
    },
    {
      candidate: makeCandidate(1, { recordOverrides: { event_id: otherEventId } }),
      code: "CANDIDATE_RESULT_INVALID",
    },
    {
      candidate: makeCandidate(1, { recordOverrides: { version: 2 } }),
      code: "CANDIDATE_RESULT_INVALID",
    },
    {
      candidate: makeCandidate(1, { recordOverrides: { supersedes_version: 0 } }),
      code: "CANDIDATE_RESULT_INVALID",
    },
    {
      candidate: makeCandidate(1, { recordOverrides: { withdrawal_reason: "withdrawal marker" } }),
      code: "CANDIDATE_RESULT_INVALID",
    },
    {
      candidate: makeCandidate(1, { recordOverrides: { withdrawn_at: "2026-09-21T04:00:00Z" } }),
      code: "CANDIDATE_RESULT_INVALID",
    },
    {
      candidate: makeCandidate(1, { recordOverrides: { publication_decision_id: "" } }),
      code: "CANDIDATE_RESULT_INVALID",
    },
    {
      candidate: makeCandidate(1, { recordOverrides: { published_at: "2026-02-30T00:00:00Z" } }),
      code: "CANDIDATE_RESULT_INVALID",
    },
    {
      candidate: makeCandidate(1, { recordOverrides: { published_at: "yesterday" } }),
      code: "CANDIDATE_RESULT_INVALID",
    },
    {
      candidate: makeCandidate(1, { recordOverrides: { extra_private_field: "must fail" } }),
      code: "CANDIDATE_RESULT_INVALID",
    },
  ];

  for (const { candidate, code } of cases) {
    await assertProjectionError(
      createService(
        makeCandidateResult([candidate]),
        makeDisclosureResult([makeDisclosure(1)]),
      ).read(eventId),
      code as PublicEventHistoryProjectionServiceError["code"],
    );
  }
});

test("rejects invalid change types and summaries over 500 Unicode code points", async () => {
  for (const reviewOverrides of [
    { changeType: "correction" },
    { summary: " \n\t " },
    { summary: "😀".repeat(501) },
  ]) {
    await assertProjectionError(
      createService(
        makeCandidateResult([makeCandidate(1)]),
        makeDisclosureResult([makeDisclosure(1, { reviewOverrides })]),
      ).read(eventId),
      "DISCLOSURE_RESULT_INVALID",
    );
  }
});

test("converts reader exceptions into stable redacted errors", async () => {
  const candidateFailure = createPublicEventHistoryProjectionService({
    candidates: {
      async read() {
        throw new Error("secret database details for " + eventId);
      },
    },
    disclosures: { async read() { return makeDisclosureResult([]); } },
  });
  await assertProjectionError(
    candidateFailure.read(eventId),
    "CANDIDATE_READ_FAILED",
    [eventId, "secret database details"],
  );

  const disclosureFailure = createPublicEventHistoryProjectionService({
    candidates: { async read() { return makeCandidateResult([makeCandidate(1)]); } },
    disclosures: {
      async read() {
        throw new Error("reviewer-private-details");
      },
    },
  });
  await assertProjectionError(
    disclosureFailure.read(eventId),
    "DISCLOSURE_READ_FAILED",
    ["reviewer-private-details"],
  );
});