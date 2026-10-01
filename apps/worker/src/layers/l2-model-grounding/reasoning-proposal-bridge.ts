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
  ReasoningResult,
  TimeScope,
} from "./contracts.js";
import { parseEvidenceReference, validateReasoningRequest } from "./validation.js";

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

      const reasoning = parseReasoningResult(outcome.value);
      const contextSnapshot = snapshotPlainData(bridgeInput.groundingContext, "invalid_bridge_input");
      const persistedRecordSnapshot = snapshotPlainData(bridgeInput.persistedContextRecord, "invalid_bridge_input");
      let context: GroundingContext;
      try {
        context = (await validateReasoningRequest({ data: { groundingContext: contextSnapshot } })).data.groundingContext;
      } catch {
        throw new ReasoningProposalBridgeError("invalid_grounding_context");
      }

      const expectedRecord = toGroundingContextRecord(context);
      if (!sameValue(persistedRecordSnapshot, expectedRecord)) {
        throw new ReasoningProposalBridgeError("grounding_context_mismatch");
      }
      if (!sameStringList(reasoning.conflicts, context.conflicts)) {
        throw new ReasoningProposalBridgeError("conflict_mismatch");
      }

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
    const proposedAt = parseDateTime(record.proposedAt, "invalid_bridge_input").source;
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

function parseReasoningResult(value: unknown): ReasoningResult {
  try {
    const record = exactObject(value, ["outcome", "claims", "unresolvedFields", "conflicts", "modelRun", "provider"]);
    if (record.outcome !== "proposed" && record.outcome !== "abstained") invalid("invalid_reasoning_outcome");
    const claims = boundedArray(record.claims, 20).map((claim) => parseProposedClaim(claim));
    const unresolvedFields = uniqueStringList(record.unresolvedFields, 100, 500);
    const conflicts = uniqueStringList(record.conflicts, 100, 500);
    const modelRunRecord = exactObject(record.modelRun, [
      "capability", "modelVersion", "promptVersion", "inputTokens", "outputTokens",
    ]);
    if (modelRunRecord.capability !== "reasoning") invalid("invalid_reasoning_outcome");
    const modelRun = {
      capability: "reasoning" as const,
      modelVersion: boundedString(modelRunRecord.modelVersion, 200),
      promptVersion: boundedString(modelRunRecord.promptVersion, 200),
      inputTokens: integer(modelRunRecord.inputTokens, 0, 12_000),
      outputTokens: integer(modelRunRecord.outputTokens, 0, 12_000),
    };
    if (modelRun.inputTokens + modelRun.outputTokens > 12_000) invalid("invalid_reasoning_outcome");
    const provider = boundedString(record.provider, 120);
    if (record.outcome === "proposed" && claims.length === 0) invalid("invalid_reasoning_outcome");
    if (record.outcome === "abstained" && (claims.length !== 0 || unresolvedFields.length === 0)) {
      invalid("invalid_reasoning_outcome");
    }
    return { outcome: record.outcome, claims, unresolvedFields, conflicts, modelRun, provider };
  } catch (error) {
    if (error instanceof ReasoningProposalBridgeError && error.code !== "invalid_bridge_input") throw error;
    throw new ReasoningProposalBridgeError("invalid_reasoning_outcome");
  }
}

function parseProposedClaim(value: unknown): ReasoningResult["claims"][number] {
  const record = exactObject(value, [
    "text", "eventTime", "validity", "scope", "qualifiers", "support", "contradictions", "contextEvidence", "supportAssessment",
  ]);
  const text = boundedString(record.text, 4_000);
  const eventTime = parseTimeScope(record.eventTime);
  const validity = parseValidity(record.validity);
  const scopeRecord = exactObject(record.scope, [
    "placeIds", "serviceIds", "institutionIds", "audienceIds", "geometryIds",
  ]);
  const scope = {
    placeIds: identifierList(scopeRecord.placeIds, 100),
    serviceIds: identifierList(scopeRecord.serviceIds, 100),
    institutionIds: identifierList(scopeRecord.institutionIds, 100),
    audienceIds: identifierList(scopeRecord.audienceIds, 100),
    geometryIds: identifierList(scopeRecord.geometryIds, 100),
  };
  const qualifiers = uniqueStringList(record.qualifiers, 100, 500);
  const support = evidenceList(record.support, "supports");
  const contradictions = evidenceList(record.contradictions, "contradicts");
  const contextEvidence = evidenceList(record.contextEvidence, "updates_or_context");
  if (support.length === 0 || support.length + contradictions.length + contextEvidence.length > 100) {
    invalid("invalid_reasoning_outcome");
  }
  if (support.length > 8 || contradictions.length > 8 || contextEvidence.length > 8) invalid("invalid_reasoning_outcome");
  if (record.supportAssessment !== "supported" && record.supportAssessment !== "uncertain" && record.supportAssessment !== "disputed") {
    invalid("invalid_reasoning_outcome");
  }
  if (contradictions.length > 0 && record.supportAssessment === "supported") invalid("invalid_reasoning_outcome");
  return {
    text,
    eventTime,
    validity,
    scope,
    qualifiers,
    support,
    contradictions,
    contextEvidence,
    supportAssessment: record.supportAssessment,
  };
}

interface ParsedDateTime {
  readonly source: string;
  readonly micros: bigint;
}

interface ParsedDateOnly {
  readonly source: string;
  readonly day: bigint;
}

const DAY_MICROS = 86_400_000_000n;

function parseTimeScope(value: unknown): TimeScope {
  const record = exactObject(value, ["start", "end", "precision"]);
  if (record.precision === "unknown") {
    if (record.start !== null || record.end !== null) invalid("invalid_reasoning_outcome");
    return { precision: "unknown", start: null, end: null };
  }
  if (record.precision === "exact") {
    const start = parseDateTime(record.start);
    const end = record.end === null ? null : parseDateTime(record.end);
    if (end && start.micros >= end.micros) invalid("invalid_reasoning_outcome");
    return { precision: "exact", start: start.source, end: end?.source ?? null };
  }
  if (record.precision === "date") {
    const start = parseDateOnly(record.start);
    const end = record.end === null ? null : parseDateOnly(record.end);
    if (end && start.day >= end.day) invalid("invalid_reasoning_outcome");
    return { precision: "date", start: start.source, end: end?.source ?? null };
  }
  if (record.precision === "range") {
    const start = parseEndpoint(record.start);
    const end = parseEndpoint(record.end);
    if (start.micros >= end.micros) invalid("invalid_reasoning_outcome");
    return { precision: "range", start: start.source, end: end.source };
  }
  invalid("invalid_reasoning_outcome");
}

function parseValidity(value: unknown): { readonly validFrom: string | null; readonly validUntil: string | null } {
  const record = exactObject(value, ["validFrom", "validUntil"]);
  const validFrom = record.validFrom === null ? null : parseDateTime(record.validFrom);
  const validUntil = record.validUntil === null ? null : parseDateTime(record.validUntil);
  if (validFrom && validUntil && validFrom.micros >= validUntil.micros) invalid("invalid_reasoning_outcome");
  return { validFrom: validFrom?.source ?? null, validUntil: validUntil?.source ?? null };
}

function parseEndpoint(value: unknown): ParsedDateTime {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = parseDateOnly(value);
    return { source: date.source, micros: date.day * DAY_MICROS };
  }
  return parseDateTime(value);
}

function parseDateOnly(value: unknown, errorCode: ReasoningProposalBridgeErrorCode = "invalid_reasoning_outcome"): ParsedDateOnly {
  if (typeof value !== "string") invalid(errorCode);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) invalid(errorCode);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > monthDays(year, month)) invalid(errorCode);
  scalarString(value, 10, 10, errorCode);
  return { source: value, day: daysFromCivil(year, month, day) };
}

function parseDateTime(value: unknown, errorCode: ReasoningProposalBridgeErrorCode = "invalid_reasoning_outcome"): ParsedDateTime {
  if (typeof value !== "string") invalid(errorCode);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) invalid(errorCode);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > monthDays(year, month)
    || hour > 23 || minute > 59 || second > 59) invalid(errorCode);
  const fraction = (match[7] ?? "").padEnd(6, "0");
  let offsetMinutes = 0;
  if (match[8] !== "Z") {
    const zone = match[8]!;
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) invalid(errorCode);
    offsetMinutes = (zone[0] === "+" ? 1 : -1) * (offsetHour * 60 + offsetMinute);
  }
  const micros = daysFromCivil(year, month, day) * DAY_MICROS
    + BigInt(hour * 3600 + minute * 60 + second) * 1_000_000n
    + BigInt(fraction || "0") - BigInt(offsetMinutes) * 60_000_000n;
  if (micros < daysFromCivil(1, 1, 1) * DAY_MICROS || micros >= daysFromCivil(10_000, 1, 1) * DAY_MICROS) {
    invalid(errorCode);
  }
  scalarString(value, 35, 20, errorCode);
  return { source: value, micros };
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

function monthDays(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function daysFromCivil(year: number, month: number, day: number): bigint {
  let adjustedYear = year;
  if (month <= 2) adjustedYear -= 1;
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const adjustedMonth = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * adjustedMonth + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return BigInt(era * 146_097 + dayOfEra - 719_468);
}

function evidenceList(value: unknown, expected: "supports" | "contradicts" | "updates_or_context"): EvidenceReference[] {
  const references = boundedArray(value, 8).map((reference) => parseEvidenceReference(reference));
  const seen = new Set<string>();
  for (const reference of references) {
    const relation = reference.relation;
    if (expected === "supports" && relation !== "supports") invalid("invalid_reasoning_outcome");
    if (expected === "contradicts" && relation !== "contradicts") invalid("invalid_reasoning_outcome");
    if (expected === "updates_or_context" && relation !== "updates" && relation !== "context") invalid("invalid_reasoning_outcome");
    const key = evidenceKey(reference);
    if (seen.has(key)) invalid("invalid_reasoning_outcome");
    seen.add(key);
  }
  return references;
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

function boundedArray(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) invalid("invalid_reasoning_outcome");
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => key !== "length" && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) {
    invalid("invalid_reasoning_outcome");
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid("invalid_reasoning_outcome");
    result.push(descriptor.value);
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

function uniqueStringList(value: unknown, maximumItems: number, maxLength: number): string[] {
  const items = boundedArray(value, maximumItems).map((item) => boundedString(item, maxLength));
  if (new Set(items).size !== items.length) invalid("invalid_reasoning_outcome");
  return items;
}

function identifierList(value: unknown, maximumItems: number): string[] {
  return boundedArray(value, maximumItems).map((item) => identifier(item));
}

function evidenceKey(reference: EvidenceReference): string {
  return [reference.reportRevisionId, reference.permittedTextHash, reference.spanStart, reference.spanEnd,
    reference.offsetUnit, reference.relation].join("\u0000");
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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
