/**
 * Protected Layer 4 composition for an explicitly reviewed manual publication.
 * Trust enters only through the injected persisted-proposal reader and the
 * trusted caller's moderator authorization result.
 */
import type {
  EventProposal,
  EventProposalReader,
  ProposalEvidenceReference,
  ProposalTime,
} from "../../../../db/src/event-proposals.js";
import type {
  PublicationClaimDecision,
  PublicationEventVersionDraft,
  PublicationImpactVersionDraft,
  PublicationWriteCommand,
  PublicationWriteConflict,
  PublicationWriteReceipt,
  PublicationWriteResult,
} from "../../../../db/src/publication-writer.js";
import type { EvidenceReference, GroundingContext, ReasoningResult } from "../l2-model-grounding/contracts.js";
import {
  assessPublicationPolicy,
  type AssessedEvidenceReference,
  type PublicationPolicyInput,
} from "./publication-policy.js";

export interface ManualPublicationWriterPort {
  publish(command: PublicationWriteCommand): Promise<PublicationWriteResult>;
}

export interface ManualPublicationWriteMetadata {
  readonly idempotencyKey: string;
  readonly decisionId: string;
  readonly policyVersion: string;
}

/** No proposal body, policy result, or writer command is accepted from the caller. */
export interface ManualPublicationServiceInput {
  readonly proposalId: string;
  readonly policyInput: PublicationPolicyInput;
  readonly eventDraft: PublicationEventVersionDraft;
  readonly impactDrafts: readonly PublicationImpactVersionDraft[];
  readonly writeMetadata: ManualPublicationWriteMetadata;
}

export type ManualPublicationDenyCode =
  | "invalid_request"
  | "proposal_not_found"
  | "proposal_unavailable"
  | "proposal_policy_mismatch"
  | "publication_not_authorized"
  | "invalid_write_draft"
  | "writer_failed";

export type ManualPublicationServiceResult =
  | { readonly status: "denied"; readonly code: ManualPublicationDenyCode }
  | { readonly status: "written" | "replayed"; readonly receipt: PublicationWriteReceipt }
  | { readonly status: "conflict"; readonly code: PublicationWriteConflict["code"] };

export interface ManualPublicationService {
  publish(input: ManualPublicationServiceInput): Promise<ManualPublicationServiceResult>;
}

const INPUT_FIELDS = ["proposalId", "policyInput", "eventDraft", "impactDrafts", "writeMetadata"] as const;
const POLICY_INPUT_FIELDS = [
  "groundingContext", "reasoningResult", "retrieval", "currentEvidenceStates",
  "target", "currentEvent", "moderatorDecision",
] as const;
const EVENT_FIELDS = [
  "event_id", "version", "supersedes_version", "title", "summary", "category", "tags",
  "lifecycle", "freshness", "event_time", "validity", "scope", "published_at",
] as const;
const IMPACT_FIELDS = [
  "impact_id", "version", "event_id", "event_version", "impact_type", "title", "description",
  "lifecycle", "freshness", "event_time", "validity", "scope", "supporting_claim_ids", "published_at",
] as const;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_SNAPSHOT_NODES = 100_000;
const MAX_SNAPSHOT_DEPTH = 40;
const CLAIM_APPROVAL_REASON = "explicit_moderator_approval";

interface ParsedServiceInput {
  readonly proposalId: string;
  readonly policyInput: PublicationPolicyInput;
  readonly eventDraft: PublicationEventVersionDraft;
  readonly impactDrafts: readonly PublicationImpactVersionDraft[];
  readonly writeMetadata: ManualPublicationWriteMetadata;
}

class InvalidServiceInput extends Error {}
class InvalidWriteDraft extends Error {}
class ProposalPolicyMismatch extends Error {}

export function createManualPublicationService(
  reader: EventProposalReader,
  writer: ManualPublicationWriterPort,
): ManualPublicationService {
  if (!reader || typeof reader.readLive !== "function") {
    throw new TypeError("Manual publication service requires a proposal reader");
  }
  if (!writer || typeof writer.publish !== "function") {
    throw new TypeError("Manual publication service requires a publication writer");
  }

  return {
    async publish(input): Promise<ManualPublicationServiceResult> {
      let parsed: ParsedServiceInput;
      try {
        parsed = parseServiceInput(input);
      } catch {
        return { status: "denied", code: "invalid_request" };
      }

      let proposal: EventProposal | null;
      try {
        proposal = await reader.readLive(parsed.proposalId);
      } catch {
        return { status: "denied", code: "proposal_unavailable" };
      }
      if (proposal === null) return { status: "denied", code: "proposal_not_found" };

      try {
        if (proposal.proposal_id !== parsed.proposalId
          || !proposalMatchesPolicy(proposal, parsed.policyInput)) {
          throw new ProposalPolicyMismatch();
        }
      } catch {
        return { status: "denied", code: "proposal_policy_mismatch" };
      }

      try {
        validateDraftTargets(proposal, parsed);
      } catch {
        return { status: "denied", code: "invalid_write_draft" };
      }

      let assessment;
      try {
        // Always recompute from the reader-returned canonical proposal's matched policy input.
        assessment = assessPublicationPolicy(parsed.policyInput);
      } catch {
        return { status: "denied", code: "invalid_request" };
      }

      const decision = parsed.policyInput.moderatorDecision;
      if (assessment.disposition !== "publish"
        || assessment.claims.length !== proposal.claims.length
        || assessment.claims.some((claim) => claim.disposition !== "publish")
        || decision?.action !== "approve"
        || decision.trustedCallerAuthorized !== true
        || assessment.moderatorAction !== "approve"
        || assessment.datasetKind !== "live"
        || assessment.contextId !== proposal.context_id
        || !sameTarget(assessment.target, parsed.policyInput.target)
        || assessment.reviewer === null
        || assessment.reviewer.actorId !== decision.actorId
        || assessment.reviewer.decidedAt !== decision.decidedAt
        || assessment.reviewer.reason !== decision.reason) {
        return { status: "denied", code: "publication_not_authorized" };
      }

      let command: PublicationWriteCommand;
      try {
        command = buildWriteCommand(proposal, parsed, assessment.claims);
      } catch {
        return { status: "denied", code: "invalid_write_draft" };
      }

      let result: PublicationWriteResult;
      try {
        result = await writer.publish(command);
      } catch {
        return { status: "denied", code: "writer_failed" };
      }
      try {
        return normalizeWriterResult(result, command);
      } catch {
        return { status: "denied", code: "writer_failed" };
      }
    },
  };
}

function parseServiceInput(value: unknown): ParsedServiceInput {
  const snapshot = snapshotPlainData(value);
  const input = exactRecord(snapshot, INPUT_FIELDS);
  const proposalId = identifier(input.proposalId);
  const policyInput = parsePolicyInput(input.policyInput);
  const writeMetadata = parseWriteMetadata(input.writeMetadata);
  const eventDraft = snapshotDraft(input.eventDraft, EVENT_FIELDS) as unknown as PublicationEventVersionDraft;
  const impactValues = input.impactDrafts;
  if (!Array.isArray(impactValues) || impactValues.length > 20) throw new InvalidServiceInput();
  const impactDrafts = impactValues.map((impact) =>
    snapshotDraft(impact, IMPACT_FIELDS) as unknown as PublicationImpactVersionDraft);
  return { proposalId, policyInput, eventDraft, impactDrafts, writeMetadata };
}

function parsePolicyInput(value: unknown): PublicationPolicyInput {
  const record = exactRecord(value, POLICY_INPUT_FIELDS, [
    "groundingContext", "reasoningResult", "retrieval", "currentEvidenceStates", "target", "currentEvent",
  ]);
  return record as unknown as PublicationPolicyInput;
}

function parseWriteMetadata(value: unknown): ManualPublicationWriteMetadata {
  const record = exactRecord(value, ["idempotencyKey", "decisionId", "policyVersion"]);
  if (typeof record.idempotencyKey !== "string" || record.idempotencyKey.length === 0
    || Array.from(record.idempotencyKey).length > 256 || /[\u0000-\u001f\u007f]/u.test(record.idempotencyKey)
    || !isIdentifier(record.decisionId) || !isIdentifier(record.policyVersion)) {
    throw new InvalidServiceInput();
  }
  return {
    idempotencyKey: record.idempotencyKey,
    decisionId: record.decisionId,
    policyVersion: record.policyVersion,
  };
}

function snapshotDraft(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const record = exactRecord(value, fields);
  // The writer remains the final validator for draft content. These shape checks
  // keep malformed objects and target mismatches away from the writer port.
  return record;
}

function validateDraftTargets(proposal: EventProposal, input: ParsedServiceInput): void {
  const target = input.policyInput.target;
  const event = input.eventDraft as unknown as Record<string, unknown>;
  if (!isIdentifier(event.event_id) || !isPositiveInteger(event.version)
    || !(event.supersedes_version === null || isPositiveInteger(event.supersedes_version))) {
    throw new InvalidWriteDraft();
  }

  if (target.kind === "new") {
    if (proposal.event_id !== null || proposal.base_event_version !== null
      || event.version !== 1 || event.supersedes_version !== null) {
      throw new InvalidWriteDraft();
    }
  } else if (target.kind === "update") {
    if (!isIdentifier(target.eventId) || !isPositiveInteger(target.baseVersion)
      || proposal.event_id !== target.eventId || proposal.base_event_version !== target.baseVersion
      || event.event_id !== target.eventId || event.version !== target.baseVersion + 1
      || event.supersedes_version !== target.baseVersion) {
      throw new InvalidWriteDraft();
    }
  } else {
    throw new InvalidWriteDraft();
  }

  const claimIds = new Set(proposal.claims.map((claim) => claim.claim_id));
  const impactIds = new Set<string>();
  for (const value of input.impactDrafts) {
    const impact = value as unknown as Record<string, unknown>;
    if (!isIdentifier(impact.impact_id) || !isPositiveInteger(impact.version)
      || impact.event_id !== event.event_id || impact.event_version !== event.version
      || impactIds.has(impact.impact_id) || !Array.isArray(impact.supporting_claim_ids)
      || impact.supporting_claim_ids.length === 0
      || !impact.supporting_claim_ids.every((claimId) =>
        typeof claimId === "string" && claimIds.has(claimId))) {
      throw new InvalidWriteDraft();
    }
    impactIds.add(impact.impact_id);
  }
}

function proposalMatchesPolicy(proposal: EventProposal, policyInput: PublicationPolicyInput): boolean {
  const context = policyInput.groundingContext;
  const reasoning = policyInput.reasoningResult;
  const retrieval = policyInput.retrieval;

  if (proposal.schema_version !== "2.0" || proposal.record_type !== "EventProposal"
    || proposal.dataset_kind !== "live" || context.datasetKind !== "live"
    || retrieval.datasetKind !== "live"
    || proposal.dataset_kind !== context.datasetKind
    || proposal.trace_id !== context.traceId
    || proposal.candidate_id !== context.candidateId
    || proposal.context_id !== context.contextId
    || retrieval.retrievalVersion !== context.retrievalVersion
    || retrieval.indexVersion !== context.indexVersion
    || !retrieval.candidates.every((candidate) =>
      candidate.datasetKind === context.datasetKind && candidate.candidateId === context.candidateId)
    || !sameTargetWithProposal(policyInput.target, proposal)
    || !sameData(reasoning.conflicts, context.conflicts)
    || !sameData(proposal.unresolved_fields, reasoning.unresolvedFields)
    || proposal.claims.length !== reasoning.claims.length
    || proposal.model_runs.length !== 1
    || !sameData(proposal.model_runs[0], {
      capability: "reasoning",
      model_version: reasoning.modelRun.modelVersion,
      prompt_version: reasoning.modelRun.promptVersion,
      input_tokens: reasoning.modelRun.inputTokens,
      output_tokens: reasoning.modelRun.outputTokens,
    })) {
    return false;
  }

  for (let index = 0; index < proposal.claims.length; index += 1) {
    const persisted = proposal.claims[index]!;
    const proposed = reasoning.claims[index]!;
    const stableClaimId = "claim-" + String(index + 1).padStart(3, "0");
    if (persisted.claim_id !== stableClaimId || persisted.evidence_label !== "under_review"
      || persisted.text !== proposed.text
      || !sameData(persisted.event_time, mapTime(proposed.eventTime))
      || !sameData(persisted.validity, {
        valid_from: proposed.validity.validFrom,
        valid_until: proposed.validity.validUntil,
      })
      || !sameData(persisted.scope, {
        place_ids: proposed.scope.placeIds,
        service_ids: proposed.scope.serviceIds,
        institution_ids: proposed.scope.institutionIds,
        audience_ids: proposed.scope.audienceIds,
        geometry_ids: proposed.scope.geometryIds,
      })
      || !sameData(persisted.qualifiers, proposed.qualifiers)
      || !sameData(persisted.support, proposed.support.map(toProposalEvidence))
      || !sameData(persisted.contradictions, proposed.contradictions.map(toProposalEvidence))
      || !sameData(persisted.context_evidence, proposed.contextEvidence.map(toProposalEvidence))
      || persisted.support_assessment !== proposed.supportAssessment
      || !hasExpectedOriginIds(context, proposed.support, persisted.origin_ids)) {
      return false;
    }
  }
  return true;
}

function hasExpectedOriginIds(
  context: GroundingContext,
  support: readonly EvidenceReference[],
  persistedOriginIds: readonly string[],
): boolean {
  const origins = new Map<string, string>();
  for (const reference of support) {
    const matches = context.evidence.filter((entry) =>
      entry.reference.relation === reference.relation && sameEvidenceLocation(entry.reference, reference));
    if (matches.length !== 1 || matches[0]!.origins.length === 0) return false;
    for (const origin of matches[0]!.origins) {
      const metadata = origin.independenceStatus + "\u0000" + [...origin.dependsOnOriginIds].sort().join("\u0000");
      const previous = origins.get(origin.originId);
      if (previous !== undefined && previous !== metadata) return false;
      origins.set(origin.originId, metadata);
    }
  }
  if (origins.size === 0) return false;
  return sameData([...origins.keys()].sort(), persistedOriginIds);
}

function sameTargetWithProposal(
  target: PublicationPolicyInput["target"],
  proposal: EventProposal,
): boolean {
  if (target.kind === "new") return proposal.event_id === null && proposal.base_event_version === null;
  if (target.kind === "update") {
    return proposal.event_id === target.eventId && proposal.base_event_version === target.baseVersion;
  }
  return false;
}

function sameTarget(
  left: PublicationPolicyInput["target"],
  right: PublicationPolicyInput["target"],
): boolean {
  return sameData(left, right);
}

function mapTime(value: ReasoningResult["claims"][number]["eventTime"]): ProposalTime {
  if (value.precision === "unknown") return { precision: "unknown", start: null, end: null };
  if (value.precision === "range") return { precision: "range", start: value.start!, end: value.end! };
  return { precision: value.precision, start: value.start!, end: value.end };
}

function toProposalEvidence(reference: EvidenceReference): ProposalEvidenceReference {
  return {
    report_revision_id: reference.reportRevisionId,
    permitted_text_hash: reference.permittedTextHash,
    span_start: reference.spanStart,
    span_end: reference.spanEnd,
    offset_unit: reference.offsetUnit,
    relation: reference.relation,
  };
}

function sameEvidenceLocation(left: EvidenceReference, right: EvidenceReference): boolean {
  return left.reportRevisionId === right.reportRevisionId
    && left.permittedTextHash === right.permittedTextHash
    && left.spanStart === right.spanStart
    && left.spanEnd === right.spanEnd
    && left.offsetUnit === right.offsetUnit;
}

function buildWriteCommand(
  proposal: EventProposal,
  input: ParsedServiceInput,
  claims: readonly {
    readonly claimIndex: number;
    readonly disposition: string;
    readonly reasonCodes: readonly string[];
    readonly support: readonly AssessedEvidenceReference[];
    readonly contradictions: readonly AssessedEvidenceReference[];
    readonly contextEvidence: readonly AssessedEvidenceReference[];
  }[],
): PublicationWriteCommand {
  const decision = input.policyInput.moderatorDecision;
  if (!decision || decision.action !== "approve" || decision.trustedCallerAuthorized !== true
    || claims.length !== proposal.claims.length) {
    throw new InvalidWriteDraft();
  }
  const claimDecisions: PublicationClaimDecision[] = proposal.claims.map((proposalClaim, index) => {
    const assessment = claims[index];
    if (!assessment || assessment.claimIndex !== index || assessment.disposition !== "publish") {
      throw new InvalidWriteDraft();
    }
    const assessedReferences = [
      ...assessment.support,
      ...assessment.contradictions,
      ...assessment.contextEvidence,
    ];
    if (assessedReferences.some((entry) =>
      entry.matchStatus !== "matched" || entry.evidenceReferenceId === null)) {
      throw new InvalidWriteDraft();
    }
    return {
      claim_id: proposalClaim.claim_id,
      disposition: "publish",
      reason_codes: assessment.reasonCodes.length > 0
        ? [...assessment.reasonCodes]
        : [CLAIM_APPROVAL_REASON],
      evidence: assessedReferences.map((entry) =>
        toPublicationEvidence(entry.reference)),
    };
  });

  return {
    datasetKind: "live",
    idempotencyKey: input.writeMetadata.idempotencyKey,
    traceId: proposal.trace_id,
    proposalId: proposal.proposal_id,
    decisionId: input.writeMetadata.decisionId,
    policyVersion: input.writeMetadata.policyVersion,
    expectedTarget: {
      event_id: proposal.event_id,
      base_event_version: proposal.base_event_version,
    },
    moderatorApproval: {
      action: "approve",
      trusted_caller_authorized: true,
      actor_id: decision.actorId,
      decided_at: decision.decidedAt,
      reason: decision.reason,
    },
    claimDecisions,
    event: input.eventDraft,
    impacts: input.impactDrafts,
  };
}

function toPublicationEvidence(reference: EvidenceReference): PublicationClaimDecision["evidence"][number] {
  if (reference.relation === "updates") throw new InvalidWriteDraft();
  return {
    report_revision_id: reference.reportRevisionId,
    permitted_text_hash: reference.permittedTextHash,
    span_start: reference.spanStart,
    span_end: reference.spanEnd,
    offset_unit: reference.offsetUnit,
    relation: reference.relation,
  };
}

function normalizeWriterResult(
  value: PublicationWriteResult,
  command: PublicationWriteCommand,
): ManualPublicationServiceResult {
  const snapshot = snapshotPlainData(value);
  const result = exactRecord(snapshot, ["outcome", "decisionId", "eventId", "eventVersion", "code"], ["outcome"]);
  if (result.outcome === "conflict"
    && (result.code === "idempotency_key_reused" || result.code === "stale_event_version"
      || result.code === "event_version_exists")) {
    return { status: "conflict", code: result.code };
  }
  if ((result.outcome === "written" || result.outcome === "replayed")
    && result.decisionId === command.decisionId
    && result.eventId === command.event.event_id
    && result.eventVersion === command.event.version) {
    return {
      status: result.outcome,
      receipt: {
        outcome: result.outcome,
        decisionId: command.decisionId,
        eventId: command.event.event_id,
        eventVersion: command.event.version,
      },
    };
  }
  return { status: "denied", code: "writer_failed" };
}

function snapshotPlainData(value: unknown): unknown {
  const active = new Set<object>();
  let nodes = 0;
  const copy = (current: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_SNAPSHOT_NODES || depth > MAX_SNAPSHOT_DEPTH) throw new InvalidServiceInput();
    if (current === null || typeof current === "string" || typeof current === "boolean") return current;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new InvalidServiceInput();
      return current;
    }
    if (typeof current !== "object") throw new InvalidServiceInput();
    if (active.has(current)) throw new InvalidServiceInput();
    active.add(current);
    try {
      if (Array.isArray(current)) {
        if (current.length > MAX_SNAPSHOT_NODES) throw new InvalidServiceInput();
        const keys = Reflect.ownKeys(current);
        if (keys.some((key) => typeof key !== "string" || (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)))) {
          throw new InvalidServiceInput();
        }
        const items: unknown[] = [];
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new InvalidServiceInput();
          items.push(copy(descriptor.value, depth + 1));
        }
        return items;
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) throw new InvalidServiceInput();
      const keys = Reflect.ownKeys(current);
      if (keys.length > 2_000 || keys.some((key) => typeof key !== "string")) throw new InvalidServiceInput();
      const record: Record<string, unknown> = {};
      for (const key of keys as string[]) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new InvalidServiceInput();
        Object.defineProperty(record, key, {
          value: copy(descriptor.value, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return record;
    } finally {
      active.delete(current);
    }
  };
  return copy(value, 0);
}

function exactRecord(
  value: unknown,
  fields: readonly string[],
  required: readonly string[] = fields,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new InvalidServiceInput();
  const record = value as Record<string, unknown>;
  const allowed = new Set(fields);
  const keys = Object.keys(record);
  if (keys.some((key) => !allowed.has(key))) throw new InvalidServiceInput();
  for (const field of required) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) throw new InvalidServiceInput();
  }
  return record;
}

function identifier(value: unknown): string {
  if (!isIdentifier(value)) throw new InvalidServiceInput();
  return value;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function sameData(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => sameData(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) return false;
  return leftKeys.every((key) => sameData(leftRecord[key], rightRecord[key]));
}
