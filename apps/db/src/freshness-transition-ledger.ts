import { createHash } from 'node:crypto';
import type { SqlExecutor, TransactionalSqlExecutor } from './sql.js';

export type FreshnessDatasetKind = 'live' | 'historical' | 'synthetic';
export type FreshnessStatus = 'current' | 'needs_update' | 'expired';
export type PersistedFreshnessTransitionReason =
  | 'issuer_validity_ended'
  | 'new_applicable_evidence_evaluated'
  | 'review_deadline_missed';
export type SourceRevisionFreshnessTransitionReason = 'source_report_retracted' | 'source_report_superseded';
type AllFreshnessTransitionReason = PersistedFreshnessTransitionReason | SourceRevisionFreshnessTransitionReason;

export type FreshnessTransitionTarget =
  | { readonly kind: 'event_claim_set' }
  | { readonly kind: 'impact'; readonly impactId: string; readonly impactVersion: number };

export interface AppendFreshnessTransitionInput {
  readonly datasetKind: FreshnessDatasetKind;
  readonly eventId: string;
  readonly eventVersion: number;
  readonly target: FreshnessTransitionTarget;
  /** The sequence the caller expects to append. The first transition is sequence 1. */
  readonly expectedSequence: number;
  readonly previousStatus: FreshnessStatus;
  readonly resultingStatus: FreshnessStatus;
  readonly reason: PersistedFreshnessTransitionReason;
  readonly evaluatedAt: string;
  readonly traceId: string;
  readonly idempotencyKey: string;
  readonly evidenceReferenceIds: readonly string[];
}

export interface AppendSourceRevisionFreshnessTransitionInput
  extends Omit<AppendFreshnessTransitionInput, 'reason'> {
  readonly reason: SourceRevisionFreshnessTransitionReason;
  readonly sourceObservationId: string;
}

export interface FreshnessTransitionRecord {
  readonly transitionId: string;
  readonly datasetKind: FreshnessDatasetKind;
  readonly eventId: string;
  readonly eventVersion: number;
  readonly target: FreshnessTransitionTarget;
  readonly transitionSequence: number;
  readonly previousStatus: FreshnessStatus;
  readonly resultingStatus: FreshnessStatus;
  readonly reason: PersistedFreshnessTransitionReason;
  readonly evaluatedAt: string;
  readonly traceId: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly evidenceReferenceIds: readonly string[];
  readonly sourceObservationId: string | null;
}

export interface SourceRevisionFreshnessTransitionRecord
  extends Omit<FreshnessTransitionRecord, 'reason' | 'sourceObservationId'> {
  readonly reason: SourceRevisionFreshnessTransitionReason;
  readonly sourceObservationId: string;
}

export type FreshnessTransitionConflictCode =
  | 'idempotency_key_reused'
  | 'event_version_not_current'
  | 'impact_version_not_referenced'
  | 'stale_sequence'
  | 'prior_status_mismatch'
  | 'target_status_invalid'
  | 'trace_not_found'
  | 'evidence_reference_not_found'
  | 'target_changed';

export type FreshnessTransitionAppendResult =
  | { readonly outcome: 'written' | 'replayed'; readonly record: FreshnessTransitionRecord }
  | { readonly outcome: 'conflict'; readonly code: FreshnessTransitionConflictCode };

export type SourceRevisionFreshnessTransitionAppendResult =
  | { readonly outcome: 'written' | 'replayed'; readonly record: SourceRevisionFreshnessTransitionRecord }
  | { readonly outcome: 'conflict'; readonly code: FreshnessTransitionConflictCode };

export interface FreshnessTransitionLedgerRepository {
  append(input: AppendFreshnessTransitionInput): Promise<FreshnessTransitionAppendResult>;
  append(input: AppendSourceRevisionFreshnessTransitionInput): Promise<SourceRevisionFreshnessTransitionAppendResult>;
}

export class FreshnessTransitionLedgerInputError extends Error {
  constructor(readonly code: 'invalid_input' | 'evidence_references_required' | 'evidence_references_not_applicable') {
    super(code);
    this.name = 'FreshnessTransitionLedgerInputError';
  }
}

export class FreshnessTransitionLedgerStorageError extends Error {
  constructor() {
    super('freshness_transition_storage_error');
    this.name = 'FreshnessTransitionLedgerStorageError';
  }
}

interface Snapshot extends Omit<AppendFreshnessTransitionInput, 'reason'> {
  readonly evidenceReferenceIds: readonly string[];
  readonly reason: AllFreshnessTransitionReason;
  readonly sourceObservationId: string | null;
}

interface InternalFreshnessTransitionRecord extends Omit<FreshnessTransitionRecord, 'reason'> {
  readonly reason: AllFreshnessTransitionReason;
}

type InternalAppendResult =
  | { readonly outcome: 'written' | 'replayed'; readonly record: InternalFreshnessTransitionRecord }
  | { readonly outcome: 'conflict'; readonly code: FreshnessTransitionConflictCode };

interface TransitionRow {
  readonly transition_id: string;
  readonly dataset_kind: FreshnessDatasetKind;
  readonly event_id: string;
  readonly event_version: number;
  readonly target_kind: 'event_claim_set' | 'impact';
  readonly impact_id: string | null;
  readonly impact_version: number | null;
  readonly transition_sequence: number;
  readonly previous_status: FreshnessStatus;
  readonly resulting_status: FreshnessStatus;
  readonly reason: AllFreshnessTransitionReason;
  readonly evaluated_at: string;
  readonly trace_id: string;
  readonly idempotency_key: string;
  readonly request_fingerprint: string;
  readonly source_observation_id: string | null;
}

interface TargetVersionRow {
  readonly publication_status: string;
  readonly record_json: unknown;
  readonly current_version: number | null;
}

interface LatestTransitionRow {
  readonly transition_sequence: number;
  readonly resulting_status: FreshnessStatus;
}

interface EvidenceReferenceRow {
  readonly evidence_ref_id: string;
}

const DATASETS = new Set<FreshnessDatasetKind>(['live', 'historical', 'synthetic']);
const STATUSES = new Set<FreshnessStatus>(['current', 'needs_update', 'expired']);
const REASONS = new Set<AllFreshnessTransitionReason>([
  'issuer_validity_ended', 'new_applicable_evidence_evaluated', 'review_deadline_missed',
  'source_report_retracted', 'source_report_superseded',
]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const EVIDENCE_ID_PATTERN = /^[1-9][0-9]{0,18}$/;
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const INT_MAX = 2_147_483_647;
const PG_BIGINT_MAX = 9_223_372_036_854_775_807n;
const INPUT_KEYS = [
  'datasetKind', 'eventId', 'eventVersion', 'target', 'expectedSequence', 'previousStatus',
  'resultingStatus', 'reason', 'evaluatedAt', 'traceId', 'idempotencyKey', 'evidenceReferenceIds',
] as const;
const OPTIONAL_INPUT_KEYS = ['sourceObservationId'] as const;

export function createSqlFreshnessTransitionLedger(
  transactions: TransactionalSqlExecutor,
): FreshnessTransitionLedgerRepository {
  if (!transactions || typeof transactions.transaction !== 'function') {
    throw new TypeError('Freshness transition persistence requires a transactional SQL executor');
  }
  return new SqlFreshnessTransitionLedger(transactions);
}

class SqlFreshnessTransitionLedger implements FreshnessTransitionLedgerRepository {
  constructor(private readonly transactions: TransactionalSqlExecutor) {}

  async append(input: AppendFreshnessTransitionInput): Promise<FreshnessTransitionAppendResult>;
  async append(input: AppendSourceRevisionFreshnessTransitionInput): Promise<SourceRevisionFreshnessTransitionAppendResult>;
  async append(
    input: AppendFreshnessTransitionInput | AppendSourceRevisionFreshnessTransitionInput,
  ): Promise<FreshnessTransitionAppendResult | SourceRevisionFreshnessTransitionAppendResult> {
    const snapshot = snapshotInput(input);
    const requestFingerprint = fingerprint(snapshot);
    try {
      const result = await this.transactions.transaction((transaction) =>
        this.appendInTransaction(transaction, snapshot, requestFingerprint));
      return publicResult(snapshot.reason, result);
    } catch (error) {
      if (pgConstraint(error, 'freshness_transition_evidence_required')) {
        throw new FreshnessTransitionLedgerInputError('evidence_references_required');
      }
      if (pgConstraint(error, 'freshness_transition_guard')) {
        return { outcome: 'conflict', code: 'target_changed' };
      }
      throw new FreshnessTransitionLedgerStorageError();
    }
  }

  private async appendInTransaction(
    transaction: SqlExecutor,
    input: Snapshot,
    requestFingerprint: string,
  ): Promise<InternalAppendResult> {
    await lock(transaction, 'waspada:freshness-idempotency:', input.idempotencyKey);
    const priorByKey = await findByIdempotencyKey(transaction, input.idempotencyKey);
    if (priorByKey) {
      if (priorByKey.request_fingerprint !== requestFingerprint) {
        return { outcome: 'conflict', code: 'idempotency_key_reused' };
      }
      return { outcome: 'replayed', record: await loadRecord(transaction, priorByKey) };
    }

    // The publication writer uses this same lock before checking max(version) and holds it through commit.
    await lock(transaction, 'waspada:publication-event:', input.eventId);
    const eventResult = await transaction.query<TargetVersionRow>(
      `SELECT event.publication_status, event.record_json,
              (SELECT max(newer.version)::integer FROM waspada.event_versions AS newer
               WHERE newer.dataset_kind = event.dataset_kind AND newer.event_id = event.event_id) AS current_version
       FROM waspada.event_versions AS event
       WHERE event.dataset_kind = $1 AND event.event_id = $2 AND event.version = $3`,
      [input.datasetKind, input.eventId, input.eventVersion],
    );
    const event = eventResult.rows[0];
    if (!event || event.publication_status !== 'published' || event.current_version !== input.eventVersion) {
      return { outcome: 'conflict', code: 'event_version_not_current' };
    }

    let baseRecord = event.record_json;
    if (input.target.kind === 'impact') {
      const impactResult = await transaction.query<{ record_json: unknown }>(
        `SELECT impact.record_json
         FROM waspada.event_impact_refs AS reference
         JOIN waspada.impact_versions AS impact
           ON impact.dataset_kind = reference.dataset_kind
          AND impact.event_id = reference.event_id
          AND impact.impact_id = reference.impact_id
          AND impact.version = reference.impact_version
         WHERE reference.dataset_kind = $1 AND reference.event_id = $2 AND reference.event_version = $3
           AND reference.impact_id = $4 AND reference.impact_version = $5`,
        [input.datasetKind, input.eventId, input.eventVersion, input.target.impactId, input.target.impactVersion],
      );
      baseRecord = impactResult.rows[0]?.record_json;
      if (baseRecord === undefined) return { outcome: 'conflict', code: 'impact_version_not_referenced' };
    }

    const storedStatus = readBaseStatus(baseRecord);
    if (storedStatus === null) return { outcome: 'conflict', code: 'target_status_invalid' };

    const trace = await transaction.query<{ trace_id: string }>(
      'SELECT trace_id FROM waspada.traces WHERE dataset_kind = $1 AND trace_id = $2',
      [input.datasetKind, input.traceId],
    );
    if (!trace.rows[0]) return { outcome: 'conflict', code: 'trace_not_found' };

    if (input.evidenceReferenceIds.length > 0) {
      const references = await transaction.query<EvidenceReferenceRow>(
        `SELECT evidence_ref_id::text AS evidence_ref_id
         FROM waspada.evidence_references
         WHERE dataset_kind = $1 AND evidence_ref_id = ANY($2::bigint[])
         ORDER BY evidence_ref_id`,
        [input.datasetKind, input.evidenceReferenceIds],
      );
      if (!sameStringList(references.rows.map(({ evidence_ref_id }) => evidence_ref_id), input.evidenceReferenceIds)) {
        return { outcome: 'conflict', code: 'evidence_reference_not_found' };
      }
    }

    const latest = await findLatestTransition(transaction, input);
    const expectedSequence = latest ? latest.transition_sequence + 1 : 1;
    const effectivePriorStatus = latest?.resulting_status ?? storedStatus;
    if (input.expectedSequence !== expectedSequence) return { outcome: 'conflict', code: 'stale_sequence' };
    if (input.previousStatus !== effectivePriorStatus) return { outcome: 'conflict', code: 'prior_status_mismatch' };

    const inserted = await transaction.query<TransitionRow>(
      `INSERT INTO waspada.freshness_transitions
         (dataset_kind, event_id, event_version, target_kind, impact_id, impact_version,
          transition_sequence, previous_status, resulting_status, reason, evaluated_at,
          trace_id, idempotency_key, request_fingerprint, source_observation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT DO NOTHING
       RETURNING transition_id::text AS transition_id, dataset_kind, event_id, event_version,
                 target_kind, impact_id, impact_version, transition_sequence, previous_status,
                 resulting_status, reason, evaluated_at, trace_id, idempotency_key, request_fingerprint,
                 source_observation_id`,
      [input.datasetKind, input.eventId, input.eventVersion, input.target.kind,
        input.target.kind === 'impact' ? input.target.impactId : null,
        input.target.kind === 'impact' ? input.target.impactVersion : null,
        input.expectedSequence, input.previousStatus, input.resultingStatus, input.reason,
        input.evaluatedAt, input.traceId, input.idempotencyKey, requestFingerprint,
        input.sourceObservationId],
    );
    const row = inserted.rows[0];
    if (!row) {
      const existing = await findByIdempotencyKey(transaction, input.idempotencyKey);
      if (existing) {
        if (existing.request_fingerprint !== requestFingerprint) {
          return { outcome: 'conflict', code: 'idempotency_key_reused' };
        }
        return { outcome: 'replayed', record: await loadRecord(transaction, existing) };
      }
      return { outcome: 'conflict', code: 'stale_sequence' };
    }

    for (const evidenceReferenceId of input.evidenceReferenceIds) {
      await transaction.query(
        `INSERT INTO waspada.freshness_transition_evidence (transition_id, dataset_kind, evidence_ref_id)
         VALUES ($1::bigint, $2, $3::bigint)`,
        [row.transition_id, input.datasetKind, evidenceReferenceId],
      );
    }
    return {
      outcome: 'written',
      record: recordFromRow(row, input.evidenceReferenceIds),
    };
  }
}

function snapshotInput(value: unknown): Snapshot {
  if (!isObject(value) || !hasExactKeysWithOptional(value, INPUT_KEYS, OPTIONAL_INPUT_KEYS)) return invalid();
  if (typeof value.datasetKind !== 'string' || !DATASETS.has(value.datasetKind as FreshnessDatasetKind)) return invalid();
  if (!isId(value.eventId) || !isId(value.traceId) || !isIdempotencyKey(value.idempotencyKey)) return invalid();
  if (!positiveInt(value.eventVersion) || !positiveInt(value.expectedSequence)) return invalid();
  if (typeof value.previousStatus !== 'string' || !STATUSES.has(value.previousStatus as FreshnessStatus)) return invalid();
  if (typeof value.resultingStatus !== 'string' || !STATUSES.has(value.resultingStatus as FreshnessStatus)) return invalid();
  if (typeof value.reason !== 'string' || !REASONS.has(value.reason as AllFreshnessTransitionReason)) return invalid();
  if (typeof value.evaluatedAt !== 'string' || !RFC3339_PATTERN.test(value.evaluatedAt)) return invalid();
  if (Object.hasOwn(value, 'sourceObservationId')
    && value.sourceObservationId !== undefined && !isId(value.sourceObservationId)) return invalid();
  if (!isObject(value.target)) return invalid();

  let target: FreshnessTransitionTarget;
  if (value.target.kind === 'event_claim_set' && hasExactKeys(value.target, ['kind'])) {
    target = { kind: 'event_claim_set' };
  } else if (value.target.kind === 'impact' && hasExactKeys(value.target, ['kind', 'impactId', 'impactVersion'])
    && isId(value.target.impactId) && positiveInt(value.target.impactVersion)) {
    target = { kind: 'impact', impactId: value.target.impactId, impactVersion: value.target.impactVersion };
  } else {
    return invalid();
  }

  if (!Array.isArray(value.evidenceReferenceIds) || value.evidenceReferenceIds.length > 32) return invalid();
  const evidenceReferenceIds: string[] = [];
  for (const item of value.evidenceReferenceIds) {
    if (typeof item !== 'string' || !EVIDENCE_ID_PATTERN.test(item) || BigInt(item) > PG_BIGINT_MAX) return invalid();
    evidenceReferenceIds.push(item);
  }
  if (new Set(evidenceReferenceIds).size !== evidenceReferenceIds.length) return invalid();
  evidenceReferenceIds.sort((left, right) => BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0);
  const reason = value.reason as AllFreshnessTransitionReason;
  const previousStatus = value.previousStatus as FreshnessStatus;
  const resultingStatus = value.resultingStatus as FreshnessStatus;
  const sourceObservationId = typeof value.sourceObservationId === 'string' ? value.sourceObservationId : null;
  if (previousStatus === resultingStatus
    || (reason === 'issuer_validity_ended'
      && (resultingStatus !== 'expired' || previousStatus === 'expired' || sourceObservationId !== null))
    || (reason === 'review_deadline_missed'
      && (previousStatus !== 'current' || resultingStatus !== 'needs_update' || sourceObservationId !== null))
    || (reason === 'new_applicable_evidence_evaluated'
      && ((previousStatus !== 'needs_update' && previousStatus !== 'expired') || resultingStatus !== 'current'
        || sourceObservationId !== null))
    || ((reason === 'source_report_retracted' || reason === 'source_report_superseded')
      && (value.datasetKind !== 'live' || previousStatus !== 'current' || resultingStatus !== 'needs_update'
        || sourceObservationId === null))) {
    return invalid();
  }
  if (reason === 'new_applicable_evidence_evaluated' && evidenceReferenceIds.length === 0) {
    throw new FreshnessTransitionLedgerInputError('evidence_references_required');
  }
  if (reason !== 'new_applicable_evidence_evaluated' && evidenceReferenceIds.length > 0) {
    throw new FreshnessTransitionLedgerInputError('evidence_references_not_applicable');
  }

  return {
    datasetKind: value.datasetKind as FreshnessDatasetKind,
    eventId: value.eventId,
    eventVersion: value.eventVersion,
    target,
    expectedSequence: value.expectedSequence,
    previousStatus,
    resultingStatus,
    reason,
    evaluatedAt: value.evaluatedAt,
    traceId: value.traceId,
    idempotencyKey: value.idempotencyKey,
    evidenceReferenceIds,
    sourceObservationId,
  };
}

async function findByIdempotencyKey(transaction: SqlExecutor, idempotencyKey: string): Promise<TransitionRow | null> {
  const result = await transaction.query<TransitionRow>(
    `SELECT transition_id::text AS transition_id, dataset_kind, event_id, event_version,
            target_kind, impact_id, impact_version, transition_sequence, previous_status,
            resulting_status, reason, evaluated_at, trace_id, idempotency_key, request_fingerprint,
            source_observation_id
     FROM waspada.freshness_transitions WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  return result.rows[0] ?? null;
}

async function findLatestTransition(
  transaction: SqlExecutor,
  input: Snapshot,
): Promise<LatestTransitionRow | null> {
  const result = await transaction.query<LatestTransitionRow>(
    `SELECT transition_sequence, resulting_status
     FROM waspada.freshness_transitions
     WHERE dataset_kind = $1 AND event_id = $2 AND event_version = $3 AND target_kind = $4
       AND impact_id IS NOT DISTINCT FROM $5 AND impact_version IS NOT DISTINCT FROM $6
     ORDER BY transition_sequence DESC LIMIT 1`,
    [input.datasetKind, input.eventId, input.eventVersion, input.target.kind,
      input.target.kind === 'impact' ? input.target.impactId : null,
      input.target.kind === 'impact' ? input.target.impactVersion : null],
  );
  return result.rows[0] ?? null;
}

async function loadRecord(transaction: SqlExecutor, row: TransitionRow): Promise<InternalFreshnessTransitionRecord> {
  const links = await transaction.query<EvidenceReferenceRow>(
    `SELECT evidence_ref_id::text AS evidence_ref_id
     FROM waspada.freshness_transition_evidence
     WHERE transition_id = $1::bigint AND dataset_kind = $2
     ORDER BY evidence_ref_id`,
    [row.transition_id, row.dataset_kind],
  );
  return recordFromRow(row, links.rows.map(({ evidence_ref_id }) => evidence_ref_id));
}

function recordFromRow(
  row: TransitionRow,
  evidenceReferenceIds: readonly string[],
): InternalFreshnessTransitionRecord {
  const target: FreshnessTransitionTarget = row.target_kind === 'event_claim_set'
    ? { kind: 'event_claim_set' }
    : { kind: 'impact', impactId: row.impact_id!, impactVersion: row.impact_version! };
  return {
    transitionId: row.transition_id,
    datasetKind: row.dataset_kind,
    eventId: row.event_id,
    eventVersion: Number(row.event_version),
    target,
    transitionSequence: Number(row.transition_sequence),
    previousStatus: row.previous_status,
    resultingStatus: row.resulting_status,
    reason: row.reason,
    evaluatedAt: row.evaluated_at,
    traceId: row.trace_id,
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    evidenceReferenceIds: [...evidenceReferenceIds],
    sourceObservationId: row.source_observation_id,
  };
}

function publicResult(
  reason: AllFreshnessTransitionReason,
  result: InternalAppendResult,
): FreshnessTransitionAppendResult | SourceRevisionFreshnessTransitionAppendResult {
  if (result.outcome === 'conflict') return result;
  if (reason === 'source_report_retracted' || reason === 'source_report_superseded') {
    if (result.record.sourceObservationId === null) return { outcome: 'conflict', code: 'target_changed' };
    return {
      outcome: result.outcome,
      record: {
        ...result.record,
        reason,
        sourceObservationId: result.record.sourceObservationId,
      },
    };
  }
  return {
    outcome: result.outcome,
    record: {
      ...result.record,
      reason,
      sourceObservationId: null,
    },
  };
}

function readBaseStatus(value: unknown): FreshnessStatus | null {
  if (!isObject(value) || !isObject(value.freshness)) return null;
  const status = value.freshness.status;
  return typeof status === 'string' && STATUSES.has(status as FreshnessStatus)
    ? status as FreshnessStatus
    : null;
}

function fingerprint(input: Snapshot): string {
  return createHash('sha256').update(canonicalJson(input), 'utf8').digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function lock(transaction: SqlExecutor, namespace: string, key: string): Promise<void> {
  await transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1 || $2, 0))', [namespace, key]);
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const expected = new Set<string>(expectedKeys);
  return Object.keys(value).length === expected.size && Object.keys(value).every((key) => expected.has(key));
}

function hasExactKeysWithOptional(
  value: Record<string, unknown>,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
): boolean {
  const allowed = new Set<string>([...requiredKeys, ...optionalKeys]);
  return requiredKeys.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function isIdempotencyKey(value: unknown): value is string {
  return typeof value === 'string' && IDEMPOTENCY_PATTERN.test(value);
}

function positiveInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= INT_MAX;
}

function pgConstraint(error: unknown, constraintName: string): boolean {
  return error !== null && typeof error === 'object' && 'constraint' in error
    && (error as { readonly constraint?: unknown }).constraint === constraintName;
}

function invalid(): never {
  throw new FreshnessTransitionLedgerInputError('invalid_input');
}
