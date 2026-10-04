import type { SqlExecutor } from './sql.js';

export type ReportRevisionImpactDatasetKind = 'live' | 'historical' | 'synthetic';
export type ReportRevisionImpactTargetKind = 'event_claim_set' | 'impact';

export type ReportRevisionImpactTargetIdentity =
  | { readonly kind: 'event_claim_set' }
  | { readonly kind: 'impact'; readonly impactId: string; readonly impactVersion: number };

export interface ReportRevisionImpactCursor {
  readonly eventId: string;
  readonly eventVersion: number;
  readonly target: ReportRevisionImpactTargetIdentity;
}

export interface ReadReportRevisionImpactTargetsRequest {
  readonly datasetKind: ReportRevisionImpactDatasetKind;
  readonly reportRevisionId: string;
  readonly limit: number;
  readonly cursor?: ReportRevisionImpactCursor | null;
}

export interface ReportRevisionImpactTarget extends ReportRevisionImpactCursor {
  readonly datasetKind: ReportRevisionImpactDatasetKind;
}

export interface ReportRevisionImpactTargetPage {
  readonly targets: readonly ReportRevisionImpactTarget[];
  readonly nextCursor: ReportRevisionImpactCursor | null;
}

export interface ReportRevisionImpactTargetReader {
  read(request: unknown): Promise<ReportRevisionImpactTargetPage>;
}

export type ReportRevisionImpactReaderErrorCode = 'INVALID_REQUEST' | 'INVALID_RESULT' | 'READ_FAILED';

const errorMessages: Record<ReportRevisionImpactReaderErrorCode, string> = {
  INVALID_REQUEST: 'The report-revision impact request is invalid.',
  INVALID_RESULT: 'The report-revision impact page could not be validated.',
  READ_FAILED: 'The report-revision impact page could not be read.',
};

export class ReportRevisionImpactReaderError extends Error {
  constructor(readonly code: ReportRevisionImpactReaderErrorCode) {
    super(errorMessages[code]);
    this.name = 'ReportRevisionImpactReaderError';
  }
}

interface TargetRow {
  readonly dataset_kind: unknown;
  readonly event_id: unknown;
  readonly event_version: unknown;
  readonly target_kind: unknown;
  readonly impact_id: unknown;
  readonly impact_version: unknown;
}

interface ValidatedRequest {
  readonly datasetKind: ReportRevisionImpactDatasetKind;
  readonly reportRevisionId: string;
  readonly limit: number;
  readonly cursor: ReportRevisionImpactCursor | null;
}

interface ValidatedTarget {
  readonly target: ReportRevisionImpactTarget;
  readonly key: readonly [string, number, string, string, number];
}

const DATASETS = new Set<ReportRevisionImpactDatasetKind>(['live', 'historical', 'synthetic']);
const TARGET_KINDS = new Set<ReportRevisionImpactTargetKind>(['event_claim_set', 'impact']);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_DATABASE_INTEGER = 2_147_483_647;
const MAX_PAGE_SIZE = 100;
const REQUIRED_REQUEST_KEYS = ['datasetKind', 'reportRevisionId', 'limit'] as const;
const ALLOWED_REQUEST_KEYS = new Set<string>([...REQUIRED_REQUEST_KEYS, 'cursor']);

export function createReportRevisionImpactTargetReader(
  executor: SqlExecutor,
): ReportRevisionImpactTargetReader {
  if (!executor || typeof executor.query !== 'function') {
    throw new TypeError('Report-revision impact reading requires a SQL executor');
  }

  return {
    async read(request: unknown): Promise<ReportRevisionImpactTargetPage> {
      const options = validateRequest(request);
      const query = buildQuery(options, options.limit + 1);

      let rawRows: unknown;
      try {
        const result: unknown = await executor.query<TargetRow>(query.statement, query.parameters);
        rawRows = isObject(result) ? result.rows : undefined;
      } catch {
        throw new ReportRevisionImpactReaderError('READ_FAILED');
      }

      const rows = validateRows(rawRows, options);
      const hasMore = rows.length > options.limit;
      if (hasMore) rows.length = options.limit;
      const last = rows.at(-1)?.target;

      return {
        targets: rows.map(({ target }) => target),
        nextCursor: hasMore && last !== undefined ? cursorFromTarget(last) : null,
      };
    },
  };
}

function buildQuery(options: ValidatedRequest, probeLimit: number): {
  readonly statement: string;
  readonly parameters: readonly unknown[];
} {
  const parameters: unknown[] = [
    options.datasetKind,
    options.reportRevisionId,
    options.cursor !== null,
    options.cursor?.eventId ?? null,
    options.cursor?.eventVersion ?? null,
    options.cursor?.target.kind ?? null,
    options.cursor?.target.kind === 'impact' ? options.cursor.target.impactId : null,
    options.cursor?.target.kind === 'impact' ? options.cursor.target.impactVersion : null,
    probeLimit,
  ];

  return {
    statement: `
      WITH current_events AS (
        SELECT event.dataset_kind, event.event_id, event.version AS event_version
        FROM waspada.event_versions AS event
        WHERE event.dataset_kind = $1::text
          AND event.publication_status = 'published'
          AND NOT EXISTS (
            SELECT 1
            FROM waspada.event_versions AS newer
            WHERE newer.dataset_kind = event.dataset_kind
              AND newer.event_id = event.event_id
              AND newer.version > event.version
          )
      ),
      matched_claims AS (
        SELECT DISTINCT current.dataset_kind, current.event_id, current.event_version,
               claim_evidence.claim_id
        FROM current_events AS current
        JOIN waspada.event_claim_evidence AS claim_evidence
          ON claim_evidence.dataset_kind = current.dataset_kind
         AND claim_evidence.event_id = current.event_id
         AND claim_evidence.event_version = current.event_version
        JOIN waspada.evidence_references AS evidence
          ON evidence.dataset_kind = claim_evidence.dataset_kind
         AND evidence.evidence_ref_id = claim_evidence.evidence_ref_id
        WHERE claim_evidence.evidence_kind = 'support'
          AND evidence.relation = 'supports'
          AND evidence.report_revision_id = $2::text
      ),
      event_targets AS (
        SELECT matched.dataset_kind, matched.event_id, matched.event_version,
               'event_claim_set'::text AS target_kind,
               NULL::text AS impact_id, NULL::integer AS impact_version
        FROM matched_claims AS matched
        GROUP BY matched.dataset_kind, matched.event_id, matched.event_version
      ),
      impact_targets AS (
        SELECT DISTINCT matched.dataset_kind, matched.event_id, matched.event_version,
               'impact'::text AS target_kind,
               reference.impact_id, reference.impact_version
        FROM matched_claims AS matched
        JOIN waspada.event_impact_refs AS reference
          ON reference.dataset_kind = matched.dataset_kind
         AND reference.event_id = matched.event_id
         AND reference.event_version = matched.event_version
        JOIN waspada.impact_claim_support AS impact_support
          ON impact_support.dataset_kind = reference.dataset_kind
         AND impact_support.impact_id = reference.impact_id
         AND impact_support.impact_version = reference.impact_version
         AND impact_support.event_id = reference.event_id
         AND impact_support.event_version = reference.event_version
         AND impact_support.claim_id = matched.claim_id
      ),
      targets AS (
        SELECT * FROM event_targets
        UNION ALL
        SELECT * FROM impact_targets
      )
      SELECT target.dataset_kind, target.event_id, target.event_version,
             target.target_kind, target.impact_id, target.impact_version
      FROM targets AS target
      WHERE NOT $3::boolean OR ROW(
          target.event_id COLLATE "C", target.event_version,
          target.target_kind COLLATE "C", COALESCE(target.impact_id, '') COLLATE "C",
          COALESCE(target.impact_version, 0)
        ) > ROW(
          $4::text COLLATE "C", $5::integer, $6::text COLLATE "C",
          COALESCE($7::text, '') COLLATE "C", COALESCE($8::integer, 0)
        )
      ORDER BY target.event_id COLLATE "C" ASC, target.event_version ASC,
               target.target_kind COLLATE "C" ASC,
               COALESCE(target.impact_id, '') COLLATE "C" ASC,
               COALESCE(target.impact_version, 0) ASC
      LIMIT $9::integer
    `,
    parameters,
  };
}

function validateRequest(value: unknown): ValidatedRequest {
  if (!isObject(value)) return invalidRequest();
  const keys = Object.keys(value);
  if (keys.some((key) => !ALLOWED_REQUEST_KEYS.has(key))
    || REQUIRED_REQUEST_KEYS.some((key) => !(key in value))) {
    return invalidRequest();
  }
  if (typeof value.datasetKind !== 'string'
    || !DATASETS.has(value.datasetKind as ReportRevisionImpactDatasetKind)
    || !isId(value.reportRevisionId)) {
    return invalidRequest();
  }
  if (!Number.isSafeInteger(value.limit)
    || (value.limit as number) < 1
    || (value.limit as number) > MAX_PAGE_SIZE) {
    return invalidRequest();
  }

  let cursor: ReportRevisionImpactCursor | null = null;
  if ('cursor' in value) {
    if (value.cursor !== null) cursor = validateCursor(value.cursor);
    if (value.cursor !== null && cursor === null) return invalidRequest();
  }

  return {
    datasetKind: value.datasetKind as ReportRevisionImpactDatasetKind,
    reportRevisionId: value.reportRevisionId,
    limit: value.limit as number,
    cursor,
  };
}

function validateCursor(value: unknown): ReportRevisionImpactCursor | null {
  if (!isObject(value)
    || !hasExactKeys(value, ['eventId', 'eventVersion', 'target'])
    || !isId(value.eventId)
    || !isPositiveDatabaseInteger(value.eventVersion)) {
    return null;
  }
  const target = validateTargetIdentity(value.target);
  return target === null ? null : { eventId: value.eventId, eventVersion: value.eventVersion, target };
}

function validateTargetIdentity(value: unknown): ReportRevisionImpactTargetIdentity | null {
  if (!isObject(value) || typeof value.kind !== 'string'
    || !TARGET_KINDS.has(value.kind as ReportRevisionImpactTargetKind)) {
    return null;
  }
  if (value.kind === 'event_claim_set' && hasExactKeys(value, ['kind'])) {
    return { kind: 'event_claim_set' };
  }
  if (value.kind === 'impact' && hasExactKeys(value, ['kind', 'impactId', 'impactVersion'])
    && isId(value.impactId)
    && isPositiveDatabaseInteger(value.impactVersion)) {
    return { kind: 'impact', impactId: value.impactId, impactVersion: value.impactVersion };
  }
  return null;
}

function validateRows(rows: unknown, request: ValidatedRequest): ValidatedTarget[] {
  if (!Array.isArray(rows) || rows.length > request.limit + 1) return invalidResult();
  const validated: ValidatedTarget[] = [];
  let previousKey: readonly [string, number, string, string, number] | null = null;
  const cursorKey = request.cursor === null ? null : keyFromCursor(request.cursor);

  for (const row of rows) {
    if (!isObject(row)
      || row.dataset_kind !== request.datasetKind
      || !isId(row.event_id)
      || !isPositiveDatabaseInteger(row.event_version)
      || typeof row.target_kind !== 'string'
      || !TARGET_KINDS.has(row.target_kind as ReportRevisionImpactTargetKind)) {
      return invalidResult();
    }

    let target: ReportRevisionImpactTargetIdentity;
    if (row.target_kind === 'event_claim_set') {
      if (row.impact_id !== null || row.impact_version !== null) return invalidResult();
      target = { kind: 'event_claim_set' };
    } else {
      if (!isId(row.impact_id) || !isPositiveDatabaseInteger(row.impact_version)) return invalidResult();
      target = {
        kind: 'impact',
        impactId: row.impact_id,
        impactVersion: row.impact_version as number,
      };
    }

    const record: ReportRevisionImpactTarget = {
      datasetKind: request.datasetKind,
      eventId: row.event_id,
      eventVersion: row.event_version as number,
      target,
    };
    const key = keyFromTarget(record);
    if ((previousKey !== null && compareKeys(key, previousKey) <= 0)
      || (cursorKey !== null && compareKeys(key, cursorKey) <= 0)) {
      return invalidResult();
    }
    previousKey = key;
    validated.push({ target: record, key });
  }

  return validated;
}

function cursorFromTarget(target: ReportRevisionImpactTarget): ReportRevisionImpactCursor {
  return { eventId: target.eventId, eventVersion: target.eventVersion, target: target.target };
}

function keyFromCursor(cursor: ReportRevisionImpactCursor): readonly [string, number, string, string, number] {
  return [
    cursor.eventId,
    cursor.eventVersion,
    cursor.target.kind,
    cursor.target.kind === 'impact' ? cursor.target.impactId : '',
    cursor.target.kind === 'impact' ? cursor.target.impactVersion : 0,
  ];
}

function keyFromTarget(
  target: ReportRevisionImpactTarget,
): readonly [string, number, string, string, number] {
  return keyFromCursor(target);
}

function compareKeys(
  left: readonly [string, number, string, string, number],
  right: readonly [string, number, string, string, number],
): number {
  const eventIdOrder = compareStrings(left[0], right[0]);
  if (eventIdOrder !== 0) return eventIdOrder;
  if (left[1] !== right[1]) return left[1] < right[1] ? -1 : 1;
  const kindOrder = compareStrings(left[2], right[2]);
  if (kindOrder !== 0) return kindOrder;
  const impactIdOrder = compareStrings(left[3], right[3]);
  if (impactIdOrder !== 0) return impactIdOrder;
  return left[4] === right[4] ? 0 : left[4] < right[4] ? -1 : 1;
}

function compareStrings(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).length === expected.size && Object.keys(value).every((key) => expected.has(key));
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function isPositiveDatabaseInteger(value: unknown): value is number {
  return Number.isSafeInteger(value)
    && (value as number) > 0
    && (value as number) <= MAX_DATABASE_INTEGER;
}

function invalidRequest(): never {
  throw new ReportRevisionImpactReaderError('INVALID_REQUEST');
}

function invalidResult(): never {
  throw new ReportRevisionImpactReaderError('INVALID_RESULT');
}
