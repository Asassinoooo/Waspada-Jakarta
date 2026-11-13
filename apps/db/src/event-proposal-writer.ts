import { createHash } from 'node:crypto';
import type { SqlExecutor, SqlTransactionRunner } from './sql.js';

import type { OfficialIncidentCategory } from './incident-categories.js';
import { assertOfficialIncidentCategory } from './incident-categories.js';

export interface EventProposalDto {
  readonly schema_version: '2.0';
  readonly proposal_id: string;
  readonly title: string;
  readonly incident_type: string;
  /** Canonical WJ-INT-02 primary category; exactly one of the ten official slugs. */
  readonly primary_category: OfficialIncidentCategory;
  readonly compatibility_category?: 'flood' | 'fire' | 'accident' | 'tree_fall' | 'crime' | 'weather' | 'other' | 'unclassified' | (string & {});
  readonly severity: 'low' | 'medium' | 'high' | 'critical' | 'unknown';
  readonly event_time: { readonly precision: 'exact' | 'date' | 'range' | 'unknown'; readonly value: string | null };
  readonly location_label: string | null;
  readonly coordinates: readonly [longitude: number, latitude: number] | null;
  readonly claims: readonly {
    readonly claim_id: string;
    readonly claim_text: string;
    /**
     * `under_review` is the model's pre-persist value. The writer maps it to the stored label.
     * MERGE-REVIEW-01: AI claims are never independent_corroboration.
     */
    readonly evidence_label: 'under_review' | 'attributed_report' | 'issuer_notice' | 'crowdsourced_observation' | 'independent_corroboration';
    readonly support_assessment: 'supported' | 'uncertain' | 'disputed';
    readonly quote_text: string;
    readonly evidence_ref_id: string;
    /** MERGE-REVIEW-01: the publisher of this claim. Null when the report has no registry source. */
    readonly source_id?: string | null;
    /** Publisher display name (the outlet). */
    readonly outlet?: string | null;
    /** Canonical article URL, the claim's source link. Null when unknown. */
    readonly source_url?: string | null;
    /** Legacy field from before MERGE-REVIEW-01. Never written by new code. */
    readonly is_corroborated?: boolean;
  }[];
  readonly impacts?: readonly string[];
  readonly proposed_at: string;
  readonly is_multi_source?: boolean;
  readonly source_count?: number;
  readonly has_discrepancy?: boolean;
  /** MERGE-REVIEW-01: AI-written Bahasa Indonesia summary naming the conflicting reports. */
  readonly discrepancy_summary?: string | null;
  readonly discrepancies?: readonly unknown[];
  /** How the correlator related this report to the incident. Unresolved proposals are not chained. */
  readonly correlation_relationship?: 'primary_initial' | 'corroborating' | 'unresolved';
  readonly caveats?: readonly string[];
  /** WJ-INT-02B: interpreter's independent category for moderator resolution. */
  readonly interpretation_category?: string | null;
  /** WJ-INT-02B: registry source id for the public-display rights gate. */
  readonly source_id?: string | null;
  readonly incident_id?: string | null;
  /**
   * FR-14 lineage: the job trace the report was processed under, the report's candidate
   * (extraction_results) and its grounding context. The writer refuses a proposal whose lineage rows
   * do not exist; it never invents them (F-TRACE-02).
   */
  readonly trace_id?: string;
  readonly candidate_id?: string;
  readonly context_id?: string;
  /** The report revision(s) whose claims this proposal carries; a merged chain lists every revision. */
  readonly report_revision_ids?: readonly string[];
}
export interface ProposalWriteOptions {
  readonly upsert?: boolean;
  /**
   * Synthetic fixtures only. With dataset_kind 'synthetic' this lets a proposal without real lineage
   * get placeholder trace, candidate and context rows. It is ignored for every other dataset_kind.
   */
  readonly syntheticFixtureLineage?: boolean;
}
/** REVIEW-EXPIRY-01: metadata only. The sweep never reads proposal text. */
export interface ExpirableProposalRow {
  readonly proposal_id: string;
  readonly proposed_at: string;
  readonly incident_id: string | null;
}

export interface EventProposalWriter {
  persistProposal(
    proposal: EventProposalDto,
    datasetKind?: string,
    options?: ProposalWriteOptions,
  ): Promise<{ proposalId: string; outcome: 'created' | 'updated' | 'already_exists' }>;
  readPendingProposals(datasetKind?: string): Promise<readonly EventProposalDto[]>;
  readProposalById(proposalId: string, datasetKind?: string): Promise<EventProposalDto | null>;
  /**
   * Undecided proposals proposed before `cutoff`, oldest first. No per-incident dedupe: every stale
   * proposal is a candidate. `limit` is clamped to 1..50.
   */
  readExpirableProposals(input: {
    readonly datasetKind: string;
    readonly cutoff: string;
    readonly limit: number;
  }): Promise<readonly ExpirableProposalRow[]>;
}

/** Hard cap on one sweep, so one cycle never writes more than this many decision rows. */
export const EXPIRABLE_PROPOSAL_BATCH_CAP = 50;

/**
 * A proposal is refused, with nothing written, when the real rows it must reference are missing or
 * do not agree. The code is stable and redacted; it carries no proposal text.
 */
export type ProposalLineageCode =
  | 'proposal_lineage_missing'
  | 'proposal_revision_missing'
  | 'proposal_trace_missing'
  | 'proposal_trace_mismatch'
  | 'proposal_candidate_missing'
  | 'proposal_candidate_conflict'
  | 'proposal_context_missing'
  | 'proposal_evidence_missing';

export class ProposalLineageError extends Error {
  readonly code: ProposalLineageCode;

  constructor(code: ProposalLineageCode) {
    super(code);
    this.name = 'ProposalLineageError';
    this.code = code;
  }
}

const VALID_DATASETS: Record<string, true> = {
  live: true,
  historical: true,
  synthetic: true,
};

const DUMMY_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

async function runInTransaction<Result>(
  executor: SqlExecutor,
  work: (tx: SqlExecutor) => Promise<Result>,
): Promise<Result> {
  const runner = executor as SqlExecutor & Partial<SqlTransactionRunner>;
  if (typeof runner.transaction === 'function') {
    return runner.transaction(work);
  }
  await executor.execute('BEGIN');
  try {
    const result = await work(executor);
    await executor.execute('COMMIT');
    return result;
  } catch (err) {
    try {
      await executor.execute('ROLLBACK');
    } catch {
      // Ignore rollback failure
    }
    throw err;
  }
}

/**
 * SYNTHETIC FIXTURES ONLY (dataset_kind 'synthetic', explicit syntheticFixtureLineage). It writes
 * placeholder trace, source, report revision, candidate and grounding context rows so that authored
 * fixtures without a real report can persist. It is never reached for live or historical data.
 * Callers: the intelligence workflow's synthetic fixture tests, and the synthetic-only tests in apps/db.
 */
async function ensureSyntheticFixturePrerequisites(
  tx: SqlExecutor,
  datasetKind: string,
  traceId: string,
  candidateId: string,
  contextId: string,
): Promise<void> {
  // 1. Ensure trace exists
  await tx.query(
    `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
     VALUES ($1, $2, now(), 'succeeded', '{"component":"event-proposal-writer"}'::jsonb)
     ON CONFLICT (trace_id) DO NOTHING`,
    [traceId, datasetKind],
  );

  // 2. Check if grounding context already exists
  const contextCheck = await tx.query<{ context_id: string }>(
    `SELECT context_id FROM waspada.grounding_contexts
     WHERE dataset_kind = $1 AND context_id = $2 AND candidate_id = $3`,
    [datasetKind, contextId, candidateId],
  );
  if (contextCheck.rows.length > 0) return;

  // 3. Ensure source registry exists
  const sourceId = `source-${candidateId}`;
  await tx.query(
    `INSERT INTO waspada.source_registry
       (source_id, trace_id, registry_version, display_name, source_kind, remit,
        access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
        approval_status, health_status, auto_acquisition_enabled, auto_publication_policy)
     VALUES ($1, $2, 1, 'System Ingestion', 'other', ARRAY['system'], 'manual_fixture',
             ARRAY[]::text[], ARRAY[]::text[], ARRAY['public'], 'active', 'approved', 'healthy', false, 'never')
     ON CONFLICT (source_id) DO NOTHING`,
    [sourceId, traceId],
  );

  // 4. Ensure report revision exists
  const revisionId = `rev-${candidateId}`;
  await tx.query(
    `INSERT INTO waspada.report_revisions
     (dataset_kind, report_revision_id, trace_id, source_id, canonical_url, content_hash, permitted_text, permitted_text_hash, normalization_version, retrieved_at, revision_status, record_json, triage_required)
     VALUES ($1, $2, $3, $4, 'https://waspada.jakarta.go.id/source', $5, 'placeholder', $5, 'v1', now(), 'unreviewed', '{}'::jsonb, false)
     ON CONFLICT (dataset_kind, report_revision_id) DO NOTHING`,
    [datasetKind, revisionId, traceId, sourceId, DUMMY_HASH],
  );

  // 5. Ensure extraction result exists
  await tx.query(
    `INSERT INTO waspada.extraction_results
     (dataset_kind, candidate_id, trace_id, report_revision_id, category, record_json)
     VALUES ($1, $2, $3, $4, NULL, '{}'::jsonb)
     ON CONFLICT (dataset_kind, candidate_id) DO NOTHING`,
    [datasetKind, candidateId, traceId, revisionId],
  );

  // 6. Ensure grounding context exists
  await tx.query(
    `INSERT INTO waspada.grounding_contexts
     (dataset_kind, context_id, trace_id, candidate_id, retrieval_version, index_version, sufficient, record_json)
     VALUES ($1, $2, $3, $4, 'v1', 'v1', true, '{}'::jsonb)
     ON CONFLICT (dataset_kind, context_id) DO NOTHING`,
    [datasetKind, contextId, traceId, candidateId],
  );
}

/**
 * FR-14 / F-TRACE-02: a live or historical proposal references rows that were written from the
 * report. The trace, the candidate (extraction result) and the grounding context must already exist
 * and agree with each other. Nothing is created here.
 */
async function requireRealLineage(
  tx: SqlExecutor,
  datasetKind: string,
  traceId: string,
  candidateId: string,
  contextId: string,
): Promise<void> {
  const trace = await tx.query<{ trace_id: string }>(
    `SELECT trace_id FROM waspada.traces WHERE trace_id = $1 AND dataset_kind = $2`,
    [traceId, datasetKind],
  );
  if (trace.rows.length === 0) throw new ProposalLineageError('proposal_trace_missing');

  const candidate = await tx.query<{ trace_id: string }>(
    `SELECT trace_id FROM waspada.extraction_results WHERE dataset_kind = $1 AND candidate_id = $2`,
    [datasetKind, candidateId],
  );
  if (candidate.rows.length === 0) throw new ProposalLineageError('proposal_candidate_missing');
  if (candidate.rows[0]!.trace_id !== traceId) throw new ProposalLineageError('proposal_trace_mismatch');

  const context = await tx.query<{ context_id: string }>(
    `SELECT context_id FROM waspada.grounding_contexts
     WHERE dataset_kind = $1 AND context_id = $2 AND candidate_id = $3 AND trace_id = $4`,
    [datasetKind, contextId, candidateId, traceId],
  );
  if (context.rows.length === 0) throw new ProposalLineageError('proposal_context_missing');
}

function nonEmptyId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * INTEL-02: thrown by incident persistence when a proposal ID already exists, because the new
 * claims would not be written. Callers must fail the run, not commit without them.
 */
export class ProposalIdConflictError extends Error {
  readonly proposalId: string;
  readonly datasetKind: string;

  constructor(proposalId: string, datasetKind: string) {
    super(`Proposal ${proposalId} already exists in ${datasetKind}; refusing to drop its claims`);
    this.name = 'ProposalIdConflictError';
    this.proposalId = proposalId;
    this.datasetKind = datasetKind;
  }
}

/**
 * INTEL-02: a proposal ID that already exists means its claims were not written. The writer
 * returns `already_exists` and logs it. Incident persistence turns it into ProposalIdConflictError.
 */
function conflictOutcome(
  proposal: EventProposalDto,
  datasetKind: string,
): { proposalId: string; outcome: 'already_exists' } {
  console.warn(
    `[event-proposal-writer] proposal ${proposal.proposal_id} already exists in ${datasetKind}; its claims were not written`,
  );
  return { proposalId: proposal.proposal_id, outcome: 'already_exists' };
}

export async function persistProposalWithTx(
  tx: SqlExecutor,
  proposal: EventProposalDto,
  datasetKind: string = 'live',
  options?: ProposalWriteOptions,
): Promise<{ proposalId: string; outcome: 'created' | 'updated' | 'already_exists' }> {
  if (!proposal || typeof proposal !== 'object') {
    throw new TypeError('Proposal must be an object');
  }
  if (!proposal.proposal_id || typeof proposal.proposal_id !== 'string') {
    throw new TypeError('Proposal must have a valid proposal_id');
  }
  if (!VALID_DATASETS[datasetKind]) {
    throw new TypeError(`Invalid dataset_kind: ${datasetKind}`);
  }
  if (!Array.isArray(proposal.claims)) {
    throw new TypeError('Proposal claims must be an array');
  }
  if (Array.isArray((proposal as unknown as Record<string, unknown>).primary_category)) {
    throw new TypeError('Proposal primary_category must be exactly one category, not an array');
  }
  assertOfficialIncidentCategory(
    (proposal as unknown as Record<string, unknown>).primary_category,
  );

  // Advisory transaction lock on (dataset_kind, proposal_id)
  const hash = createHash('sha256')
    .update(datasetKind)
    .update(':')
    .update(proposal.proposal_id)
    .digest();
  await tx.query('SELECT pg_advisory_xact_lock($1::integer, $2::integer)', [
    hash.readInt32BE(0),
    hash.readInt32BE(4),
  ]);

  // Idempotency check: does the proposal already exist?
  const existing = await tx.query<{ proposal_id: string }>(
    `SELECT proposal_id FROM waspada.event_proposals
     WHERE dataset_kind = $1 AND proposal_id = $2`,
    [datasetKind, proposal.proposal_id],
  );
  if (existing.rows.length > 0) {
    return conflictOutcome(proposal, datasetKind);
  }
  // Lineage IDs. The proposal's trace, candidate and context must be the rows its report was written
  // under. Only a synthetic fixture that opts in gets placeholder rows; anything else is refused.
  const extra = proposal as unknown as Record<string, unknown>;
  const declaredTrace = nonEmptyId(extra.trace_id);
  const declaredCandidate = nonEmptyId(extra.candidate_id);
  const declaredContext = nonEmptyId(extra.context_id);
  let traceId: string;
  let candidateId: string;
  let contextId: string;
  if (datasetKind === 'synthetic' && options?.syntheticFixtureLineage === true) {
    traceId = declaredTrace ?? `trace-${proposal.proposal_id}`;
    candidateId = declaredCandidate ?? `candidate-${proposal.proposal_id}`;
    contextId = declaredContext ?? `context-${proposal.proposal_id}`;
    await ensureSyntheticFixturePrerequisites(tx, datasetKind, traceId, candidateId, contextId);
  } else {
    if (!declaredTrace || !declaredCandidate || !declaredContext) {
      throw new ProposalLineageError('proposal_lineage_missing');
    }
    traceId = declaredTrace;
    candidateId = declaredCandidate;
    contextId = declaredContext;
    await requireRealLineage(tx, datasetKind, traceId, candidateId, contextId);
  }

  // Insert proposal into waspada.event_proposals
  const inserted = await tx.query<{ proposal_id: string }>(
    `INSERT INTO waspada.event_proposals
     (dataset_kind, proposal_id, trace_id, candidate_id, context_id, event_id, base_event_version, investigation_id, proposed_at, record_json)
     VALUES ($1, $2, $3, $4, $5, NULL, NULL, NULL, $6::timestamptz, $7::jsonb)
     ON CONFLICT (dataset_kind, proposal_id) DO NOTHING
     RETURNING proposal_id`,
    [
      datasetKind,
      proposal.proposal_id,
      traceId,
      candidateId,
      contextId,
      proposal.proposed_at || new Date().toISOString(),
      JSON.stringify(proposal),
    ],
  );

  if (inserted.rows.length === 0) {
    return conflictOutcome(proposal, datasetKind);
  }
  // Insert claims into waspada.proposal_claims.
  // Owner decision: AI claims are never auto-labelled independent_corroboration
  // (not even for multi-source proposals). Issuer notices (BMKG) and crowdsourced
  // observations (PetaBencana) keep their source-type label; everything else is an
  // attributed report. Only a moderator may choose independent_corroboration.
  function mapEvidenceLabel(clm: EventProposalDto["claims"][number]): string {
    const raw = clm.evidence_label as string;
    return raw === 'issuer_notice' || raw === 'crowdsourced_observation' ? raw : 'attributed_report';
  }
  for (const claim of proposal.claims) {
    await tx.query(
      `INSERT INTO waspada.proposal_claims
       (dataset_kind, proposal_id, claim_id, support_assessment, evidence_label, claim_text, record_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (dataset_kind, proposal_id, claim_id) DO NOTHING`,
      [
        datasetKind,
        proposal.proposal_id,
        claim.claim_id,
        claim.support_assessment,
        mapEvidenceLabel(claim),
        claim.claim_text,
        JSON.stringify(claim),
      ],
    );

    // If evidence_ref_id is numeric and exists in evidence_references, link in proposal_claim_evidence
    if (claim.evidence_ref_id && /^\d+$/.test(claim.evidence_ref_id)) {
      const refCheck = await tx.query<{ evidence_ref_id: string }>(
        `SELECT evidence_ref_id::text FROM waspada.evidence_references
         WHERE dataset_kind = $1 AND evidence_ref_id = $2::bigint`,
        [datasetKind, claim.evidence_ref_id],
      );
      if (refCheck.rows.length > 0) {
        await tx.query(
          `INSERT INTO waspada.proposal_claim_evidence
           (dataset_kind, proposal_id, claim_id, evidence_kind, evidence_ref_id)
           VALUES ($1, $2, $3, 'support', $4::bigint)
           ON CONFLICT DO NOTHING`,
          [datasetKind, proposal.proposal_id, claim.claim_id, claim.evidence_ref_id],
        );
      }
    }
  }

  return { proposalId: proposal.proposal_id, outcome: 'created' };
}

export function createEventProposalWriter(executor: SqlExecutor): EventProposalWriter {
  if (!executor || typeof executor.query !== 'function') {
    throw new TypeError('Event proposal persistence requires a SQL executor');
  }

  return {
    async persistProposal(
      proposal: EventProposalDto,
      datasetKind: string = 'live',
      options?: ProposalWriteOptions,
    ): Promise<{ proposalId: string; outcome: 'created' | 'updated' | 'already_exists' }> {
      return runInTransaction(executor, (tx) => persistProposalWithTx(tx, proposal, datasetKind, options));
    },

    async readPendingProposals(datasetKind: string = 'live'): Promise<readonly EventProposalDto[]> {
      if (!VALID_DATASETS[datasetKind]) {
        throw new TypeError(`Invalid dataset_kind: ${datasetKind}`);
      }

      const result = await executor.query<{ record_json: unknown }>(
        `SELECT ep.record_json
         FROM waspada.event_proposals ep
         LEFT JOIN waspada.publication_decisions pd
           ON pd.dataset_kind = ep.dataset_kind AND pd.proposal_id = ep.proposal_id
         WHERE ep.dataset_kind = $1
           AND pd.proposal_id IS NULL
         ORDER BY ep.proposed_at DESC`,
        [datasetKind],
      );

      const proposals = result.rows.map((row) =>
        typeof row.record_json === 'string'
          ? (JSON.parse(row.record_json) as EventProposalDto)
          : (row.record_json as EventProposalDto),
      );

      // Deduplicate: If multiple proposals exist for the same physical incident, keep the latest one
      const seenIncidents = new Set<string>();
      const deduped: EventProposalDto[] = [];
      for (const prop of proposals) {
        const key = prop.incident_id || (prop.proposal_id.startsWith("prop-inc-") ? prop.proposal_id.replace(/-v\d+$/, "") : prop.proposal_id);
        if (!seenIncidents.has(key)) {
          seenIncidents.add(key);
          deduped.push(prop);
        }
      }
      return deduped;
    },

    async readExpirableProposals({ datasetKind, cutoff, limit }): Promise<readonly ExpirableProposalRow[]> {
      if (!VALID_DATASETS[datasetKind]) {
        throw new TypeError(`Invalid dataset_kind: ${datasetKind}`);
      }
      const cutoffMs = typeof cutoff === 'string' ? Date.parse(cutoff) : Number.NaN;
      if (Number.isNaN(cutoffMs)) {
        throw new TypeError('cutoff must be an ISO timestamp');
      }
      const cap = Math.max(1, Math.min(EXPIRABLE_PROPOSAL_BATCH_CAP, Math.trunc(limit)));

      const result = await executor.query<{ proposal_id: string; proposed_at: unknown; incident_id: string | null }>(
        `SELECT ep.proposal_id,
                ep.proposed_at,
                ep.record_json->>'incident_id' AS incident_id
         FROM waspada.event_proposals ep
         LEFT JOIN waspada.publication_decisions pd
           ON pd.dataset_kind = ep.dataset_kind AND pd.proposal_id = ep.proposal_id
         WHERE ep.dataset_kind = $1
           AND pd.proposal_id IS NULL
           AND ep.proposed_at < $2::timestamptz
         ORDER BY ep.proposed_at ASC, ep.proposal_id ASC
         LIMIT $3`,
        [datasetKind, new Date(cutoffMs).toISOString(), cap],
      );

      return result.rows.map((row) => ({
        proposal_id: row.proposal_id,
        proposed_at: row.proposed_at instanceof Date ? row.proposed_at.toISOString() : String(row.proposed_at),
        incident_id: row.incident_id ?? null,
      }));
    },

    async readProposalById(proposalId: string, datasetKind?: string): Promise<EventProposalDto | null> {
      if (!proposalId || typeof proposalId !== 'string') {
        throw new TypeError('proposalId must be a non-empty string');
      }

      const query = datasetKind
        ? `SELECT record_json FROM waspada.event_proposals
           WHERE dataset_kind = $1 AND proposal_id = $2`
        : `SELECT record_json FROM waspada.event_proposals
           WHERE proposal_id = $1
           ORDER BY (dataset_kind = 'live') DESC
           LIMIT 1`;
      const params = datasetKind ? [datasetKind, proposalId] : [proposalId];

      const result = await executor.query<{ record_json: unknown }>(query, params);
      if (result.rows.length === 0) return null;

      const row = result.rows[0]!;
      return typeof row.record_json === 'string'
        ? (JSON.parse(row.record_json) as EventProposalDto)
        : (row.record_json as EventProposalDto);
    },
  };
}
