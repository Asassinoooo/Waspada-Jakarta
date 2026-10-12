import type {
  ClassificationRequest,
  EmbeddingRequest,
  EvidenceReference,
  ExtractionRequest,
  GroundingContext,
  ReasoningRequest,
  RetrievedEvidence,
} from "../../apps/worker/src/layers/l2-model-grounding/contracts.js";
import { sha256Text } from "../../apps/worker/src/layers/l2-model-grounding/validation.js";
import type {
  InvestigationActionMenuEntry,
  InvestigationPlanRequest,
} from "../../apps/worker/src/layers/l2-model-grounding/investigation-planner.js";

/** Stable identity for a local, authored fixture set; it is not an event or source ID. */
export const NINEROUTER_SYNTHETIC_FIXTURE_ID = "ninerouter_synthetic_smoke_v1" as const;

const PRIMARY_REPORT_TEXT =
  "Laporan sintetis untuk latihan: layanan air di Zona Uji A kembali beroperasi pukul 09.15 WIB; data ini bukan laporan nyata. 🧪";
const CONTRARY_REPORT_TEXT =
  "Catatan sintetis untuk latihan: layanan air di Zona Uji A belum kembali pada 09.20 WIB; data ini bukan laporan nyata. 🧪";

const PRIMARY_REVISION_ID = "revision_synthetic_smoke_primary_v1";
const CONTRARY_REVISION_ID = "revision_synthetic_smoke_contrary_v1";
const CANDIDATE_ID = "candidate_synthetic_smoke_v1";
const RETRIEVED_AT = "2026-10-12T09:30:00+07:00";
const NORMALIZATION_VERSION = "synthetic-normalization-v1";
const CONFLICT_LABEL = "synthetic_reports_disagree_on_service_status";
const MISSING_FIELD_LABEL = "synthetic_service_status_confirmation";

const PLANNER_QUESTIONS = Object.freeze(["missing_field_1", "conflict_1"] as const);

const PLANNER_ACTION_MENU: readonly InvestigationActionMenuEntry[] = Object.freeze([
  Object.freeze({
    name: "inspect_synthetic_record",
    description: "Inspect only the authored synthetic evidence fixture.",
  }),
  Object.freeze({
    name: "compare_synthetic_report_times",
    description: "Compare timestamps in the authored synthetic reports.",
  }),
]);

export interface SyntheticModelSmokeFixtures {
  readonly fixtureId: typeof NINEROUTER_SYNTHETIC_FIXTURE_ID;
  readonly manifestMetadata: {
    readonly datasetKind: "synthetic";
    readonly reportDate: "2026-10-12";
    readonly geometry: null;
  };
  readonly reportText: string;
  readonly contraryReportText: string;
  readonly reportTextHash: string;
  readonly contraryReportTextHash: string;
  readonly supportReference: EvidenceReference;
  readonly contraryReference: EvidenceReference;
  readonly classificationRequest: ClassificationRequest;
  readonly extractionRequest: ExtractionRequest;
  readonly embeddingRequest: EmbeddingRequest;
  readonly sufficientReasoningRequest: ReasoningRequest;
  readonly insufficientReasoningRequest: ReasoningRequest;
  readonly plannerQuestions: readonly string[];
  readonly plannerActionMenu: readonly InvestigationActionMenuEntry[];
  readonly plannerRequest: InvestigationPlanRequest;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) deepFreeze(descriptor.value);
  }
  return Object.freeze(value);
}

function evidence(args: {
  readonly reference: EvidenceReference;
  readonly text: string;
  readonly sourceId: string;
  readonly observedAt: string;
  readonly publishedAt: string;
}): RetrievedEvidence {
  return {
    reference: args.reference,
    text: args.text,
    sourceId: args.sourceId,
    revisionStatus: "unreviewed",
    publishedAt: args.publishedAt,
    observedAt: args.observedAt,
    retrievedAt: RETRIEVED_AT,
    origins: [{
      originId: args.sourceId.replace("source_", "origin_"),
      independenceStatus: "unknown",
      dependsOnOriginIds: [],
    }],
  };
}

function groundingContext(args: {
  readonly contextId: string;
  readonly supportEvidence: RetrievedEvidence;
  readonly contraryEvidence: RetrievedEvidence;
  readonly sufficient: boolean;
}): GroundingContext {
  return {
    schemaVersion: "2.0",
    recordType: "GroundingContext",
    datasetKind: "synthetic",
    traceId: "trace_synthetic_smoke_v1",
    contextId: args.contextId,
    candidateId: CANDIDATE_ID,
    evidence: [args.supportEvidence, args.contraryEvidence],
    revisionStates: [
      { reportRevisionId: PRIMARY_REVISION_ID, revisionStatus: "unreviewed" },
      { reportRevisionId: CONTRARY_REVISION_ID, revisionStatus: "unreviewed" },
    ],
    candidateEvents: [],
    priorDecisionIds: [],
    missingFields: args.sufficient ? [] : [MISSING_FIELD_LABEL],
    conflicts: [CONFLICT_LABEL],
    retrievalVersion: "synthetic-retrieval-v1",
    indexVersion: "synthetic-index-v1",
    sufficient: args.sufficient,
  };
}

/**
 * Creates immutable synthetic report, chunk, evidence, and reasoning fixtures.
 * Hashes are SHA-256 of the exact authored Unicode strings; every span counts
 * Unicode code points, and no geographic geometry is asserted.
 */
export async function createSyntheticModelSmokeFixtures(): Promise<SyntheticModelSmokeFixtures> {
  const reportTextHash = await sha256Text(PRIMARY_REPORT_TEXT);
  const contraryReportTextHash = await sha256Text(CONTRARY_REPORT_TEXT);
  const reportCodePoints = codePointLength(PRIMARY_REPORT_TEXT);
  const contraryCodePoints = codePointLength(CONTRARY_REPORT_TEXT);

  const supportReference: EvidenceReference = {
    reportRevisionId: PRIMARY_REVISION_ID,
    permittedTextHash: reportTextHash,
    spanStart: 0,
    spanEnd: reportCodePoints,
    offsetUnit: "unicode_code_points",
    relation: "supports",
  };
  const contraryReference: EvidenceReference = {
    reportRevisionId: CONTRARY_REVISION_ID,
    permittedTextHash: contraryReportTextHash,
    spanStart: 0,
    spanEnd: contraryCodePoints,
    offsetUnit: "unicode_code_points",
    relation: "contradicts",
  };

  const report = {
    reportRevisionId: PRIMARY_REVISION_ID,
    permittedTextHash: reportTextHash,
    normalizationVersion: NORMALIZATION_VERSION,
    permittedText: PRIMARY_REPORT_TEXT,
  };
  const supportEvidence = evidence({
    reference: supportReference,
    text: PRIMARY_REPORT_TEXT,
    sourceId: "source_synthetic_smoke_primary",
    publishedAt: "2026-10-12T09:16:00+07:00",
    observedAt: "2026-10-12T09:15:00+07:00",
  });
  const contraryEvidence = evidence({
    reference: contraryReference,
    text: CONTRARY_REPORT_TEXT,
    sourceId: "source_synthetic_smoke_contrary",
    publishedAt: "2026-10-12T09:21:00+07:00",
    observedAt: "2026-10-12T09:20:00+07:00",
  });

  const sufficientContext = groundingContext({
    contextId: "context_synthetic_smoke_sufficient_v1",
    supportEvidence,
    contraryEvidence,
    sufficient: true,
  });
  const insufficientContext = groundingContext({
    contextId: "context_synthetic_smoke_insufficient_v1",
    supportEvidence,
    contraryEvidence,
    sufficient: false,
  });

  return deepFreeze({
    fixtureId: NINEROUTER_SYNTHETIC_FIXTURE_ID,
    manifestMetadata: {
      datasetKind: "synthetic",
      reportDate: "2026-10-12",
      geometry: null,
    },
    reportText: PRIMARY_REPORT_TEXT,
    contraryReportText: CONTRARY_REPORT_TEXT,
    reportTextHash,
    contraryReportTextHash,
    supportReference,
    contraryReference,
    classificationRequest: { data: { report } },
    extractionRequest: { data: { candidateId: CANDIDATE_ID, report } },
    embeddingRequest: {
      data: {
        chunk: {
          chunkId: "chunk_synthetic_smoke_primary_v1",
          reportRevisionId: PRIMARY_REVISION_ID,
          permittedTextHash: reportTextHash,
          normalizationVersion: NORMALIZATION_VERSION,
          spanStart: 0,
          spanEnd: reportCodePoints,
          offsetUnit: "unicode_code_points",
          chunkTextHash: reportTextHash,
          text: PRIMARY_REPORT_TEXT,
        },
      },
    },
    sufficientReasoningRequest: { data: { groundingContext: sufficientContext } },
    insufficientReasoningRequest: { data: { groundingContext: insufficientContext } },
    plannerQuestions: PLANNER_QUESTIONS,
    plannerActionMenu: PLANNER_ACTION_MENU,
    plannerRequest: {
      schemaVersion: "1.0",
      recordType: "InvestigationPlanRequest",
      groundingContext: insufficientContext,
      questions: PLANNER_QUESTIONS,
      actionMenu: PLANNER_ACTION_MENU,
    },
  });
}
