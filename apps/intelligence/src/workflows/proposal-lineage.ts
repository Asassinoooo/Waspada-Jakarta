import { createHash } from "node:crypto";
import type { SqlExecutor, TransactionalSqlExecutor } from "../../../db/src/sql.js";
import type { DatasetKind } from "../../../db/src/ports.js";
import { createRepositoryPorts } from "../../../db/src/ports.js";
import { ProposalLineageError } from "../../../db/src/event-proposal-writer.js";
import { isOfficialIncidentCategory } from "../../../db/src/incident-categories.js";
import {
  createSqlGroundingContextRepository,
  type GroundingContextRecord,
  type GroundingEvidenceReference,
  type GroundingRevisionState,
} from "../../../db/src/grounding-contexts.js";
import type { NineRouterConfig } from "../providers/ninerouter-adapter.js";
import { NINEROUTER_EMBEDDING_IDENTITY } from "../services/semantic-retrieval-service.js";
import {
  GENERATION_MAX_ACTIVE_MS,
  GENERATION_MAX_OUTPUT_TOKENS,
  GENERATION_MAX_STEPS,
  GENERATION_MAX_TOKENS,
} from "../agents/generation-budget.js";

/**
 * FR-14 lineage the live intelligence workflow writes for one report revision, before its proposal.
 * Every row is derived from data the workflow actually used: the report revision, its evidence
 * chunks and the citations in the interpretation. Nothing here is a placeholder.
 */

export const WORKFLOW_RETRIEVAL_VERSION = "intelligence-workflow-retrieval-v1";
export const CHAT_MODEL_PROVIDER = "9router";
export const LINEAGE_ACTOR_ID = "agent:intelligence-workflow";
export const MODEL_CONFIGURATION_ACTION = "model_configuration_recorded";

export interface LineageChunk {
  readonly chunkId: string;
  readonly spanStart: number;
  readonly spanEnd: number;
}

export interface PersistReportLineageInput {
  readonly datasetKind: DatasetKind;
  /** The job trace. It must be the trace the report revision was ingested under. */
  readonly traceId: string;
  readonly reportRevisionId: string;
  readonly evidenceChunks: readonly LineageChunk[];
  /** Chunk ids the interpretation cites. With none, the chunk the fallback claim uses is taken. */
  readonly citedChunkIds: readonly string[];
  readonly category: string | null;
  readonly categorySource: "triage" | "interpreter";
}

export interface ReportLineage {
  readonly candidateId: string;
  readonly contextId: string;
  /** True only when every cited chunk resolved to this revision and at least one was cited. */
  readonly sufficient: boolean;
  readonly evidenceRefCount: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** One candidate and one grounding context per report revision. The hash keeps the id short and valid. */
export function candidateIdFor(reportRevisionId: string): string {
  return `cand-${sha256(reportRevisionId).slice(0, 32)}`;
}

export function contextIdFor(reportRevisionId: string): string {
  return `ctx-${sha256(reportRevisionId).slice(0, 32)}`;
}

/**
 * Writes the candidate, evidence references and grounding context for one report revision. The
 * revision must exist in the dataset and belong to the job trace; otherwise nothing is written and
 * the caller gets a ProposalLineageError.
 */
export async function persistReportLineage(
  executor: SqlExecutor,
  transactional: TransactionalSqlExecutor,
  input: PersistReportLineageInput,
): Promise<ReportLineage> {
  const revision = await executor.query<{ trace_id: string; permitted_text_hash: string; revision_status: string }>(
    `SELECT trace_id, permitted_text_hash, revision_status FROM waspada.report_revisions
     WHERE dataset_kind = $1 AND report_revision_id = $2`,
    [input.datasetKind, input.reportRevisionId],
  );
  const rev = revision.rows[0];
  if (!rev) throw new ProposalLineageError("proposal_revision_missing");
  if (rev.trace_id !== input.traceId) throw new ProposalLineageError("proposal_trace_mismatch");

  const candidateId = candidateIdFor(input.reportRevisionId);
  const contextId = contextIdFor(input.reportRevisionId);
  const category = isOfficialIncidentCategory(input.category) ? input.category : null;
  await executor.query(
    `INSERT INTO waspada.extraction_results
       (dataset_kind, candidate_id, trace_id, report_revision_id, category, record_json)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (dataset_kind, candidate_id) DO NOTHING`,
    [
      input.datasetKind,
      candidateId,
      input.traceId,
      input.reportRevisionId,
      category,
      JSON.stringify({ pipeline_version: "v1", category_source: input.categorySource }),
    ],
  );
  const candidate = await executor.query<{ trace_id: string; report_revision_id: string }>(
    `SELECT trace_id, report_revision_id FROM waspada.extraction_results
     WHERE dataset_kind = $1 AND candidate_id = $2`,
    [input.datasetKind, candidateId],
  );
  const stored = candidate.rows[0];
  if (!stored || stored.report_revision_id !== input.reportRevisionId || stored.trace_id !== input.traceId) {
    throw new ProposalLineageError("proposal_candidate_conflict");
  }

  const cited = input.citedChunkIds.length > 0
    ? input.citedChunkIds
    : input.evidenceChunks.slice(0, 1).map((chunk) => chunk.chunkId);
  const ports = createRepositoryPorts(transactional);
  const refs: GroundingEvidenceReference[] = [];
  const seenSpans = new Set<string>();
  let allResolved = true;
  for (const chunkId of cited) {
    const chunk = input.evidenceChunks.find((candidateChunk) => candidateChunk.chunkId === chunkId);
    if (!chunk) {
      allResolved = false;
      continue;
    }
    const spanKey = `${chunk.spanStart}:${chunk.spanEnd}`;
    if (seenSpans.has(spanKey)) continue;
    seenSpans.add(spanKey);
    await ports.reportRevisions.createEvidenceReference({
      datasetKind: input.datasetKind,
      traceId: input.traceId,
      reportRevisionId: input.reportRevisionId,
      permittedTextHash: rev.permitted_text_hash,
      spanStart: chunk.spanStart,
      spanEnd: chunk.spanEnd,
      relation: "supports",
    });
    refs.push({
      report_revision_id: input.reportRevisionId,
      permitted_text_hash: rev.permitted_text_hash,
      span_start: chunk.spanStart,
      span_end: chunk.spanEnd,
      offset_unit: "unicode_code_points",
      relation: "supports",
    });
  }
  if (refs.length === 0) throw new ProposalLineageError("proposal_evidence_missing");

  const sufficient = input.citedChunkIds.length > 0 && allResolved;
  const revisionState: GroundingRevisionState = {
    report_revision_id: input.reportRevisionId,
    revision_status: rev.revision_status as GroundingRevisionState["revision_status"],
  };
  const record: GroundingContextRecord = {
    schema_version: "2.0",
    trace_id: input.traceId,
    record_type: "GroundingContext",
    dataset_kind: input.datasetKind,
    context_id: contextId,
    candidate_id: candidateId,
    evidence: refs,
    revision_states: [revisionState],
    candidate_events: [],
    prior_decision_ids: [],
    missing_fields: sufficient ? [] : ["cited_evidence"],
    conflicts: [],
    retrieval_version: WORKFLOW_RETRIEVAL_VERSION,
    index_version: NINEROUTER_EMBEDDING_IDENTITY.vectorIndexVersion,
    sufficient,
  };
  await createSqlGroundingContextRepository(transactional).createOrVerify(record);
  return { candidateId, contextId, sufficient, evidenceRefCount: refs.length };
}

export interface ModelConfigurationInput {
  readonly datasetKind: DatasetKind;
  readonly traceId: string;
  readonly reportRevisionId: string;
  readonly role: "interpretation" | "correlation";
  readonly config: NineRouterConfig;
  /** "override" means a caller supplied the agent, so its model identity is not known here. */
  readonly agentSource: "factory" | "override";
  readonly occurredAt: string;
}

/**
 * FR-14: the model configuration of one model call, recorded as an audit row on the job trace.
 * Only the provider, model id, execution mode and generation caps are stored. Never prompts, keys,
 * endpoints or model output. Re-recording the same role for the same revision is a no-op.
 */
export async function recordModelConfiguration(executor: SqlExecutor, input: ModelConfigurationInput): Promise<void> {
  const override = input.agentSource === "override";
  const details = {
    role: input.role,
    provider: override ? null : CHAT_MODEL_PROVIDER,
    model_id: override ? null : input.config.chatModel,
    mode: override ? "override" : input.config.executionMode,
    source: input.agentSource,
    max_steps: GENERATION_MAX_STEPS,
    max_output_tokens: GENERATION_MAX_OUTPUT_TOKENS,
    max_active_ms: GENERATION_MAX_ACTIVE_MS,
    token_budget: GENERATION_MAX_TOKENS,
  };
  await executor.query(
    `INSERT INTO waspada.audit_records
       (dataset_kind, audit_id, trace_id, occurred_at, actor_id, action,
        entity_type, entity_id, reason, details)
     VALUES ($1, $2, $3, $4, $5, $6, 'report_revision', $7, NULL, $8::jsonb)
     ON CONFLICT (dataset_kind, audit_id) DO NOTHING`,
    [
      input.datasetKind,
      `model-config-${input.role}-${input.reportRevisionId}`,
      input.traceId,
      input.occurredAt,
      LINEAGE_ACTOR_ID,
      MODEL_CONFIGURATION_ACTION,
      input.reportRevisionId,
      JSON.stringify(details),
    ],
  );
}
