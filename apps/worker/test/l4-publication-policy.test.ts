import assert from "node:assert/strict";
import test from "node:test";
import type {
  EvidenceRetrievalCandidate,
  EvidenceRetrievalResult,
} from "../../db/src/evidence-retrieval.js";
import type {
  EvidenceReference,
  GroundingContext,
  ProposedClaim,
  ReasoningResult,
} from "../src/layers/l2-model-grounding/contracts.js";
import {
  assessPublicationPolicy,
  type CurrentEvidenceState,
  type ExplicitModeratorDecision,
  type PublicationPolicyInput,
} from "../src/layers/l4-application-integration/publication-policy.js";

const supportText = "🚧 Jalan Merdeka ditutup sementara.";
const supportReference: EvidenceReference = {
  reportRevisionId: "revision-support-synthetic",
  permittedTextHash: "a".repeat(64),
  spanStart: 0,
  spanEnd: Array.from(supportText).length,
  offsetUnit: "unicode_code_points",
  relation: "supports",
};
const contradictionText = "Synthetic account says the road reopened.";
const contradictionReference: EvidenceReference = {
  reportRevisionId: "revision-contradiction-synthetic",
  permittedTextHash: "b".repeat(64),
  spanStart: 0,
  spanEnd: Array.from(contradictionText).length,
  offsetUnit: "unicode_code_points",
  relation: "contradicts",
};
const contextText = "Synthetic note gives nearby context.";
const contextReference: EvidenceReference = {
  reportRevisionId: "revision-context-synthetic",
  permittedTextHash: "c".repeat(64),
  spanStart: 0,
  spanEnd: Array.from(contextText).length,
  offsetUnit: "unicode_code_points",
  relation: "context",
};

const moderatorDecision: ExplicitModeratorDecision = {
  action: "approve",
  actorId: "moderator-synthetic-1",
  decidedAt: "2026-09-25T09:00:00+07:00",
  reason: "Synthetic manual review approved for the policy test.",
  trustedCallerAuthorized: true,
};

function makeContext(
  references: readonly EvidenceReference[] = [supportReference, contradictionReference, contextReference],
): GroundingContext {
  return {
    schemaVersion: "2.0",
    recordType: "GroundingContext",
    datasetKind: "synthetic",
    traceId: "trace-synthetic-policy",
    contextId: "context-synthetic-policy",
    candidateId: "candidate-synthetic-policy",
    evidence: references.map((reference) => ({
      reference,
      text: reference.reportRevisionId === supportReference.reportRevisionId
        ? supportText
        : reference.reportRevisionId === contradictionReference.reportRevisionId
          ? contradictionText
          : contextText,
      sourceId: `source-for-${reference.reportRevisionId}`,
      revisionStatus: "eligible",
      publishedAt: null,
      observedAt: null,
      retrievedAt: "2026-09-25T08:45:00+07:00",
      origins: [],
    })),
    revisionStates: references.map((reference) => ({
      reportRevisionId: reference.reportRevisionId,
      revisionStatus: "eligible",
    })),
    candidateEvents: [],
    priorDecisionIds: [],
    missingFields: [],
    conflicts: [],
    retrievalVersion: "hybrid-evidence-v1",
    indexVersion: "synthetic-index-v1",
    // This field is routing metadata; it must not authorize or block L4 publication.
    sufficient: false,
  };
}

function makeCandidate(
  reference: EvidenceReference,
  evidenceReferenceId: string,
  overrides: Partial<EvidenceRetrievalCandidate> = {},
): EvidenceRetrievalCandidate {
  const defaultCandidate: EvidenceRetrievalCandidate = {
    datasetKind: "synthetic",
    candidateId: "candidate-synthetic-policy",
    reportRevisionId: reference.reportRevisionId,
    permittedTextHash: reference.permittedTextHash,
    evidenceReferenceId,
    spanStart: reference.spanStart,
    spanEnd: reference.spanEnd,
    offsetUnit: reference.offsetUnit,
    relation: reference.relation === "updates" ? "context" : reference.relation,
    spanText: "Synthetic evidence only.",
    spanTextStart: 0,
    spanTextEnd: 25,
    spanTextTruncated: false,
    revisionStatus: "eligible",
    source: {
      sourceId: `source-for-${reference.reportRevisionId}`,
      displayName: "Synthetic test source",
      sourceKind: "other",
      publisherGroupId: null,
      // Lifecycle and source health are informational; explicit approval/remit/freshness gate publication.
      registryStatus: "retired",
      approvalStatus: "approved",
      healthStatus: "unavailable",
    },
    publishedAt: null,
    observedAt: null,
    retrievedAt: "2026-09-25T08:46:00+07:00",
    validFrom: null,
    validUntil: null,
    eventTime: { start: null, end: null, precision: "unknown", status: "unknown" },
    origins: [],
    originLineageStatus: "unknown",
    geometryMatches: [{
      geometryId: "geometry-synthetic-road",
      role: "incident_scene",
      precisionM: 25,
      precisionBasis: "source_defined",
      displayLabel: "Synthetic road geometry",
    }],
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
  return {
    ...defaultCandidate,
    ...overrides,
    source: { ...defaultCandidate.source, ...overrides.source },
  };
}

function makeRetrieval(
  candidates: readonly EvidenceRetrievalCandidate[] = [
    makeCandidate(supportReference, "evidence-ref-synthetic-support"),
    makeCandidate(contradictionReference, "evidence-ref-synthetic-contradiction"),
    makeCandidate(contextReference, "evidence-ref-synthetic-context"),
  ],
  overrides: Partial<EvidenceRetrievalResult> = {},
): EvidenceRetrievalResult {
  return {
    datasetKind: "synthetic",
    retrievalVersion: "hybrid-evidence-v1",
    indexVersion: "synthetic-index-v1",
    candidates,
    rowsExamined: candidates.length,
    filteredRowsOmitted: 0,
    invalidSpanRowsOmitted: 0,
    scanTruncated: false,
    resultTruncated: false,
    semanticStatus: "not_requested",
    ...overrides,
  };
}

function makeClaim(overrides: Partial<ProposedClaim> = {}): ProposedClaim {
  return {
    text: "Jalan Merdeka ditutup sementara.",
    eventTime: { start: null, end: null, precision: "unknown" },
    validity: { validFrom: null, validUntil: null },
    scope: {
      placeIds: [],
      serviceIds: [],
      institutionIds: [],
      audienceIds: [],
      geometryIds: [],
    },
    qualifiers: [],
    support: [supportReference],
    contradictions: [],
    contextEvidence: [],
    supportAssessment: "supported",
    ...overrides,
  };
}

function makeReasoningResult(claims: readonly ProposedClaim[] = [makeClaim()], overrides: Partial<ReasoningResult> = {}): ReasoningResult {
  return {
    outcome: "proposed",
    claims,
    unresolvedFields: [],
    conflicts: [],
    modelRun: {
      capability: "reasoning",
      modelVersion: "synthetic-model-v1",
      promptVersion: "synthetic-prompt-v1",
      inputTokens: 0,
      outputTokens: 0,
    },
    provider: "synthetic-only",
    ...overrides,
  };
}

function makeEvidenceStates(
  candidates: readonly EvidenceRetrievalCandidate[] = [makeCandidate(supportReference, "evidence-ref-synthetic-support")],
): readonly CurrentEvidenceState[] {
  return candidates.map((candidate) => ({
    datasetKind: candidate.datasetKind,
    evidenceReferenceId: candidate.evidenceReferenceId,
    sourceId: candidate.source.sourceId,
    remit: "in_scope",
    freshness: "current",
  }));
}

function makeInput(overrides: Partial<PublicationPolicyInput> = {}): PublicationPolicyInput {
  const retrieval = makeRetrieval();
  return {
    groundingContext: makeContext(),
    reasoningResult: makeReasoningResult(),
    retrieval,
    currentEvidenceStates: makeEvidenceStates(retrieval.candidates),
    target: { kind: "new" },
    currentEvent: null,
    moderatorDecision,
    ...overrides,
  };
}

/**
 * These remain in-memory synthetic values; changing the dataset discriminator
 * exercises the live-only policy branch without using a live source/database.
 */
function makeSyntheticFixtureInputForDataset(
  datasetKind: "live" | "historical" | "synthetic",
): PublicationPolicyInput {
  const base = makeInput();
  const candidates = base.retrieval.candidates.map((candidate) => ({ ...candidate, datasetKind }));
  return {
    ...base,
    groundingContext: { ...base.groundingContext, datasetKind },
    retrieval: { ...base.retrieval, datasetKind, candidates },
    currentEvidenceStates: base.currentEvidenceStates.map((state) => ({ ...state, datasetKind })),
  };
}

test("publishes only after explicit authorized review and exact current evidence checks", () => {
  const input = makeSyntheticFixtureInputForDataset("live");
  const result = assessPublicationPolicy(input);

  assert.equal(result.disposition, "publish");
  assert.equal(result.claims[0]?.claimIndex, 0);
  assert.equal(result.claims[0]?.disposition, "publish");
  assert.equal(result.claims[0]?.support[0]?.evidenceReferenceId, "evidence-ref-synthetic-support");
  assert.equal(result.claims[0]?.support[0]?.currentEvidenceState?.freshness, "current");
  assert.equal(result.claims[0]?.support[0]?.sourceApprovalStatus, "approved");
  assert.equal(result.claims[0]?.support[0]?.sourceRegistryStatus, "retired");
  assert.equal(result.claims[0]?.support[0]?.sourceHealthStatus, "unavailable");
  assert.equal(result.reasonCodes.length, 0);
  assert.deepEqual(assessPublicationPolicy(input), result);
});

test("model support and context sufficiency do not authorize without moderator review", () => {
  const result = assessPublicationPolicy(makeInput({
    groundingContext: { ...makeContext(), sufficient: true },
    moderatorDecision: null,
  }));

  assert.equal(result.disposition, "hold");
  assert.equal(result.claims[0]?.disposition, "hold");
  assert.ok(result.reasonCodes.includes("moderator_decision_missing"));
});

test("historical and synthetic datasets cannot publish, while exact same-dataset citations remain linked", () => {
  for (const datasetKind of ["synthetic", "historical"] as const) {
    const result = assessPublicationPolicy(makeSyntheticFixtureInputForDataset(datasetKind));
    assert.equal(result.disposition, "hold");
    assert.equal(result.claims[0]?.disposition, "hold");
    assert.ok(result.reasonCodes.includes("non_live_dataset"));
    assert.equal(result.claims[0]?.support[0]?.matchStatus, "matched");
    assert.equal(result.claims[0]?.support[0]?.evidenceReferenceId, "evidence-ref-synthetic-support");
  }
});

test("unauthorized, held, rejected, and malformed moderator decisions fail closed", () => {
  const unauthorized = assessPublicationPolicy(makeInput({
    moderatorDecision: { ...moderatorDecision, trustedCallerAuthorized: false },
  }));
  assert.equal(unauthorized.disposition, "hold");
  assert.ok(unauthorized.reasonCodes.includes("moderator_unauthorized"));

  const held = assessPublicationPolicy(makeInput({
    moderatorDecision: { ...moderatorDecision, action: "hold" },
  }));
  assert.equal(held.disposition, "hold");
  assert.ok(held.reasonCodes.includes("moderator_held"));

  const rejected = assessPublicationPolicy(makeInput({
    moderatorDecision: { ...moderatorDecision, action: "reject" },
  }));
  assert.equal(rejected.disposition, "reject");
  assert.equal(rejected.claims[0]?.disposition, "reject");

  const invalid = assessPublicationPolicy(makeInput({
    moderatorDecision: { ...moderatorDecision, decidedAt: "2026-02-30T09:00:00Z" },
  }));
  assert.equal(invalid.disposition, "hold");
  assert.ok(invalid.reasonCodes.includes("moderator_decision_invalid"));
});

test("keeps contradictory and contextual references separate from supporting references", () => {
  const claim = makeClaim({
    supportAssessment: "uncertain",
    contradictions: [contradictionReference],
    contextEvidence: [contextReference],
  });
  const result = assessPublicationPolicy(makeInput({ reasoningResult: makeReasoningResult([claim]) }));

  assert.equal(result.disposition, "hold");
  assert.ok(result.reasonCodes.includes("claim_not_supported"));
  assert.deepEqual(result.claims[0]?.support.map((entry) => entry.reference.relation), ["supports"]);
  assert.deepEqual(result.claims[0]?.contradictions.map((entry) => entry.reference.relation), ["contradicts"]);
  assert.deepEqual(result.claims[0]?.contextEvidence.map((entry) => entry.reference.relation), ["context"]);
  assert.equal(result.claims[0]?.contradictions[0]?.evidenceReferenceId, "evidence-ref-synthetic-contradiction");
  assert.equal(result.claims[0]?.contextEvidence[0]?.evidenceReferenceId, "evidence-ref-synthetic-context");
});

test("a retrieval join duplicate with the same stored reference ID is deduplicated deterministically", () => {
  const liveInput = makeSyntheticFixtureInputForDataset("live");
  const rows = liveInput.retrieval.candidates;
  const support = rows[0]!;
  const duplicateJoin = { ...support, candidateId: "candidate-synthetic-policy-duplicate" };
  const result = assessPublicationPolicy({
    ...liveInput,
    retrieval: makeRetrieval([...rows, duplicateJoin], { datasetKind: "live" }),
    // The current evidence state is keyed by reference ID, so it appears once.
    currentEvidenceStates: makeEvidenceStates(rows),
  });

  assert.equal(result.disposition, "publish");
  assert.equal(result.claims[0]?.support[0]?.evidenceReferenceId, support.evidenceReferenceId);
});

test("an update relation accepted as context by L2 is not coerced to the stored context relation", () => {
  const updateReference: EvidenceReference = { ...contextReference, relation: "updates" };
  const claim = makeClaim({
    supportAssessment: "uncertain",
    contextEvidence: [updateReference],
  });
  const result = assessPublicationPolicy(makeInput({
    groundingContext: makeContext([supportReference, updateReference]),
    reasoningResult: makeReasoningResult([claim]),
  }));

  assert.equal(result.disposition, "hold");
  assert.ok(result.claims[0]?.reasonCodes.includes("citation_relation_mismatch"));
  assert.equal(result.claims[0]?.contextEvidence[0]?.reference.relation, "updates");
  assert.equal(result.claims[0]?.contextEvidence[0]?.evidenceReferenceId, null);
});

test("context or contradiction citations cannot substitute for support", () => {
  const contextOnly = makeClaim({ support: [], contextEvidence: [contextReference] });
  const result = assessPublicationPolicy(makeInput({ reasoningResult: makeReasoningResult([contextOnly]) }));

  assert.equal(result.disposition, "hold");
  assert.ok(result.claims[0]?.reasonCodes.includes("missing_support"));
  assert.equal(result.claims[0]?.support.length, 0);
  assert.equal(result.claims[0]?.contextEvidence[0]?.evidenceReferenceId, "evidence-ref-synthetic-context");
});

test("holds when the revision is not eligible, source is unapproved, remit is unknown, or freshness is not current", () => {
  const baseCandidate = makeCandidate(supportReference, "evidence-ref-synthetic-support");
  const revision = assessPublicationPolicy(makeInput({
    retrieval: makeRetrieval([
      makeCandidate(supportReference, baseCandidate.evidenceReferenceId, { revisionStatus: "superseded" }),
      makeCandidate(contradictionReference, "evidence-ref-synthetic-contradiction"),
      makeCandidate(contextReference, "evidence-ref-synthetic-context"),
    ]),
  }));
  assert.equal(revision.disposition, "hold");
  assert.ok(revision.reasonCodes.includes("revision_not_eligible"));

  const source = assessPublicationPolicy(makeInput({
    retrieval: makeRetrieval([
      makeCandidate(supportReference, baseCandidate.evidenceReferenceId, { source: { approvalStatus: "pending" } as EvidenceRetrievalCandidate["source"] }),
      makeCandidate(contradictionReference, "evidence-ref-synthetic-contradiction"),
      makeCandidate(contextReference, "evidence-ref-synthetic-context"),
    ]),
  }));
  assert.equal(source.disposition, "hold");
  assert.ok(source.reasonCodes.includes("source_not_approved"));

  const states = makeEvidenceStates([baseCandidate]);
  const remit = assessPublicationPolicy(makeInput({ currentEvidenceStates: [{ ...states[0]!, remit: "unknown" }] }));
  assert.equal(remit.disposition, "hold");
  assert.ok(remit.reasonCodes.includes("source_remit_unknown"));

  const freshness = assessPublicationPolicy(makeInput({ currentEvidenceStates: [{ ...states[0]!, freshness: "needs_update" }] }));
  assert.equal(freshness.disposition, "hold");
  assert.ok(freshness.reasonCodes.includes("evidence_not_current"));

  const outOfScope = assessPublicationPolicy(makeInput({ currentEvidenceStates: [{
    ...states[0]!,
    remit: "out_of_scope",
  }] }));
  assert.equal(outOfScope.disposition, "hold");
  assert.ok(outOfScope.reasonCodes.includes("source_out_of_scope"));

  const expired = assessPublicationPolicy(makeInput({ currentEvidenceStates: [{
    ...states[0]!,
    freshness: "expired",
  }] }));
  assert.equal(expired.disposition, "hold");
  assert.ok(expired.reasonCodes.includes("evidence_not_current"));
});

test("unknown and missing current evidence state never falls back to retrieval timestamps", () => {
  const missing = assessPublicationPolicy(makeInput({ currentEvidenceStates: [] }));
  assert.equal(missing.disposition, "hold");
  assert.ok(missing.reasonCodes.includes("evidence_state_missing"));

  const candidate = makeCandidate(supportReference, "evidence-ref-synthetic-support");
  const unknown = assessPublicationPolicy(makeInput({
    currentEvidenceStates: [{
      datasetKind: "synthetic",
      evidenceReferenceId: candidate.evidenceReferenceId,
      sourceId: candidate.source.sourceId,
      remit: "in_scope",
      freshness: "unknown",
    }],
  }));
  assert.equal(unknown.disposition, "hold");
  assert.ok(unknown.reasonCodes.includes("evidence_freshness_unknown"));
});

test("requires exact dataset, revision, hash, offsets, unit, and relation matches", () => {
  const contextMismatch = assessPublicationPolicy(makeInput({
    groundingContext: makeContext([contradictionReference, contextReference]),
  }));
  assert.equal(contextMismatch.disposition, "hold");
  assert.ok(contextMismatch.reasonCodes.includes("citation_not_in_context"));

  const retrievalRows = makeRetrieval().candidates.map((candidate) =>
    candidate.evidenceReferenceId === "evidence-ref-synthetic-support"
      ? { ...candidate, permittedTextHash: "d".repeat(64) }
      : candidate);
  const hashMismatch = assessPublicationPolicy(makeInput({ retrieval: makeRetrieval(retrievalRows) }));
  assert.equal(hashMismatch.disposition, "hold");
  assert.ok(hashMismatch.reasonCodes.includes("citation_not_in_retrieval"));

  const relationRows = makeRetrieval().candidates.map((candidate) =>
    candidate.evidenceReferenceId === "evidence-ref-synthetic-support"
      ? { ...candidate, relation: "contradicts" as const }
      : candidate);
  const relationMismatch = assessPublicationPolicy(makeInput({ retrieval: makeRetrieval(relationRows) }));
  assert.equal(relationMismatch.disposition, "hold");
  assert.ok(relationMismatch.reasonCodes.includes("citation_relation_mismatch"));

  const offsetRows = makeRetrieval().candidates.map((candidate) =>
    candidate.evidenceReferenceId === "evidence-ref-synthetic-support"
      ? { ...candidate, spanEnd: candidate.spanEnd - 1 }
      : candidate);
  const offsetMismatch = assessPublicationPolicy(makeInput({ retrieval: makeRetrieval(offsetRows) }));
  assert.equal(offsetMismatch.disposition, "hold");
  assert.ok(offsetMismatch.reasonCodes.includes("citation_not_in_retrieval"));

  const crossDataset = assessPublicationPolicy(makeInput({
    retrieval: makeRetrieval([], { datasetKind: "live" }),
  }));
  assert.equal(crossDataset.disposition, "hold");
  assert.ok(crossDataset.reasonCodes.includes("retrieval_dataset_mismatch"));
  assert.equal(crossDataset.claims[0]?.support[0]?.matchStatus, "dataset_mismatch");
});

test("ambiguous reference IDs fail closed instead of selecting one retrieval row", () => {
  const candidates = makeRetrieval().candidates;
  const duplicateSupport = makeCandidate(supportReference, "another-evidence-ref-synthetic-support");
  const retrieval = makeRetrieval([...candidates, duplicateSupport]);
  const states = [...makeEvidenceStates(candidates), ...makeEvidenceStates([duplicateSupport])];
  const result = assessPublicationPolicy(makeInput({ retrieval, currentEvidenceStates: states }));

  assert.equal(result.disposition, "hold");
  assert.ok(result.claims[0]?.reasonCodes.includes("citation_ambiguous"));
  assert.equal(result.claims[0]?.support[0]?.evidenceReferenceId, null);
  assert.equal(result.claims[0]?.support[0]?.matchStatus, "ambiguous");
});

test("geometry can pass only when linked to cited supporting source evidence", () => {
  const linked = makeClaim({
    scope: {
      placeIds: [], serviceIds: [], institutionIds: [], audienceIds: [],
      geometryIds: ["geometry-synthetic-road"],
    },
  });
  const accepted = assessPublicationPolicy({
    ...makeSyntheticFixtureInputForDataset("live"),
    reasoningResult: makeReasoningResult([linked]),
  });
  assert.equal(accepted.disposition, "publish");

  const unlinked = makeClaim({
    scope: {
      placeIds: [], serviceIds: [], institutionIds: [], audienceIds: [],
      geometryIds: ["geometry-not-in-synthetic-evidence"],
    },
  });
  const held = assessPublicationPolicy({
    ...makeSyntheticFixtureInputForDataset("live"),
    reasoningResult: makeReasoningResult([unlinked]),
  });
  assert.equal(held.disposition, "hold");
  assert.ok(held.reasonCodes.includes("geometry_not_linked_to_support"));
});

test("event updates require an exact current ID/version pair and new targets have no current event", () => {
  const matching = assessPublicationPolicy({
    ...makeSyntheticFixtureInputForDataset("live"),
    target: { kind: "update", eventId: "event-synthetic-1", baseVersion: 3 },
    currentEvent: { eventId: "event-synthetic-1", version: 3 },
  });
  assert.equal(matching.disposition, "publish");

  const stale = assessPublicationPolicy({
    ...makeSyntheticFixtureInputForDataset("live"),
    target: { kind: "update", eventId: "event-synthetic-1", baseVersion: 3 },
    currentEvent: { eventId: "event-synthetic-1", version: 4 },
  });
  assert.equal(stale.disposition, "hold");
  assert.ok(stale.reasonCodes.includes("stale_event_version"));

  const newWithCurrent = assessPublicationPolicy({
    ...makeSyntheticFixtureInputForDataset("live"),
    target: { kind: "new" },
    currentEvent: { eventId: "event-synthetic-1", version: 1 },
  });
  assert.equal(newWithCurrent.disposition, "hold");
  assert.ok(newWithCurrent.reasonCodes.includes("new_target_has_current_event"));
});

test("abstentions, unresolved fields, and empty proposals remain held", () => {
  const abstained = assessPublicationPolicy(makeInput({
    reasoningResult: makeReasoningResult([makeClaim()], { outcome: "abstained" }),
  }));
  assert.equal(abstained.disposition, "hold");
  assert.ok(abstained.reasonCodes.includes("proposal_abstained"));

  const unresolved = assessPublicationPolicy(makeInput({
    reasoningResult: makeReasoningResult([makeClaim()], { unresolvedFields: ["event_time"] }),
  }));
  assert.equal(unresolved.disposition, "hold");
  assert.ok(unresolved.reasonCodes.includes("unresolved_fields"));

  const empty = assessPublicationPolicy(makeInput({ reasoningResult: makeReasoningResult([]) }));
  assert.equal(empty.disposition, "hold");
  assert.ok(empty.reasonCodes.includes("empty_proposal"));
  assert.equal(empty.claims.length, 0);
});

test("dispositions remain per claim and use zero-based proposal indexes", () => {
  const result = assessPublicationPolicy({
    ...makeSyntheticFixtureInputForDataset("live"),
    reasoningResult: makeReasoningResult([
      makeClaim(),
      makeClaim({ supportAssessment: "disputed" }),
    ]),
  });

  assert.equal(result.disposition, "hold");
  assert.deepEqual(result.claims.map((claim) => [claim.claimIndex, claim.disposition]), [
    [0, "publish"],
    [1, "hold"],
  ]);
});

test("reason codes and reference mapping are stable regardless of retrieval row order", () => {
  const rows = makeRetrieval().candidates;
  const first = assessPublicationPolicy(makeInput({
    retrieval: makeRetrieval(rows),
    currentEvidenceStates: [],
  }));
  const second = assessPublicationPolicy(makeInput({
    retrieval: makeRetrieval([...rows].reverse()),
    currentEvidenceStates: [],
  }));

  assert.deepEqual(first, second);
  assert.deepEqual(first.reasonCodes, [...first.reasonCodes].sort());
  assert.deepEqual(first.claims[0]?.reasonCodes, [...first.claims[0]!.reasonCodes].sort());
});
