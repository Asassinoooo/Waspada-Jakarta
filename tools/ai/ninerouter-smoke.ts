import type {
  GroundingContext,
  ModelCapabilityAdapter,
} from "../../apps/worker/src/layers/l2-model-grounding/contracts.js";
import {
  createReasoningContextPersister,
} from "../../apps/worker/src/layers/l2-model-grounding/context-persistence.js";
import {
  createDirectReasoningService,
} from "../../apps/worker/src/layers/l2-model-grounding/direct-reasoning.js";
import type {
  GroundingContextRecord,
  GroundingContextRepository,
} from "../../apps/db/src/grounding-contexts.js";
import type {
  InvestigationPlanRequest,
  InvestigationPlanner,
  InvestigationPlannerOutcome,
} from "../../apps/worker/src/layers/l2-model-grounding/investigation-planner.js";
import { sha256Text } from "../../apps/worker/src/layers/l2-model-grounding/validation.js";
import {
  createSyntheticModelSmokeFixtures,
  NINEROUTER_SYNTHETIC_FIXTURE_ID,
  type SyntheticModelSmokeFixtures,
} from "./ninerouter-fixtures.js";

const MAX_PLANNER_TOKENS = 12_000;

export type SyntheticModelSmokeStatus =
  | "succeeded"
  | "not_configured"
  | "invalid_request"
  | "invalid_output"
  | "provider_error"
  | "investigation_required"
  | "harness_error"
  | "skipped";

export type SyntheticModelSmokeReason =
  | "provider_not_configured"
  | "capability_not_configured"
  | "model_metadata_not_configured"
  | "contract_validation_failed"
  | "provider_error"
  | "planner_request_rejected"
  | "planner_output_rejected"
  | "adapter_outcome_unrecognized"
  | "direct_reasoning_failed"
  | "context_persistence_failed"
  | "unexpected_sufficient_handoff"
  | "expected_insufficient_handoff_missing"
  | "fixture_initialization_failed"
  | "insufficient_context";

export interface SyntheticModelSmokeCapabilityResult {
  readonly status: SyntheticModelSmokeStatus;
  /** A fixed summary code only; provider messages and validation paths are omitted. */
  readonly reason: SyntheticModelSmokeReason | null;
}

export interface SyntheticModelSmokeBranchResult {
  readonly status: "succeeded" | "failed" | "skipped";
  readonly reason: SyntheticModelSmokeReason | null;
  readonly contextPersisted: boolean;
  readonly reasonerInvoked: boolean;
  readonly reasonerSkipped: boolean;
  readonly plannerInvoked: boolean;
}

export interface SyntheticModelSmokeSummary {
  readonly success: boolean;
  readonly fixtureId: typeof NINEROUTER_SYNTHETIC_FIXTURE_ID;
  readonly capabilities: {
    readonly classification: SyntheticModelSmokeCapabilityResult;
    readonly extraction: SyntheticModelSmokeCapabilityResult;
    readonly embedding: SyntheticModelSmokeCapabilityResult;
    readonly sufficientReasoning: SyntheticModelSmokeCapabilityResult;
    readonly insufficientContext: SyntheticModelSmokeCapabilityResult;
    readonly investigationPlanning: SyntheticModelSmokeCapabilityResult;
  };
  readonly branches: {
    readonly sufficient: SyntheticModelSmokeBranchResult;
    readonly insufficient: SyntheticModelSmokeBranchResult;
  };
  readonly lineage: {
    readonly reportHashesMatchText: boolean;
    readonly classificationReportIdentityMatches: boolean;
    readonly classificationEvidenceMatchesFixture: boolean;
    readonly extractionReportIdentityMatches: boolean;
    readonly extractionEvidenceMatchesFixture: boolean;
    readonly embeddingChunkIdentityMatches: boolean;
    readonly sufficientContraryEvidencePreserved: boolean;
    readonly insufficientContraryEvidencePreserved: boolean;
    readonly refsOnlyContextsPersisted: boolean;
  };
  /** Counts adapter/planner boundary invocations, not hidden gateway retries. */
  readonly callCounts: {
    readonly classification: number;
    readonly extraction: number;
    readonly embedding: number;
    readonly sufficientReasoning: number;
    readonly insufficientReasoning: number;
    readonly investigationPlanning: number;
    readonly directReasoningService: number;
    readonly totalInjectedCapabilityCalls: number;
  };
  readonly actionExecuted: false;
  readonly publicationAttempted: false;
}

export interface SyntheticModelSmokeOptions {
  readonly adapter: ModelCapabilityAdapter;
  readonly planner: InvestigationPlanner;
  readonly signal?: AbortSignal;
}

interface MutableCallCounts {
  classification: number;
  extraction: number;
  embedding: number;
  sufficientReasoning: number;
  insufficientReasoning: number;
  investigationPlanning: number;
  directReasoningService: number;
}

interface MemoryContextSink {
  readonly repository: GroundingContextRepository;
  readonly records: ReadonlyMap<string, GroundingContextRecord>;
}

function result(
  status: SyntheticModelSmokeStatus,
  reason: SyntheticModelSmokeReason | null = null,
): SyntheticModelSmokeCapabilityResult {
  return { status, reason };
}

function skippedResult(reason: SyntheticModelSmokeReason): SyntheticModelSmokeCapabilityResult {
  return result("skipped", reason);
}

function branchResult(args: {
  readonly status: "succeeded" | "failed" | "skipped";
  readonly reason: SyntheticModelSmokeReason | null;
  readonly contextPersisted?: boolean;
  readonly reasonerInvoked?: boolean;
  readonly reasonerSkipped?: boolean;
  readonly plannerInvoked?: boolean;
}): SyntheticModelSmokeBranchResult {
  return {
    status: args.status,
    reason: args.reason,
    contextPersisted: args.contextPersisted ?? false,
    reasonerInvoked: args.reasonerInvoked ?? false,
    reasonerSkipped: args.reasonerSkipped ?? false,
    plannerInvoked: args.plannerInvoked ?? false,
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function knownNotConfiguredReason(value: unknown): SyntheticModelSmokeReason {
  if (value === "provider_not_configured") return "provider_not_configured";
  if (value === "capability_not_configured") return "capability_not_configured";
  if (value === "model_metadata_not_configured") return "model_metadata_not_configured";
  return "adapter_outcome_unrecognized";
}

function summarizeCapabilityOutcome(value: unknown, expectedCapability: string): SyntheticModelSmokeCapabilityResult {
  if (!isPlainRecord(value) || value.capability !== expectedCapability) {
    return result("harness_error", "adapter_outcome_unrecognized");
  }
  switch (value.status) {
    case "succeeded":
      return result("succeeded");
    case "not_configured":
      return result("not_configured", knownNotConfiguredReason(value.reason));
    case "invalid_request":
      return result("invalid_request", "contract_validation_failed");
    case "invalid_output":
      return result("invalid_output", "contract_validation_failed");
    case "provider_error":
      return result("provider_error", "provider_error");
    default:
      return result("harness_error", "adapter_outcome_unrecognized");
  }
}

function summarizePlannerOutcome(value: unknown): SyntheticModelSmokeCapabilityResult {
  if (!isPlainRecord(value) || value.capability !== "investigation_planning") {
    return result("harness_error", "adapter_outcome_unrecognized");
  }
  switch (value.status) {
    case "succeeded":
      return result("succeeded");
    case "not_configured":
      return result("not_configured", knownNotConfiguredReason(value.reason));
    case "invalid_request":
      return result("invalid_request", "planner_request_rejected");
    case "invalid_output":
      return result("invalid_output", "planner_output_rejected");
    case "provider_error":
      return result("provider_error", "provider_error");
    default:
      return result("harness_error", "adapter_outcome_unrecognized");
  }
}

function copiedRecord(record: GroundingContextRecord): GroundingContextRecord {
  return Object.freeze({
    ...record,
    evidence: Object.freeze(record.evidence.map((entry) => Object.freeze({ ...entry }))),
    revision_states: Object.freeze(record.revision_states.map((entry) => Object.freeze({ ...entry }))),
    candidate_events: Object.freeze(record.candidate_events.map((entry) => Object.freeze({ ...entry }))),
    prior_decision_ids: Object.freeze([...record.prior_decision_ids]),
    missing_fields: Object.freeze([...record.missing_fields]),
    conflicts: Object.freeze([...record.conflicts]),
  });
}

function createMemoryContextSink(): MemoryContextSink {
  const stored = new Map<string, GroundingContextRecord>();
  const repository: GroundingContextRepository = {
    async createOrVerify(record) {
      const key = record.dataset_kind + ":" + record.context_id;
      const previous = stored.get(key);
      if (previous) {
        if (JSON.stringify(previous) !== JSON.stringify(record)) {
          throw new Error("synthetic_grounding_context_conflict");
        }
        return previous;
      }
      const copy = copiedRecord(record);
      stored.set(key, copy);
      return copy;
    },
  };
  return { repository, records: stored };
}

function referenceRecord(reference: GroundingContext["evidence"][number]["reference"]) {
  return {
    report_revision_id: reference.reportRevisionId,
    permitted_text_hash: reference.permittedTextHash,
    span_start: reference.spanStart,
    span_end: reference.spanEnd,
    offset_unit: reference.offsetUnit,
    relation: reference.relation,
  };
}

function persistedRecordMatches(
  record: GroundingContextRecord | undefined,
  context: GroundingContext,
  fixtureTexts: readonly string[],
): boolean {
  if (!record) return false;
  try {
    const expectedKeys = [
      "schema_version",
      "trace_id",
      "record_type",
      "dataset_kind",
      "context_id",
      "candidate_id",
      "evidence",
      "revision_states",
      "candidate_events",
      "prior_decision_ids",
      "missing_fields",
      "conflicts",
      "retrieval_version",
      "index_version",
      "sufficient",
    ].sort();
    if (Object.keys(record).sort().join("|") !== expectedKeys.join("|")) return false;
    const serialized = JSON.stringify(record);
    if (fixtureTexts.some((text) => serialized.includes(text))) return false;
    return record.schema_version === context.schemaVersion
      && record.trace_id === context.traceId
      && record.record_type === context.recordType
      && record.dataset_kind === context.datasetKind
      && record.context_id === context.contextId
      && record.candidate_id === context.candidateId
      && JSON.stringify(record.evidence) === JSON.stringify(context.evidence.map(({ reference }) => referenceRecord(reference)))
      && JSON.stringify(record.revision_states) === JSON.stringify(context.revisionStates.map((state) => ({
        report_revision_id: state.reportRevisionId,
        revision_status: state.revisionStatus,
      })))
      && JSON.stringify(record.candidate_events) === JSON.stringify(context.candidateEvents.map((event) => ({
        event_id: event.eventId,
        event_version: event.eventVersion,
      })))
      && JSON.stringify(record.prior_decision_ids) === JSON.stringify(context.priorDecisionIds)
      && JSON.stringify(record.missing_fields) === JSON.stringify(context.missingFields)
      && JSON.stringify(record.conflicts) === JSON.stringify(context.conflicts)
      && record.retrieval_version === context.retrievalVersion
      && record.index_version === context.indexVersion
      && record.sufficient === context.sufficient;
  } catch {
    return false;
  }
}

function evidenceMatchesFixture(
  value: unknown,
  expected: GroundingContext["evidence"][number]["reference"],
  reportCodePointLength: number,
): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  let hasSupportingReference = false;
  for (const candidate of value) {
    if (!isPlainRecord(candidate)
      || candidate.reportRevisionId !== expected.reportRevisionId
      || candidate.permittedTextHash !== expected.permittedTextHash
      || candidate.offsetUnit !== "unicode_code_points"
      || typeof candidate.spanStart !== "number"
      || !Number.isSafeInteger(candidate.spanStart)
      || typeof candidate.spanEnd !== "number"
      || !Number.isSafeInteger(candidate.spanEnd)
      || candidate.spanStart < 0
      || candidate.spanEnd <= candidate.spanStart
      || candidate.spanEnd > reportCodePointLength
      || !["supports", "contradicts", "updates", "context"].includes(String(candidate.relation))) {
      return false;
    }
    if (candidate.relation === "supports") hasSupportingReference = true;
  }
  return hasSupportingReference;
}

function reportIdentityMatches(value: unknown, fixtures: SyntheticModelSmokeFixtures): boolean {
  if (!isPlainRecord(value)) return false;
  return value.reportRevisionId === fixtures.supportReference.reportRevisionId
    && value.permittedTextHash === fixtures.reportTextHash;
}

function embeddingIdentityMatches(value: unknown, fixtures: SyntheticModelSmokeFixtures): boolean {
  if (!isPlainRecord(value)) return false;
  const chunk = fixtures.embeddingRequest.data.chunk;
  if (!Array.isArray(value.vector)) return false;
  return value.chunkId === chunk.chunkId
    && value.reportRevisionId === chunk.reportRevisionId
    && value.permittedTextHash === chunk.permittedTextHash
    && value.spanStart === chunk.spanStart
    && value.spanEnd === chunk.spanEnd
    && value.offsetUnit === chunk.offsetUnit
    && value.inputTextHash === chunk.chunkTextHash
    && value.dimensions === value.vector.length
    && value.vector.every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

function contextContraryEvidenceMatches(
  context: GroundingContext,
  fixtures: SyntheticModelSmokeFixtures,
): boolean {
  const expected = fixtures.sufficientReasoningRequest.data.groundingContext.evidence.find(
    (entry) => entry.reference.relation === "contradicts",
  );
  if (!expected) return false;
  const actual = context.evidence.filter((entry) => entry.reference.relation === "contradicts");
  return actual.length === 1 && JSON.stringify(actual[0]) === JSON.stringify(expected);
}

function reasoningConflictsMatch(value: unknown, context: GroundingContext): boolean {
  if (!isPlainRecord(value) || !Array.isArray(value.conflicts)) return false;
  return JSON.stringify(value.conflicts) === JSON.stringify(context.conflicts);
}

function createInitialSummary(): SyntheticModelSmokeSummary {
  const failed = result("harness_error", "fixture_initialization_failed");
  const skipped = skippedResult("fixture_initialization_failed");
  const falseLineage = {
    reportHashesMatchText: false,
    classificationReportIdentityMatches: false,
    classificationEvidenceMatchesFixture: false,
    extractionReportIdentityMatches: false,
    extractionEvidenceMatchesFixture: false,
    embeddingChunkIdentityMatches: false,
    sufficientContraryEvidencePreserved: false,
    insufficientContraryEvidencePreserved: false,
    refsOnlyContextsPersisted: false,
  };
  const noCalls = {
    classification: 0,
    extraction: 0,
    embedding: 0,
    sufficientReasoning: 0,
    insufficientReasoning: 0,
    investigationPlanning: 0,
    directReasoningService: 0,
    totalInjectedCapabilityCalls: 0,
  };
  return {
    success: false,
    fixtureId: NINEROUTER_SYNTHETIC_FIXTURE_ID,
    capabilities: {
      classification: failed,
      extraction: skipped,
      embedding: skipped,
      sufficientReasoning: skipped,
      insufficientContext: skipped,
      investigationPlanning: skipped,
    },
    branches: {
      sufficient: branchResult({ status: "skipped", reason: "fixture_initialization_failed" }),
      insufficient: branchResult({ status: "skipped", reason: "fixture_initialization_failed" }),
    },
    lineage: falseLineage,
    callCounts: noCalls,
    actionExecuted: false,
    publicationAttempted: false,
  };
}

function summary(args: {
  readonly capabilities: SyntheticModelSmokeSummary["capabilities"];
  readonly branches: SyntheticModelSmokeSummary["branches"];
  readonly lineage: SyntheticModelSmokeSummary["lineage"];
  readonly counts: MutableCallCounts;
}): SyntheticModelSmokeSummary {
  const callCounts: SyntheticModelSmokeSummary["callCounts"] = {
    classification: args.counts.classification,
    extraction: args.counts.extraction,
    embedding: args.counts.embedding,
    sufficientReasoning: args.counts.sufficientReasoning,
    insufficientReasoning: args.counts.insufficientReasoning,
    investigationPlanning: args.counts.investigationPlanning,
    directReasoningService: args.counts.directReasoningService,
    totalInjectedCapabilityCalls: args.counts.classification
      + args.counts.extraction
      + args.counts.embedding
      + args.counts.sufficientReasoning
      + args.counts.insufficientReasoning
      + args.counts.investigationPlanning,
  };
  const allLineageChecksPass = Object.values(args.lineage).every(Boolean);
  const success = args.capabilities.classification.status === "succeeded"
    && args.capabilities.extraction.status === "succeeded"
    && args.capabilities.embedding.status === "succeeded"
    && args.capabilities.sufficientReasoning.status === "succeeded"
    && args.capabilities.insufficientContext.status === "investigation_required"
    && args.capabilities.investigationPlanning.status === "succeeded"
    && args.branches.sufficient.status === "succeeded"
    && args.branches.insufficient.status === "succeeded"
    && args.counts.classification === 1
    && args.counts.extraction === 1
    && args.counts.embedding === 1
    && args.counts.sufficientReasoning === 1
    && args.counts.insufficientReasoning === 0
    && args.counts.investigationPlanning === 1
    && args.counts.directReasoningService === 2
    && allLineageChecksPass;
  return {
    success,
    fixtureId: NINEROUTER_SYNTHETIC_FIXTURE_ID,
    capabilities: args.capabilities,
    branches: args.branches,
    lineage: args.lineage,
    callCounts,
    actionExecuted: false,
    publicationAttempted: false,
  };
}

function unexpectedDirectOutcome(value: unknown): SyntheticModelSmokeCapabilityResult {
  if (!isPlainRecord(value)) return result("harness_error", "adapter_outcome_unrecognized");
  if (value.status === "not_configured" || value.status === "invalid_request"
    || value.status === "invalid_output" || value.status === "provider_error") {
    return summarizeCapabilityOutcome(value, "reasoning");
  }
  return result("harness_error", "adapter_outcome_unrecognized");
}

/**
 * Composes the existing injected L2 capabilities and direct-reasoning/planner
 * boundaries with authored synthetic inputs. It reads no environment or files,
 * performs no fetch, retries no boundary, and retains no model output.
 */
export async function runSyntheticModelSmoke(
  options: SyntheticModelSmokeOptions,
): Promise<SyntheticModelSmokeSummary> {
  let fixtures: SyntheticModelSmokeFixtures;
  try {
    fixtures = await createSyntheticModelSmokeFixtures();
  } catch {
    return createInitialSummary();
  }

  const counts: MutableCallCounts = {
    classification: 0,
    extraction: 0,
    embedding: 0,
    sufficientReasoning: 0,
    insufficientReasoning: 0,
    investigationPlanning: 0,
    directReasoningService: 0,
  };
  let activeReasoningBranch: "sufficient" | "insufficient" | null = null;
  const adapter: ModelCapabilityAdapter = {
    classify(request) {
      counts.classification += 1;
      return options.adapter.classify(request);
    },
    extract(request) {
      counts.extraction += 1;
      return options.adapter.extract(request);
    },
    embed(request) {
      counts.embedding += 1;
      return options.adapter.embed(request);
    },
    reason(request) {
      if (activeReasoningBranch === "sufficient") counts.sufficientReasoning += 1;
      if (activeReasoningBranch === "insufficient") counts.insufficientReasoning += 1;
      return options.adapter.reason(request);
    },
  };

  let classificationSummary = result("harness_error", "adapter_outcome_unrecognized");
  let classificationValue: unknown;
  try {
    const outcome = await adapter.classify(fixtures.classificationRequest);
    classificationSummary = summarizeCapabilityOutcome(outcome, "classification");
    if (outcome.status === "succeeded") classificationValue = outcome.value;
  } catch {
    classificationSummary = result("harness_error", "adapter_outcome_unrecognized");
  }

  let extractionSummary = result("harness_error", "adapter_outcome_unrecognized");
  let extractionValue: unknown;
  try {
    const outcome = await adapter.extract(fixtures.extractionRequest);
    extractionSummary = summarizeCapabilityOutcome(outcome, "extraction");
    if (outcome.status === "succeeded") extractionValue = outcome.value;
  } catch {
    extractionSummary = result("harness_error", "adapter_outcome_unrecognized");
  }

  let embeddingSummary = result("harness_error", "adapter_outcome_unrecognized");
  let embeddingValue: unknown;
  try {
    const outcome = await adapter.embed(fixtures.embeddingRequest);
    embeddingSummary = summarizeCapabilityOutcome(outcome, "embedding");
    if (outcome.status === "succeeded") embeddingValue = outcome.value;
  } catch {
    embeddingSummary = result("harness_error", "adapter_outcome_unrecognized");
  }

  const memory = createMemoryContextSink();
  const directReasoning = createDirectReasoningService(
    createReasoningContextPersister(memory.repository),
    adapter,
  );

  let sufficientReasoningSummary = result("harness_error", "direct_reasoning_failed");
  let sufficientReasoningValue: unknown;
  let sufficientContext: GroundingContext | undefined;
  let sufficientBranch = branchResult({ status: "failed", reason: "direct_reasoning_failed" });
  counts.directReasoningService += 1;
  activeReasoningBranch = "sufficient";
  try {
    const directOutcome = await directReasoning.reason(fixtures.sufficientReasoningRequest);
    if (directOutcome.status === "succeeded") {
      sufficientReasoningSummary = summarizeCapabilityOutcome(directOutcome, "reasoning");
      sufficientReasoningValue = directOutcome.value;
      sufficientContext = fixtures.sufficientReasoningRequest.data.groundingContext;
      sufficientBranch = branchResult({
        status: sufficientReasoningSummary.status === "succeeded" ? "succeeded" : "failed",
        reason: sufficientReasoningSummary.reason,
        contextPersisted: memory.records.has("synthetic:" + fixtures.sufficientReasoningRequest.data.groundingContext.contextId),
        reasonerInvoked: counts.sufficientReasoning === 1,
      });
    } else if (directOutcome.status === "investigation_required") {
      sufficientReasoningSummary = result("harness_error", "unexpected_sufficient_handoff");
      sufficientContext = directOutcome.reasoningRequest.data.groundingContext;
      sufficientBranch = branchResult({
        status: "failed",
        reason: "unexpected_sufficient_handoff",
        contextPersisted: memory.records.has("synthetic:" + sufficientContext.contextId),
        reasonerInvoked: counts.sufficientReasoning > 0,
      });
    } else {
      sufficientReasoningSummary = unexpectedDirectOutcome(directOutcome);
      sufficientContext = fixtures.sufficientReasoningRequest.data.groundingContext;
      sufficientBranch = branchResult({
        status: "failed",
        reason: sufficientReasoningSummary.reason,
        contextPersisted: memory.records.has("synthetic:" + sufficientContext.contextId),
        reasonerInvoked: counts.sufficientReasoning > 0,
      });
    }
  } catch {
    sufficientReasoningSummary = result("harness_error", "direct_reasoning_failed");
    sufficientBranch = branchResult({
      status: "failed",
      reason: "direct_reasoning_failed",
      contextPersisted: memory.records.has("synthetic:" + fixtures.sufficientReasoningRequest.data.groundingContext.contextId),
      reasonerInvoked: counts.sufficientReasoning > 0,
    });
  } finally {
    activeReasoningBranch = null;
  }

  let insufficientContextSummary = result("harness_error", "expected_insufficient_handoff_missing");
  let investigationPlanningSummary = skippedResult("expected_insufficient_handoff_missing");
  let insufficientBranch = branchResult({
    status: "failed",
    reason: "expected_insufficient_handoff_missing",
  });
  let insufficientContext: GroundingContext | undefined;
  counts.directReasoningService += 1;
  activeReasoningBranch = "insufficient";
  try {
    const directOutcome = await directReasoning.reason(fixtures.insufficientReasoningRequest);
    if (directOutcome.status === "investigation_required") {
      const context = directOutcome.reasoningRequest.data.groundingContext;
      insufficientContext = context;
      insufficientContextSummary = result("investigation_required", "insufficient_context");
      const contextPersisted = memory.records.has("synthetic:" + directOutcome.persistedRecord.context_id)
        && persistedRecordMatches(
          directOutcome.persistedRecord,
          context,
          [fixtures.reportText, fixtures.contraryReportText],
        );
      const reasonerWasSkipped = counts.insufficientReasoning === 0;
      let plannerInvoked = false;
      let plannerReason: SyntheticModelSmokeReason | null = null;
      try {
        const plannerRequest: InvestigationPlanRequest = {
          ...fixtures.plannerRequest,
          groundingContext: context,
        };
        const callOptions = {
          signal: options.signal ?? new AbortController().signal,
          maxTotalTokens: MAX_PLANNER_TOKENS,
        };
        counts.investigationPlanning += 1;
        plannerInvoked = true;
        const plannerOutcome: InvestigationPlannerOutcome = await options.planner.propose(plannerRequest, callOptions);
        investigationPlanningSummary = summarizePlannerOutcome(plannerOutcome);
        plannerReason = investigationPlanningSummary.reason;
      } catch {
        investigationPlanningSummary = result("harness_error", "provider_error");
        plannerReason = "provider_error";
      }

      const expectedContext = fixtures.insufficientReasoningRequest.data.groundingContext;
      const contextMatchesFixture = JSON.stringify(context) === JSON.stringify(expectedContext);
      const plannerSucceeded = investigationPlanningSummary.status === "succeeded";
      insufficientBranch = branchResult({
        status: contextPersisted && reasonerWasSkipped && contextMatchesFixture && plannerSucceeded
          ? "succeeded"
          : "failed",
        reason: contextPersisted && reasonerWasSkipped && contextMatchesFixture
          ? plannerReason
          : "context_persistence_failed",
        contextPersisted,
        reasonerSkipped: reasonerWasSkipped,
        plannerInvoked,
      });
    } else {
      insufficientContextSummary = unexpectedDirectOutcome(directOutcome);
      insufficientBranch = branchResult({
        status: "failed",
        reason: insufficientContextSummary.reason ?? "expected_insufficient_handoff_missing",
        contextPersisted: memory.records.has("synthetic:" + fixtures.insufficientReasoningRequest.data.groundingContext.contextId),
        reasonerInvoked: counts.insufficientReasoning > 0,
        reasonerSkipped: counts.insufficientReasoning === 0,
      });
    }
  } catch {
    insufficientContextSummary = result("harness_error", "direct_reasoning_failed");
    insufficientBranch = branchResult({
      status: "failed",
      reason: "direct_reasoning_failed",
      contextPersisted: memory.records.has("synthetic:" + fixtures.insufficientReasoningRequest.data.groundingContext.contextId),
      reasonerSkipped: counts.insufficientReasoning === 0,
    });
  } finally {
    activeReasoningBranch = null;
  }

  const sufficientContextExpected = fixtures.sufficientReasoningRequest.data.groundingContext;
  const insufficientContextExpected = fixtures.insufficientReasoningRequest.data.groundingContext;
  const sufficientRecord = memory.records.get("synthetic:" + sufficientContextExpected.contextId);
  const insufficientRecord = memory.records.get("synthetic:" + insufficientContextExpected.contextId);
  let fixtureHashesMatch = false;
  try {
    fixtureHashesMatch = await sha256Text(fixtures.reportText) === fixtures.reportTextHash
      && await sha256Text(fixtures.contraryReportText) === fixtures.contraryReportTextHash
      && fixtures.embeddingRequest.data.chunk.chunkTextHash === fixtures.reportTextHash
      && fixtures.supportReference.spanEnd === Array.from(fixtures.reportText).length
      && fixtures.contraryReference.spanEnd === Array.from(fixtures.contraryReportText).length;
  } catch {
    fixtureHashesMatch = false;
  }

  const lineage: SyntheticModelSmokeSummary["lineage"] = {
    reportHashesMatchText: fixtureHashesMatch,
    classificationReportIdentityMatches: classificationSummary.status === "succeeded"
      && reportIdentityMatches(classificationValue, fixtures),
    classificationEvidenceMatchesFixture: classificationSummary.status === "succeeded"
      && isPlainRecord(classificationValue)
      && classificationValue.permittedTextHash === fixtures.reportTextHash
      && evidenceMatchesFixture(
        classificationValue.evidence,
        fixtures.supportReference,
        Array.from(fixtures.reportText).length,
      ),
    extractionReportIdentityMatches: extractionSummary.status === "succeeded"
      && reportIdentityMatches(extractionValue, fixtures)
      && isPlainRecord(extractionValue)
      && extractionValue.candidateId === fixtures.extractionRequest.data.candidateId,
    extractionEvidenceMatchesFixture: extractionSummary.status === "succeeded"
      && isPlainRecord(extractionValue)
      && extractionValue.permittedTextHash === fixtures.reportTextHash
      && evidenceMatchesFixture(
        extractionValue.evidence,
        fixtures.supportReference,
        Array.from(fixtures.reportText).length,
      ),
    embeddingChunkIdentityMatches: embeddingSummary.status === "succeeded"
      && embeddingIdentityMatches(embeddingValue, fixtures),
    sufficientContraryEvidencePreserved: sufficientContext !== undefined
      && contextContraryEvidenceMatches(sufficientContext, fixtures)
      && sufficientReasoningSummary.status === "succeeded"
      && reasoningConflictsMatch(sufficientReasoningValue, sufficientContext),
    insufficientContraryEvidencePreserved: insufficientContext !== undefined
      && contextContraryEvidenceMatches(insufficientContext, fixtures),
    refsOnlyContextsPersisted: persistedRecordMatches(
      sufficientRecord,
      sufficientContextExpected,
      [fixtures.reportText, fixtures.contraryReportText],
    ) && persistedRecordMatches(
      insufficientRecord,
      insufficientContextExpected,
      [fixtures.reportText, fixtures.contraryReportText],
    ) && memory.records.size === 2,
  };

  return summary({
    capabilities: {
      classification: classificationSummary,
      extraction: extractionSummary,
      embedding: embeddingSummary,
      sufficientReasoning: sufficientReasoningSummary,
      insufficientContext: insufficientContextSummary,
      investigationPlanning: investigationPlanningSummary,
    },
    branches: {
      sufficient: sufficientBranch,
      insufficient: insufficientBranch,
    },
    lineage,
    counts,
  });
}
