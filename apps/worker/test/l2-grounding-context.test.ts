import assert from "node:assert/strict";
import { it } from "node:test";
import type {
  ExactEvidenceSpanReader,
  ExactEvidenceSpanRequest,
  EvidenceRetrievalCandidate,
  EvidenceRetrievalResult,
} from "../../db/src/evidence-retrieval.js";
import {
  GroundingContextAssemblyError,
  assembleGroundingReasoningRequest,
  type GroundingContextAssemblyInput,
} from "../src/layers/l2-model-grounding/grounding-context.js";

const retrievalTime = "2026-09-26T05:00:00Z";

it("assembles exact selected spans with relations, timestamps, revision states, and origin lineage", async () => {
  const candidates = [
    makeCandidate({
      evidenceReferenceId: "104",
      reportRevisionId: "revision-primary",
      spanStart: 4,
      relation: "supports",
      revisionStatus: "eligible",
      exactText: "support 😀",
      sourceId: "source-primary",
      publishedAt: "2026-09-25T01:02:03Z",
      observedAt: "2026-09-25T02:03:04Z",
      retrievedAt: "2026-09-25T03:04:05Z",
      origins: [{
        originId: "origin-primary",
        originKind: "issuer_statement",
        sourceId: "source-primary",
        lineageRelation: "original",
        independenceStatus: "established",
        dependsOnOriginIds: [],
      }],
    }),
    makeCandidate({
      evidenceReferenceId: "105",
      reportRevisionId: "revision-primary",
      spanStart: 30,
      relation: "contradicts",
      revisionStatus: "eligible",
      exactText: "against it",
      sourceId: "source-copy",
      publishedAt: null,
      observedAt: "2026-09-25T04:05:06Z",
      retrievedAt: "2026-09-25T06:07:08Z",
      origins: [{
        originId: "origin-copy",
        originKind: "reporter_observation",
        sourceId: "source-copy",
        lineageRelation: "copied",
        independenceStatus: "dependent",
        dependsOnOriginIds: ["origin-primary"],
      }],
    }),
    makeCandidate({
      evidenceReferenceId: "106",
      reportRevisionId: "revision-update",
      spanStart: 0,
      relation: "updates",
      revisionStatus: "quarantined",
      exactText: "changed time",
      sourceId: "source-update",
      publishedAt: "2026-09-25T07:08:09Z",
      observedAt: null,
      retrievedAt: "2026-09-25T08:09:10Z",
      origins: [{
        originId: "origin-update",
        originKind: "unknown",
        sourceId: "source-update",
        lineageRelation: "unknown",
        independenceStatus: "unknown",
        dependsOnOriginIds: [],
      }],
    }),
    makeCandidate({
      evidenceReferenceId: "107",
      reportRevisionId: "revision-update",
      spanStart: 20,
      relation: "context",
      revisionStatus: "quarantined",
      exactText: "background",
      sourceId: "source-context",
      publishedAt: null,
      observedAt: "2026-09-25T09:10:11Z",
      retrievedAt: "2026-09-25T10:11:12Z",
      origins: [],
    }),
  ];
  const retrieval = makeRetrieval(candidates, null);
  const caller = makeInput(retrieval, ["107", "104", "105", "106"], true);
  const reader = createReader(candidates);

  const request = await assembleGroundingReasoningRequest(reader, caller);
  const context = request.data.groundingContext;

  assert.equal(context.sufficient, true);
  assert.equal(context.indexVersion, "not_applicable");
  assert.deepEqual(context.candidateEvents, caller.candidateEvents);
  assert.deepEqual(context.priorDecisionIds, caller.priorDecisionIds);
  assert.deepEqual(context.missingFields, caller.missingFields);
  assert.deepEqual(context.conflicts, caller.conflicts);
  assert.deepEqual(context.evidence.map((entry) => entry.reference.relation), [
    "context", "supports", "contradicts", "updates",
  ]);
  assert.deepEqual(context.evidence.map((entry) => entry.text), [
    "background", "support 😀", "against it", "changed time",
  ]);
  assert.deepEqual(context.revisionStates, [
    { reportRevisionId: "revision-update", revisionStatus: "quarantined" },
    { reportRevisionId: "revision-primary", revisionStatus: "eligible" },
  ]);
  assert.deepEqual(context.evidence[2]?.origins, [{
    originId: "origin-copy",
    independenceStatus: "dependent",
    dependsOnOriginIds: ["origin-primary"],
  }]);
  assert.equal(context.evidence[0]?.sourceId, "source-context");
  assert.equal(context.evidence[1]?.publishedAt, "2026-09-25T01:02:03Z");
  assert.equal(context.evidence[1]?.observedAt, "2026-09-25T02:03:04Z");
  assert.equal(context.evidence[1]?.retrievedAt, "2026-09-25T03:04:05Z");
  assert.deepEqual(reader.requests.map((request) => request.evidenceReferenceId), caller.evidenceReferenceIds);
  assert.equal(caller.evidenceReferenceIds.length, 4, "assembly does not mutate caller selection");
});

it("copies explicit false sufficiency and an available index version without assessment", async () => {
  const candidates = [makeCandidate({
    evidenceReferenceId: "201",
    reportRevisionId: "revision-single",
    spanStart: 0,
    relation: "supports",
    revisionStatus: "eligible",
    exactText: "synthetic evidence",
  })];
  const retrieval = makeRetrieval(candidates, "synthetic-index-v4");
  const request = await assembleGroundingReasoningRequest(
    createReader(candidates),
    makeInput(retrieval, ["201"], false),
  );

  assert.equal(request.data.groundingContext.sufficient, false);
  assert.equal(request.data.groundingContext.indexVersion, "synthetic-index-v4");
});

it("rejects truncated or invalid retrieval snapshots before exact reads", async () => {
  const candidate = makeCandidate({
    evidenceReferenceId: "301",
    reportRevisionId: "revision-truncated",
    spanStart: 0,
    relation: "supports",
    revisionStatus: "eligible",
    exactText: "evidence",
  });
  const base = makeRetrieval([candidate], null);

  for (const retrieval of [
    { ...base, scanTruncated: true },
    { ...base, resultTruncated: true },
    { ...base, invalidSpanRowsOmitted: 1 },
  ]) {
    const reader = createReader([candidate]);
    await assert.rejects(
      assembleGroundingReasoningRequest(reader, makeInput(retrieval, ["301"], true)),
      assemblyError("retrieval_incomplete"),
    );
    assert.equal(reader.requests.length, 0);
  }
});

it("fails closed on empty-sufficient, over-limit, duplicate, or cross-identity selections", async () => {
  const candidates = [
    makeCandidate({
      evidenceReferenceId: "401",
      reportRevisionId: "revision-one",
      spanStart: 0,
      relation: "supports",
      revisionStatus: "eligible",
      exactText: "first",
    }),
    makeCandidate({
      evidenceReferenceId: "402",
      reportRevisionId: "revision-two",
      spanStart: 0,
      relation: "supports",
      revisionStatus: "eligible",
      exactText: "second",
    }),
  ];
  const retrieval = makeRetrieval(candidates, null);
  const reader = createReader(candidates);

  await assert.rejects(
    assembleGroundingReasoningRequest(reader, makeInput(retrieval, [], true)),
    assemblyError("empty_sufficient_context"),
  );
  await assert.rejects(
    assembleGroundingReasoningRequest(reader, makeInput(retrieval, Array(9).fill("401"), false)),
    assemblyError("reference_limit_exceeded"),
  );
  await assert.rejects(
    assembleGroundingReasoningRequest(reader, makeInput(retrieval, ["401", "401"], false)),
    assemblyError("duplicate_reference_identity"),
  );
  await assert.rejects(
    assembleGroundingReasoningRequest(reader, { ...makeInput(retrieval, ["401"], false), candidateId: "different-candidate" }),
    assemblyError("candidate_mismatch"),
  );
  await assert.rejects(
    assembleGroundingReasoningRequest(reader, { ...makeInput(retrieval, ["401"], false), datasetKind: "historical" }),
    assemblyError("dataset_mismatch"),
  );
  const crossCandidate = { ...candidates[1]!, candidateId: "candidate-unselected" };
  await assert.rejects(
    assembleGroundingReasoningRequest(
      createReader([candidates[0]!, crossCandidate]),
      makeInput(makeRetrieval([candidates[0]!, crossCandidate], null), ["401"], false),
    ),
    assemblyError("candidate_mismatch"),
  );

  const duplicateNaturalIdentity = {
    ...candidates[0]!,
    evidenceReferenceId: "403",
  };
  await assert.rejects(
    assembleGroundingReasoningRequest(
      createReader([...candidates, duplicateNaturalIdentity]),
      makeInput(makeRetrieval([...candidates, duplicateNaturalIdentity], null), ["401", "403"], false),
    ),
    assemblyError("duplicate_reference_identity"),
  );
  assert.equal(reader.requests.length, 0, "invalid selections are rejected before span reads");
});

it("rejects oversized spans and stale or malformed exact-reader results", async () => {
  const candidate = makeCandidate({
    evidenceReferenceId: "501",
    reportRevisionId: "revision-large",
    spanStart: 0,
    spanEnd: 40_001,
    relation: "supports",
    revisionStatus: "eligible",
    exactText: "x".repeat(40_001),
  });
  const retrieval = makeRetrieval([candidate], null);
  const oversizedReader = createReader([candidate]);
  await assert.rejects(
    assembleGroundingReasoningRequest(oversizedReader, makeInput(retrieval, ["501"], false)),
    assemblyError("span_too_large"),
  );
  assert.equal(oversizedReader.requests.length, 0);

  const normal = makeCandidate({
    evidenceReferenceId: "502",
    reportRevisionId: "revision-normal",
    spanStart: 3,
    relation: "contradicts",
    revisionStatus: "quarantined",
    exactText: "no closure",
  });
  const normalRetrieval = makeRetrieval([normal], null);
  const identityMismatchReader: ExactEvidenceSpanReader = {
    async readExactSpan(request) {
      return { ...request, permittedTextHash: "f".repeat(64), text: "no closure" };
    },
  };
  await assert.rejects(
    assembleGroundingReasoningRequest(identityMismatchReader, makeInput(normalRetrieval, ["502"], false)),
    assemblyError("rehydrated_identity_mismatch"),
  );

  const staleRevisionReader: ExactEvidenceSpanReader = {
    async readExactSpan(request) {
      return { ...request, revisionStatus: "eligible", text: "no closure" };
    },
  };
  await assert.rejects(
    assembleGroundingReasoningRequest(staleRevisionReader, makeInput(normalRetrieval, ["502"], false)),
    assemblyError("rehydrated_identity_mismatch"),
  );

  const shortSpanReader: ExactEvidenceSpanReader = {
    async readExactSpan(request) {
      return { ...request, text: "short" };
    },
  };
  await assert.rejects(
    assembleGroundingReasoningRequest(shortSpanReader, makeInput(normalRetrieval, ["502"], false)),
    assemblyError("rehydrated_span_mismatch"),
  );
});

it("runs schema 2.0 validation after copying caller fields", async () => {
  const candidate = makeCandidate({
    evidenceReferenceId: "601",
    reportRevisionId: "revision-validation",
    spanStart: 0,
    relation: "context",
    revisionStatus: "eligible",
    exactText: "valid exact span",
  });
  const input = {
    ...makeInput(makeRetrieval([candidate], null), ["601"], false),
    conflicts: ["same", "same"],
  } as unknown as GroundingContextAssemblyInput;

  await assert.rejects(
    assembleGroundingReasoningRequest(createReader([candidate]), input),
    (error: unknown) => error instanceof Error && error.name === "ContractValidationError",
  );
});

interface CandidateFixtureInput {
  readonly evidenceReferenceId: string;
  readonly reportRevisionId: string;
  readonly spanStart: number;
  readonly spanEnd?: number;
  readonly relation: EvidenceRetrievalCandidate["relation"];
  readonly revisionStatus: EvidenceRetrievalCandidate["revisionStatus"];
  readonly exactText: string;
  readonly sourceId?: string;
  readonly publishedAt?: string | null;
  readonly observedAt?: string | null;
  readonly retrievedAt?: string;
  readonly origins?: EvidenceRetrievalCandidate["origins"];
}

function makeCandidate(input: CandidateFixtureInput): EvidenceRetrievalCandidate {
  const spanEnd = input.spanEnd ?? input.spanStart + Array.from(input.exactText).length;
  const excerpt = input.exactText.slice(0, 5);
  return {
    datasetKind: "synthetic",
    candidateId: "candidate-synthetic-context",
    reportRevisionId: input.reportRevisionId,
    permittedTextHash: input.reportRevisionId === "revision-two" ? "b".repeat(64) : "a".repeat(64),
    evidenceReferenceId: input.evidenceReferenceId,
    spanStart: input.spanStart,
    spanEnd,
    offsetUnit: "unicode_code_points",
    relation: input.relation,
    spanText: excerpt,
    spanTextStart: input.spanStart,
    spanTextEnd: input.spanStart + Array.from(excerpt).length,
    spanTextTruncated: Array.from(excerpt).length < spanEnd - input.spanStart,
    revisionStatus: input.revisionStatus,
    source: {
      sourceId: input.sourceId ?? `source-${input.evidenceReferenceId}`,
      displayName: "Synthetic fixture source",
      sourceKind: "other",
      publisherGroupId: null,
      registryStatus: "active",
      approvalStatus: "approved",
      healthStatus: "healthy",
    },
    publishedAt: input.publishedAt === undefined ? null : input.publishedAt,
    observedAt: input.observedAt === undefined ? null : input.observedAt,
    retrievedAt: input.retrievedAt ?? retrievalTime,
    validFrom: null,
    validUntil: null,
    eventTime: { start: null, end: null, precision: null, status: "unknown" },
    origins: input.origins ?? [],
    originLineageStatus: input.origins?.length ? "recorded" : "unknown",
    geometryMatches: [],
    chunk: null,
    matchFacets: {
      identifiers: [],
      exactTerms: [],
      reportTimeFields: [],
      eventTime: false,
      geometry: false,
      semanticDistance: null,
    },
  };
}

function makeRetrieval(
  candidates: readonly EvidenceRetrievalCandidate[],
  indexVersion: string | null,
): EvidenceRetrievalResult {
  return {
    datasetKind: "synthetic",
    retrievalVersion: "hybrid-evidence-v1",
    indexVersion,
    candidates,
    rowsExamined: candidates.length,
    filteredRowsOmitted: 0,
    invalidSpanRowsOmitted: 0,
    scanTruncated: false,
    resultTruncated: false,
    semanticStatus: "not_requested",
  };
}

function makeInput(
  retrieval: EvidenceRetrievalResult,
  evidenceReferenceIds: readonly string[],
  sufficient: boolean,
): GroundingContextAssemblyInput {
  return {
    retrieval,
    datasetKind: "synthetic",
    traceId: "trace-synthetic-context",
    contextId: "context-synthetic-context",
    candidateId: "candidate-synthetic-context",
    evidenceReferenceIds,
    candidateEvents: [{ eventId: "event-synthetic-match", eventVersion: 3 }],
    priorDecisionIds: ["decision-synthetic-prior"],
    missingFields: ["service_resume_confirmation"],
    conflicts: ["synthetic sources disagree on current status"],
    sufficient,
  };
}

function createReader(candidates: readonly EvidenceRetrievalCandidate[]): ExactEvidenceSpanReader & {
  readonly requests: ExactEvidenceSpanRequest[];
} {
  const requests: ExactEvidenceSpanRequest[] = [];
  const byId = new Map(candidates.map((candidate) => [candidate.evidenceReferenceId, candidate]));
  return {
    requests,
    async readExactSpan(request) {
      requests.push(request);
      const candidate = byId.get(request.evidenceReferenceId);
      if (!candidate) throw new Error("synthetic fixture reader cannot find reference");
      const exactText = exactTextById.get(request.evidenceReferenceId);
      return {
        ...request,
        text: exactText ?? candidate.spanText,
      };
    },
  };
}

const exactTextById = new Map<string, string>([
  ["104", "support 😀"],
  ["105", "against it"],
  ["106", "changed time"],
  ["107", "background"],
  ["201", "synthetic evidence"],
  ["301", "evidence"],
  ["401", "first"],
  ["402", "second"],
  ["403", "first"],
  ["502", "no closure"],
  ["601", "valid exact span"],
]);

function assemblyError(code: string) {
  return (error: unknown) => error instanceof GroundingContextAssemblyError && error.code === code;
}
