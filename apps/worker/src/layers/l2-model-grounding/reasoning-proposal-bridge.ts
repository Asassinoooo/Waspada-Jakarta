import type {
  GroundingContextRecord,
} from "../../../../db/src/grounding-contexts.js";
import {
  EventProposalConflictError,
  EventProposalReferenceError,
  EventProposalStorageError,
  EventProposalValidationError,
  type EventProposal,
  type EventProposalRepository,
  type ProposalEvidenceReference,
  type ProposalTime,
} from "../../../../db/src/event-proposals.js";
import type {
  CapabilityOutcome,
  EvidenceReference,
  GroundingContext,
  ModelIdentity,
  ReasoningRequest,
  ReasoningResult,
} from "./contracts.js";
import { parseReasoningOutput, validateReasoningRequest } from "./validation.js";

export type ReasoningProposalTarget =
  | { readonly kind: "new" }
  | { readonly kind: "update"; readonly eventId: string; readonly baseEventVersion: number };

export interface ReasoningProposalBridgeInput {
  readonly capabilityOutcome: CapabilityOutcome<ReasoningResult, "reasoning">;
  readonly groundingContext: GroundingContext;
  readonly persistedContextRecord: GroundingContextRecord;
  readonly proposalId: string;
  readonly proposedAt: string;
  readonly target: ReasoningProposalTarget;
  readonly investigationId?: string | null;
}

export type ReasoningProposalBridgeResult =
  | { readonly status: "no_write"; readonly capabilityStatus: "not_configured" | "invalid_request" | "invalid_output" | "provider_error" }
  | { readonly status: "persisted"; readonly proposal: EventProposal };

export type ReasoningProposalBridgeErrorCode =
  | "invalid_bridge_input"
  | "invalid_reasoning_outcome"
  | "invalid_grounding_context"
  | "grounding_context_mismatch"
  | "conflict_mismatch"
  | "invalid_event_target"
  | "origin_lineage_missing"
  | "origin_lineage_ambiguous"
  | "origin_lineage_not_in_context"
  | "proposal_repository_failed";

/** Errors from this bridge contain codes only; no source or model content is included. */
export class ReasoningProposalBridgeError extends Error {
  readonly code: ReasoningProposalBridgeErrorCode;

  constructor(code: ReasoningProposalBridgeErrorCode) {
    super(code);
    this.name = "ReasoningProposalBridgeError";
    this.code = code;
  }
}

export interface ReasoningProposalBridge {
  persist(input: ReasoningProposalBridgeInput): Promise<ReasoningProposalBridgeResult>;
}

const BRIDGE_INPUT_FIELDS = [
  "capabilityOutcome", "groundingContext", "persistedContextRecord", "proposalId", "proposedAt", "target", "investigationId",
] as const;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Maps an already validated L2 reasoning outcome into the private canonical
 * proposal repository. It has no provider, retrieval, investigation, or
 * publication capability.
 */
export function createReasoningProposalBridge(repository: EventProposalRepository): ReasoningProposalBridge {
  if (!repository || typeof repository.createOrVerify !== "function") {
    throw new TypeError("Reasoning proposal bridge requires an event proposal repository");
  }

  return {
    async persist(input): Promise<ReasoningProposalBridgeResult> {
      const bridgeInput = parseBridgeInput(input);
      const outcome = parseCapabilityOutcome(bridgeInput.capabilityOutcome);
      if (outcome.status !== "succeeded") {
        return { status: "no_write", capabilityStatus: outcome.status };
      }

      const contextSnapshot = snapshotPlainData(bridgeInput.groundingContext, "invalid_bridge_input");
      const persistedRecordSnapshot = snapshotPlainData(bridgeInput.persistedContextRecord, "invalid_bridge_input");
      let request: ReasoningRequest;
      try {
        request = await validateReasoningRequest({ data: { groundingContext: contextSnapshot } });
      } catch {
        throw new ReasoningProposalBridgeError("invalid_grounding_context");
      }
      const context = request.data.groundingContext;

      const expectedRecord = toGroundingContextRecord(context);
      if (!sameValue(persistedRecordSnapshot, expectedRecord)) {
        throw new ReasoningProposalBridgeError("grounding_context_mismatch");
      }

      const reasoning = await parseReasoningResult(outcome.value, request, context);
      const target = validateTarget(bridgeInput.target, context);
      const proposal = mapProposal(reasoning, context, bridgeInput, target);
      try {
        return { status: "persisted", proposal: await repository.createOrVerify(proposal) };
      } catch (error) {
        // The repository's public errors are already content-free and useful to callers.
        if (isSafeRepositoryError(error)) throw error;
        throw new ReasoningProposalBridgeError("proposal_repository_failed");
      }
    },
  };
}

interface ParsedBridgeInput {
  readonly capabilityOutcome: unknown;
  readonly groundingContext: unknown;
  readonly persistedContextRecord: unknown;
  readonly proposalId: string;
  readonly proposedAt: string;
  readonly target: unknown;
  readonly investigationId: string | null;
}

function parseBridgeInput(value: unknown): ParsedBridgeInput {
  try {
    const record = exactObject(value, BRIDGE_INPUT_FIELDS, [
      "capabilityOutcome", "groundingContext", "persistedContextRecord", "proposalId", "proposedAt", "target",
    ]);
    const proposalId = identifier(record.proposalId);
    const proposedAt = boundedString(record.proposedAt, 500, "invalid_bridge_input");
    const investigationId = record.investigationId === undefined || record.investigationId === null
      ? null
      : identifier(record.investigationId);
    return {
      capabilityOutcome: record.capabilityOutcome,
      groundingContext: record.groundingContext,
      persistedContextRecord: record.persistedContextRecord,
      proposalId,
      proposedAt,
      target: record.target,
      investigationId,
    };
  } catch (error) {
    if (error instanceof ReasoningProposalBridgeError && error.code === "invalid_bridge_input") throw error;
    throw new ReasoningProposalBridgeError("invalid_bridge_input");
  }
}

type ParsedCapabilityOutcome =
  | { readonly status: "succeeded"; readonly value: unknown }
  | { readonly status: "not_configured" | "invalid_request" | "invalid_output" | "provider_error" };

function parseCapabilityOutcome(value: unknown): ParsedCapabilityOutcome {
  try {
    const initial = recordObject(value);
    if (initial.capability !== "reasoning") invalid("invalid_reasoning_outcome");
    if (initial.status === "succeeded") {
      const record = exactObject(value, ["status", "capability", "value"]);
      return { status: "succeeded", value: record.value };
    }
    if (initial.status === "not_configured") {
      const record = exactObject(value, ["status", "capability", "reason"]);
      if (record.reason !== "provider_not_configured" && record.reason !== "capability_not_configured") {
        invalid("invalid_reasoning_outcome");
      }
      return { status: "not_configured" };
    }
    if (initial.status === "invalid_request" || initial.status === "invalid_output") {
      const record = exactObject(value, ["status", "capability", "reason"]);
      boundedString(record.reason, 500);
      return { status: initial.status };
    }
    if (initial.status === "provider_error") {
      exactObject(value, ["status", "capability"]);
      return { status: "provider_error" };
    }
    invalid("invalid_reasoning_outcome");
  } catch (error) {
    if (error instanceof ReasoningProposalBridgeError && error.code !== "invalid_bridge_input") throw error;
    throw new ReasoningProposalBridgeError("invalid_reasoning_outcome");
  }
}

async function parseReasoningResult(
  value: unknown,
  request: ReasoningRequest,
  context: GroundingContext,
): Promise<ReasoningResult> {
  try {
    const snapshot = snapshotPlainData(value, "invalid_reasoning_outcome");
    const record = exactObject(snapshot, ["outcome", "claims", "unresolvedFields", "conflicts", "modelRun", "provider"]);
    if (!sameValue(record.conflicts, context.conflicts)) invalid("conflict_mismatch");

    const modelRun = exactObject(record.modelRun, [
      "capability", "modelVersion", "promptVersion", "inputTokens", "outputTokens",
    ]);
    if (modelRun.capability !== "reasoning") invalid("invalid_reasoning_outcome");

    const parsed = await parseReasoningOutput(
      {
        output: {
          outcome: record.outcome,
          claims: record.claims,
          unresolvedFields: record.unresolvedFields,
        },
        usage: {
          inputTokens: modelRun.inputTokens,
          outputTokens: modelRun.outputTokens,
        },
      },
      request,
      {
        provider: record.provider as string,
        modelVersion: modelRun.modelVersion as string,
        promptVersion: modelRun.promptVersion as string,
      } satisfies ModelIdentity,
    );

    if (!sameValue(parsed.claims, record.claims)
      || !sameValue(parsed.unresolvedFields, record.unresolvedFields)
      || !sameValue(parsed.modelRun, record.modelRun)
      || !sameValue(parsed.provider, record.provider)) {
      invalid("invalid_reasoning_outcome");
    }
    return parsed;
  } catch (error) {
    if (error instanceof ReasoningProposalBridgeError && error.code === "conflict_mismatch") throw error;
    throw new ReasoningProposalBridgeError("invalid_reasoning_outcome");
  }
}

function validateTarget(value: unknown, context: GroundingContext): { readonly eventId: string | null; readonly baseVersion: number | null } {
  try {
    const initial = recordObject(value);
    if (initial.kind === "new") {
      exactObject(value, ["kind"]);
      return { eventId: null, baseVersion: null };
    }
    if (initial.kind !== "update") invalid("invalid_event_target");
    const target = exactObject(value, ["kind", "eventId", "baseEventVersion"]);
    const eventId = identifier(target.eventId);
    const baseVersion = integer(target.baseEventVersion, 1, 2_147_483_647);
    const matches = context.candidateEvents.filter((candidate) => candidate.eventId === eventId && candidate.eventVersion === baseVersion);
    if (matches.length !== 1) invalid("invalid_event_target");
    return { eventId, baseVersion };
  } catch (error) {
    if (error instanceof ReasoningProposalBridgeError && error.code === "invalid_event_target") throw error;
    throw new ReasoningProposalBridgeError("invalid_event_target");
  }
}

function mapProposal(
  reasoning: ReasoningResult,
  context: GroundingContext,
  input: ParsedBridgeInput,
  target: { readonly eventId: string | null; readonly baseVersion: number | null },
): EventProposal {
  const contextEvidenceByKey = new Map<string, GroundingContext["evidence"][number]>();
  for (const entry of context.evidence) {
    const key = evidenceKey(entry.reference);
    if (contextEvidenceByKey.has(key)) throw new ReasoningProposalBridgeError("origin_lineage_ambiguous");
    contextEvidenceByKey.set(key, entry);
  }

  for (const claim of reasoning.claims) {
    for (const reference of [...claim.support, ...claim.contradictions, ...claim.contextEvidence]) {
      if (!contextEvidenceByKey.has(evidenceKey(reference))) {
        throw new ReasoningProposalBridgeError("invalid_reasoning_outcome");
      }
    }
  }

  const claims = reasoning.claims.map((claim, index) => {
    const origins = new Map<string, string>();
    for (const supportReference of claim.support) {
      const key = evidenceKey(supportReference);
      const contextEvidence = contextEvidenceByKey.get(key);
      if (!contextEvidence) throw new ReasoningProposalBridgeError("origin_lineage_not_in_context");
      if (contextEvidence.origins.length === 0) throw new ReasoningProposalBridgeError("origin_lineage_missing");
      for (const origin of contextEvidence.origins) {
        const metadata = [origin.independenceStatus, ...[...origin.dependsOnOriginIds].sort()].join("\u0000");
        const priorMetadata = origins.get(origin.originId);
        if (priorMetadata !== undefined && priorMetadata !== metadata) {
          throw new ReasoningProposalBridgeError("origin_lineage_ambiguous");
        }
        origins.set(origin.originId, metadata);
      }
    }
    const originIds = [...origins.keys()].sort();
    if (originIds.length === 0) throw new ReasoningProposalBridgeError("origin_lineage_missing");
    if (originIds.length > 100) throw new ReasoningProposalBridgeError("invalid_reasoning_outcome");
    return {
      claim_id: `claim-${String(index + 1).padStart(3, "0")}`,
      text: claim.text,
      event_time: mapTime(claim.eventTime),
      validity: { valid_from: claim.validity.validFrom, valid_until: claim.validity.validUntil },
      scope: {
        place_ids: [...claim.scope.placeIds],
        service_ids: [...claim.scope.serviceIds],
        institution_ids: [...claim.scope.institutionIds],
        audience_ids: [...claim.scope.audienceIds],
        geometry_ids: [...claim.scope.geometryIds],
      },
      qualifiers: [...claim.qualifiers],
      support: claim.support.map(mapEvidenceReference),
      contradictions: claim.contradictions.map(mapEvidenceReference),
      context_evidence: claim.contextEvidence.map(mapEvidenceReference),
      origin_ids: originIds,
      support_assessment: claim.supportAssessment,
      evidence_label: "under_review" as const,
    };
  });

  return {
    schema_version: "2.0",
    trace_id: context.traceId,
    record_type: "EventProposal",
    dataset_kind: context.datasetKind,
    proposal_id: input.proposalId,
    candidate_id: context.candidateId,
    context_id: context.contextId,
    event_id: target.eventId,
    base_event_version: target.baseVersion,
    investigation_id: input.investigationId,
    claims,
    unresolved_fields: [...reasoning.unresolvedFields],
    model_runs: [{
      capability: "reasoning",
      model_version: reasoning.modelRun.modelVersion,
      prompt_version: reasoning.modelRun.promptVersion,
      input_tokens: reasoning.modelRun.inputTokens,
      output_tokens: reasoning.modelRun.outputTokens,
    }],
    proposed_at: input.proposedAt,
  };
}

function mapTime(value: ReasoningResult["claims"][number]["eventTime"]): ProposalTime {
  if (value.precision === "unknown") return { precision: "unknown", start: null, end: null };
  if (value.precision === "range") return { precision: "range", start: value.start!, end: value.end! };
  return { precision: value.precision, start: value.start!, end: value.end };
}

function mapEvidenceReference(reference: EvidenceReference): ProposalEvidenceReference {
  return {
    report_revision_id: reference.reportRevisionId,
    permitted_text_hash: reference.permittedTextHash,
    span_start: reference.spanStart,
    span_end: reference.spanEnd,
    offset_unit: reference.offsetUnit,
    relation: reference.relation,
  };
}

function toGroundingContextRecord(context: GroundingContext): GroundingContextRecord {
  return {
    schema_version: context.schemaVersion,
    trace_id: context.traceId,
    record_type: context.recordType,
    dataset_kind: context.datasetKind,
    context_id: context.contextId,
    candidate_id: context.candidateId,
    evidence: context.evidence.map(({ reference }) => ({
      report_revision_id: reference.reportRevisionId,
      permitted_text_hash: reference.permittedTextHash,
      span_start: reference.spanStart,
      span_end: reference.spanEnd,
      offset_unit: reference.offsetUnit,
      relation: reference.relation,
    })),
    revision_states: context.revisionStates.map((state) => ({
      report_revision_id: state.reportRevisionId,
      revision_status: state.revisionStatus,
    })),
    candidate_events: context.candidateEvents.map((event) => ({
      event_id: event.eventId,
      event_version: event.eventVersion,
    })),
    prior_decision_ids: [...context.priorDecisionIds],
    missing_fields: [...context.missingFields],
    conflicts: [...context.conflicts],
    retrieval_version: context.retrievalVersion,
    index_version: context.indexVersion,
    sufficient: context.sufficient,
  };
}

function exactObject(value: unknown, fields: readonly string[], required: readonly string[] = fields): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid("invalid_bridge_input");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid("invalid_bridge_input");
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) invalid("invalid_bridge_input");
  const allowed = new Set(fields);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    if (!allowed.has(key)) invalid("invalid_bridge_input");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid("invalid_bridge_input");
    result[key] = descriptor.value;
  }
  for (const field of required) if (!Object.prototype.hasOwnProperty.call(result, field)) invalid("invalid_bridge_input");
  return result;
}

function recordObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid("invalid_bridge_input");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid("invalid_bridge_input");
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") invalid("invalid_bridge_input");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid("invalid_bridge_input");
    result[key] = descriptor.value;
  }
  return result;
}

function boundedString(
  value: unknown,
  maximum: number,
  errorCode: ReasoningProposalBridgeErrorCode = "invalid_reasoning_outcome",
): string {
  if (typeof value !== "string") invalid(errorCode);
  scalarString(value, maximum, 1, errorCode);
  return value;
}

function scalarString(value: string, maximum: number, minimum: number, errorCode: ReasoningProposalBridgeErrorCode): void {
  if (value.includes("\0")) invalid(errorCode);
  let count = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) invalid(errorCode);
    count += 1;
  }
  if (count < minimum || count > maximum) invalid(errorCode);
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) invalid("invalid_bridge_input");
  return value;
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalid("invalid_reasoning_outcome");
  }
  return value;
}

function evidenceKey(reference: EvidenceReference): string {
  return [reference.reportRevisionId, reference.permittedTextHash, reference.spanStart, reference.spanEnd,
    reference.offsetUnit, reference.relation].join("\u0000");
}

function snapshotPlainData(value: unknown, errorCode: ReasoningProposalBridgeErrorCode): unknown {
  const seen = new Set<object>();
  const clone = (current: unknown, depth: number): unknown => {
    if (current === null || typeof current === "string" || typeof current === "number" || typeof current === "boolean") return current;
    if (depth > 20 || typeof current !== "object" || seen.has(current)) throw new ReasoningProposalBridgeError(errorCode);
    seen.add(current);
    try {
      if (Array.isArray(current)) {
        const keys = Reflect.ownKeys(current);
        if (keys.some((key) => key !== "length" && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= current.length))) {
          throw new ReasoningProposalBridgeError(errorCode);
        }
        const result: unknown[] = [];
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new ReasoningProposalBridgeError(errorCode);
          result.push(clone(descriptor.value, depth + 1));
        }
        return result;
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) throw new ReasoningProposalBridgeError(errorCode);
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const key of Reflect.ownKeys(current)) {
        if (typeof key !== "string") throw new ReasoningProposalBridgeError(errorCode);
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new ReasoningProposalBridgeError(errorCode);
        result[key] = clone(descriptor.value, depth + 1);
      }
      return result;
    } finally {
      seen.delete(current);
    }
  };
  try {
    return clone(value, 0);
  } catch (error) {
    if (error instanceof ReasoningProposalBridgeError) throw error;
    throw new ReasoningProposalBridgeError(errorCode);
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => sameValue(item, right[index]));
  }
  const leftKeys = Reflect.ownKeys(left);
  const rightKeys = Reflect.ownKeys(right);
  if (leftKeys.some((key) => typeof key !== "string") || rightKeys.some((key) => typeof key !== "string")) return false;
  if (leftKeys.length !== rightKeys.length || leftKeys.some((key) => !rightKeys.includes(key))) return false;
  return (leftKeys as string[]).every((key) => sameValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

function isSafeRepositoryError(error: unknown): boolean {
  return error instanceof EventProposalValidationError
    || error instanceof EventProposalReferenceError
    || error instanceof EventProposalConflictError
    || error instanceof EventProposalStorageError;
}

function invalid(code: ReasoningProposalBridgeErrorCode): never {
  throw new ReasoningProposalBridgeError(code);
}
