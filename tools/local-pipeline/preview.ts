import { createHash } from 'node:crypto';
import type { TransactionalSqlExecutor } from '../../apps/db/src/sql.js';
import {
  LOCAL_PIPELINE_PREVIEW_SCHEMA,
  type LocalPipelinePreview,
  type LocalPreviewClaim,
  type LocalPreviewEvidence,
  type LocalPreviewFailure,
  type LocalPreviewJob,
  type LocalPreviewJobStatus,
  type LocalPreviewReport,
} from '../../apps/worker/src/contracts/local-pipeline-preview.js';
import { NORMALIZATION_VERSION } from '../../apps/worker/src/layers/l1-data-knowledge/text-preparation.js';
import { LOCAL_SOURCE_ID } from './contracts.js';

const JOB_STATUSES: readonly LocalPreviewJobStatus[] = ['pending', 'leased', 'retry', 'completed', 'terminal'];
const STAGES = ['extraction', 'embedding', 'grounding', 'reasoning', 'proposal'] as const;
const FAILURES: readonly LocalPreviewFailure[] = [
  'l1_failed', 'prerequisite_pending', 'model_timeout', 'model_failed', 'invalid_output',
  'context_insufficient', 'persistence_failed', 'lease_expired',
];
const HASH = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface LocalPreviewSchedulerState {
  readonly status: 'idle' | 'running' | 'completed' | 'failed';
  readonly polls: number;
  readonly collectionFailures: number;
}

export interface ReadLocalPipelinePreviewInput {
  readonly executor: TransactionalSqlExecutor;
  readonly models: 'mock' | 'opt_in_gateway';
  readonly scheduler: LocalPreviewSchedulerState;
  readonly generatedAt?: string;
}

interface CountRow { count: number | string; }
interface StatusCountRow { status: string; count: number | string; }

interface SnapshotRow {
  snapshot_id: string;
  snapshot_dataset_kind: string;
  snapshot_source_id: string;
  stable_report_id: string;
  version: number | string;
  content_hash: string;
  title: string;
  report_text: string;
  published_at_text: string | null;
  observed_at_text: string | null;
  source_revision_key: string;
  report_revision_id: string;
  candidate_id: string;
  trace_id: string;
  supersedes_id: string | null;
  captured_at_text: string;
  inbox_snapshot_id: string | null;
  inbox_dataset_kind: string | null;
  inbox_source_id: string | null;
  inbox_job_id: string | null;
  ingestion_job_id: string | null;
  ingestion_dataset_kind: string | null;
  ingestion_job_kind: string | null;
  ingestion_source_id: string | null;
  ingestion_trace_id: string | null;
  ingestion_status: string | null;
  ingestion_attempt_count: number | string | null;
  ingestion_max_attempts: number | string | null;
  ingestion_available_at: string | null;
  ingestion_failure: string | null;
  ai_job_id: string | null;
  ai_snapshot_id: string | null;
  ai_status: string | null;
  ai_attempt_count: number | string | null;
  ai_available_at: string | null;
  ai_failure: string | null;
  revision_dataset_kind: string | null;
  revision_id: string | null;
  revision_trace_id: string | null;
  revision_source_id: string | null;
  revision_content_hash: string | null;
  revision_text_hash: string | null;
  revision_text: string | null;
  revision_status: string | null;
  revision_source_key: string | null;
  revision_supersedes_id: string | null;
  revision_normalization_version: string | null;
  prior_revision_id: string | null;
  extraction_dataset_kind: string | null;
  extraction_candidate_id: string | null;
  extraction_trace_id: string | null;
  extraction_revision_id: string | null;
}

interface ProposalRow {
  dataset_kind: string;
  proposal_id: string;
  trace_id: string;
  candidate_id: string;
  context_id: string;
  event_id: string | null;
  base_event_version: number | string | null;
  investigation_id: string | null;
  proposed_at: string;
  unresolved_fields: unknown;
  context_dataset_kind: string | null;
  context_trace_id: string | null;
  context_candidate_id: string | null;
  context_sufficient: boolean | null;
  extraction_dataset_kind: string | null;
  extraction_trace_id: string | null;
  extraction_revision_id: string | null;
}

interface ClaimRow {
  dataset_kind: string;
  proposal_id: string;
  claim_id: string;
  claim_text: string;
  support_assessment: string;
}

interface ClaimEvidenceRow {
  dataset_kind: string;
  proposal_id: string;
  claim_id: string;
  evidence_kind: string;
  evidence_ref_id: string;
  reference_dataset_kind: string | null;
  report_revision_id: string | null;
  permitted_text_hash: string | null;
  span_start: number | string | null;
  span_end: number | string | null;
  offset_unit: string | null;
  relation: string | null;
  revision_dataset_kind: string | null;
  revision_trace_id: string | null;
  revision_source_id: string | null;
  revision_content_hash: string | null;
  revision_text_hash: string | null;
  revision_text: string | null;
  revision_status: string | null;
  revision_source_key: string | null;
  revision_supersedes_id: string | null;
  snapshot_dataset_kind: string | null;
  snapshot_source_id: string | null;
  snapshot_stable_report_id: string | null;
  snapshot_version: number | string | null;
  snapshot_content_hash: string | null;
  snapshot_source_key: string | null;
  snapshot_revision_id: string | null;
  snapshot_trace_id: string | null;
  snapshot_supersedes_id: string | null;
}

/** Build the closed local DTO from the owned synthetic snapshot and canonical evidence tables. */
export async function readLocalPipelinePreview(input: ReadLocalPipelinePreviewInput): Promise<LocalPipelinePreview> {
  try {
    validateReadInput(input);
    return await input.executor.transaction(async (transaction) => {
      await transaction.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      return readLocalPipelinePreviewInTransaction({ ...input, executor: transaction });
    });
  } catch {
    throw new Error('local_preview_unavailable');
  }
}

async function readLocalPipelinePreviewInTransaction(
  input: Omit<ReadLocalPipelinePreviewInput, 'executor'> & { readonly executor: Pick<TransactionalSqlExecutor, 'query'> },
): Promise<LocalPipelinePreview> {
  try {
    validateReadInput(input);
    const [snapshotCountResult, ingestionStatusResult, aiStatusResult, proposalCountResult] = await Promise.all([
      input.executor.query<CountRow>(
        `SELECT count(*)::text AS count FROM waspada.local_report_snapshots
         WHERE dataset_kind = 'synthetic' AND source_id = $1`, [LOCAL_SOURCE_ID]),
      input.executor.query<StatusCountRow>(
        `SELECT job.status, count(*)::text AS count
         FROM waspada.local_report_inbox AS inbox
         JOIN waspada.acquisition_jobs AS job ON job.job_id = inbox.source_poll_job_id
         WHERE inbox.dataset_kind = 'synthetic' AND inbox.source_id = $1
         GROUP BY job.status`, [LOCAL_SOURCE_ID]),
      input.executor.query<StatusCountRow>(
        `SELECT job.status, count(*)::text AS count
         FROM waspada.local_ai_jobs AS job
         JOIN waspada.local_report_snapshots AS snapshot ON snapshot.snapshot_id = job.snapshot_id
         WHERE snapshot.dataset_kind = 'synthetic' AND snapshot.source_id = $1
         GROUP BY job.status`, [LOCAL_SOURCE_ID]),
      input.executor.query<CountRow>(
        `SELECT count(*)::text AS count
         FROM waspada.event_proposals AS proposal
         JOIN waspada.local_report_snapshots AS snapshot
           ON snapshot.candidate_id = proposal.candidate_id
         WHERE proposal.dataset_kind = 'synthetic'
           AND snapshot.dataset_kind = 'synthetic' AND snapshot.source_id = $1`, [LOCAL_SOURCE_ID]),
    ]);

    const totalSnapshots = count(snapshotCountResult.rows[0]?.count);
    const ingestion = statusCounts(ingestionStatusResult.rows);
    const ai = statusCounts(aiStatusResult.rows);
    const proposalCount = count(proposalCountResult.rows[0]?.count);
    if (totalOf(ingestion) !== totalSnapshots || totalOf(ai) !== ingestion.completed || proposalCount > totalOf(ai)) invalid();

    const snapshotResult = await input.executor.query<SnapshotRow>(
      `SELECT
         snapshot.snapshot_id, snapshot.dataset_kind AS snapshot_dataset_kind,
         snapshot.source_id AS snapshot_source_id, snapshot.stable_report_id, snapshot.version,
         snapshot.content_hash, snapshot.title, snapshot.report_text,
         snapshot.published_at_text, snapshot.observed_at_text, snapshot.source_revision_key,
         snapshot.report_revision_id, snapshot.candidate_id, snapshot.trace_id,
         snapshot.supersedes_id, snapshot.captured_at_text,
         inbox.snapshot_id AS inbox_snapshot_id, inbox.dataset_kind AS inbox_dataset_kind,
         inbox.source_id AS inbox_source_id, inbox.source_poll_job_id AS inbox_job_id,
         ingestion.job_id AS ingestion_job_id, ingestion.dataset_kind AS ingestion_dataset_kind,
         ingestion.job_kind AS ingestion_job_kind, ingestion.source_id AS ingestion_source_id,
         ingestion.trace_id AS ingestion_trace_id, ingestion.status AS ingestion_status,
         ingestion.attempt_count AS ingestion_attempt_count, ingestion.max_attempts AS ingestion_max_attempts,
         ingestion.available_at::text AS ingestion_available_at,
         ingestion.last_failure_code AS ingestion_failure,
         ai.job_id AS ai_job_id, ai.snapshot_id AS ai_snapshot_id, ai.status AS ai_status,
         ai.attempt_count AS ai_attempt_count, ai.available_at::text AS ai_available_at,
         ai.last_failure_code AS ai_failure,
         revision.dataset_kind AS revision_dataset_kind,
         revision.report_revision_id AS revision_id, revision.trace_id AS revision_trace_id,
         revision.source_id AS revision_source_id, revision.content_hash AS revision_content_hash,
         revision.permitted_text_hash AS revision_text_hash, revision.permitted_text AS revision_text,
         revision.revision_status, revision.source_revision_key AS revision_source_key,
         revision.supersedes_id AS revision_supersedes_id,
         revision.normalization_version AS revision_normalization_version,
         prior.report_revision_id AS prior_revision_id,
         extraction.dataset_kind AS extraction_dataset_kind,
         extraction.candidate_id AS extraction_candidate_id,
         extraction.trace_id AS extraction_trace_id,
         extraction.report_revision_id AS extraction_revision_id
       FROM waspada.local_report_snapshots AS snapshot
       LEFT JOIN waspada.local_report_inbox AS inbox
         ON inbox.snapshot_id = snapshot.snapshot_id
       LEFT JOIN waspada.acquisition_jobs AS ingestion
         ON ingestion.job_id = inbox.source_poll_job_id
       LEFT JOIN waspada.local_ai_jobs AS ai
         ON ai.snapshot_id = snapshot.snapshot_id
       LEFT JOIN waspada.report_revisions AS revision
         ON revision.dataset_kind = 'synthetic'
        AND revision.report_revision_id = snapshot.report_revision_id
       LEFT JOIN waspada.local_report_snapshots AS prior
         ON prior.dataset_kind = snapshot.dataset_kind
        AND prior.source_id = snapshot.source_id
        AND prior.stable_report_id = snapshot.stable_report_id
        AND prior.version = snapshot.version - 1
       LEFT JOIN waspada.extraction_results AS extraction
         ON extraction.dataset_kind = 'synthetic'
        AND extraction.candidate_id = snapshot.candidate_id
       WHERE snapshot.dataset_kind = 'synthetic' AND snapshot.source_id = $1
       ORDER BY snapshot.captured_at_text::timestamptz DESC,
                snapshot.stable_report_id, snapshot.version DESC
       LIMIT 21`, [LOCAL_SOURCE_ID]);
    if (snapshotResult.rows.length !== Math.min(totalSnapshots, 21)) invalid();
    const selectedRows = snapshotResult.rows.slice(0, 20);
    const reportBases = selectedRows.map(validateSnapshotRow);
    const aiJobIds = reportBases.flatMap((report) => report.aiJobId === null ? [] : [report.aiJobId]);
    const candidateIds = reportBases.map((report) => report.candidateId);

    const [stageResult, proposalResult] = await Promise.all([
      aiJobIds.length === 0
        ? Promise.resolve({ rows: [] as { job_id: string; stage: string }[] })
        : input.executor.query<{ job_id: string; stage: string }>(
          `SELECT job_id, stage FROM waspada.local_ai_receipts
           WHERE job_id = ANY($1::text[]) ORDER BY job_id, stage`, [aiJobIds]),
      candidateIds.length === 0
        ? Promise.resolve({ rows: [] as ProposalRow[] })
        : input.executor.query<ProposalRow>(
          `SELECT proposal.dataset_kind, proposal.proposal_id, proposal.trace_id,
                  proposal.candidate_id, proposal.context_id, proposal.event_id,
                  proposal.base_event_version, proposal.investigation_id,
                  proposal.proposed_at::text AS proposed_at,
                  proposal.record_json -> 'unresolved_fields' AS unresolved_fields,
                  context.dataset_kind AS context_dataset_kind,
                  context.trace_id AS context_trace_id,
                  context.candidate_id AS context_candidate_id,
                  context.sufficient AS context_sufficient,
                  extraction.dataset_kind AS extraction_dataset_kind,
                  extraction.trace_id AS extraction_trace_id,
                  extraction.report_revision_id AS extraction_revision_id
           FROM waspada.event_proposals AS proposal
           LEFT JOIN waspada.grounding_contexts AS context
             ON context.dataset_kind = proposal.dataset_kind
            AND context.context_id = proposal.context_id
           LEFT JOIN waspada.extraction_results AS extraction
             ON extraction.dataset_kind = proposal.dataset_kind
            AND extraction.candidate_id = proposal.candidate_id
           WHERE proposal.dataset_kind = 'synthetic'
             AND proposal.candidate_id = ANY($1::text[])
           ORDER BY proposal.candidate_id, proposal.proposed_at, proposal.proposal_id
           LIMIT 21`, [candidateIds]),
    ]);
    if (proposalResult.rows.length > 20) invalid();
    const stagesByJob = groupStages(stageResult.rows, aiJobIds);
    const proposalByCandidate = new Map<string, ProposalRow>();
    for (const proposal of proposalResult.rows) {
      if (proposalByCandidate.has(proposal.candidate_id)) invalid();
      proposalByCandidate.set(proposal.candidate_id, proposal);
    }

    const proposalRows = [...proposalByCandidate.values()];
    const proposalIds = proposalRows.map((proposal) => proposal.proposal_id);
    const [claimResult, originResult] = await Promise.all([
      proposalIds.length === 0
        ? Promise.resolve({ rows: [] as ClaimRow[] })
        : input.executor.query<ClaimRow>(
          `SELECT dataset_kind, proposal_id, claim_id, claim_text, support_assessment
           FROM waspada.proposal_claims
           WHERE dataset_kind = 'synthetic' AND proposal_id = ANY($1::text[])
           ORDER BY proposal_id, claim_id LIMIT 401`, [proposalIds]),
      proposalIds.length === 0
        ? Promise.resolve({ rows: [] as ClaimOriginRow[] })
        : input.executor.query<ClaimOriginRow>(
          `SELECT link.dataset_kind, link.proposal_id, link.claim_id, link.origin_id,
                  origin.dataset_kind AS origin_dataset_kind, origin.source_id AS origin_source_id,
                  origin.trace_id AS origin_trace_id, origin.independence_status,
                  origin.lineage_relation,
                  EXISTS (
                    SELECT 1
                    FROM waspada.origin_report_revisions AS origin_revision
                    JOIN waspada.local_report_snapshots AS source_snapshot
                      ON source_snapshot.dataset_kind = origin_revision.dataset_kind
                     AND source_snapshot.report_revision_id = origin_revision.report_revision_id
                     AND source_snapshot.source_id = $2
                    WHERE origin_revision.dataset_kind = link.dataset_kind
                      AND origin_revision.origin_id = link.origin_id
                      AND source_snapshot.trace_id = origin.trace_id
                  ) AS origin_source_lineage
           FROM waspada.proposal_claim_origins AS link
           LEFT JOIN waspada.evidence_origins AS origin
             ON origin.dataset_kind = link.dataset_kind AND origin.origin_id = link.origin_id
           WHERE link.dataset_kind = 'synthetic' AND link.proposal_id = ANY($1::text[])
           ORDER BY link.proposal_id, link.claim_id, link.origin_id LIMIT 3201`, [proposalIds, LOCAL_SOURCE_ID]),
    ]);
    if (claimResult.rows.length > 400 || originResult.rows.length > 3200) invalid();
    const claimsByProposal = groupClaims(claimResult.rows, proposalRows);
    const originsByClaim = groupOrigins(originResult.rows, proposalRows, claimsByProposal);

    const [evidenceResult, originEvidenceResult] = await Promise.all([
      proposalIds.length === 0
        ? Promise.resolve({ rows: [] as ClaimEvidenceRow[] })
        : input.executor.query<ClaimEvidenceRow>(
          `SELECT link.dataset_kind, link.proposal_id, link.claim_id, link.evidence_kind,
                  link.evidence_ref_id::text AS evidence_ref_id,
                  reference.dataset_kind AS reference_dataset_kind,
                  reference.report_revision_id, reference.permitted_text_hash,
                  reference.span_start, reference.span_end, reference.offset_unit,
                  reference.relation,
                  revision.dataset_kind AS revision_dataset_kind,
                  revision.trace_id AS revision_trace_id, revision.source_id AS revision_source_id,
                  revision.content_hash AS revision_content_hash,
                  revision.permitted_text_hash AS revision_text_hash,
                  revision.permitted_text AS revision_text, revision.revision_status,
                  revision.source_revision_key AS revision_source_key,
                  revision.supersedes_id AS revision_supersedes_id,
                  source_snapshot.dataset_kind AS snapshot_dataset_kind,
                  source_snapshot.source_id AS snapshot_source_id,
                  source_snapshot.stable_report_id AS snapshot_stable_report_id,
                  source_snapshot.version AS snapshot_version,
                  source_snapshot.content_hash AS snapshot_content_hash,
                  source_snapshot.source_revision_key AS snapshot_source_key,
                  source_snapshot.report_revision_id AS snapshot_revision_id,
                  source_snapshot.trace_id AS snapshot_trace_id,
                  source_snapshot.supersedes_id AS snapshot_supersedes_id
           FROM waspada.proposal_claim_evidence AS link
           LEFT JOIN waspada.evidence_references AS reference
             ON reference.dataset_kind = link.dataset_kind
            AND reference.evidence_ref_id = link.evidence_ref_id
           LEFT JOIN waspada.report_revisions AS revision
             ON revision.dataset_kind = reference.dataset_kind
            AND revision.report_revision_id = reference.report_revision_id
            AND revision.permitted_text_hash = reference.permitted_text_hash
           LEFT JOIN waspada.local_report_snapshots AS source_snapshot
             ON source_snapshot.dataset_kind = 'synthetic'
            AND source_snapshot.source_id = $2
            AND source_snapshot.report_revision_id = reference.report_revision_id
           WHERE link.dataset_kind = 'synthetic' AND link.proposal_id = ANY($1::text[])
           ORDER BY link.proposal_id, link.claim_id, link.evidence_kind, link.evidence_ref_id
           LIMIT 4001`, [proposalIds, LOCAL_SOURCE_ID]),
      proposalIds.length === 0
        ? Promise.resolve({ rows: [] as OriginEvidenceRow[] })
        : input.executor.query<OriginEvidenceRow>(
          `SELECT link.dataset_kind, link.proposal_id, link.claim_id, link.origin_id,
                  claim_evidence.evidence_ref_id::text AS evidence_ref_id,
                  origin_evidence.evidence_ref_id::text AS linked_evidence_ref_id,
                  claim_evidence.evidence_kind
           FROM waspada.proposal_claim_origins AS link
           JOIN waspada.proposal_claim_evidence AS claim_evidence
             ON claim_evidence.dataset_kind = link.dataset_kind
            AND claim_evidence.proposal_id = link.proposal_id
            AND claim_evidence.claim_id = link.claim_id
            AND claim_evidence.evidence_kind = 'support'
           JOIN waspada.origin_report_revisions AS origin_revision
             ON origin_revision.dataset_kind = link.dataset_kind
            AND origin_revision.origin_id = link.origin_id
           JOIN waspada.evidence_references AS support_reference
             ON support_reference.dataset_kind = claim_evidence.dataset_kind
            AND support_reference.evidence_ref_id = claim_evidence.evidence_ref_id
            AND support_reference.report_revision_id = origin_revision.report_revision_id
           LEFT JOIN waspada.origin_evidence AS origin_evidence
             ON origin_evidence.dataset_kind = link.dataset_kind
            AND origin_evidence.origin_id = link.origin_id
            AND origin_evidence.evidence_ref_id = claim_evidence.evidence_ref_id
           WHERE link.dataset_kind = 'synthetic' AND link.proposal_id = ANY($1::text[])
           ORDER BY link.proposal_id, link.claim_id, link.origin_id,
                    claim_evidence.evidence_ref_id LIMIT 25601`, [proposalIds]),
    ]);
    if (evidenceResult.rows.length > 4000 || originEvidenceResult.rows.length > 25_600) invalid();
    const evidenceByClaim = groupClaimEvidence(evidenceResult.rows, claimsByProposal);
    const supportReferenceIds = collectSupportReferenceIds(evidenceResult.rows);
    validateOriginEvidence(originEvidenceResult.rows, originsByClaim, supportReferenceIds);

    const reports: LocalPreviewReport[] = reportBases.map((report) => {
      const stages = report.aiJobId === null ? [] : stagesByJob.get(report.aiJobId) ?? [];
      const proposal = proposalByCandidate.get(report.candidateId);
      if ((proposal !== undefined) !== stages.includes('proposal')) invalid();
      const previewProposal = proposal === undefined
        ? null
        : projectProposal(proposal, report, claimsByProposal, evidenceByClaim, originsByClaim);
      if (report.extractionPresent !== stages.includes('extraction')) invalid();
      return {
        reportId: report.reportId,
        version: report.version,
        title: report.title,
        publishedAt: report.publishedAt,
        observedAt: report.observedAt,
        capturedAt: report.capturedAt,
        reportRevisionId: report.reportRevisionId,
        supersedesId: report.supersedesId,
        contentHash: report.contentHash,
        permittedText: report.permittedText,
        permittedTextHash: report.permittedTextHash,
        ingestion: report.ingestion,
        ai: report.ai,
        stages,
        proposal: previewProposal,
      };
    });

    const generatedAt = isoTimestamp(input.generatedAt ?? new Date().toISOString());
    const scheduler = validateScheduler(input.scheduler);
    const projection: LocalPipelinePreview = {
      schemaVersion: LOCAL_PIPELINE_PREVIEW_SCHEMA,
      datasetKind: 'synthetic',
      publicationEnabled: false,
      generatedAt,
      sourceId: LOCAL_SOURCE_ID,
      models: input.models,
      scheduler,
      summary: { snapshots: totalSnapshots, ingestion, ai, proposals: proposalCount },
      reports,
      truncated: totalSnapshots > reports.length,
    };
    if (Buffer.byteLength(JSON.stringify(projection), 'utf8') > 512 * 1024) invalid();
    return projection;
  } catch {
    // SQL errors, malformed persisted state and validation failures share one closed signal.
    throw new Error('local_preview_unavailable');
  }
}

interface ClaimOriginRow {
  dataset_kind: string;
  proposal_id: string;
  claim_id: string;
  origin_id: string;
  origin_dataset_kind: string | null;
  origin_source_id: string | null;
  origin_trace_id: string | null;
  independence_status: string | null;
  lineage_relation: string | null;
  origin_source_lineage: boolean;
}

interface OriginEvidenceRow {
  dataset_kind: string;
  proposal_id: string;
  claim_id: string;
  origin_id: string;
  evidence_ref_id: string;
  linked_evidence_ref_id: string | null;
  evidence_kind: string;
}

interface ReportBase {
  readonly reportId: string;
  readonly version: number;
  readonly title: string;
  readonly publishedAt: string | null;
  readonly observedAt: string | null;
  readonly capturedAt: string;
  readonly reportRevisionId: string;
  readonly supersedesId: string | null;
  readonly contentHash: string;
  readonly permittedText: string | null;
  readonly permittedTextHash: string | null;
  readonly candidateId: string;
  readonly traceId: string;
  readonly ingestion: LocalPreviewJob;
  readonly ai: LocalPreviewJob | null;
  readonly aiJobId: string | null;
  readonly extractionPresent: boolean;
}

function validateReadInput(input: Pick<ReadLocalPipelinePreviewInput, 'models' | 'scheduler'>
  & { readonly executor: Pick<TransactionalSqlExecutor, 'query'> }): void {
  if (!input || typeof input !== 'object' || !input.executor || typeof input.executor.query !== 'function'
    || (input.models !== 'mock' && input.models !== 'opt_in_gateway')) invalid();
  validateScheduler(input.scheduler);
}

function validateSnapshotRow(row: SnapshotRow): ReportBase {
  if (row.snapshot_dataset_kind !== 'synthetic' || row.snapshot_source_id !== LOCAL_SOURCE_ID
    || !row.inbox_snapshot_id || row.inbox_snapshot_id !== row.snapshot_id
    || row.inbox_dataset_kind !== 'synthetic' || row.inbox_source_id !== LOCAL_SOURCE_ID
    || !row.inbox_job_id || row.ingestion_job_id !== row.inbox_job_id
    || row.ingestion_dataset_kind !== 'synthetic' || row.ingestion_job_kind !== 'source_poll'
    || row.ingestion_source_id !== LOCAL_SOURCE_ID || row.ingestion_trace_id !== row.trace_id) invalid();
  const reportId = boundedText(row.stable_report_id, 200, false);
  if (!ID.test(reportId)) invalid();
  const version = integer(row.version, 1, 2_147_483_647);
  const contentHash = hash(row.content_hash);
  const title = boundedSingleLineText(row.title, 300);
  const reportText = boundedText(row.report_text, 4096, false);
  const publishedAt = nullableTimestamp(row.published_at_text);
  const observedAt = nullableTimestamp(row.observed_at_text);
  const capturedAt = isoTimestamp(row.captured_at_text);
  const traceId = uuid(row.trace_id);
  const sourceRevisionKey = boundedText(row.source_revision_key, 100, false);
  const reportRevisionId = boundedText(row.report_revision_id, 128, false);
  const candidateId = boundedText(row.candidate_id, 128, false);
  const supersedesId = nullableId(row.supersedes_id, 128);
  const identity = sha256(JSON.stringify([LOCAL_SOURCE_ID, reportId, version, contentHash]));
  if (sha256(JSON.stringify([reportId, title, reportText, row.published_at_text, row.observed_at_text])) !== contentHash
    || sourceRevisionKey !== `local-v1:${sha256(JSON.stringify([reportId, version]))}`
    || reportRevisionId !== `local-revision:${identity}` || candidateId !== `local-candidate:${identity}`) invalid();
  if (version === 1 ? (row.prior_revision_id !== null || supersedesId !== null)
    : (!row.prior_revision_id || row.prior_revision_id !== supersedesId)) invalid();
  const jobStatus = status(row.ingestion_status);
  const ingestionAttempts = integer(row.ingestion_attempt_count, 0, 5);
  const ingestionMaxAttempts = integer(row.ingestion_max_attempts, 1, 5);
  if (ingestionAttempts > ingestionMaxAttempts) invalid();
  const ingestion: LocalPreviewJob = {
    status: jobStatus,
    attempts: ingestionAttempts,
    availableAt: isoTimestamp(row.ingestion_available_at),
    failure: nullableFailure(row.ingestion_failure),
  };
  if (jobStatus === 'pending' && ingestionAttempts !== 0) invalid();
  const aiPresent = row.ai_job_id !== null;
  if (jobStatus === 'completed' !== aiPresent) invalid();
  let ai: LocalPreviewJob | null = null;
  if (aiPresent) {
    if (!row.ai_job_id || row.ai_snapshot_id !== row.snapshot_id) invalid();
    const aiStatus = status(row.ai_status);
    const attempts = integer(row.ai_attempt_count, 0, 5);
    if (aiStatus === 'pending' && attempts !== 0) invalid();
    ai = {
      status: aiStatus,
      attempts,
      availableAt: isoTimestamp(row.ai_available_at),
      failure: nullableFailure(row.ai_failure),
    };
  } else if (row.ai_snapshot_id !== null || row.ai_status !== null || row.ai_attempt_count !== null
    || row.ai_available_at !== null || row.ai_failure !== null) invalid();

  let permittedText: string | null = null;
  let permittedTextHash: string | null = null;
  if (row.revision_id === null) {
    if (jobStatus === 'completed' || hasRevisionColumns(row)) invalid();
  } else {
    if (jobStatus !== 'completed' || row.revision_dataset_kind !== 'synthetic'
      || row.revision_id !== reportRevisionId || row.revision_trace_id !== traceId
      || row.revision_source_id !== LOCAL_SOURCE_ID || row.revision_content_hash !== contentHash
      || row.revision_source_key !== sourceRevisionKey || row.revision_supersedes_id !== supersedesId
      || row.revision_status !== 'unreviewed' || row.revision_normalization_version === null
      || typeof row.revision_text !== 'string') invalid();
    permittedText = boundedCanonicalText(row.revision_text, 4096);
    permittedTextHash = hash(row.revision_text_hash);
    if (permittedTextHash !== sha256(permittedText)
      || row.revision_normalization_version !== NORMALIZATION_VERSION) invalid();
  }
  const extractionPresent = row.extraction_candidate_id !== null;
  if (extractionPresent) {
    if (row.extraction_dataset_kind !== 'synthetic' || row.extraction_candidate_id !== candidateId
      || row.extraction_trace_id !== traceId || row.extraction_revision_id !== reportRevisionId
      || aiPresent === false) invalid();
  } else if (row.extraction_dataset_kind !== null || row.extraction_trace_id !== null
    || row.extraction_revision_id !== null) invalid();
  return {
    reportId, version, title, publishedAt, observedAt, capturedAt, reportRevisionId, supersedesId,
    contentHash, permittedText, permittedTextHash, candidateId, traceId, ingestion, ai,
    aiJobId: row.ai_job_id, extractionPresent,
  };
}

function hasRevisionColumns(row: SnapshotRow): boolean {
  return row.revision_dataset_kind !== null || row.revision_trace_id !== null || row.revision_source_id !== null
    || row.revision_content_hash !== null || row.revision_text_hash !== null || row.revision_text !== null
    || row.revision_status !== null || row.revision_source_key !== null || row.revision_supersedes_id !== null
    || row.revision_normalization_version !== null;
}

function groupStages(rows: readonly { job_id: string; stage: string }[], jobIds: readonly string[]): Map<string, readonly (typeof STAGES)[number][]> {
  const byJob = new Map<string, string[]>();
  const allowed = new Set(jobIds);
  for (const row of rows) {
    if (!allowed.has(row.job_id) || !STAGES.includes(row.stage as (typeof STAGES)[number])) invalid();
    const values = byJob.get(row.job_id) ?? [];
    if (values.includes(row.stage)) invalid();
    values.push(row.stage);
    byJob.set(row.job_id, values);
  }
  return new Map([...byJob].map(([jobId, values]) => [
    jobId,
    STAGES.filter((stage) => values.includes(stage)),
  ]));
}

function groupClaims(rows: readonly ClaimRow[], proposals: readonly ProposalRow[]): Map<string, readonly ClaimRow[]> {
  const known = new Set(proposals.map((proposal) => proposal.proposal_id));
  const byProposal = new Map<string, ClaimRow[]>();
  for (const row of rows) {
    if (row.dataset_kind !== 'synthetic' || !known.has(row.proposal_id)
      || !ID.test(boundedText(row.claim_id, 128, false))) invalid();
    const claims = byProposal.get(row.proposal_id) ?? [];
    if (claims.length >= 20 || claims.some((claim) => claim.claim_id === row.claim_id)) invalid();
    row.claim_text = boundedClaimText(row.claim_text, 4000);
    if (!['supported', 'uncertain', 'disputed'].includes(row.support_assessment)) invalid();
    claims.push(row);
    byProposal.set(row.proposal_id, claims);
  }
  return byProposal;
}

function groupOrigins(
  rows: readonly ClaimOriginRow[],
  proposals: readonly ProposalRow[],
  claimsByProposal: Map<string, readonly ClaimRow[]>,
): Map<string, Set<string>> {
  const proposalIds = new Set(proposals.map((proposal) => proposal.proposal_id));
  const claimKeys = new Set([...claimsByProposal].flatMap(([proposalId, claims]) =>
    claims.map((claim) => compositeKey(proposalId, claim.claim_id))));
  const byClaim = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.dataset_kind !== 'synthetic' || !proposalIds.has(row.proposal_id)
      || row.origin_dataset_kind !== 'synthetic' || row.origin_source_id !== LOCAL_SOURCE_ID
      || !row.origin_trace_id || !UUID.test(row.origin_trace_id)
      || row.independence_status !== 'unknown' || row.lineage_relation !== 'unknown'
      || row.origin_source_lineage !== true || !ID.test(boundedText(row.origin_id, 128, false))) invalid();
    const key = compositeKey(row.proposal_id, row.claim_id);
    if (!claimKeys.has(key)) invalid();
    const originIds = byClaim.get(key) ?? new Set<string>();
    if (originIds.has(row.origin_id) || originIds.size >= 8) invalid();
    originIds.add(row.origin_id);
    byClaim.set(key, originIds);
  }
  return byClaim;
}

function groupClaimEvidence(
  rows: readonly ClaimEvidenceRow[],
  claimsByProposal: Map<string, readonly ClaimRow[]>,
): Map<string, LocalPreviewEvidence[]> {
  const claimIds = new Set([...claimsByProposal].flatMap(([proposalId, claims]) =>
    claims.map((claim) => compositeKey(proposalId, claim.claim_id))));
  const byClaim = new Map<string, LocalPreviewEvidence[]>();
  const seen = new Set<string>();
  let perProposal = new Map<string, number>();
  for (const row of rows) {
    const key = compositeKey(row.proposal_id, row.claim_id);
    if (row.dataset_kind !== 'synthetic' || !claimIds.has(key)
      || row.reference_dataset_kind !== 'synthetic' || row.revision_dataset_kind !== 'synthetic'
      || row.revision_source_id !== LOCAL_SOURCE_ID || row.snapshot_dataset_kind !== 'synthetic'
      || row.snapshot_source_id !== LOCAL_SOURCE_ID) invalid();
    const referenceId = boundedText(row.evidence_ref_id, 32, false);
    if (!/^\d{1,19}$/.test(referenceId)) invalid();
    const revisionId = boundedText(row.report_revision_id, 128, false);
    const textHash = hash(row.permitted_text_hash);
    const spanStart = integer(row.span_start, 0, 10_000_000);
    const spanEnd = integer(row.span_end, 1, 10_000_000);
    const relation = row.relation;
    if (spanEnd <= spanStart || row.offset_unit !== 'unicode_code_points'
      || row.revision_trace_id !== row.snapshot_trace_id
      || row.revision_content_hash !== row.snapshot_content_hash
      || row.revision_text_hash !== textHash || row.revision_source_key !== row.snapshot_source_key
      || row.revision_supersedes_id !== row.snapshot_supersedes_id
      || row.snapshot_revision_id !== revisionId || row.revision_status !== 'unreviewed'
      || !row.revision_text || spanEnd > Array.from(boundedCanonicalText(row.revision_text, 4096)).length
      || sha256(boundedCanonicalText(row.revision_text, 4096)) !== textHash
      || hash(row.revision_content_hash) !== row.snapshot_content_hash
      || !['supports', 'contradicts', 'context', 'updates'].includes(relation ?? '')) invalid();
    const snapshotIdentity = expectedSnapshotIdentity(
      row.snapshot_stable_report_id, row.snapshot_version, row.snapshot_content_hash,
    );
    if (row.snapshot_source_key !== `local-v1:${sha256(JSON.stringify([row.snapshot_stable_report_id, integer(row.snapshot_version, 1, 2_147_483_647)]))}`
      || row.snapshot_revision_id !== `local-revision:${snapshotIdentity}`) invalid();
    const expectedRelation = row.evidence_kind === 'support' ? 'supports'
      : row.evidence_kind === 'contradiction' ? 'contradicts'
        : row.evidence_kind === 'context' ? relation : null;
    if (expectedRelation === null || (row.evidence_kind !== 'context' && relation !== expectedRelation)
      || (row.evidence_kind === 'context' && relation !== 'context' && relation !== 'updates')) invalid();
    const evidence: LocalPreviewEvidence = {
      reportRevisionId: revisionId,
      permittedTextHash: textHash,
      spanStart,
      spanEnd,
      relation: relation as LocalPreviewEvidence['relation'],
    };
    const evidenceKey = JSON.stringify([revisionId, textHash, spanStart, spanEnd, relation]);
    const scopedKey = `${key}\u0000${evidenceKey}`;
    if (seen.has(scopedKey)) invalid();
    seen.add(scopedKey);
    const value = byClaim.get(key) ?? [];
    if (value.length >= 24) invalid();
    if (value.filter((entry) => entry.relation === relation).length >= 8) invalid();
    value.push(evidence);
    byClaim.set(key, value);
    const proposalCount = (perProposal.get(row.proposal_id) ?? 0) + 1;
    if (proposalCount > 200) invalid();
    perProposal.set(row.proposal_id, proposalCount);
  }
  return byClaim;
}

function validateOriginEvidence(
  rows: readonly OriginEvidenceRow[],
  originsByClaim: Map<string, Set<string>>,
  supportReferenceIds: Map<string, Set<string>>,
): void {
  const coverage = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.dataset_kind !== 'synthetic' || row.evidence_kind !== 'support') invalid();
    const key = compositeKey(row.proposal_id, row.claim_id);
    const allowedOrigins = originsByClaim.get(key);
    const supportRefs = supportReferenceIds.get(key);
    if (!allowedOrigins?.has(row.origin_id) || !supportRefs?.has(row.evidence_ref_id)
      || !/^\d{1,19}$/.test(row.evidence_ref_id)) invalid();
    if (row.linked_evidence_ref_id === null) continue;
    if (row.linked_evidence_ref_id !== row.evidence_ref_id) invalid();
    const joinedKey = `${key}\u0000${row.origin_id}`;
    const refs = coverage.get(joinedKey) ?? new Set<string>();
    refs.add(row.evidence_ref_id);
    coverage.set(joinedKey, refs);
  }
  for (const [key, originIds] of originsByClaim) {
    const supportRefs = supportReferenceIds.get(key);
    if (!supportRefs?.size) invalid();
    const covered = new Set<string>();
    for (const originId of originIds) {
      const refs = coverage.get(`${key}\u0000${originId}`);
      if (!refs?.size) invalid();
      for (const ref of refs) covered.add(ref);
    }
    if ([...supportRefs].some((ref) => !covered.has(ref))) invalid();
  }
}

function collectSupportReferenceIds(rows: readonly ClaimEvidenceRow[]): Map<string, Set<string>> {
  const byClaim = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.dataset_kind !== 'synthetic' || row.evidence_kind !== 'support'
      || !/^\d{1,19}$/.test(row.evidence_ref_id)) continue;
    const key = compositeKey(row.proposal_id, row.claim_id);
    const referenceIds = byClaim.get(key) ?? new Set<string>();
    referenceIds.add(row.evidence_ref_id);
    byClaim.set(key, referenceIds);
  }
  return byClaim;
}

function projectProposal(
  row: ProposalRow,
  report: ReportBase,
  claimsByProposal: Map<string, readonly ClaimRow[]>,
  evidenceByClaim: Map<string, LocalPreviewEvidence[]>,
  originsByClaim: Map<string, Set<string>>,
): NonNullable<LocalPreviewReport['proposal']> {
  if (row.dataset_kind !== 'synthetic' || !ID.test(boundedText(row.proposal_id, 128, false))
    || row.candidate_id !== report.candidateId || row.trace_id !== report.traceId
    || !ID.test(boundedText(row.context_id, 128, false)) || row.event_id !== null
    || row.base_event_version !== null || row.investigation_id !== null
    || row.context_dataset_kind !== 'synthetic' || row.context_trace_id !== report.traceId
    || row.context_candidate_id !== report.candidateId || row.context_sufficient !== true
    || row.extraction_dataset_kind !== 'synthetic' || row.extraction_trace_id !== report.traceId
    || row.extraction_revision_id !== report.reportRevisionId || !report.aiJobId) invalid();
  const proposedAt = isoTimestamp(row.proposed_at);
  if (Date.parse(proposedAt) !== Date.parse(report.capturedAt)) invalid();
  const unresolved = boundedStringList(row.unresolved_fields, 100, 500);
  const claims = (claimsByProposal.get(row.proposal_id) ?? []).map((claim): LocalPreviewClaim => {
    const key = compositeKey(row.proposal_id, claim.claim_id);
    const evidence = evidenceByClaim.get(key) ?? [];
    const claimEvidence = evidence.filter((entry) => entry.relation === 'supports'
      || entry.relation === 'contradicts' || entry.relation === 'context' || entry.relation === 'updates');
    const supportCount = claimEvidence.filter((entry) => entry.relation === 'supports').length;
    const contradictionCount = claimEvidence.filter((entry) => entry.relation === 'contradicts').length;
    const contextCount = claimEvidence.filter((entry) => entry.relation === 'context' || entry.relation === 'updates').length;
    if (claimEvidence.length > 24 || supportCount > 8 || contradictionCount > 8 || contextCount > 8
      || !claimEvidence.some((entry) => entry.relation === 'supports')
      || !originsByClaim.get(key)?.size
      || (claim.support_assessment === 'supported' && claimEvidence.some((entry) => entry.relation === 'contradicts'))) invalid();
    return {
      claimId: claim.claim_id,
      text: claim.claim_text,
      assessment: claim.support_assessment as LocalPreviewClaim['assessment'],
      evidence: claimEvidence,
    };
  });
  if (claims.length > 20) invalid();
  return { proposalId: row.proposal_id, proposedAt, claims, unresolvedCount: unresolved.length };
}

function compositeKey(proposalId: string, claimId: string): string {
  return `${proposalId}\u0000${claimId}`;
}

function status(value: unknown): LocalPreviewJobStatus {
  if (typeof value !== 'string' || !JOB_STATUSES.includes(value as LocalPreviewJobStatus)) invalid();
  return value as LocalPreviewJobStatus;
}

function statusCounts(rows: readonly StatusCountRow[]): Record<LocalPreviewJobStatus, number> {
  const result: Record<LocalPreviewJobStatus, number> = {
    pending: 0, leased: 0, retry: 0, completed: 0, terminal: 0,
  };
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.status)) invalid();
    seen.add(row.status);
    result[status(row.status)] = count(row.count);
  }
  return result;
}

function totalOf(counts: Readonly<Record<LocalPreviewJobStatus, number>>): number {
  return JOB_STATUSES.reduce((sum, value) => sum + counts[value], 0);
}

function validateScheduler(value: LocalPreviewSchedulerState): LocalPreviewSchedulerState {
  if (!value || typeof value !== 'object'
    || !['idle', 'running', 'completed', 'failed'].includes(value.status)
    || !Number.isSafeInteger(value.polls) || value.polls < 0 || value.polls > 10_000
    || !Number.isSafeInteger(value.collectionFailures) || value.collectionFailures < 0
    || value.collectionFailures > value.polls) invalid();
  return { status: value.status, polls: value.polls, collectionFailures: value.collectionFailures };
}

function count(value: unknown): number {
  const parsed = typeof value === 'number' ? value
    : typeof value === 'string' && /^\d{1,10}$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 1_000_000) invalid();
  return parsed;
}

function integer(value: unknown, minimum: number, maximum: number): number {
  const parsed = typeof value === 'number' ? value
    : typeof value === 'string' && /^\d{1,10}$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) invalid();
  return parsed;
}

function boundedText(value: unknown, maxCodePoints: number, allowEmpty: boolean): string {
  if (typeof value !== 'string' || value.includes('\0') || value.trim() !== value) invalid();
  const length = Array.from(value).length;
  if ((!allowEmpty && length === 0) || length > maxCodePoints) invalid();
  return value;
}

function boundedCanonicalText(value: unknown, maxCodePoints: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')
    || Array.from(value).length > maxCodePoints
    || !hasWellFormedUnicode(value)
    || /[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/.test(value)) invalid();
  return value;
}

function boundedSingleLineText(value: unknown, maxCodePoints: number): string {
  const text = boundedText(value, maxCodePoints, false);
  if (!hasWellFormedUnicode(text) || /[\u0000-\u001F\u007F-\u009F]/.test(text)) invalid();
  return text;
}

function boundedClaimText(value: unknown, maxCodePoints: number): string {
  const text = boundedText(value, maxCodePoints, false);
  if (!hasWellFormedUnicode(text) || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/.test(text)) invalid();
  return text;
}

function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function boundedStringList(value: unknown, maxItems: number, maxLength: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maxItems) invalid();
  return value.map((entry) => boundedText(entry, maxLength, false));
}

function nullableId(value: unknown, maxLength: number): string | null {
  if (value === null) return null;
  const parsed = boundedText(value, maxLength, false);
  if (!ID.test(parsed)) invalid();
  return parsed;
}

function hash(value: unknown): string {
  if (typeof value !== 'string' || !HASH.test(value)) invalid();
  return value;
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) invalid();
  return value;
}

function nullableFailure(value: unknown): LocalPreviewFailure | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !FAILURES.includes(value as LocalPreviewFailure)) invalid();
  return value as LocalPreviewFailure;
}

function nullableTimestamp(value: unknown): string | null {
  if (value === null) return null;
  return isoTimestamp(value);
}

function isoTimestamp(value: unknown): string {
  if (typeof value !== 'string' || value.length > 100 || !Number.isFinite(Date.parse(value))) invalid();
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) invalid();
  return date.toISOString();
}

function expectedSnapshotIdentity(reportId: unknown, versionValue: unknown, contentHashValue: unknown): string {
  const report = boundedText(reportId, 200, false);
  const version = integer(versionValue, 1, 2_147_483_647);
  const contentHash = hash(contentHashValue);
  return sha256(JSON.stringify([LOCAL_SOURCE_ID, report, version, contentHash]));
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function invalid(): never {
  throw new Error('invalid_local_preview_state');
}
