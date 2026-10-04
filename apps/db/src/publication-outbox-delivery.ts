import { randomUUID } from 'node:crypto';
import type { SqlExecutor, TransactionalSqlExecutor } from './sql.js';

export const PUBLICATION_OUTBOX_DELIVERY_PAGE_SIZE = 20;
export const PUBLICATION_OUTBOX_DELIVERY_LEASE_MS = 60_000;
export const PUBLICATION_OUTBOX_DELIVERY_MAX_RETRY_MS = 60 * 60 * 1_000;

export type PublicationDeliveryOutcome = 'delivered' | 'retryable_failure' | 'permanent_failure';
export type PublicationDeliveryFailureClassification =
  | 'timeout'
  | 'transient'
  | 'unknown'
  | 'permanent_rejection';

export interface PublicationNotice {
  readonly eventId: string;
  readonly eventVersion: number;
  readonly eventKind: 'event_version_published';
  readonly occurredAt: string;
}

export interface PublicationOutboxDeliveryAttempt {
  readonly attemptId: string;
  readonly reservationKey: string;
  readonly outboxId: string;
  readonly attemptNumber: number;
  readonly leaseExpiresAt: string;
  readonly notice: PublicationNotice;
}

export type PublicationOutboxDeliveryClaimResult =
  | {
    readonly outcome: 'reserved' | 'replayed';
    readonly attempts: readonly PublicationOutboxDeliveryAttempt[];
  }
  | { readonly outcome: 'conflict'; readonly code: 'reservation_key_reused' };

export interface ClaimPublicationOutboxDeliveryPageInput {
  readonly evaluatedAtMs: number;
  /** Stable across an application retry of the same page reservation. */
  readonly reservationKey: string;
}

export interface RecordPublicationOutboxDeliveryResultInput {
  readonly attemptId: string;
  readonly outcome: PublicationDeliveryOutcome;
  readonly completedAtMs: number;
  readonly failureClassification?: PublicationDeliveryFailureClassification;
}

export interface PublicationOutboxDeliveryResult {
  readonly attemptId: string;
  readonly outcome: PublicationDeliveryOutcome;
  readonly failureClassification: PublicationDeliveryFailureClassification | null;
  readonly completedAt: string;
  readonly retryAfter: string | null;
}

export type RecordPublicationOutboxDeliveryResult =
  | { readonly outcome: 'recorded' | 'replayed'; readonly result: PublicationOutboxDeliveryResult }
  | { readonly outcome: 'conflict'; readonly code: 'attempt_not_found' | 'result_conflict' };

export interface PublicationOutboxDeliveryRepository {
  claimPage(input: ClaimPublicationOutboxDeliveryPageInput): Promise<PublicationOutboxDeliveryClaimResult>;
  recordResult(input: RecordPublicationOutboxDeliveryResultInput): Promise<RecordPublicationOutboxDeliveryResult>;
}

export class PublicationOutboxDeliveryInputError extends Error {
  constructor() {
    super('publication_outbox_delivery_invalid_input');
    this.name = 'PublicationOutboxDeliveryInputError';
  }
}

export class PublicationOutboxDeliveryStorageError extends Error {
  constructor() {
    super('publication_outbox_delivery_storage_error');
    this.name = 'PublicationOutboxDeliveryStorageError';
  }
}

interface CandidateRow {
  readonly outbox_id: string;
  readonly event_id: string;
  readonly event_version: number;
  readonly event_kind: string;
  readonly occurred_at: string;
  readonly latest_attempt_number: number | null;
}

interface ExistingReservationRow extends CandidateRow {
  readonly attempt_id: string;
  readonly reservation_key: string;
  readonly attempt_number: number;
  readonly lease_expires_at: string;
  readonly reserved_at: string;
  readonly has_result: boolean;
  readonly is_latest_attempt: boolean;
}

interface AttemptIdentityRow {
  readonly attempt_id: string;
  readonly outbox_id: string;
  readonly attempt_number: number;
}

interface StoredResultRow {
  readonly attempt_id: string;
  readonly outcome: PublicationDeliveryOutcome;
  readonly failure_classification: PublicationDeliveryFailureClassification | null;
  readonly completed_at: string;
  readonly retry_after: string | null;
}

interface InsertedAttemptRow {
  readonly attempt_id: string;
  readonly attempt_number: number;
}

interface InsertedResultRow extends StoredResultRow {}

const RESERVATION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FAILURE_CLASSIFICATIONS = new Set<PublicationDeliveryFailureClassification>([
  'timeout', 'transient', 'unknown', 'permanent_rejection',
]);

class ReservationKeyConflict extends Error {}

export function createSqlPublicationOutboxDeliveryRepository(
  transactions: TransactionalSqlExecutor,
): PublicationOutboxDeliveryRepository {
  if (!transactions || typeof transactions.transaction !== 'function') {
    throw new TypeError('Publication outbox delivery requires a transactional SQL executor');
  }
  return new SqlPublicationOutboxDeliveryRepository(transactions);
}

class SqlPublicationOutboxDeliveryRepository implements PublicationOutboxDeliveryRepository {
  constructor(private readonly transactions: TransactionalSqlExecutor) {}

  async claimPage(input: ClaimPublicationOutboxDeliveryPageInput): Promise<PublicationOutboxDeliveryClaimResult> {
    const snapshot = snapshotClaimInput(input);
    const evaluatedAt = timestamp(snapshot.evaluatedAtMs);
    const reservationKey = snapshot.reservationKey;
    const leaseExpiresAt = timestamp(snapshot.evaluatedAtMs + PUBLICATION_OUTBOX_DELIVERY_LEASE_MS);

    try {
      return await this.transactions.transaction(async (transaction) => {
        await transaction.execute('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');

        const replay = await readReservationPage(transaction, reservationKey, evaluatedAt, leaseExpiresAt);
        if (replay.length > 0) {
          if (replay.length > PUBLICATION_OUTBOX_DELIVERY_PAGE_SIZE
            || replay.some((row) => row.reserved_at !== evaluatedAt || row.lease_expires_at !== leaseExpiresAt)) {
            return { outcome: 'conflict', code: 'reservation_key_reused' };
          }
          return {
            outcome: 'replayed',
            attempts: replay.filter(isPendingLatestAttempt).map((row) => attemptFromRow(row)),
          };
        }

        const candidates = await readReadyCandidates(transaction, evaluatedAt, PUBLICATION_OUTBOX_DELIVERY_PAGE_SIZE);
        const attempts: PublicationOutboxDeliveryAttempt[] = [];
        let insertedCount = 0;

        for (const candidate of candidates.rows) {
          await lockOutbox(transaction, candidate.outbox_id);

          const existingForReservation = await readReservationForOutbox(transaction, reservationKey, candidate.outbox_id);
          if (existingForReservation) {
            if (existingForReservation.reserved_at !== evaluatedAt
              || existingForReservation.lease_expires_at !== leaseExpiresAt) {
              throw new ReservationKeyConflict();
            }
            if (isPendingLatestAttempt(existingForReservation)) attempts.push(attemptFromRow(existingForReservation));
            continue;
          }

          const current = await readReadyCandidate(transaction, candidate.outbox_id, evaluatedAt);
          if (!current) continue;
          const attemptNumber = (current.latest_attempt_number ?? 0) + 1;
          if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1 || attemptNumber > 2_147_483_647) {
            throw new Error('attempt number out of range');
          }

          const attemptId = randomUUID();
          const inserted = await transaction.query<InsertedAttemptRow>(
            `INSERT INTO waspada.publication_outbox_delivery_attempts
               (attempt_id, outbox_id, attempt_number, reservation_key, reserved_at, lease_expires_at)
             VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz)
             ON CONFLICT DO NOTHING
             RETURNING attempt_id, attempt_number`,
            [attemptId, current.outbox_id, attemptNumber, reservationKey, evaluatedAt, leaseExpiresAt],
          );
          const row = inserted.rows[0];
          if (!row) {
            const afterConflict = await readReservationForOutbox(transaction, reservationKey, current.outbox_id);
            if (afterConflict) {
              if (afterConflict.reserved_at !== evaluatedAt || afterConflict.lease_expires_at !== leaseExpiresAt) {
                throw new ReservationKeyConflict();
              }
              if (isPendingLatestAttempt(afterConflict)) attempts.push(attemptFromRow(afterConflict));
              continue;
            }
            // A reservation by another pass won after the candidate read. It is not this pass's work.
            continue;
          }

          attempts.push(attemptFromCandidate(current, row.attempt_id, reservationKey, row.attempt_number, leaseExpiresAt));
          insertedCount += 1;
        }

        return {
          outcome: insertedCount === 0 && attempts.length > 0 ? 'replayed' : 'reserved',
          attempts,
        };
      });
    } catch (error) {
      if (error instanceof PublicationOutboxDeliveryInputError) throw error;
      if (error instanceof ReservationKeyConflict) return { outcome: 'conflict', code: 'reservation_key_reused' };
      throw new PublicationOutboxDeliveryStorageError();
    }
  }

  async recordResult(input: RecordPublicationOutboxDeliveryResultInput): Promise<RecordPublicationOutboxDeliveryResult> {
    const snapshot = snapshotResultInput(input);
    try {
      return await this.transactions.transaction(async (transaction) => {
        await transaction.execute('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');

        const found = await readAttemptIdentity(transaction, snapshot.attemptId);
        if (!found) return { outcome: 'conflict', code: 'attempt_not_found' };

        await lockOutbox(transaction, found.outbox_id);
        const currentAttempt = await readAttemptIdentity(transaction, snapshot.attemptId);
        if (!currentAttempt || currentAttempt.outbox_id !== found.outbox_id
          || currentAttempt.attempt_number !== found.attempt_number) {
          return { outcome: 'conflict', code: 'attempt_not_found' };
        }

        const result = resultFromInput(snapshot, currentAttempt.attempt_number);
        const existing = await readResult(transaction, snapshot.attemptId);
        if (existing) {
          return sameResult(existing, result)
            ? { outcome: 'replayed', result: resultFromRow(existing) }
            : { outcome: 'conflict', code: 'result_conflict' };
        }

        const inserted = await transaction.query<InsertedResultRow>(
          `INSERT INTO waspada.publication_outbox_delivery_results
             (attempt_id, outcome, failure_classification, completed_at, retry_after)
           VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz)
           ON CONFLICT (attempt_id) DO NOTHING
           RETURNING attempt_id, outcome, failure_classification,
                     ${formatTimestampSql('completed_at')} AS completed_at,
                     CASE WHEN retry_after IS NULL THEN NULL ELSE ${formatTimestampSql('retry_after')} END AS retry_after`,
          [result.attemptId, result.outcome, result.failureClassification, result.completedAt, result.retryAfter],
        );
        const insertedRow = inserted.rows[0];
        if (insertedRow) return { outcome: 'recorded', result: resultFromRow(insertedRow) };

        const raced = await readResult(transaction, snapshot.attemptId);
        if (!raced) throw new Error('delivery result insert did not persist');
        return sameResult(raced, result)
          ? { outcome: 'replayed', result: resultFromRow(raced) }
          : { outcome: 'conflict', code: 'result_conflict' };
      });
    } catch (error) {
      if (error instanceof PublicationOutboxDeliveryInputError) throw error;
      throw new PublicationOutboxDeliveryStorageError();
    }
  }
}

function readReadyCandidates(
  transaction: SqlExecutor,
  evaluatedAt: string,
  limit: number,
): Promise<{ readonly rows: readonly CandidateRow[] }> {
  return transaction.query<CandidateRow>(
    `${candidateSelect()}
     WHERE outbox.dataset_kind = 'live'
       AND ${isReadySql('outbox.outbox_id', '$1::timestamptz')}
     ORDER BY outbox.occurred_at ASC, outbox.outbox_id ASC
     LIMIT $2`,
    [evaluatedAt, limit],
  );
}

async function readReadyCandidate(
  transaction: SqlExecutor,
  outboxId: string,
  evaluatedAt: string,
): Promise<CandidateRow | undefined> {
  const result = await transaction.query<CandidateRow>(
    `${candidateSelect()}
     WHERE outbox.outbox_id = $1 AND outbox.dataset_kind = 'live'
       AND ${isReadySql('outbox.outbox_id', '$2::timestamptz')}`,
    [outboxId, evaluatedAt],
  );
  return result.rows[0];
}

function candidateSelect(): string {
  return `SELECT outbox.outbox_id, outbox.event_id, outbox.event_version,
                 outbox.event_kind,
                 ${formatTimestampSql('outbox.occurred_at')} AS occurred_at,
                 latest.attempt_number AS latest_attempt_number
          FROM waspada.publication_outbox AS outbox
          LEFT JOIN LATERAL (
            SELECT attempt.attempt_id, attempt.attempt_number, attempt.lease_expires_at,
                   result.outcome, result.retry_after
            FROM waspada.publication_outbox_delivery_attempts AS attempt
            LEFT JOIN waspada.publication_outbox_delivery_results AS result
              ON result.attempt_id = attempt.attempt_id
            WHERE attempt.outbox_id = outbox.outbox_id
            ORDER BY attempt.attempt_number DESC
            LIMIT 1
          ) AS latest ON true`;
}

function isReadySql(outboxReference: string, evaluatedAtReference: string): string {
  return `NOT EXISTS (
           SELECT 1
           FROM waspada.publication_outbox_delivery_attempts AS terminal_attempt
           JOIN waspada.publication_outbox_delivery_results AS terminal_result
             ON terminal_result.attempt_id = terminal_attempt.attempt_id
           WHERE terminal_attempt.outbox_id = ${outboxReference}
             AND terminal_result.outcome IN ('delivered', 'permanent_failure')
         )
         AND NOT EXISTS (
           SELECT 1
           FROM waspada.publication_outbox_delivery_attempts AS leased_attempt
           LEFT JOIN waspada.publication_outbox_delivery_results AS leased_result
             ON leased_result.attempt_id = leased_attempt.attempt_id
           WHERE leased_attempt.outbox_id = ${outboxReference}
             AND leased_result.attempt_id IS NULL
             AND leased_attempt.lease_expires_at > ${evaluatedAtReference}
         )
         AND (
           NOT EXISTS (
             SELECT 1 FROM waspada.publication_outbox_delivery_attempts AS any_attempt
             WHERE any_attempt.outbox_id = ${outboxReference}
           )
           OR EXISTS (
             SELECT 1
             FROM waspada.publication_outbox_delivery_attempts AS latest_attempt
             LEFT JOIN waspada.publication_outbox_delivery_results AS latest_result
               ON latest_result.attempt_id = latest_attempt.attempt_id
             WHERE latest_attempt.outbox_id = ${outboxReference}
               AND latest_attempt.attempt_number = (
                 SELECT max(numbered.attempt_number)
                 FROM waspada.publication_outbox_delivery_attempts AS numbered
                 WHERE numbered.outbox_id = ${outboxReference}
               )
               AND (
                 (latest_result.attempt_id IS NULL AND latest_attempt.lease_expires_at <= ${evaluatedAtReference})
                 OR (latest_result.outcome = 'retryable_failure'
                   AND latest_result.retry_after <= ${evaluatedAtReference})
               )
           )
         )`;
}

async function readReservationPage(
  transaction: SqlExecutor,
  reservationKey: string,
  evaluatedAt: string,
  leaseExpiresAt: string,
): Promise<readonly ExistingReservationRow[]> {
  const exists = await transaction.query<{ readonly reservation_count: number; readonly request_matches: boolean }>(
    `SELECT count(*)::integer AS reservation_count,
            coalesce(bool_and(attempt.reserved_at = $2::timestamptz
              AND attempt.lease_expires_at = $3::timestamptz), true) AS request_matches
     FROM waspada.publication_outbox_delivery_attempts AS attempt
     WHERE attempt.reservation_key = $1`,
    [reservationKey, evaluatedAt, leaseExpiresAt],
  );
  const count = exists.rows[0]?.reservation_count ?? 0;
  if (count === 0) return [];
  if (count > PUBLICATION_OUTBOX_DELIVERY_PAGE_SIZE) throw new Error('invalid delivery reservation page size');
  if (exists.rows[0]?.request_matches !== true) throw new ReservationKeyConflict();

  const rows = await transaction.query<ExistingReservationRow>(
    `SELECT attempt.attempt_id, attempt.outbox_id, attempt.attempt_number,
            attempt.reservation_key,
            ${formatTimestampSql('attempt.reserved_at')} AS reserved_at,
            ${formatTimestampSql('attempt.lease_expires_at')} AS lease_expires_at,
            outbox.event_id, outbox.event_version, outbox.event_kind,
            ${formatTimestampSql('outbox.occurred_at')} AS occurred_at,
            attempt.attempt_number AS latest_attempt_number,
            (result.attempt_id IS NOT NULL) AS has_result,
            attempt.attempt_number = (
              SELECT max(newer.attempt_number)
              FROM waspada.publication_outbox_delivery_attempts AS newer
              WHERE newer.outbox_id = attempt.outbox_id
            ) AS is_latest_attempt
     FROM waspada.publication_outbox_delivery_attempts AS attempt
     JOIN waspada.publication_outbox AS outbox ON outbox.outbox_id = attempt.outbox_id
     LEFT JOIN waspada.publication_outbox_delivery_results AS result
       ON result.attempt_id = attempt.attempt_id
     WHERE attempt.reservation_key = $1
     ORDER BY outbox.occurred_at ASC, outbox.outbox_id ASC`,
    [reservationKey],
  );
  return rows.rows;
}

async function readReservationForOutbox(
  transaction: SqlExecutor,
  reservationKey: string,
  outboxId: string,
): Promise<ExistingReservationRow | undefined> {
  const result = await transaction.query<ExistingReservationRow>(
    `SELECT attempt.attempt_id, attempt.outbox_id, attempt.attempt_number,
            attempt.reservation_key,
            ${formatTimestampSql('attempt.reserved_at')} AS reserved_at,
            ${formatTimestampSql('attempt.lease_expires_at')} AS lease_expires_at,
            outbox.event_id, outbox.event_version, outbox.event_kind,
            ${formatTimestampSql('outbox.occurred_at')} AS occurred_at,
            attempt.attempt_number AS latest_attempt_number,
            (result.attempt_id IS NOT NULL) AS has_result,
            attempt.attempt_number = (
              SELECT max(newer.attempt_number)
              FROM waspada.publication_outbox_delivery_attempts AS newer
              WHERE newer.outbox_id = attempt.outbox_id
            ) AS is_latest_attempt
     FROM waspada.publication_outbox_delivery_attempts AS attempt
     JOIN waspada.publication_outbox AS outbox ON outbox.outbox_id = attempt.outbox_id
     LEFT JOIN waspada.publication_outbox_delivery_results AS result
       ON result.attempt_id = attempt.attempt_id
     WHERE attempt.reservation_key = $1 AND attempt.outbox_id = $2`,
    [reservationKey, outboxId],
  );
  return result.rows[0];
}

async function readAttemptIdentity(transaction: SqlExecutor, attemptId: string): Promise<AttemptIdentityRow | undefined> {
  const result = await transaction.query<AttemptIdentityRow>(
    `SELECT attempt_id, outbox_id, attempt_number
     FROM waspada.publication_outbox_delivery_attempts
     WHERE attempt_id = $1`,
    [attemptId],
  );
  return result.rows[0];
}

async function readResult(transaction: SqlExecutor, attemptId: string): Promise<StoredResultRow | undefined> {
  const result = await transaction.query<StoredResultRow>(
    `SELECT attempt_id, outcome, failure_classification,
            ${formatTimestampSql('completed_at')} AS completed_at,
            CASE WHEN retry_after IS NULL THEN NULL ELSE ${formatTimestampSql('retry_after')} END AS retry_after
     FROM waspada.publication_outbox_delivery_results
     WHERE attempt_id = $1`,
    [attemptId],
  );
  return result.rows[0];
}

async function lockOutbox(transaction: SqlExecutor, outboxId: string): Promise<void> {
  await transaction.query(
    `SELECT pg_advisory_xact_lock(hashtextextended('waspada:publication-outbox-delivery:' || $1, 0))`,
    [outboxId],
  );
}

function attemptFromRow(row: ExistingReservationRow): PublicationOutboxDeliveryAttempt {
  return attemptFromCandidate(row, row.attempt_id, row.reservation_key, row.attempt_number, row.lease_expires_at);
}

function isPendingLatestAttempt(row: ExistingReservationRow): boolean {
  return row.has_result === false && row.is_latest_attempt === true;
}

function attemptFromCandidate(
  row: CandidateRow,
  attemptId: string,
  reservationKey: string,
  attemptNumber: number,
  leaseExpiresAt: string,
): PublicationOutboxDeliveryAttempt {
  if (!isBoundedText(row.outbox_id, 200) || !isBoundedText(row.event_id, 200)
    || !Number.isSafeInteger(row.event_version) || row.event_version < 1
    || row.event_kind !== 'event_version_published' || !isBoundedText(row.occurred_at, 40)
    || !UUID_PATTERN.test(attemptId) || !RESERVATION_KEY_PATTERN.test(reservationKey)
    || !Number.isSafeInteger(attemptNumber) || attemptNumber < 1 || !isBoundedText(leaseExpiresAt, 40)) {
    throw new PublicationOutboxDeliveryStorageError();
  }
  return {
    attemptId,
    reservationKey,
    outboxId: row.outbox_id,
    attemptNumber,
    leaseExpiresAt,
    notice: {
      eventId: row.event_id,
      eventVersion: row.event_version,
      eventKind: 'event_version_published',
      occurredAt: row.occurred_at,
    },
  };
}

function snapshotResultInput(value: unknown): RecordPublicationOutboxDeliveryResultInput & { readonly completedAt: string } {
  const expectedKeys = ['attemptId', 'outcome', 'completedAtMs', 'failureClassification'];
  if (!isObject(value) || !hasOnlyKeys(value, expectedKeys)
    || !UUID_PATTERN.test(String(value.attemptId))
    || (value.outcome !== 'delivered' && value.outcome !== 'retryable_failure' && value.outcome !== 'permanent_failure')) {
    return invalid();
  }

  const completedAt = timestamp(value.completedAtMs);
  const classification = value.failureClassification;
  if (value.outcome === 'delivered') {
    if (classification !== undefined) return invalid();
    return { attemptId: String(value.attemptId), outcome: 'delivered', completedAtMs: value.completedAtMs as number, completedAt };
  }

  if (typeof classification !== 'string' || !FAILURE_CLASSIFICATIONS.has(classification as PublicationDeliveryFailureClassification)) {
    return invalid();
  }
  if (value.outcome === 'retryable_failure'
    && classification !== 'timeout' && classification !== 'transient' && classification !== 'unknown') return invalid();
  if (value.outcome === 'permanent_failure' && classification !== 'permanent_rejection') return invalid();
  return {
    attemptId: String(value.attemptId),
    outcome: value.outcome,
    completedAtMs: value.completedAtMs as number,
    completedAt,
    failureClassification: classification as PublicationDeliveryFailureClassification,
  };
}

function resultFromInput(
  input: RecordPublicationOutboxDeliveryResultInput & { readonly completedAt: string },
  attemptNumber: number,
): PublicationOutboxDeliveryResult {
  const retryAfter = input.outcome === 'retryable_failure'
    ? timestamp(input.completedAtMs + retryDelayMs(attemptNumber))
    : null;
  return {
    attemptId: input.attemptId,
    outcome: input.outcome,
    failureClassification: input.failureClassification ?? null,
    completedAt: input.completedAt,
    retryAfter,
  };
}

function resultFromRow(row: StoredResultRow): PublicationOutboxDeliveryResult {
  if (!UUID_PATTERN.test(row.attempt_id)
    || (row.outcome !== 'delivered' && row.outcome !== 'retryable_failure' && row.outcome !== 'permanent_failure')
    || !isBoundedText(row.completed_at, 40)
    || (row.retry_after !== null && !isBoundedText(row.retry_after, 40))
    || (row.failure_classification !== null && !FAILURE_CLASSIFICATIONS.has(row.failure_classification))) {
    throw new PublicationOutboxDeliveryStorageError();
  }
  return {
    attemptId: row.attempt_id,
    outcome: row.outcome,
    failureClassification: row.failure_classification,
    completedAt: row.completed_at,
    retryAfter: row.retry_after,
  };
}

function sameResult(left: StoredResultRow, right: PublicationOutboxDeliveryResult): boolean {
  return left.attempt_id === right.attemptId
    && left.outcome === right.outcome
    && left.failure_classification === right.failureClassification
    && left.completed_at === right.completedAt
    && left.retry_after === right.retryAfter;
}

function retryDelayMs(attemptNumber: number): number {
  const exponent = Math.min(attemptNumber - 1, 12);
  return Math.min(PUBLICATION_OUTBOX_DELIVERY_MAX_RETRY_MS, 1_000 * (2 ** exponent));
}

function formatTimestampSql(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

function timestamp(value: unknown): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Math.abs(value) > 8.64e15) return invalid();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return invalid();
  try {
    return date.toISOString().replace(/\.(\d{3})Z$/u, '.$1000Z');
  } catch {
    return invalid();
  }
}

function reservationKeyValue(value: unknown): string {
  if (typeof value !== 'string' || !RESERVATION_KEY_PATTERN.test(value)) return invalid();
  return value;
}

function snapshotClaimInput(value: unknown): ClaimPublicationOutboxDeliveryPageInput {
  if (!isObject(value) || !hasExactKeys(value, ['evaluatedAtMs', 'reservationKey'])) return invalid();
  return {
    evaluatedAtMs: timestampValue(value.evaluatedAtMs),
    reservationKey: reservationKeyValue(value.reservationKey),
  };
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
    && ['attemptId', 'outcome', 'completedAtMs'].every((key) => key in value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => key in value);
}

function timestampValue(value: unknown): number {
  timestamp(value);
  return value as number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalid(): never {
  throw new PublicationOutboxDeliveryInputError();
}
