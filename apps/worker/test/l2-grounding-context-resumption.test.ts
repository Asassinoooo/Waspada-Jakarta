import assert from "node:assert/strict";
import { it } from "node:test";
import type {
  GroundingContextRecord,
  GroundingEvidenceReference,
} from "../../db/src/grounding-contexts.js";
import {
  ExactEvidenceSpanReadError,
  type ExactEvidenceReferenceReadRequest,
  type ExactEvidenceReferenceSnapshot,
  type ExactEvidenceSpanRequest,
} from "../../db/src/evidence-retrieval.js";
import {
  createGroundingContextResumer,
  GroundingContextResumptionError,
  type GroundingContextResumptionErrorCode,
} from "../src/layers/l2-model-grounding/context-resumption.js";

const textByEvidenceId: Readonly<Record<string, string>> = {
  "901": "supporting notice 😀",
  "902": "contrary report excerpt",
};

it("rehydrates the exact saved evidence and copies current provenance and pinned metadata", async () => {
  const record = makeRecord();
  const before = structuredClone(record);
  const fixture = makeFixture(record);

  const request = await fixture.resumer.resume("synthetic", record.context_id);

  assert.ok(request);
  const context = request.data.groundingContext;
  assert.equal(context.sufficient, false);
  assert.equal(context.datasetKind, "synthetic");
  assert.equal(context.traceId, record.trace_id);
  assert.equal(context.contextId, record.context_id);
  assert.equal(context.candidateId, record.candidate_id);
  assert.equal(context.retrievalVersion, "exact-retrieval-v7");
  assert.equal(context.indexVersion, "index-v4");
  assert.deepEqual(context.candidateEvents, [{ eventId: "event-pinned", eventVersion: 4 }]);
  assert.deepEqual(context.priorDecisionIds, ["decision-pinned"]);
  assert.deepEqual(context.missingFields, ["service_status"]);
  assert.deepEqual(context.conflicts, ["reports disagree on reopening time"]);
  assert.deepEqual(context.evidence.map((entry) => entry.reference.relation), ["supports", "contradicts"]);
  assert.deepEqual(context.evidence.map((entry) => entry.text), [
    textByEvidenceId["901"], textByEvidenceId["902"],
  ]);
  assert.deepEqual(context.evidence[0]?.reference, {
    reportRevisionId: "revision-supported",
    permittedTextHash: "a".repeat(64),
    spanStart: 0,
    spanEnd: Array.from(textByEvidenceId["901"]!).length,
    offsetUnit: "unicode_code_points",
    relation: "supports",
  });
  assert.deepEqual(context.evidence[0]?.origins, [{
    originId: "origin-primary",
    independenceStatus: "established",
    dependsOnOriginIds: [],
  }]);
  assert.deepEqual(context.evidence[1]?.origins, [{
    originId: "origin-copy",
    independenceStatus: "dependent",
    dependsOnOriginIds: ["origin-primary"],
  }]);
  assert.equal(context.evidence[0]?.sourceId, "source-supported");
  assert.equal(context.evidence[0]?.publishedAt, "2026-10-01T01:02:03.123456Z");
  assert.equal(context.evidence[0]?.observedAt, "2026-10-01T02:03:04.123456Z");
  assert.equal(context.evidence[0]?.retrievedAt, "2026-10-01T03:04:05.123456Z");
  assert.deepEqual(fixture.referenceReads, [{
    datasetKind: "synthetic",
    candidateId: "candidate-pinned",
    references: record.evidence.map((reference) => ({
      reportRevisionId: reference.report_revision_id,
      permittedTextHash: reference.permitted_text_hash,
      spanStart: reference.span_start,
      spanEnd: reference.span_end,
      offsetUnit: reference.offset_unit,
      relation: reference.relation,
    })),
  }], "resume makes one exact, bounded identity read");
  assert.deepEqual(fixture.spanReads.map((entry) => entry.evidenceReferenceId), ["901", "902"]);
  assert.equal(fixture.contextWrites, 0);
  assert.deepEqual(record, before, "resume does not mutate the persisted context object");
  assert.notStrictEqual(context.evidence, record.evidence);
  assert.equal(fixture.snapshots[0]?.healthStatus, "unavailable");
  assert.equal(context.evidence.length, 2, "source health alone does not invalidate saved evidence");
});

it("returns null for an absent exact context without resolving evidence", async () => {
  const fixture = makeFixture(null);
  assert.equal(await fixture.resumer.resume("synthetic", "context-pinned"), null);
  assert.deepEqual(fixture.referenceReads, []);
  assert.deepEqual(fixture.spanReads, []);
});

it("fails closed on missing, duplicate, cross-dataset, cross-candidate, or changed identities", async () => {
  const record = makeRecord();
  const [first] = makeSnapshots(record);
  assert.ok(first);

  const cases: readonly [string, readonly ExactEvidenceReferenceSnapshot[], GroundingContextResumptionErrorCode][] = [
    ["missing", [], "reference_not_found"],
    ["duplicate", [first, { ...first, evidenceReferenceId: "903" }], "duplicate_reference"],
    ["cross dataset", [{ ...first, datasetKind: "historical" }], "evidence_identity_mismatch"],
    ["cross candidate", [{ ...first, candidateId: "candidate-other" }], "evidence_identity_mismatch"],
    ["changed natural identity", [{ ...first, permittedTextHash: "f".repeat(64) }], "evidence_identity_mismatch"],
  ];

  for (const [name, snapshots, code] of cases) {
    const fixture = makeFixture(record, snapshots);
    await assert.rejects(
      fixture.resumer.resume("synthetic", record.context_id),
      resumptionError(code),
      name,
    );
    assert.deepEqual(fixture.spanReads, [], `${name} fails before excerpt reads`);
  }
});

it("requires the persisted revision-state set and current state to match exactly", async () => {
  const record = makeRecord();
  const snapshots = makeSnapshots(record);
  const stale = makeFixture(record, snapshots.map((snapshot) => snapshot.reportRevisionId === "revision-supported"
    ? { ...snapshot, revisionStatus: "superseded" }
    : snapshot));
  await assert.rejects(
    stale.resumer.resume("synthetic", record.context_id),
    resumptionError("revision_state_mismatch"),
  );
  assert.deepEqual(stale.spanReads, []);

  const incompleteRecord = {
    ...record,
    revision_states: record.revision_states.filter((state) => state.report_revision_id !== "revision-supported"),
  };
  const incomplete = makeFixture(incompleteRecord);
  await assert.rejects(
    incomplete.resumer.resume("synthetic", record.context_id),
    resumptionError("revision_state_mismatch"),
  );
  assert.deepEqual(incomplete.referenceReads, []);
});

it("requires current active and approved source status without using health as a validity gate", async () => {
  const record = makeRecord();
  const [first] = makeSnapshots(record);
  assert.ok(first);
  for (const snapshot of [
    { ...first, registryStatus: "paused" as const },
    { ...first, registryStatus: "retired" as const },
    { ...first, approvalStatus: "pending" as const },
    { ...first, approvalStatus: "suspended" as const },
    { ...first, approvalStatus: "revoked" as const },
  ]) {
    const fixture = makeFixture(record, [snapshot]);
    await assert.rejects(
      fixture.resumer.resume("synthetic", record.context_id),
      resumptionError("source_ineligible"),
    );
    assert.deepEqual(fixture.spanReads, []);
  }
});

it("preserves a typed source_invalidated failure from the exact-span gate", async () => {
  const fixture = makeFixture(makeRecord(), undefined, {
    spanError: new ExactEvidenceSpanReadError("source_invalidated"),
  });
  await assert.rejects(
    fixture.resumer.resume("synthetic", "context-pinned"),
    resumptionError("source_invalidated"),
  );
  assert.deepEqual(fixture.spanReads.map((request) => request.evidenceReferenceId), ["901"]);
});

it("rejects malformed current-reference state before reading excerpts", async () => {
  const record = makeRecord();
  const [first] = makeSnapshots(record);
  assert.ok(first);
  const malformed = {
    ...first,
    origins: [{ originId: "origin-primary", independenceStatus: "unverified", dependsOnOriginIds: [] }],
  } as unknown as ExactEvidenceReferenceSnapshot;
  const fixture = makeFixture(record, [malformed, ...makeSnapshots(record).slice(1)]);

  await assert.rejects(fixture.resumer.resume("synthetic", record.context_id), resumptionError("evidence_invalid"));
  assert.deepEqual(fixture.spanReads, []);
});

it("rejects an exact-span reader response for a different candidate", async () => {
  const record = makeRecord();
  const fixture = makeFixture(record, undefined, { spanIdentityMismatch: true });

  await assert.rejects(fixture.resumer.resume("synthetic", record.context_id), resumptionError("excerpt_invalid"));
  assert.deepEqual(fixture.spanReads.map((request) => request.evidenceReferenceId), ["901"]);
});

it("redacts context, retrieval, and excerpt failures and validates returned spans", async () => {
  const record = makeRecord();
  const secret = "private excerpt https://source.invalid/example";

  const contextFailure = makeFixture(record, undefined, { contextError: new Error(secret) });
  await assert.rejects(
    contextFailure.resumer.resume("synthetic", record.context_id),
    (error: unknown) => isRedactedError(error, "context_read_failed", secret),
  );

  const retrievalFailure = makeFixture(record, undefined, { referenceError: new Error(secret) });
  await assert.rejects(
    retrievalFailure.resumer.resume("synthetic", record.context_id),
    (error: unknown) => isRedactedError(error, "evidence_read_failed", secret),
  );

  const excerptFailure = makeFixture(record, undefined, { spanError: new Error(secret) });
  await assert.rejects(
    excerptFailure.resumer.resume("synthetic", record.context_id),
    (error: unknown) => isRedactedError(error, "excerpt_read_failed", secret),
  );

  const invalidSpan = makeFixture(record, undefined, { spanText: "wrong-sized" });
  await assert.rejects(
    invalidSpan.resumer.resume("synthetic", record.context_id),
    resumptionError("excerpt_invalid"),
  );

  const invalidKey = makeFixture(record);
  await assert.rejects(
    invalidKey.resumer.resume("synthetic", "source text must never appear"),
    (error: unknown) => isRedactedError(error, "invalid_resume_key", "source text"),
  );
  assert.deepEqual(invalidKey.referenceReads, []);
});

function makeRecord(overrides: Partial<GroundingContextRecord> = {}): GroundingContextRecord {
  const support = makeReference("revision-supported", textByEvidenceId["901"]!, "supports", "a".repeat(64));
  const contradiction = makeReference("revision-contrary", textByEvidenceId["902"]!, "contradicts", "b".repeat(64));
  return {
    schema_version: "2.0",
    trace_id: "trace-pinned",
    record_type: "GroundingContext",
    dataset_kind: "synthetic",
    context_id: "context-pinned",
    candidate_id: "candidate-pinned",
    evidence: [support, contradiction],
    revision_states: [
      { report_revision_id: support.report_revision_id, revision_status: "eligible" },
      { report_revision_id: contradiction.report_revision_id, revision_status: "eligible" },
    ],
    candidate_events: [{ event_id: "event-pinned", event_version: 4 }],
    prior_decision_ids: ["decision-pinned"],
    missing_fields: ["service_status"],
    conflicts: ["reports disagree on reopening time"],
    retrieval_version: "exact-retrieval-v7",
    index_version: "index-v4",
    sufficient: false,
    ...overrides,
  };
}

function makeReference(
  reportRevisionId: string,
  text: string,
  relation: GroundingEvidenceReference["relation"],
  permittedTextHash: string,
): GroundingEvidenceReference {
  return {
    report_revision_id: reportRevisionId,
    permitted_text_hash: permittedTextHash,
    span_start: 0,
    span_end: Array.from(text).length,
    offset_unit: "unicode_code_points",
    relation,
  };
}

function makeSnapshots(record: GroundingContextRecord): ExactEvidenceReferenceSnapshot[] {
  return record.evidence.map((reference, index) => ({
    datasetKind: record.dataset_kind,
    candidateId: record.candidate_id,
    evidenceReferenceId: index === 0 ? "901" : "902",
    reportRevisionId: reference.report_revision_id,
    permittedTextHash: reference.permitted_text_hash,
    spanStart: reference.span_start,
    spanEnd: reference.span_end,
    offsetUnit: reference.offset_unit,
    relation: reference.relation,
    revisionStatus: "eligible",
    sourceId: index === 0 ? "source-supported" : "source-contrary",
    registryStatus: "active",
    approvalStatus: "approved",
    healthStatus: index === 0 ? "unavailable" : "healthy",
    publishedAt: index === 0 ? "2026-10-01T01:02:03.123456Z" : null,
    observedAt: index === 0 ? "2026-10-01T02:03:04.123456Z" : "2026-10-01T04:05:06.000001Z",
    retrievedAt: index === 0 ? "2026-10-01T03:04:05.123456Z" : "2026-10-01T05:06:07.000001Z",
    origins: index === 0
      ? [{
          originId: "origin-primary",
          originKind: "issuer_statement",
          sourceId: "source-supported",
          lineageRelation: "original",
          independenceStatus: "established",
          dependsOnOriginIds: [],
        }]
      : [{
          originId: "origin-copy",
          originKind: "reporter_observation",
          sourceId: "source-contrary",
          lineageRelation: "copied",
          independenceStatus: "dependent",
          dependsOnOriginIds: ["origin-primary"],
        }],
  }));
}

function makeFixture(
  context: GroundingContextRecord | null,
  snapshots: readonly ExactEvidenceReferenceSnapshot[] = context ? makeSnapshots(context) : [],
  options: {
    readonly contextError?: Error;
    readonly referenceError?: Error;
    readonly spanError?: Error;
    readonly spanText?: string;
    readonly spanIdentityMismatch?: boolean;
  } = {},
) {
  const referenceReads: ExactEvidenceReferenceReadRequest[] = [];
  const spanReads: ExactEvidenceSpanRequest[] = [];
  const contextCalls: Array<readonly [string, string]> = [];
  let contextWrites = 0;
  const contexts = {
    async findById(datasetKind: string, contextId: string) {
      contextCalls.push([datasetKind, contextId]);
      if (options.contextError) throw options.contextError;
      return context;
    },
    async createOrVerify() {
      contextWrites += 1;
      throw new Error("unexpected write");
    },
  };
  const resumer = createGroundingContextResumer({
    contexts,
    evidenceReferences: {
      async readExactReferences(request) {
        referenceReads.push(structuredClone(request));
        if (options.referenceError) throw options.referenceError;
        return snapshots;
      },
    },
    exactSpans: {
      async readExactSpan(request) {
        spanReads.push(structuredClone(request));
        if (options.spanError) throw options.spanError;
        const result = {
          ...request,
          text: options.spanText ?? textByEvidenceId[request.evidenceReferenceId] ?? "",
        };
        return options.spanIdentityMismatch ? { ...result, candidateId: "candidate-other" } : result;
      },
    },
  });
  return { resumer, referenceReads, spanReads, contextCalls, contextWrites, snapshots };
}

function resumptionError(code: GroundingContextResumptionErrorCode) {
  return (error: unknown) => error instanceof GroundingContextResumptionError && error.code === code;
}

function isRedactedError(error: unknown, code: GroundingContextResumptionErrorCode, secret: string): boolean {
  return error instanceof GroundingContextResumptionError
    && error.code === code
    && error.message === code
    && !error.message.includes(secret)
    && !error.message.includes("https://");
}
