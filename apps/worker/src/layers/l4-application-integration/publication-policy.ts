/**
 * Deterministic L4 policy assessment for an explicitly reviewed proposal.
 * This module does not authenticate moderators, persist decisions, or publish
 * event versions. Model output and retrieval sufficiency are never authority.
 */
import type {
  EvidenceRetrievalCandidate,
  EvidenceRetrievalResult,
} from "../../../../db/src/evidence-retrieval.js";
import type {
  DatasetKind,
  EvidenceReference,
  GroundingContext,
  ReasoningResult,
  RevisionStatus,
} from "../l2-model-grounding/contracts.js";

export type PublicationPolicyDisposition = "publish" | "hold" | "reject";
export type EvidenceRemitStatus = "in_scope" | "out_of_scope" | "unknown";
export type EvidenceFreshnessStatus = "current" | "needs_update" | "expired" | "unknown";

/** L4 supplies this state from its current evidence assessment, never from RAG timestamps. */
export interface CurrentEvidenceState {
  readonly datasetKind: DatasetKind;
  readonly evidenceReferenceId: string;
  readonly sourceId: string;
  readonly remit: EvidenceRemitStatus;
  readonly freshness: EvidenceFreshnessStatus;
}

export type PublicationEventTarget =
  | { readonly kind: "new" }
  | { readonly kind: "update"; readonly eventId: string; readonly baseVersion: number };

export interface CurrentEventVersionSnapshot {
  readonly eventId: string;
  readonly version: number;
}

/** The authorization boolean is asserted by the trusted L4 caller; this module does not authenticate. */
export interface ExplicitModeratorDecision {
  readonly action: "approve" | "hold" | "reject";
  readonly actorId: string;
  readonly decidedAt: string;
  readonly reason: string;
  readonly trustedCallerAuthorized: boolean;
}

export interface PublicationPolicyInput {
  readonly groundingContext: GroundingContext;
  readonly reasoningResult: ReasoningResult;
  /** The result of the current RAG-CORE retrieval pass for this proposal. */
  readonly retrieval: EvidenceRetrievalResult;
  readonly currentEvidenceStates: readonly CurrentEvidenceState[];
  readonly target: PublicationEventTarget;
  readonly currentEvent: CurrentEventVersionSnapshot | null;
  readonly moderatorDecision?: ExplicitModeratorDecision | null;
}

export type EvidenceMatchStatus =
  | "matched"
  | "missing_from_context"
  | "missing_from_retrieval"
  | "ambiguous"
  | "reference_mismatch"
  | "dataset_mismatch";

export interface AssessedEvidenceReference {
  readonly reference: EvidenceReference;
  /** Present only when the exact citation maps to one current retrieval row. */
  readonly evidenceReferenceId: string | null;
  readonly matchStatus: EvidenceMatchStatus;
  readonly contextRevisionStatus: RevisionStatus | null;
  readonly retrievalRevisionStatus: EvidenceRetrievalCandidate["revisionStatus"] | null;
  readonly sourceId: string | null;
  readonly sourceApprovalStatus: EvidenceRetrievalCandidate["source"]["approvalStatus"] | null;
  /** Informational only; neither value establishes approval, remit, or freshness. */
  readonly sourceRegistryStatus: EvidenceRetrievalCandidate["source"]["registryStatus"] | null;
  readonly sourceHealthStatus: EvidenceRetrievalCandidate["source"]["healthStatus"] | null;
  /** Geometry IDs are copied only from source geometry linked to this evidence row. */
  readonly sourceGeometryIds: readonly string[];
  readonly currentEvidenceState: Pick<CurrentEvidenceState, "remit" | "freshness"> | null;
}

export interface PublicationClaimAssessment {
  readonly claimIndex: number;
  readonly disposition: PublicationPolicyDisposition;
  readonly reasonCodes: readonly PublicationPolicyReasonCode[];
  readonly support: readonly AssessedEvidenceReference[];
  readonly contradictions: readonly AssessedEvidenceReference[];
  readonly contextEvidence: readonly AssessedEvidenceReference[];
}

export interface PublicationPolicyAssessment {
  readonly datasetKind: DatasetKind;
  readonly contextId: string;
  readonly proposalOutcome: ReasoningResult["outcome"];
  readonly disposition: PublicationPolicyDisposition;
  readonly reasonCodes: readonly PublicationPolicyReasonCode[];
  readonly moderatorAction: ExplicitModeratorDecision["action"] | null;
  readonly reviewer: Pick<ExplicitModeratorDecision, "actorId" | "decidedAt" | "reason"> | null;
  readonly target: PublicationEventTarget;
  readonly currentEvent: CurrentEventVersionSnapshot | null;
  readonly unresolvedFields: readonly string[];
  readonly conflicts: readonly string[];
  readonly retrieval: {
    readonly retrievalVersion: EvidenceRetrievalResult["retrievalVersion"];
    readonly indexVersion: string | null;
    readonly scanTruncated: boolean;
    readonly resultTruncated: boolean;
    readonly invalidSpanRowsOmitted: number;
  };
  readonly claims: readonly PublicationClaimAssessment[];
}

export type PublicationPolicyReasonCode =
  | "moderator_decision_missing"
  | "moderator_decision_invalid"
  | "moderator_unauthorized"
  | "moderator_held"
  | "moderator_rejected"
  | "proposal_abstained"
  | "empty_proposal"
  | "unresolved_fields"
  | "non_live_dataset"
  | "retrieval_dataset_mismatch"
  | "retrieval_rows_dataset_mismatch"
  | "event_target_invalid"
  | "new_target_has_current_event"
  | "stale_event_version"
  | "claim_not_supported"
  | "claim_text_missing"
  | "missing_support"
  | "citation_not_in_context"
  | "citation_not_in_retrieval"
  | "citation_ambiguous"
  | "citation_mismatch"
  | "citation_relation_mismatch"
  | "source_identity_mismatch"
  | "revision_state_missing"
  | "revision_state_ambiguous"
  | "revision_not_eligible"
  | "source_not_approved"
  | "evidence_state_missing"
  | "evidence_state_ambiguous"
  | "source_out_of_scope"
  | "source_remit_unknown"
  | "evidence_not_current"
  | "evidence_freshness_unknown"
  | "geometry_not_linked_to_support";

type ReasonCode = PublicationPolicyReasonCode;

const MAX_ACTOR_ID_CODE_POINTS = 128;
const MAX_REASON_CODE_POINTS = 1_000;
const ACTOR_ID_PATTERN = /^[^\s\u0000-\u001f\u007f]+$/u;
const ENTITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RFC3339_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/;

interface ReferenceMatch {
  readonly status: EvidenceMatchStatus;
  readonly contextEntry: GroundingContext["evidence"][number] | null;
  readonly retrievalCandidate: EvidenceRetrievalCandidate | null;
  readonly reasons: readonly ReasonCode[];
}

interface BuiltReferenceAssessment {
  readonly assessed: AssessedEvidenceReference;
  readonly reasons: readonly ReasonCode[];
  readonly retrievalCandidate: EvidenceRetrievalCandidate | null;
}

/**
 * Evaluate only an explicit moderator review against exact citation lineage
 * and current L4 state. This function is pure and does not infer missing facts.
 */
export function assessPublicationPolicy(input: PublicationPolicyInput): PublicationPolicyAssessment {
  const context = input.groundingContext;
  const reasoning = input.reasoningResult;
  const globalReasons = new Set<ReasonCode>();

  const moderator = assessModeratorDecision(input.moderatorDecision);
  for (const reason of moderator.reasons) globalReasons.add(reason);

  if (reasoning.outcome === "abstained") globalReasons.add("proposal_abstained");
  if (reasoning.unresolvedFields.length > 0) globalReasons.add("unresolved_fields");
  if (reasoning.claims.length === 0) globalReasons.add("empty_proposal");
  if (context.datasetKind !== "live") globalReasons.add("non_live_dataset");

  if (input.retrieval.datasetKind !== context.datasetKind) {
    globalReasons.add("retrieval_dataset_mismatch");
  }
  if (input.retrieval.candidates.some((candidate) => candidate.datasetKind !== input.retrieval.datasetKind)) {
    globalReasons.add("retrieval_rows_dataset_mismatch");
  }

  for (const reason of assessEventTarget(input.target, input.currentEvent)) globalReasons.add(reason);

  const claims = reasoning.claims.map((claim, claimIndex) => {
    const claimReasons = new Set<ReasonCode>();
    if (claim.text.trim().length === 0) claimReasons.add("claim_text_missing");
    if (claim.supportAssessment !== "supported") claimReasons.add("claim_not_supported");
    if (claim.support.length === 0) claimReasons.add("missing_support");

    const support = claim.support.map((reference) =>
      buildReferenceAssessment(input, reference, "supports"));
    const contradictions = claim.contradictions.map((reference) =>
      buildReferenceAssessment(input, reference, "contradicts"));
    const contextEvidence = claim.contextEvidence.map((reference) =>
      buildReferenceAssessment(input, reference, "context"));

    for (const evidence of [...support, ...contradictions, ...contextEvidence]) {
      for (const reason of evidence.reasons) claimReasons.add(reason);
    }

    const supportCandidates = support
      .filter((evidence) => evidence.assessed.matchStatus === "matched"
        && evidence.assessed.reference.relation === "supports"
        && evidence.retrievalCandidate !== null)
      .map((evidence) => evidence.retrievalCandidate!);
    const linkedGeometryIds = new Set(supportCandidates.flatMap((candidate) =>
      candidate.geometryMatches.map((geometry) => geometry.geometryId)));
    if (claim.scope.geometryIds.some((geometryId) => !linkedGeometryIds.has(geometryId))) {
      claimReasons.add("geometry_not_linked_to_support");
    }

    const reasons = new Set<ReasonCode>(globalReasons);
    for (const reason of claimReasons) reasons.add(reason);
    const disposition = claimDisposition(moderator, reasons);
    return {
      claimIndex,
      disposition,
      reasonCodes: orderedReasonCodes(reasons),
      support: support.map((entry) => entry.assessed),
      contradictions: contradictions.map((entry) => entry.assessed),
      contextEvidence: contextEvidence.map((entry) => entry.assessed),
    } satisfies PublicationClaimAssessment;
  });

  const topLevelReasons = new Set(globalReasons);
  for (const claim of claims) {
    for (const reason of claim.reasonCodes) topLevelReasons.add(reason);
  }

  const disposition = proposalDisposition(moderator, claims, topLevelReasons);
  const decision = moderator.validatedDecision;
  return {
    datasetKind: context.datasetKind,
    contextId: context.contextId,
    proposalOutcome: reasoning.outcome,
    disposition,
    reasonCodes: orderedReasonCodes(topLevelReasons),
    moderatorAction: decision?.action ?? null,
    reviewer: decision && decision.trustedCallerAuthorized
      ? { actorId: decision.actorId, decidedAt: decision.decidedAt, reason: decision.reason }
      : null,
    target: input.target,
    currentEvent: input.currentEvent,
    unresolvedFields: [...reasoning.unresolvedFields],
    conflicts: [...reasoning.conflicts],
    retrieval: {
      retrievalVersion: input.retrieval.retrievalVersion,
      indexVersion: input.retrieval.indexVersion,
      scanTruncated: input.retrieval.scanTruncated,
      resultTruncated: input.retrieval.resultTruncated,
      invalidSpanRowsOmitted: input.retrieval.invalidSpanRowsOmitted,
    },
    claims,
  };
}

function buildReferenceAssessment(
  input: PublicationPolicyInput,
  reference: EvidenceReference,
  expectedRelation: "supports" | "contradicts" | "context",
): BuiltReferenceAssessment {
  const match = matchReference(input, reference);
  const reasons = new Set<ReasonCode>(match.reasons);
  if (!relationFitsGroup(reference.relation, expectedRelation)) {
    reasons.add("citation_relation_mismatch");
  }

  const contextRevisionStatus = match.contextEntry?.revisionStatus ?? null;
  const candidate = match.retrievalCandidate;
  const exactCandidate = match.status === "matched" ? candidate : null;
  const evidenceState = exactCandidate
    ? findEvidenceState(input.currentEvidenceStates, input.groundingContext.datasetKind,
      exactCandidate.evidenceReferenceId, exactCandidate.source.sourceId)
    : { value: null, reasons: [] as readonly ReasonCode[] };

  if (candidate && match.contextEntry && candidate.source.sourceId !== match.contextEntry.sourceId) {
    reasons.add("source_identity_mismatch");
  }

  if (expectedRelation === "supports" && match.status === "matched" && candidate) {
    const revisionStates = input.groundingContext.revisionStates.filter((state) =>
      state.reportRevisionId === reference.reportRevisionId);
    if (revisionStates.length === 0) reasons.add("revision_state_missing");
    else if (revisionStates.length > 1) reasons.add("revision_state_ambiguous");
    if (revisionStates.some((state) => state.revisionStatus !== "eligible")
      || contextRevisionStatus !== "eligible" || candidate.revisionStatus !== "eligible") {
      reasons.add("revision_not_eligible");
    }
    if (candidate.source.approvalStatus !== "approved") reasons.add("source_not_approved");
    for (const reason of evidenceState.reasons) reasons.add(reason);
  }

  return {
    assessed: {
      reference,
      evidenceReferenceId: match.status === "matched" ? candidate?.evidenceReferenceId ?? null : null,
      matchStatus: match.status,
      contextRevisionStatus,
      retrievalRevisionStatus: candidate?.revisionStatus ?? null,
      sourceId: candidate?.source.sourceId ?? match.contextEntry?.sourceId ?? null,
      sourceApprovalStatus: candidate?.source.approvalStatus ?? null,
      sourceRegistryStatus: candidate?.source.registryStatus ?? null,
      sourceHealthStatus: candidate?.source.healthStatus ?? null,
      sourceGeometryIds: candidate
        ? [...new Set(candidate.geometryMatches.map((geometry) => geometry.geometryId))].sort()
        : [],
      currentEvidenceState: evidenceState.value
        ? { remit: evidenceState.value.remit, freshness: evidenceState.value.freshness }
        : null,
    },
    reasons: [...reasons],
    retrievalCandidate: candidate,
  };
}

function matchReference(input: PublicationPolicyInput, reference: EvidenceReference): ReferenceMatch {
  const contextEntries = input.groundingContext.evidence.filter((entry) =>
    sameReferenceLocation(entry.reference, reference));
  if (input.retrieval.datasetKind !== input.groundingContext.datasetKind) {
    const contextExact = contextEntries.filter((entry) => entry.reference.relation === reference.relation);
    if (contextExact.length > 1) {
      return { status: "ambiguous", contextEntry: null, retrievalCandidate: null, reasons: ["citation_ambiguous"] };
    }
    return {
      status: "dataset_mismatch",
      contextEntry: contextExact[0] ?? null,
      retrievalCandidate: null,
      reasons: [],
    };
  }
  const retrievalRows = input.retrieval.candidates.filter((candidate) =>
    candidate.datasetKind === input.groundingContext.datasetKind
      && sameCandidateLocation(candidate, reference));

  const contextExact = contextEntries.filter((entry) => entry.reference.relation === reference.relation);
  const retrievalExactRows = retrievalRows.filter((candidate) => candidate.relation === reference.relation);
  const uniqueRetrieval = selectUniqueReferenceCandidate(retrievalExactRows);
  if (contextExact.length > 1 || uniqueRetrieval.ambiguous) {
    return { status: "ambiguous", contextEntry: null, retrievalCandidate: null, reasons: ["citation_ambiguous"] };
  }
  if (contextExact.length === 1 && uniqueRetrieval.candidate) {
    return {
      status: "matched",
      contextEntry: contextExact[0]!,
      retrievalCandidate: uniqueRetrieval.candidate,
      reasons: [],
    };
  }

  const reasons = new Set<ReasonCode>();
  if (contextEntries.length === 0) reasons.add("citation_not_in_context");
  else if (contextExact.length === 0) reasons.add("citation_relation_mismatch");
  if (retrievalRows.length === 0) reasons.add("citation_not_in_retrieval");
  else if (retrievalExactRows.length === 0) reasons.add("citation_relation_mismatch");
  if (contextEntries.length > 0 && retrievalRows.length > 0
    && (contextExact.length === 0 || retrievalExactRows.length === 0)) {
    reasons.add("citation_mismatch");
  }

  const contextEntry = contextExact[0] ?? null;
  const retrievalCandidate = uniqueRetrieval.candidate;
  const status: EvidenceMatchStatus = contextEntry && retrievalCandidate
    ? "matched"
    : contextEntries.length > 0 && retrievalRows.length === 0
      ? "missing_from_retrieval"
      : contextEntries.length === 0 && retrievalRows.length > 0
        ? "missing_from_context"
        : contextEntries.length === 0 && retrievalRows.length === 0
          ? "reference_mismatch"
          : "reference_mismatch";
  return { status, contextEntry, retrievalCandidate, reasons: [...reasons] };
}

function selectUniqueReferenceCandidate(
  candidates: readonly EvidenceRetrievalCandidate[],
): { readonly candidate: EvidenceRetrievalCandidate | null; readonly ambiguous: boolean } {
  if (candidates.length === 0) return { candidate: null, ambiguous: false };
  const evidenceReferenceIds = new Set(candidates.map((candidate) => candidate.evidenceReferenceId));
  if (evidenceReferenceIds.size !== 1) return { candidate: null, ambiguous: true };
  const first = candidates[0]!;
  if (candidates.some((candidate) => !sameCandidateFacts(first, candidate))) {
    return { candidate: null, ambiguous: true };
  }
  // A reference may be joined to multiple extraction candidates. The evidence
  // reference ID remains authoritative; choose a deterministic representative.
  const candidate = [...candidates].sort((left, right) => left.candidateId < right.candidateId ? -1
    : left.candidateId > right.candidateId ? 1 : 0)[0]!;
  return { candidate, ambiguous: false };
}

function sameCandidateFacts(left: EvidenceRetrievalCandidate, right: EvidenceRetrievalCandidate): boolean {
  if (left.datasetKind !== right.datasetKind
    || left.reportRevisionId !== right.reportRevisionId
    || left.permittedTextHash !== right.permittedTextHash
    || left.evidenceReferenceId !== right.evidenceReferenceId
    || left.spanStart !== right.spanStart
    || left.spanEnd !== right.spanEnd
    || left.offsetUnit !== right.offsetUnit
    || left.relation !== right.relation
    || left.revisionStatus !== right.revisionStatus
    || left.source.sourceId !== right.source.sourceId
    || left.source.approvalStatus !== right.source.approvalStatus
    || left.source.registryStatus !== right.source.registryStatus
    || left.source.healthStatus !== right.source.healthStatus) return false;
  return geometrySignature(left) === geometrySignature(right);
}

function geometrySignature(candidate: EvidenceRetrievalCandidate): string {
  return candidate.geometryMatches
    .map((geometry) => [geometry.geometryId, geometry.role, geometry.precisionM,
      geometry.precisionBasis, geometry.displayLabel ?? ""].join("\u0000"))
    .sort()
    .join("\u0001");
}

function sameReferenceLocation(left: EvidenceReference, right: EvidenceReference): boolean {
  return left.reportRevisionId === right.reportRevisionId
    && left.permittedTextHash === right.permittedTextHash
    && left.spanStart === right.spanStart
    && left.spanEnd === right.spanEnd
    && left.offsetUnit === right.offsetUnit;
}

function sameCandidateLocation(candidate: EvidenceRetrievalCandidate, reference: EvidenceReference): boolean {
  return candidate.reportRevisionId === reference.reportRevisionId
    && candidate.permittedTextHash === reference.permittedTextHash
    && candidate.spanStart === reference.spanStart
    && candidate.spanEnd === reference.spanEnd
    && candidate.offsetUnit === reference.offsetUnit;
}

function relationFitsGroup(
  relation: EvidenceReference["relation"],
  expected: "supports" | "contradicts" | "context",
): boolean {
  if (expected === "context") return relation === "context" || relation === "updates";
  return relation === expected;
}

function findEvidenceState(
  states: readonly CurrentEvidenceState[],
  datasetKind: DatasetKind,
  evidenceReferenceId: string,
  sourceId: string,
): { readonly value: CurrentEvidenceState | null; readonly reasons: readonly ReasonCode[] } {
  const matches = states.filter((state) => state.datasetKind === datasetKind
    && state.evidenceReferenceId === evidenceReferenceId && state.sourceId === sourceId);
  if (matches.length === 0) return { value: null, reasons: ["evidence_state_missing"] };
  if (matches.length > 1) return { value: null, reasons: ["evidence_state_ambiguous"] };
  const state = matches[0]!;
  const reasons: ReasonCode[] = [];
  if (state.remit === "out_of_scope") reasons.push("source_out_of_scope");
  else if (state.remit !== "in_scope") reasons.push("source_remit_unknown");
  if (state.freshness === "needs_update" || state.freshness === "expired") {
    reasons.push("evidence_not_current");
  } else if (state.freshness !== "current") {
    reasons.push("evidence_freshness_unknown");
  }
  return { value: state, reasons };
}

function assessModeratorDecision(
  decision: ExplicitModeratorDecision | null | undefined,
): {
  readonly validatedDecision: ExplicitModeratorDecision | null;
  readonly reasons: readonly ReasonCode[];
} {
  if (decision == null) {
    return { validatedDecision: null, reasons: ["moderator_decision_missing"] };
  }
  if (typeof decision !== "object" || Array.isArray(decision)) {
    return { validatedDecision: null, reasons: ["moderator_decision_invalid", "moderator_unauthorized"] };
  }
  const reasons = new Set<ReasonCode>();
  if (!isValidActorId(decision.actorId) || !isValidTimestamp(decision.decidedAt)
    || !isBoundedReason(decision.reason)
    || !["approve", "hold", "reject"].includes(decision.action)) {
    reasons.add("moderator_decision_invalid");
  }
  if (decision.trustedCallerAuthorized !== true) reasons.add("moderator_unauthorized");
  if (reasons.size > 0) return { validatedDecision: null, reasons: [...reasons] };
  if (decision.action === "hold") reasons.add("moderator_held");
  if (decision.action === "reject") reasons.add("moderator_rejected");
  return { validatedDecision: decision, reasons: [...reasons] };
}

function isValidActorId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const length = Array.from(value).length;
  return length > 0 && length <= MAX_ACTOR_ID_CODE_POINTS && value.trim() === value
    && ACTOR_ID_PATTERN.test(value);
}

function isBoundedReason(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const length = Array.from(value).length;
  return length > 0 && length <= MAX_REASON_CODE_POINTS && value.trim().length > 0
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

function isValidTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = RFC3339_PATTERN.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
    || hour > 23 || minute > 59 || second > 59) return false;
  if (offsetHourText !== undefined && (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59)) return false;
  return true;
}

function assessEventTarget(
  target: PublicationEventTarget,
  currentEvent: CurrentEventVersionSnapshot | null,
): readonly ReasonCode[] {
  if (target == null || typeof target !== "object" || Array.isArray(target)) return ["event_target_invalid"];
  if (target.kind === "new") {
    if (currentEvent === undefined) return ["event_target_invalid"];
    if (currentEvent !== null) return ["new_target_has_current_event"];
    return [];
  }
  if (target.kind !== "update" || typeof target.eventId !== "string" || !ENTITY_ID_PATTERN.test(target.eventId)
    || !Number.isSafeInteger(target.baseVersion) || target.baseVersion < 1) {
    return ["event_target_invalid"];
  }
  if (currentEvent == null || typeof currentEvent !== "object" || Array.isArray(currentEvent)
    || typeof currentEvent.eventId !== "string" || !ENTITY_ID_PATTERN.test(currentEvent.eventId)
    || !Number.isSafeInteger(currentEvent.version) || currentEvent.version < 1
    || currentEvent.eventId !== target.eventId || currentEvent.version !== target.baseVersion) {
    return ["stale_event_version"];
  }
  return [];
}

function claimDisposition(
  moderator: ReturnType<typeof assessModeratorDecision>,
  reasons: ReadonlySet<ReasonCode>,
): PublicationPolicyDisposition {
  if (moderator.validatedDecision?.action === "reject") return "reject";
  if (reasons.size > 0) return "hold";
  return "publish";
}

function proposalDisposition(
  moderator: ReturnType<typeof assessModeratorDecision>,
  claims: readonly PublicationClaimAssessment[],
  reasons: ReadonlySet<ReasonCode>,
): PublicationPolicyDisposition {
  if (moderator.validatedDecision?.action === "reject") return "reject";
  if (reasons.size > 0 || claims.length === 0) return "hold";
  return claims.every((claim) => claim.disposition === "publish") ? "publish" : "hold";
}

function orderedReasonCodes(reasons: ReadonlySet<ReasonCode>): readonly ReasonCode[] {
  return [...reasons].sort();
}
