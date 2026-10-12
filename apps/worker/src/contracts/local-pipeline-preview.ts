/** Local development projection only. Never a published-event or hosted API contract. */
export const LOCAL_PIPELINE_PREVIEW_SCHEMA = 'local-pipeline-preview-v1';
export const LOCAL_PIPELINE_PREVIEW_PATH = '/__local/pipeline';
export type LocalPreviewJobStatus = 'pending' | 'leased' | 'retry' | 'completed' | 'terminal';
export type LocalPreviewFailure = 'l1_failed' | 'prerequisite_pending' | 'model_timeout' | 'model_failed'
  | 'invalid_output' | 'context_insufficient' | 'persistence_failed' | 'lease_expired';
export interface LocalPreviewJob {
  readonly status: LocalPreviewJobStatus;
  readonly attempts: number;
  readonly availableAt: string;
  readonly failure: LocalPreviewFailure | null;
}
export interface LocalPreviewEvidence {
  readonly reportRevisionId: string;
  readonly permittedTextHash: string;
  readonly spanStart: number;
  readonly spanEnd: number;
  readonly relation: 'supports' | 'contradicts' | 'updates' | 'context';
}
export interface LocalPreviewClaim {
  readonly claimId: string;
  readonly text: string;
  readonly assessment: 'supported' | 'uncertain' | 'disputed';
  readonly evidence: readonly LocalPreviewEvidence[];
}
export interface LocalPreviewReport {
  readonly reportId: string;
  readonly version: number;
  readonly title: string;
  readonly publishedAt: string | null;
  readonly observedAt: string | null;
  readonly capturedAt: string;
  readonly reportRevisionId: string;
  readonly supersedesId: string | null;
  readonly contentHash: string;
  /** Canonical L1 text, null until persisted; source text is data, never HTML. */
  readonly permittedText: string | null;
  readonly permittedTextHash: string | null;
  readonly ingestion: LocalPreviewJob;
  readonly ai: LocalPreviewJob | null;
  readonly stages: readonly ('extraction' | 'embedding' | 'grounding' | 'reasoning' | 'proposal')[];
  readonly proposal: {
    readonly proposalId: string;
    readonly proposedAt: string;
    readonly claims: readonly LocalPreviewClaim[];
    readonly unresolvedCount: number;
  } | null;
}
export interface LocalPipelinePreview {
  readonly schemaVersion: typeof LOCAL_PIPELINE_PREVIEW_SCHEMA;
  readonly datasetKind: 'synthetic';
  readonly publicationEnabled: false;
  readonly generatedAt: string;
  readonly sourceId: 'local-authored-api';
  readonly models: 'mock' | 'opt_in_gateway';
  readonly scheduler: {
    readonly status: 'idle' | 'running' | 'completed' | 'failed';
    readonly polls: number;
    readonly collectionFailures: number;
  };
  readonly summary: {
    readonly snapshots: number;
    readonly ingestion: Readonly<Record<LocalPreviewJobStatus, number>>;
    readonly ai: Readonly<Record<LocalPreviewJobStatus, number>>;
    readonly proposals: number;
  };
  readonly reports: readonly LocalPreviewReport[];
  /** Newest twenty snapshot versions only; summary counts cover the entire owned state. */
  readonly truncated: boolean;
}
