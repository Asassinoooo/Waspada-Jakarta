import { createHash } from 'node:crypto';
import type { SqlExecutor } from './sql.js';
/** WJ-INT-02 triage policy version. */
export const NEWS_TRIAGE_POLICY_VERSION = 'wj-int-02-v1' as const;

export type NewsTriageDisposition = 'ingest' | 'drop' | 'uncertain';
export type NewsTriageJakartaScope =
  | 'dki_jakarta'
  | 'direct_jakarta_impact'
  | 'outside_scope'
  | 'unknown';
export type NewsTriageActionability =
  | 'immediate'
  | 'actionable'
  | 'context_only'
  | 'none'
  | 'unknown';
export type NewsTriageConfidence = 'high' | 'medium' | 'low';
export type NewsTriageModelStatus =
  | 'ok'
  | 'provider_error'
  | 'invalid_model_output'
  | 'skipped_stage_a'
  | 'not_cleared';

export interface NewsTriageDecisionRow {
  readonly datasetKind: string;
  /** sha256(source_id + '|' + (guid || link)); never raw title/body. */
  readonly itemIdentityHash: string;
  readonly sourceId: string;
  readonly traceId: string;
  readonly disposition: NewsTriageDisposition;
  readonly jakartaScope: NewsTriageJakartaScope;
  readonly actionability: NewsTriageActionability;
  readonly primaryCategory: string | null;
  readonly incidentType: string | null;
  readonly confidence: NewsTriageConfidence;
  readonly reasonCodes: readonly string[];
  readonly policyVersion: string;
  readonly modelStatus: NewsTriageModelStatus;
  readonly evaluatedAt: string;
  readonly expiresAt: string;
}

export interface RecordNewsTriageDecisionInput extends Omit<
  NewsTriageDecisionRow,
  'evaluatedAt' | 'expiresAt' | 'policyVersion'
> {
  readonly policyVersion?: string;
}

const VALID_DATASETS: Record<string, true> = {
  live: true,
  historical: true,
  synthetic: true,
};

export function newsTriageIdentityHash(sourceId: string, stableIdentity: string): string {
  if (!sourceId || typeof sourceId !== 'string') {
    throw new TypeError('sourceId must be a non-empty string');
  }
  if (!stableIdentity || typeof stableIdentity !== 'string') {
    throw new TypeError('stableIdentity (guid || link) must be a non-empty string');
  }
  return createHash('sha256').update(`${sourceId}|${stableIdentity}`, 'utf8').digest('hex');
}

export async function recordTriageDecision(
  executor: SqlExecutor,
  input: RecordNewsTriageDecisionInput,
): Promise<NewsTriageDecisionRow> {
  if (!VALID_DATASETS[input.datasetKind]) {
    throw new TypeError(`Invalid dataset_kind: ${input.datasetKind}`);
  }
  if (!/^[0-9a-f]{64}$/.test(input.itemIdentityHash)) {
    throw new TypeError('itemIdentityHash must be a 64-char lowercase hex sha256');
  }
  const result = await executor.query<Record<string, unknown>>(
    `INSERT INTO waspada.news_triage_decisions (
       dataset_kind, item_identity_hash, source_id, trace_id, disposition,
       jakarta_scope, actionability, primary_category, incident_type,
       confidence, reason_codes, policy_version, model_status,
       evaluated_at, expires_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now(), now() + interval '7 days')
     ON CONFLICT (dataset_kind, item_identity_hash)
     DO UPDATE SET
       source_id = EXCLUDED.source_id,
       trace_id = EXCLUDED.trace_id,
       disposition = EXCLUDED.disposition,
       jakarta_scope = EXCLUDED.jakarta_scope,
       actionability = EXCLUDED.actionability,
       primary_category = EXCLUDED.primary_category,
       incident_type = EXCLUDED.incident_type,
       confidence = EXCLUDED.confidence,
       reason_codes = EXCLUDED.reason_codes,
       policy_version = EXCLUDED.policy_version,
       model_status = EXCLUDED.model_status,
       evaluated_at = EXCLUDED.evaluated_at,
       expires_at = EXCLUDED.expires_at
     RETURNING dataset_kind, item_identity_hash, source_id, trace_id, disposition,
       jakarta_scope, actionability, primary_category, incident_type,
       confidence, reason_codes, policy_version, model_status,
       evaluated_at::text AS evaluated_at, expires_at::text AS expires_at`,
    [
      input.datasetKind,
      input.itemIdentityHash,
      input.sourceId,
      input.traceId,
      input.disposition,
      input.jakartaScope,
      input.actionability,
      input.primaryCategory,
      input.incidentType,
      input.confidence,
      [...input.reasonCodes],
      input.policyVersion ?? NEWS_TRIAGE_POLICY_VERSION,
      input.modelStatus,
    ],
  );
  return mapRow(result.rows[0]!);
}

export async function readTriageDecision(
  executor: SqlExecutor,
  datasetKind: string,
  itemIdentityHash: string,
): Promise<NewsTriageDecisionRow | null> {
  if (!VALID_DATASETS[datasetKind]) {
    throw new TypeError(`Invalid dataset_kind: ${datasetKind}`);
  }
  const result = await executor.query<Record<string, unknown>>(
    `SELECT dataset_kind, item_identity_hash, source_id, trace_id, disposition,
       jakarta_scope, actionability, primary_category, incident_type,
       confidence, reason_codes, policy_version, model_status,
       evaluated_at::text AS evaluated_at, expires_at::text AS expires_at
     FROM waspada.news_triage_decisions
     WHERE dataset_kind = $1 AND item_identity_hash = $2`,
    [datasetKind, itemIdentityHash],
  );
  if (result.rows.length === 0) return null;
  return mapRow(result.rows[0]!);
}

/**
 * Minimal bounded reader for uncertain triage review/retry inspection.
 * Returns newest-first rows; does not expose article content (none is stored).
 */
export async function readUncertainTriage(
  executor: SqlExecutor,
  datasetKind: string,
  limit: number = 100,
): Promise<readonly NewsTriageDecisionRow[]> {
  if (!VALID_DATASETS[datasetKind]) {
    throw new TypeError(`Invalid dataset_kind: ${datasetKind}`);
  }
  const bounded = Math.max(1, Math.min(Math.floor(limit), 500));
  const result = await executor.query<Record<string, unknown>>(
    `SELECT dataset_kind, item_identity_hash, source_id, trace_id, disposition,
       jakarta_scope, actionability, primary_category, incident_type,
       confidence, reason_codes, policy_version, model_status,
       evaluated_at::text AS evaluated_at, expires_at::text AS expires_at
     FROM waspada.news_triage_decisions
     WHERE dataset_kind = $1 AND disposition = 'uncertain'
     ORDER BY evaluated_at DESC
     LIMIT $2`,
    [datasetKind, bounded],
  );
  return result.rows.map(mapRow);
}

function mapRow(row: Record<string, unknown>): NewsTriageDecisionRow {
  return {
    datasetKind: row.dataset_kind as string,
    itemIdentityHash: row.item_identity_hash as string,
    sourceId: row.source_id as string,
    traceId: row.trace_id as string,
    disposition: row.disposition as NewsTriageDisposition,
    jakartaScope: row.jakarta_scope as NewsTriageJakartaScope,
    actionability: row.actionability as NewsTriageActionability,
    primaryCategory: (row.primary_category as string | null) ?? null,
    incidentType: (row.incident_type as string | null) ?? null,
    confidence: row.confidence as NewsTriageConfidence,
    reasonCodes: Array.isArray(row.reason_codes) ? [...(row.reason_codes as string[])] : [],
    policyVersion: row.policy_version as string,
    modelStatus: row.model_status as NewsTriageModelStatus,
    evaluatedAt: row.evaluated_at as string,
    expiresAt: row.expires_at as string,
  };
}
