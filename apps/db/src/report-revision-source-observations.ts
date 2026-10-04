import type { SqlExecutor, TransactionalSqlExecutor } from './sql.js';

export type ReportRevisionSourceAssertionState = 'current' | 'superseded' | 'retracted' | 'withdrawn';

export interface NewReportRevisionSourceObservation {
  readonly datasetKind: 'live' | 'historical' | 'synthetic';
  readonly observationId: string;
  readonly traceId: string;
  readonly targetReportRevisionId: string;
  readonly assertionReportRevisionId: string;
  readonly assertedState: ReportRevisionSourceAssertionState;
  readonly replacementReportRevisionId?: string | null;
  readonly publisherObservedAt?: string | null;
  readonly retrievedAt: string;
}

export interface ReportRevisionSourceObservationRecord {
  readonly datasetKind: 'live' | 'historical' | 'synthetic';
  readonly observationId: string;
  readonly traceId: string;
  readonly sourceId: string;
  readonly targetReportRevisionId: string;
  readonly assertionReportRevisionId: string;
  readonly assertedState: ReportRevisionSourceAssertionState;
  readonly replacementReportRevisionId: string | null;
  readonly publisherObservedAt: string | null;
  readonly retrievedAt: string;
  readonly recordedAt: string;
}

export interface ReportRevisionSourceObservationRepository {
  create(input: NewReportRevisionSourceObservation): Promise<ReportRevisionSourceObservationRecord>;
}

export type ReportRevisionSourceObservationErrorCode =
  | 'invalid_input'
  | 'revision_not_found'
  | 'source_lineage_mismatch'
  | 'replacement_mismatch'
  | 'observation_id_reused'
  | 'storage_error';

const ERROR_MESSAGES: Record<ReportRevisionSourceObservationErrorCode, string> = {
  invalid_input: 'report_revision_source_observation_invalid_input',
  revision_not_found: 'report_revision_source_observation_revision_not_found',
  source_lineage_mismatch: 'report_revision_source_observation_source_lineage_mismatch',
  replacement_mismatch: 'report_revision_source_observation_replacement_mismatch',
  observation_id_reused: 'report_revision_source_observation_conflict',
  storage_error: 'report_revision_source_observation_storage_error',
};

export class ReportRevisionSourceObservationError extends Error {
  constructor(readonly code: ReportRevisionSourceObservationErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'ReportRevisionSourceObservationError';
  }
}

interface Snapshot {
  readonly datasetKind: NewReportRevisionSourceObservation['datasetKind'];
  readonly observationId: string;
  readonly traceId: string;
  readonly targetReportRevisionId: string;
  readonly assertionReportRevisionId: string;
  readonly assertedState: ReportRevisionSourceAssertionState;
  readonly replacementReportRevisionId: string | null;
  readonly publisherObservedAt: string | null;
  readonly retrievedAt: string;
}

interface ObservationRow {
  readonly dataset_kind: NewReportRevisionSourceObservation['datasetKind'];
  readonly observation_id: string;
  readonly trace_id: string;
  readonly source_id: string;
  readonly target_report_revision_id: string;
  readonly assertion_report_revision_id: string;
  readonly asserted_state: ReportRevisionSourceAssertionState;
  readonly replacement_report_revision_id: string | null;
  readonly publisher_observed_at: string | null;
  readonly retrieved_at: string;
  readonly recorded_at: string;
}

interface ExistingObservationRow extends ObservationRow {
  readonly matches: boolean;
}

interface RevisionLineageRow {
  readonly target_source_id: string;
  readonly assertion_exists: boolean;
  readonly assertion_source_id: string | null;
  readonly replacement_exists: boolean;
  readonly replacement_source_id: string | null;
  readonly replacement_supersedes_id: string | null;
}

const DATASETS = new Set(['live', 'historical', 'synthetic']);
const STATES = new Set<ReportRevisionSourceAssertionState>(['current', 'superseded', 'retracted', 'withdrawn']);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RFC3339_MICROSECOND_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-](\d{2}):(\d{2}))$/u;
const REQUIRED_KEYS = [
  'datasetKind', 'observationId', 'traceId', 'targetReportRevisionId',
  'assertionReportRevisionId', 'assertedState', 'retrievedAt',
] as const;
const ALLOWED_KEYS = new Set<string>([
  ...REQUIRED_KEYS, 'replacementReportRevisionId', 'publisherObservedAt',
]);

export function createSqlReportRevisionSourceObservationRepository(
  transactions: TransactionalSqlExecutor,
): ReportRevisionSourceObservationRepository {
  if (!transactions || typeof transactions.query !== 'function' || typeof transactions.transaction !== 'function') {
    throw new TypeError('Source revision observation persistence requires a transactional SQL executor');
  }

  return new SqlReportRevisionSourceObservationRepository(transactions);
}

class SqlReportRevisionSourceObservationRepository implements ReportRevisionSourceObservationRepository {
  constructor(private readonly transactions: TransactionalSqlExecutor) {}

  async create(input: NewReportRevisionSourceObservation): Promise<ReportRevisionSourceObservationRecord> {
    const snapshot = snapshotInput(input);
    try {
      return await this.transactions.transaction((transaction) => this.createInTransaction(transaction, snapshot));
    } catch (error) {
      if (error instanceof ReportRevisionSourceObservationError) throw error;
      throw new ReportRevisionSourceObservationError('storage_error');
    }
  }

  private async createInTransaction(
    transaction: SqlExecutor,
    input: Snapshot,
  ): Promise<ReportRevisionSourceObservationRecord> {
    const prior = await findExisting(transaction, input);
    if (prior) return verifyReplay(prior);

    const lineage = await readLineage(transaction, input);
    if (!lineage) throw new ReportRevisionSourceObservationError('revision_not_found');
    if (!lineage.assertion_exists
      || (input.assertedState === 'superseded' && !lineage.replacement_exists)) {
      throw new ReportRevisionSourceObservationError('revision_not_found');
    }
    if (lineage.target_source_id !== lineage.assertion_source_id) {
      throw new ReportRevisionSourceObservationError('source_lineage_mismatch');
    }

    if (input.assertedState === 'superseded') {
      if (lineage.target_source_id !== lineage.replacement_source_id) {
        throw new ReportRevisionSourceObservationError('source_lineage_mismatch');
      }
      if (lineage.replacement_supersedes_id !== input.targetReportRevisionId) {
        throw new ReportRevisionSourceObservationError('replacement_mismatch');
      }
    }

    const inserted = await transaction.query<ObservationRow>(
      `INSERT INTO waspada.report_revision_source_observations
         (dataset_kind, observation_id, trace_id, source_id, target_report_revision_id,
          assertion_report_revision_id, asserted_state, replacement_report_revision_id,
          publisher_observed_at, retrieved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz)
       ON CONFLICT (dataset_kind, observation_id) DO NOTHING
       RETURNING dataset_kind, observation_id, trace_id, source_id, target_report_revision_id,
                 assertion_report_revision_id, asserted_state, replacement_report_revision_id,
                 publisher_observed_at::text AS publisher_observed_at,
                 retrieved_at::text AS retrieved_at, recorded_at::text AS recorded_at`,
      [input.datasetKind, input.observationId, input.traceId, lineage.target_source_id,
        input.targetReportRevisionId, input.assertionReportRevisionId, input.assertedState,
        input.replacementReportRevisionId, input.publisherObservedAt, input.retrievedAt],
    );
    const row = inserted.rows[0];
    if (row) return mapObservation(row);

    const racedPrior = await findExisting(transaction, input);
    if (!racedPrior) throw new ReportRevisionSourceObservationError('storage_error');
    return verifyReplay(racedPrior);
  }
}

async function readLineage(transaction: SqlExecutor, input: Snapshot): Promise<RevisionLineageRow | null> {
  const result = await transaction.query<RevisionLineageRow>(
    `SELECT target.source_id AS target_source_id,
            assertion.report_revision_id IS NOT NULL AS assertion_exists,
            assertion.source_id AS assertion_source_id,
            replacement.report_revision_id IS NOT NULL AS replacement_exists,
            replacement.source_id AS replacement_source_id,
            replacement.supersedes_id AS replacement_supersedes_id
     FROM waspada.report_revisions AS target
     LEFT JOIN waspada.report_revisions AS assertion
       ON assertion.dataset_kind = $1 AND assertion.report_revision_id = $3
     LEFT JOIN waspada.report_revisions AS replacement
       ON replacement.dataset_kind = $1 AND replacement.report_revision_id = $4
     WHERE target.dataset_kind = $1 AND target.report_revision_id = $2`,
    [input.datasetKind, input.targetReportRevisionId, input.assertionReportRevisionId,
      input.replacementReportRevisionId],
  );
  return result.rows[0] ?? null;
}

async function findExisting(transaction: SqlExecutor, input: Snapshot): Promise<ExistingObservationRow | null> {
  const result = await transaction.query<ExistingObservationRow>(
    `SELECT observation.dataset_kind, observation.observation_id, observation.trace_id,
            observation.source_id, observation.target_report_revision_id,
            observation.assertion_report_revision_id, observation.asserted_state,
            observation.replacement_report_revision_id,
            observation.publisher_observed_at::text AS publisher_observed_at,
            observation.retrieved_at::text AS retrieved_at,
            observation.recorded_at::text AS recorded_at,
            observation.target_report_revision_id IS NOT DISTINCT FROM $3::text
              AND observation.assertion_report_revision_id IS NOT DISTINCT FROM $4::text
              AND observation.asserted_state IS NOT DISTINCT FROM $5::text
              AND observation.replacement_report_revision_id IS NOT DISTINCT FROM $6::text
              AND observation.publisher_observed_at IS NOT DISTINCT FROM $7::timestamptz
              AND observation.retrieved_at IS NOT DISTINCT FROM $8::timestamptz
              AND observation.trace_id IS NOT DISTINCT FROM $9::text AS matches
     FROM waspada.report_revision_source_observations AS observation
     WHERE observation.dataset_kind = $1 AND observation.observation_id = $2`,
    [input.datasetKind, input.observationId, input.targetReportRevisionId,
      input.assertionReportRevisionId, input.assertedState, input.replacementReportRevisionId,
      input.publisherObservedAt, input.retrievedAt, input.traceId],
  );
  return result.rows[0] ?? null;
}

function verifyReplay(row: ExistingObservationRow): ReportRevisionSourceObservationRecord {
  if (row.matches !== true) throw new ReportRevisionSourceObservationError('observation_id_reused');
  return mapObservation(row);
}

function mapObservation(row: ObservationRow): ReportRevisionSourceObservationRecord {
  return {
    datasetKind: row.dataset_kind,
    observationId: row.observation_id,
    traceId: row.trace_id,
    sourceId: row.source_id,
    targetReportRevisionId: row.target_report_revision_id,
    assertionReportRevisionId: row.assertion_report_revision_id,
    assertedState: row.asserted_state,
    replacementReportRevisionId: row.replacement_report_revision_id,
    publisherObservedAt: row.publisher_observed_at,
    retrievedAt: row.retrieved_at,
    recordedAt: row.recorded_at,
  };
}

function snapshotInput(value: unknown): Snapshot {
  if (!isRecord(value)) return invalidInput();
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || !ALLOWED_KEYS.has(key))
    || REQUIRED_KEYS.some((key) => !Object.hasOwn(value, key))) {
    return invalidInput();
  }

  const datasetKind = value.datasetKind;
  const observationId = value.observationId;
  const traceId = value.traceId;
  const targetReportRevisionId = value.targetReportRevisionId;
  const assertionReportRevisionId = value.assertionReportRevisionId;
  const assertedState = value.assertedState;
  const retrievedAt = value.retrievedAt;
  const replacementValue = Object.hasOwn(value, 'replacementReportRevisionId')
    ? value.replacementReportRevisionId : null;
  const observedValue = Object.hasOwn(value, 'publisherObservedAt') ? value.publisherObservedAt : null;

  if (typeof datasetKind !== 'string' || !DATASETS.has(datasetKind)
    || !isId(observationId) || !isId(traceId)
    || !isId(targetReportRevisionId) || !isId(assertionReportRevisionId)
    || typeof assertedState !== 'string' || !STATES.has(assertedState as ReportRevisionSourceAssertionState)
    || !isTimestamp(retrievedAt)) {
    return invalidInput();
  }

  let replacementReportRevisionId: string | null = null;
  if (replacementValue !== null) {
    if (!isId(replacementValue)) return invalidInput();
    replacementReportRevisionId = replacementValue;
  }
  if (assertedState === 'superseded') {
    if (replacementReportRevisionId === null || replacementReportRevisionId === targetReportRevisionId) {
      return invalidInput();
    }
  } else if (replacementReportRevisionId !== null) {
    return invalidInput();
  }

  let publisherObservedAt: string | null = null;
  if (observedValue !== null) {
    if (!isTimestamp(observedValue)) return invalidInput();
    publisherObservedAt = observedValue;
  }

  return {
    datasetKind: datasetKind as Snapshot['datasetKind'],
    observationId,
    traceId,
    targetReportRevisionId,
    assertionReportRevisionId,
    assertedState: assertedState as ReportRevisionSourceAssertionState,
    replacementReportRevisionId,
    publisherObservedAt,
    retrievedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = RFC3339_MICROSECOND_PATTERN.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59
    || offsetHour > 23 || offsetMinute > 59) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysByMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= daysByMonth[month - 1]! && Number.isFinite(Date.parse(value));
}

function invalidInput(): never {
  throw new ReportRevisionSourceObservationError('invalid_input');
}
