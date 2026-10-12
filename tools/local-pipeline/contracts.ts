import type { AcquisitionJobRecord, AcquisitionJobStatus } from '../../apps/db/src/queue.js';
import type { TransactionalSqlExecutor } from '../../apps/db/src/sql.js';

/** Local-only composition contract. Public v1 and domain schema 2.0 are unchanged. */
export const LOCAL_SOURCE_ID = 'local-authored-api';
export const LOCAL_FEED_SCHEMA = 'local-synthetic-api-v1';
export const LOCAL_PIPELINE_SCHEMA = 'local-private-pipeline-v1';
export const LOCAL_LIMITS = Object.freeze({ maxReports: 20, maxFeedBytes: 65_536, maxTextCodePoints: 4_096 });
export interface AuthoredReport {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly publishedAt: string | null;
  readonly observedAt: string | null;
}
export interface AuthoredFeed {
  readonly schemaVersion: typeof LOCAL_FEED_SCHEMA;
  readonly datasetKind: 'synthetic';
  readonly sourceId: typeof LOCAL_SOURCE_ID;
  readonly reports: readonly AuthoredReport[];
}
export interface ReportSnapshot extends AuthoredReport {
  readonly sourceId: typeof LOCAL_SOURCE_ID;
  readonly datasetKind: 'synthetic';
  readonly version: number;
  readonly contentHash: string;
  readonly canonicalUrl: string;
  readonly sourceRevisionKey: string;
  readonly reportRevisionId: string;
  readonly candidateId: string;
  readonly traceId: string;
  readonly supersedesId: string | null;
  readonly capturedAt: string;
}
export type AiStage = 'extraction' | 'embedding' | 'grounding' | 'reasoning' | 'proposal';
export type SafeFailure = 'l1_failed' | 'prerequisite_pending' | 'model_timeout' | 'model_failed' | 'invalid_output' | 'context_insufficient' | 'persistence_failed' | 'lease_expired';
export interface AiJob {
  readonly jobId: string;
  readonly status: AcquisitionJobStatus;
  readonly attemptCount: number;
  readonly leaseToken: string | null;
  readonly leaseExpiresAt: string | null;
  readonly snapshot: ReportSnapshot;
}
export interface PipelineSummary {
  readonly snapshots: number;
  readonly ingestion: Readonly<Record<AcquisitionJobStatus, number>>;
  readonly ai: Readonly<Record<AcquisitionJobStatus, number>>;
  readonly proposals: number;
}
export type FailureTransition = 'retry' | 'terminal' | 'lost_lease';
/** All callbacks are SQL-only. No provider or filesystem work inside these transactions. */
export interface LocalPipelineStore {
  capture(feed: AuthoredFeed, now: string): Promise<{ captured: number; unchanged: number }>;
  claimIngestion(now: string): Promise<AcquisitionJobRecord | null>;
  ingestionSnapshot(jobId: string): Promise<ReportSnapshot | null>;
  finishIngestion(job: AcquisitionJobRecord, now: string, write: (tx: TransactionalSqlExecutor, snapshot: ReportSnapshot) => Promise<void>): Promise<boolean>;
  failIngestion(job: AcquisitionJobRecord, now: string, code: SafeFailure): Promise<FailureTransition>;
  claimAi(now: string, leaseDurationMs?: number): Promise<AiJob | null>;
  renewAi(job: AiJob, now: string, leaseDurationMs?: number): Promise<boolean>;
  readReceipt(jobId: string, stage: AiStage): Promise<unknown | null>;
  checkpoint(job: AiJob, now: string, stage: AiStage, value: unknown, write?: (tx: TransactionalSqlExecutor) => Promise<void>): Promise<boolean>;
  completeAi(job: AiJob, now: string): Promise<boolean>;
  failAi(job: AiJob, now: string, code: SafeFailure): Promise<FailureTransition>;
  recover(now: string): Promise<{ ingestion: number; ai: number }>;
  summary(): Promise<PipelineSummary>;
}
