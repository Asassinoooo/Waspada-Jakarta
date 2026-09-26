import {
  MAX_EXACT_EVIDENCE_SPAN_CODE_POINTS,
  type ExactEvidenceSpanReader,
  type ExactEvidenceSpanRequest,
  type EvidenceRetrievalCandidate,
  type EvidenceRetrievalResult,
} from "../../../../db/src/evidence-retrieval.js";
import type {
  CandidateEventVersion,
  DatasetKind,
  EvidenceReference,
  ReasoningRequest,
} from "./contracts.js";
import { validateReasoningRequest } from "./validation.js";

export interface GroundingContextAssemblyInput {
  readonly retrieval: EvidenceRetrievalResult;
  readonly datasetKind: DatasetKind;
  readonly traceId: string;
  readonly contextId: string;
  readonly candidateId: string;
  /** Evidence-reference IDs are selected explicitly by the caller. */
  readonly evidenceReferenceIds: readonly string[];
  /** Context adjacent to evidence is copied as supplied and never assessed. */
  readonly candidateEvents: readonly CandidateEventVersion[];
  readonly priorDecisionIds: readonly string[];
  readonly missingFields: readonly string[];
  readonly conflicts: readonly string[];
  readonly sufficient: boolean;
}

export type GroundingContextAssemblyErrorCode =
  | "retrieval_incomplete"
  | "dataset_mismatch"
  | "reference_limit_exceeded"
  | "empty_sufficient_context"
  | "selected_reference_missing"
  | "duplicate_reference_identity"
  | "candidate_mismatch"
  | "revision_state_mismatch"
  | "span_too_large"
  | "rehydrated_identity_mismatch"
  | "rehydrated_span_mismatch"
  | "caller_input_invalid";

export class GroundingContextAssemblyError extends Error {
  constructor(readonly code: GroundingContextAssemblyErrorCode) {
    super(code);
    this.name = "GroundingContextAssemblyError";
  }
}

/**
 * Rehydrates only caller-selected exact evidence spans and builds a closed
 * schema 2.0 reasoning request. This adapter makes no sufficiency judgment.
 */
export async function assembleGroundingReasoningRequest(
  reader: ExactEvidenceSpanReader,
  input: GroundingContextAssemblyInput,
): Promise<ReasoningRequest> {
  const retrieval = input?.retrieval;
  if (!retrieval || !Array.isArray(retrieval.candidates)
    || retrieval.scanTruncated || retrieval.resultTruncated || retrieval.invalidSpanRowsOmitted > 0) {
    throw new GroundingContextAssemblyError("retrieval_incomplete");
  }
  if (retrieval.datasetKind !== input.datasetKind
    || retrieval.candidates.some((candidate) => candidate.datasetKind !== retrieval.datasetKind)) {
    throw new GroundingContextAssemblyError("dataset_mismatch");
  }
  if (retrieval.candidates.some((candidate) => candidate.candidateId !== input.candidateId)) {
    throw new GroundingContextAssemblyError("candidate_mismatch");
  }
  if (typeof input.sufficient !== "boolean"
    || !Array.isArray(input.evidenceReferenceIds)
    || !Array.isArray(input.candidateEvents)
    || !Array.isArray(input.priorDecisionIds)
    || !Array.isArray(input.missingFields)
    || !Array.isArray(input.conflicts)) {
    throw new GroundingContextAssemblyError("caller_input_invalid");
  }
  if (input.evidenceReferenceIds.length > 8) {
    throw new GroundingContextAssemblyError("reference_limit_exceeded");
  }
  if (input.sufficient && input.evidenceReferenceIds.length === 0) {
    throw new GroundingContextAssemblyError("empty_sufficient_context");
  }

  const selectedIds = new Set<string>();
  for (const evidenceReferenceId of input.evidenceReferenceIds) {
    if (typeof evidenceReferenceId !== "string" || selectedIds.has(evidenceReferenceId)) {
      throw new GroundingContextAssemblyError("duplicate_reference_identity");
    }
    selectedIds.add(evidenceReferenceId);
  }

  const selectedCandidates: EvidenceRetrievalCandidate[] = [];
  const selectedNaturalIdentities = new Set<string>();
  const revisionStates = new Map<string, EvidenceRetrievalCandidate["revisionStatus"]>();
  for (const evidenceReferenceId of input.evidenceReferenceIds) {
    const matches = retrieval.candidates.filter((candidate) => candidate.evidenceReferenceId === evidenceReferenceId);
    if (matches.length === 0) throw new GroundingContextAssemblyError("selected_reference_missing");
    if (matches.length !== 1) throw new GroundingContextAssemblyError("duplicate_reference_identity");

    const candidate = matches[0]!;
    if (candidate.datasetKind !== input.datasetKind || candidate.candidateId !== input.candidateId) {
      throw new GroundingContextAssemblyError("candidate_mismatch");
    }
    if (candidate.offsetUnit !== "unicode_code_points"
      || !Number.isSafeInteger(candidate.spanStart)
      || !Number.isSafeInteger(candidate.spanEnd)
      || candidate.spanStart < 0
      || candidate.spanEnd <= candidate.spanStart) {
      throw new GroundingContextAssemblyError("rehydrated_identity_mismatch");
    }
    if (candidate.spanEnd - candidate.spanStart > MAX_EXACT_EVIDENCE_SPAN_CODE_POINTS) {
      throw new GroundingContextAssemblyError("span_too_large");
    }

    const naturalIdentity = evidenceIdentityKey(candidate);
    if (selectedNaturalIdentities.has(naturalIdentity)) {
      throw new GroundingContextAssemblyError("duplicate_reference_identity");
    }
    selectedNaturalIdentities.add(naturalIdentity);

    const priorRevisionStatus = revisionStates.get(candidate.reportRevisionId);
    if (priorRevisionStatus !== undefined && priorRevisionStatus !== candidate.revisionStatus) {
      throw new GroundingContextAssemblyError("revision_state_mismatch");
    }
    revisionStates.set(candidate.reportRevisionId, candidate.revisionStatus);
    selectedCandidates.push(candidate);
  }

  const evidence = [];
  for (const candidate of selectedCandidates) {
    const exactSpanRequest: ExactEvidenceSpanRequest = {
      datasetKind: candidate.datasetKind,
      candidateId: candidate.candidateId,
      evidenceReferenceId: candidate.evidenceReferenceId,
      reportRevisionId: candidate.reportRevisionId,
      permittedTextHash: candidate.permittedTextHash,
      spanStart: candidate.spanStart,
      spanEnd: candidate.spanEnd,
      offsetUnit: candidate.offsetUnit,
      relation: candidate.relation,
      revisionStatus: candidate.revisionStatus,
    };
    const exactSpan = await reader.readExactSpan(exactSpanRequest);
    if (!sameExactSpanIdentity(exactSpan, exactSpanRequest)) {
      throw new GroundingContextAssemblyError("rehydrated_identity_mismatch");
    }
    if (typeof exactSpan.text !== "string"
      || codePointCount(exactSpan.text) !== candidate.spanEnd - candidate.spanStart
      || codePointCount(exactSpan.text) > MAX_EXACT_EVIDENCE_SPAN_CODE_POINTS) {
      throw new GroundingContextAssemblyError("rehydrated_span_mismatch");
    }

    const reference: EvidenceReference = {
      reportRevisionId: candidate.reportRevisionId,
      permittedTextHash: candidate.permittedTextHash,
      spanStart: candidate.spanStart,
      spanEnd: candidate.spanEnd,
      offsetUnit: candidate.offsetUnit,
      relation: candidate.relation,
    };
    evidence.push({
      reference,
      text: exactSpan.text,
      sourceId: candidate.source.sourceId,
      revisionStatus: candidate.revisionStatus,
      publishedAt: candidate.publishedAt,
      observedAt: candidate.observedAt,
      retrievedAt: candidate.retrievedAt,
      origins: candidate.origins.map((origin) => ({
        originId: origin.originId,
        independenceStatus: origin.independenceStatus,
        dependsOnOriginIds: [...origin.dependsOnOriginIds],
      })),
    });
  }

  const untrustedRequest = {
    data: {
      groundingContext: {
        schemaVersion: "2.0",
        recordType: "GroundingContext",
        datasetKind: input.datasetKind,
        traceId: input.traceId,
        contextId: input.contextId,
        candidateId: input.candidateId,
        evidence,
        revisionStates: [...revisionStates].map(([reportRevisionId, revisionStatus]) => ({
          reportRevisionId,
          revisionStatus,
        })),
        candidateEvents: input.candidateEvents.map((event) => ({
          eventId: event.eventId,
          eventVersion: event.eventVersion,
        })),
        priorDecisionIds: [...input.priorDecisionIds],
        missingFields: [...input.missingFields],
        conflicts: [...input.conflicts],
        retrievalVersion: retrieval.retrievalVersion,
        indexVersion: retrieval.indexVersion ?? "not_applicable",
        sufficient: input.sufficient,
      },
    },
  };

  return await validateReasoningRequest(untrustedRequest);
}

function evidenceIdentityKey(candidate: EvidenceRetrievalCandidate): string {
  return [
    candidate.reportRevisionId,
    candidate.permittedTextHash,
    candidate.spanStart,
    candidate.spanEnd,
    candidate.offsetUnit,
    candidate.relation,
  ].join("\u0000");
}

function sameExactSpanIdentity(
  actual: Awaited<ReturnType<ExactEvidenceSpanReader["readExactSpan"]>>,
  expected: ExactEvidenceSpanRequest,
): boolean {
  return actual.datasetKind === expected.datasetKind
    && actual.candidateId === expected.candidateId
    && actual.evidenceReferenceId === expected.evidenceReferenceId
    && actual.reportRevisionId === expected.reportRevisionId
    && actual.permittedTextHash === expected.permittedTextHash
    && actual.spanStart === expected.spanStart
    && actual.spanEnd === expected.spanEnd
    && actual.offsetUnit === expected.offsetUnit
    && actual.relation === expected.relation
    && actual.revisionStatus === expected.revisionStatus;
}

function codePointCount(value: string): number {
  return Array.from(value).length;
}
