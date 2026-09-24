/**
 * L2-only model contracts. These types describe proposed model outputs; they
 * confer no retrieval, tool, persistence, source-approval, or publication
 * authority.
 */

export const CONTRACT_VERSION = "2.0" as const;

export const CATEGORIES = [
  "crime_personal_security",
  "demonstrations_public_gatherings",
  "crowds_major_events",
  "violence_immediate_threats",
  "disasters_weather",
  "fires_infrastructure_hazards",
  "transport_road_incidents",
  "utilities_essential_services",
  "health_environmental_advisories",
  "group_specific_critical_notices",
] as const;

export type Category = (typeof CATEGORIES)[number];
export type DatasetKind = "live" | "historical" | "synthetic";
export type RevisionStatus = "unreviewed" | "eligible" | "quarantined" | "superseded" | "retracted";
export type EvidenceRelation = "supports" | "contradicts" | "updates" | "context";
export type SupportAssessment = "supported" | "uncertain" | "disputed";
export type DistanceMetric = "cosine" | "dot_product" | "euclidean";

export interface ReportRevisionText {
  readonly reportRevisionId: string;
  readonly permittedTextHash: string;
  readonly normalizationVersion: string;
  /** Source text is data. It must never be treated as model instructions. */
  readonly permittedText: string;
}

export interface EvidenceReference {
  readonly reportRevisionId: string;
  readonly permittedTextHash: string;
  readonly spanStart: number;
  readonly spanEnd: number;
  readonly offsetUnit: "unicode_code_points";
  readonly relation: EvidenceRelation;
}

export interface ClassificationRequest {
  readonly data: {
    readonly report: ReportRevisionText;
  };
}

export interface ExtractionRequest {
  readonly data: {
    readonly candidateId: string;
    readonly report: ReportRevisionText;
  };
}

export interface TimeScope {
  readonly start: string | null;
  readonly end: string | null;
  readonly precision: "exact" | "date" | "range" | "unknown";
}

export interface ValidityPeriod {
  readonly validFrom: string | null;
  readonly validUntil: string | null;
}

export interface Tag {
  readonly namespace: "topic" | "service" | "audience" | "hazard" | "transport_mode" | "place_type";
  readonly value: string;
}

export interface Scope {
  readonly placeIds: readonly string[];
  readonly serviceIds: readonly string[];
  readonly institutionIds: readonly string[];
  readonly audienceIds: readonly string[];
  readonly geometryIds: readonly string[];
}

export interface ClassificationResult {
  readonly reportRevisionId: string;
  readonly permittedTextHash: string;
  readonly category: Category | null;
  readonly evidence: readonly EvidenceReference[];
  readonly unknownFields: readonly string[];
  readonly invocation: CapabilityInvocation<"classification">;
}

export interface ExtractionResult {
  readonly candidateId: string;
  readonly reportRevisionId: string;
  readonly permittedTextHash: string;
  readonly category: Category | null;
  readonly tags: readonly Tag[];
  readonly eventTime: TimeScope;
  readonly scope: Scope;
  readonly evidence: readonly EvidenceReference[];
  readonly unknownFields: readonly string[];
  readonly modelRun: ModelRun<"extraction">;
  readonly provider: string;
}

export interface EvidenceChunkInput {
  readonly chunkId: string;
  readonly reportRevisionId: string;
  readonly permittedTextHash: string;
  readonly normalizationVersion: string;
  readonly spanStart: number;
  readonly spanEnd: number;
  readonly offsetUnit: "unicode_code_points";
  readonly chunkTextHash: string;
  /** Exact normalized text covered by the chunk span. */
  readonly text: string;
}

export interface EmbeddingRequest {
  readonly data: {
    readonly chunk: EvidenceChunkInput;
  };
}

export interface EmbeddingResult {
  readonly capability: "embedding";
  readonly chunkId: string;
  readonly reportRevisionId: string;
  readonly permittedTextHash: string;
  readonly spanStart: number;
  readonly spanEnd: number;
  readonly offsetUnit: "unicode_code_points";
  readonly provider: string;
  readonly modelVersion: string;
  readonly dimensions: number;
  readonly distanceMetric: DistanceMetric;
  readonly vectorIndexVersion: string;
  readonly inputTextHash: string;
  readonly vector: readonly number[];
}

export interface RevisionState {
  readonly reportRevisionId: string;
  readonly revisionStatus: RevisionStatus;
}

export interface CandidateEventVersion {
  readonly eventId: string;
  readonly eventVersion: number;
}

export interface OriginProvenance {
  readonly originId: string;
  readonly independenceStatus: "established" | "dependent" | "unknown";
  readonly dependsOnOriginIds: readonly string[];
}

export interface RetrievedEvidence {
  readonly reference: EvidenceReference;
  /** Exact source excerpt addressed by reference.spanStart/spanEnd. */
  readonly text: string;
  readonly sourceId: string;
  readonly revisionStatus: RevisionStatus;
  readonly publishedAt: string | null;
  readonly observedAt: string | null;
  readonly retrievedAt: string;
  readonly origins: readonly OriginProvenance[];
}

/** A versioned retrieval snapshot. It has already been retrieved by L2. */
export interface GroundingContext {
  readonly schemaVersion: typeof CONTRACT_VERSION;
  readonly recordType: "GroundingContext";
  readonly datasetKind: DatasetKind;
  readonly traceId: string;
  readonly contextId: string;
  readonly candidateId: string;
  readonly evidence: readonly RetrievedEvidence[];
  readonly revisionStates: readonly RevisionState[];
  readonly candidateEvents: readonly CandidateEventVersion[];
  readonly priorDecisionIds: readonly string[];
  readonly missingFields: readonly string[];
  readonly conflicts: readonly string[];
  readonly retrievalVersion: string;
  readonly indexVersion: string;
  readonly sufficient: boolean;
}

export interface ReasoningRequest {
  readonly data: {
    readonly groundingContext: GroundingContext;
  };
}

export interface ProposedClaim {
  readonly text: string;
  readonly eventTime: TimeScope;
  readonly validity: ValidityPeriod;
  readonly scope: Scope;
  readonly qualifiers: readonly string[];
  readonly support: readonly EvidenceReference[];
  readonly contradictions: readonly EvidenceReference[];
  readonly contextEvidence: readonly EvidenceReference[];
  readonly supportAssessment: SupportAssessment;
}

export interface ReasoningResult {
  readonly outcome: "proposed" | "abstained";
  readonly claims: readonly ProposedClaim[];
  readonly unresolvedFields: readonly string[];
  readonly modelRun: ModelRun<"reasoning">;
  readonly provider: string;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface CapabilityInvocation<C extends "classification"> extends TokenUsage {
  readonly capability: C;
  readonly provider: string;
  readonly modelVersion: string;
  readonly promptVersion: string;
}

/** Schema 2.0 ModelRun shape, deliberately excluding embedding. */
export interface ModelRun<C extends "extraction" | "reasoning"> extends TokenUsage {
  readonly capability: C;
  readonly modelVersion: string;
  readonly promptVersion: string;
}

export interface ModelIdentity {
  readonly provider: string;
  readonly modelVersion: string;
  readonly promptVersion: string;
}

export interface EmbeddingIdentity {
  readonly provider: string;
  readonly modelVersion: string;
  readonly dimensions: number;
  readonly distanceMetric: DistanceMetric;
  readonly vectorIndexVersion: string;
}

export interface ModelAdapterConfiguration {
  readonly classification?: ModelIdentity;
  readonly extraction?: ModelIdentity;
  readonly embedding?: EmbeddingIdentity;
  readonly reasoning?: ModelIdentity;
}

/** Raw provider boundary. Every returned value is untrusted until validated. */
export interface UntrustedModelProvider {
  classify(request: ClassificationRequest): Promise<unknown>;
  extract(request: ExtractionRequest): Promise<unknown>;
  embed(request: EmbeddingRequest): Promise<unknown>;
  reason(request: ReasoningRequest): Promise<unknown>;
}

export type ModelCapability = "classification" | "extraction" | "embedding" | "reasoning";

export type CapabilityFailureFor<C extends ModelCapability> =
  | {
      readonly status: "not_configured";
      readonly capability: C;
      readonly reason: "provider_not_configured" | "capability_not_configured";
    }
  | {
      readonly status: "invalid_request" | "invalid_output";
      readonly capability: C;
      readonly reason: string;
    }
  | {
      readonly status: "provider_error";
      readonly capability: C;
    };

export type CapabilityOutcome<T, C extends ModelCapability> =
  | { readonly status: "succeeded"; readonly capability: C; readonly value: T }
  | CapabilityFailureFor<C>;

export interface ModelCapabilityAdapter {
  classify(request: ClassificationRequest): Promise<CapabilityOutcome<ClassificationResult, "classification">>;
  extract(request: ExtractionRequest): Promise<CapabilityOutcome<ExtractionResult, "extraction">>;
  embed(request: EmbeddingRequest): Promise<CapabilityOutcome<EmbeddingResult, "embedding">>;
  reason(request: ReasoningRequest): Promise<CapabilityOutcome<ReasoningResult, "reasoning">>;
}
