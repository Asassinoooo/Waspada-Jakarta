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
  /** WJ-INT-02A revision lineage: accepted revision this evaluation produced. */
  readonly reportRevisionId: string | null;
  /** sha256(link + ':' + permitted_text); changes on content edits. */
  readonly contentHash: string | null;
  readonly attemptCount: number;
  readonly supersedesHash: string | null;
  readonly reviewedAt: string | null;
  readonly reviewedBy: string | null;
}

export interface RecordNewsTriageDecisionInput extends Omit<
  NewsTriageDecisionRow,
  'evaluatedAt' | 'expiresAt' | 'policyVersion' | 'reportRevisionId' | 'contentHash' | 'attemptCount' | 'supersedesHash' | 'reviewedAt' | 'reviewedBy'
> {
  readonly policyVersion?: string;
  readonly reportRevisionId?: string | null;
  readonly contentHash?: string | null;
  readonly attemptCount?: number;
  readonly supersedesHash?: string | null;
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
       report_revision_id, content_hash, attempt_count, supersedes_hash,
       evaluated_at, expires_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, now(), now() + interval '7 days')
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
       report_revision_id = EXCLUDED.report_revision_id,
       content_hash = EXCLUDED.content_hash,
       attempt_count = EXCLUDED.attempt_count,
       supersedes_hash = EXCLUDED.supersedes_hash,
       evaluated_at = EXCLUDED.evaluated_at,
       expires_at = EXCLUDED.expires_at
     RETURNING dataset_kind, item_identity_hash, source_id, trace_id, disposition,
       jakarta_scope, actionability, primary_category, incident_type,
       confidence, reason_codes, policy_version, model_status,
       report_revision_id, content_hash, attempt_count, supersedes_hash,
       reviewed_at::text AS reviewed_at, reviewed_by,
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
      input.reportRevisionId ?? null,
      input.contentHash ?? null,
      input.attemptCount ?? 1,
      input.supersedesHash ?? null,
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
       report_revision_id, content_hash, attempt_count, supersedes_hash,
       reviewed_at::text AS reviewed_at, reviewed_by,
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
       report_revision_id, content_hash, attempt_count, supersedes_hash,
       reviewed_at::text AS reviewed_at, reviewed_by,
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
    reportRevisionId: (row.report_revision_id as string | null) ?? null,
    contentHash: (row.content_hash as string | null) ?? null,
    attemptCount: typeof row.attempt_count === 'number' ? row.attempt_count : Number(row.attempt_count ?? 1),
    supersedesHash: (row.supersedes_hash as string | null) ?? null,
    reviewedAt: (row.reviewed_at as string | null) ?? null,
    reviewedBy: (row.reviewed_by as string | null) ?? null,
  };
}

/**
 * WJ-INT-02A append-only attempt ledger. Every evaluation producing a
 * report_revision_id inserts here; the decisions table keeps the latest per
 * item hash. Never upserts, never overwrites history.
 */
export interface RecordTriageAttemptInput {
  readonly datasetKind: string;
  readonly itemIdentityHash: string;
  readonly reportRevisionId: string;
  readonly sourceId: string;
  readonly traceId: string;
  readonly disposition: NewsTriageDisposition;
  readonly jakartaScope: NewsTriageJakartaScope;
  readonly actionability: NewsTriageActionability;
  readonly primaryCategory: string | null;
  readonly incidentType: string | null;
  readonly confidence: NewsTriageConfidence;
  readonly reasonCodes: readonly string[];
  readonly policyVersion?: string;
  readonly modelStatus: NewsTriageModelStatus;
  readonly contentHash?: string | null;
  readonly supersedesHash?: string | null;
}

export async function recordTriageAttempt(
  executor: SqlExecutor,
  input: RecordTriageAttemptInput,
): Promise<void> {
  if (!VALID_DATASETS[input.datasetKind]) {
    throw new TypeError(`Invalid dataset_kind: ${input.datasetKind}`);
  }
  if (!/^[0-9a-f]{64}$/.test(input.itemIdentityHash)) {
    throw new TypeError('itemIdentityHash must be a 64-char lowercase hex sha256');
  }
  if (!input.reportRevisionId) {
    throw new TypeError('reportRevisionId is required for an attempt row');
  }
  await executor.query(
    `INSERT INTO waspada.news_triage_attempts (
       dataset_kind, item_identity_hash, report_revision_id, source_id, trace_id,
       disposition, jakarta_scope, actionability, primary_category, incident_type,
       confidence, reason_codes, policy_version, model_status,
       content_hash, supersedes_hash, evaluated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, now())`,
    [
      input.datasetKind,
      input.itemIdentityHash,
      input.reportRevisionId,
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
      input.contentHash ?? null,
      input.supersedesHash ?? null,
    ],
  );
}
/**
 * WJ-INT-02B latest-attempt lookup for the job-runner triage gate.
 * Returns the newest attempt row for a revision (evaluated_at DESC) or null.
 * Selects metadata only; attempt rows never carry title/description/body text.
 */
export interface NewsTriageAttemptRow {
  readonly datasetKind: string;
  readonly itemIdentityHash: string;
  readonly reportRevisionId: string;
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
  readonly contentHash: string | null;
  readonly supersedesHash: string | null;
  readonly evaluatedAt: string;
}

export async function readLatestAttemptForRevision(
  executor: SqlExecutor,
  datasetKind: string,
  reportRevisionId: string,
): Promise<NewsTriageAttemptRow | null> {
  if (!VALID_DATASETS[datasetKind]) {
    throw new TypeError(`Invalid dataset_kind: ${datasetKind}`);
  }
  const result = await executor.query<Record<string, unknown>>(
    `SELECT dataset_kind, item_identity_hash, report_revision_id, source_id, trace_id,
       disposition, jakarta_scope, actionability, primary_category, incident_type,
       confidence, reason_codes, policy_version, model_status,
       content_hash, supersedes_hash,
       evaluated_at::text AS evaluated_at
     FROM waspada.news_triage_attempts
     WHERE dataset_kind = $1 AND report_revision_id = $2
     ORDER BY evaluated_at DESC
     LIMIT 1`,
    [datasetKind, reportRevisionId],
  );
  if (result.rows.length === 0) return null;
  return mapAttemptRow(result.rows[0]!);
}

function mapAttemptRow(row: Record<string, unknown>): NewsTriageAttemptRow {
  return {
    datasetKind: row.dataset_kind as string,
    itemIdentityHash: row.item_identity_hash as string,
    reportRevisionId: row.report_revision_id as string,
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
    contentHash: (row.content_hash as string | null) ?? null,
    supersedesHash: (row.supersedes_hash as string | null) ?? null,
    evaluatedAt: row.evaluated_at as string,
  };
}

/**
 * WJ-INT-02A revision-keyed decision lookup. Returns the accepted decision
 * row for a report revision, or null when no accepted ingest exists.
 */
export async function readTriageDecisionForRevision(
  executor: SqlExecutor,
  datasetKind: string,
  reportRevisionId: string,
): Promise<NewsTriageDecisionRow | null> {
  if (!VALID_DATASETS[datasetKind]) {
    throw new TypeError(`Invalid dataset_kind: ${datasetKind}`);
  }
  const result = await executor.query<Record<string, unknown>>(
    `SELECT dataset_kind, item_identity_hash, source_id, trace_id, disposition,
       jakarta_scope, actionability, primary_category, incident_type,
       confidence, reason_codes, policy_version, model_status,
       report_revision_id, content_hash, attempt_count, supersedes_hash,
       reviewed_at::text AS reviewed_at, reviewed_by,
       evaluated_at::text AS evaluated_at, expires_at::text AS expires_at
     FROM waspada.news_triage_decisions
     WHERE dataset_kind = $1 AND report_revision_id = $2`,
    [datasetKind, reportRevisionId],
  );
  if (result.rows.length === 0) return null;
  return mapRow(result.rows[0]!);
}

/**
 * WJ-INT-02B held persistence contract: one real transaction containing the
 * advisory lock, decision snapshot upsert, reviewed-flag clearing, and
 * attempt insert. All-or-nothing: any throw rolls back every write.
 * Requires a transaction-capable executor; fails closed otherwise.
 */
export interface HeldTriagePersistInput {
  readonly datasetKind: string;
  readonly itemIdentityHash: string;
  readonly sourceId: string;
  readonly traceId: string;
  readonly reportRevisionId: string | null;
  readonly disposition: NewsTriageDisposition;
  readonly jakartaScope: NewsTriageJakartaScope;
  readonly actionability: NewsTriageActionability;
  readonly primaryCategory: string | null;
  readonly incidentType: string | null;
  readonly confidence: NewsTriageConfidence;
  readonly reasonCodes: readonly string[];
  readonly policyVersion?: string;
  readonly modelStatus: NewsTriageModelStatus;
  readonly contentHash?: string | null;
  readonly supersedesHash?: string | null;
  readonly priorDisposition: string | null;
  readonly priorPrimaryCategory: string | null;
}
export async function persistHeldTriageTransaction(
  executor: SqlExecutor & Partial<{ transaction: (work: (tx: SqlExecutor) => Promise<unknown>) => Promise<unknown> }>,
  input: HeldTriagePersistInput,
  attempt: Omit<RecordTriageAttemptInput, "datasetKind" | "itemIdentityHash" | "reportRevisionId"> & { reportRevisionId: string },
): Promise<void> {
  if (!VALID_DATASETS[input.datasetKind]) {
    throw new TypeError(`Invalid dataset_kind: ${input.datasetKind}`);
  }
  if (typeof executor.transaction !== "function") {
    throw new Error("held triage persistence requires a transaction-capable executor");
  }
  await executor.transaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      input.itemIdentityHash,
    ]);
    const currentCount = await tx.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM waspada.news_triage_attempts
       WHERE dataset_kind = $1 AND item_identity_hash = $2`,
      [input.datasetKind, input.itemIdentityHash],
    );
    const attemptCount = 1 + Number(currentCount.rows[0]?.count ?? "0");
    await recordTriageDecision(tx, {
      datasetKind: input.datasetKind,
      itemIdentityHash: input.itemIdentityHash,
      sourceId: input.sourceId,
      traceId: input.traceId,
      disposition: input.disposition,
      jakartaScope: input.jakartaScope,
      actionability: input.actionability,
      primaryCategory: input.primaryCategory,
      incidentType: input.incidentType,
      confidence: input.confidence,
      reasonCodes: [...input.reasonCodes],
      policyVersion: input.policyVersion,
      modelStatus: input.modelStatus,
      reportRevisionId: input.reportRevisionId,
      contentHash: input.contentHash ?? null,
      attemptCount,
      supersedesHash: input.supersedesHash ?? null,
    });
    if (
      input.priorDisposition !== null &&
      (input.priorDisposition !== input.disposition ||
        input.priorPrimaryCategory !== input.primaryCategory)
    ) {
      await tx.query(
        `UPDATE waspada.news_triage_decisions
         SET reviewed_at = NULL, reviewed_by = NULL
         WHERE dataset_kind = $1 AND item_identity_hash = $2`,
        [input.datasetKind, input.itemIdentityHash],
      );
    }
    await recordTriageAttempt(tx, {
      ...attempt,
      datasetKind: input.datasetKind,
      itemIdentityHash: input.itemIdentityHash,
      reportRevisionId: attempt.reportRevisionId,
    });
  });
}

/**
 * WJ-INT-02A inspection-only reviewed flag. Sets reviewed_at/by only where
 * the row is still uncertain; returns false otherwise (including missing).
 */
export async function markTriageReviewed(
  executor: SqlExecutor,
  datasetKind: string,
  itemIdentityHash: string,
  actorId: string,
): Promise<boolean> {
  if (!VALID_DATASETS[datasetKind]) {
    throw new TypeError(`Invalid dataset_kind: ${datasetKind}`);
  }
  if (!actorId) {
    throw new TypeError('actorId is required to mark a triage row reviewed');
  }
  const result = await executor.query<{ item_identity_hash: string }>(
    `UPDATE waspada.news_triage_decisions
     SET reviewed_at = now(), reviewed_by = $3
     WHERE dataset_kind = $1 AND item_identity_hash = $2
       AND disposition = 'uncertain'
     RETURNING item_identity_hash`,
    [datasetKind, itemIdentityHash, actorId],
  );
  return result.rows.length > 0;
}
