import { createHash } from 'node:crypto';
import type { SqlExecutor, SqlTransactionRunner } from './sql.js';

export interface EventProposalDto {
  readonly schema_version: '2.0';
  readonly proposal_id: string;
  readonly title: string;
  readonly incident_type: 'flood' | 'fire' | 'accident' | 'tree_fall' | 'crime' | 'weather';
  readonly severity: 'low' | 'medium' | 'high' | 'critical';
  readonly event_time: { readonly precision: 'exact' | 'date' | 'range' | 'unknown'; readonly value: string };
  readonly location_label: string;
  readonly coordinates: readonly [longitude: number, latitude: number] | null;
  readonly claims: readonly {
    readonly claim_id: string;
    readonly claim_text: string;
    readonly evidence_label: 'under_review';
    readonly support_assessment: 'supported';
    readonly quote_text: string;
    readonly evidence_ref_id: string;
  }[];
  readonly proposed_at: string;
}

export interface EventProposalWriter {
  persistProposal(
    proposal: EventProposalDto,
    datasetKind?: string,
  ): Promise<{ proposalId: string; outcome: 'created' | 'already_exists' }>;
  readPendingProposals(datasetKind?: string): Promise<readonly EventProposalDto[]>;
  readProposalById(proposalId: string, datasetKind?: string): Promise<EventProposalDto | null>;
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

async function ensurePrerequisites(
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
     (dataset_kind, report_revision_id, trace_id, source_id, canonical_url, content_hash, permitted_text, permitted_text_hash, normalization_version, retrieved_at, revision_status, record_json)
     VALUES ($1, $2, $3, $4, 'https://waspada.jakarta.go.id/source', $5, 'placeholder', $5, 'v1', now(), 'unreviewed', '{}'::jsonb)
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

export function createEventProposalWriter(executor: SqlExecutor): EventProposalWriter {
  if (!executor || typeof executor.query !== 'function') {
    throw new TypeError('Event proposal persistence requires a SQL executor');
  }

  return {
    async persistProposal(
      proposal: EventProposalDto,
      datasetKind: string = 'live',
    ): Promise<{ proposalId: string; outcome: 'created' | 'already_exists' }> {
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

      return runInTransaction(executor, async (tx) => {
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
          return { proposalId: proposal.proposal_id, outcome: 'already_exists' };
        }

        // Lineage IDs
        const extra = proposal as unknown as Record<string, unknown>;
        const traceId = (typeof extra.trace_id === 'string' && extra.trace_id) || `trace-${proposal.proposal_id}`;
        const candidateId = (typeof extra.candidate_id === 'string' && extra.candidate_id) || `candidate-${proposal.proposal_id}`;
        const contextId = (typeof extra.context_id === 'string' && extra.context_id) || `context-${proposal.proposal_id}`;

        await ensurePrerequisites(tx, datasetKind, traceId, candidateId, contextId);

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
          return { proposalId: proposal.proposal_id, outcome: 'already_exists' };
        }

        // Insert claims into waspada.proposal_claims
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
              claim.evidence_label,
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
      });
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

      return result.rows.map((row) =>
        typeof row.record_json === 'string'
          ? (JSON.parse(row.record_json) as EventProposalDto)
          : (row.record_json as EventProposalDto),
      );
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
