import type { SqlExecutor } from './sql.js';

export type PublicScopeEntityType = 'place' | 'service' | 'institution' | 'audience';

export interface PublicScopeNameKey {
  readonly entityType: PublicScopeEntityType;
  readonly entityId: string;
}

export interface PublicSupportingEvidenceKey {
  readonly reportRevisionId: string;
  readonly permittedTextHash: string;
  readonly spanStart: number;
  readonly spanEnd: number;
  readonly offsetUnit: 'unicode_code_points';
  readonly relation: 'supports';
}

export interface PublicProjectionLookupQuery {
  readonly scopeKeys: readonly PublicScopeNameKey[];
  readonly supportReferences: readonly PublicSupportingEvidenceKey[];
}

export interface PublicScopeNameLookup {
  readonly entity_type: PublicScopeEntityType;
  readonly id: string;
  readonly display_name: string;
}

export interface PublicSourceAttributionLookup {
  readonly dataset_kind: 'live';
  readonly report_revision_id: string;
  readonly permitted_text_hash: string;
  readonly span_start: number;
  readonly span_end: number;
  readonly offset_unit: 'unicode_code_points';
  readonly relation: 'supports';
  readonly public_use_approved: true;
  readonly display_name: string;
  readonly url: string;
  readonly published_at: string | null;
  readonly observed_at: string | null;
  readonly excerpt_public_use_approved: false;
  readonly excerpt: null;
}

export interface PublicProjectionLookupResult {
  readonly scopeNames: readonly PublicScopeNameLookup[];
  readonly publicAttributions: readonly PublicSourceAttributionLookup[];
}

export interface PublicProjectionLookupRepository {
  /** Resolves only caller-requested exact keys. Missing or withdrawn keys are omitted. */
  resolve(input: unknown): Promise<PublicProjectionLookupResult>;
}

export const PUBLIC_PROJECTION_LOOKUP_LIMITS = Object.freeze({
  scopeKeys: 100,
  supportReferences: 100,
  identifierLength: 200,
});

export type PublicProjectionLookupErrorCode = 'INVALID_QUERY' | 'QUERY_LIMIT_EXCEEDED' | 'LOOKUP_RESULT_INVALID';

const errorMessages: Record<PublicProjectionLookupErrorCode, string> = {
  INVALID_QUERY: 'The public lookup query is invalid.',
  QUERY_LIMIT_EXCEEDED: 'The public lookup query exceeds its limit.',
  LOOKUP_RESULT_INVALID: 'A public lookup result could not be validated.',
};

/** A bounded error that never includes a lookup key or database value. */
export class PublicProjectionLookupError extends Error {
  constructor(readonly code: PublicProjectionLookupErrorCode) {
    super(errorMessages[code]);
    this.name = 'PublicProjectionLookupError';
  }
}

interface ScopeNameRow {
  readonly entity_type: unknown;
  readonly id: unknown;
  readonly display_name: unknown;
}

interface SourceAttributionRow {
  readonly dataset_kind: unknown;
  readonly report_revision_id: unknown;
  readonly permitted_text_hash: unknown;
  readonly span_start: unknown;
  readonly span_end: unknown;
  readonly offset_unit: unknown;
  readonly relation: unknown;
  readonly public_use_approved: unknown;
  readonly display_name: unknown;
  readonly url: unknown;
  readonly published_at: unknown;
  readonly observed_at: unknown;
  readonly excerpt_public_use_approved: unknown;
  readonly excerpt: unknown;
}

const scopeEntityTypes = new Set<PublicScopeEntityType>(['place', 'service', 'institution', 'audience']);
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const hashPattern = /^[a-f0-9]{64}$/u;
const dateTimePattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/u;

export function createPublicProjectionLookupRepository(
  executor: SqlExecutor,
): PublicProjectionLookupRepository {
  return {
    async resolve(input: unknown): Promise<PublicProjectionLookupResult> {
      const query = validateQuery(input);
      const [scopeNames, publicAttributions] = await Promise.all([
        query.scopeKeys.length === 0 ? Promise.resolve([]) : readScopeNames(executor, query.scopeKeys),
        query.supportReferences.length === 0
          ? Promise.resolve([])
          : readSourceAttributions(executor, query.supportReferences),
      ]);
      return { scopeNames, publicAttributions };
    },
  };
}

function validateQuery(value: unknown): PublicProjectionLookupQuery {
  if (!isRecord(value) || !hasExactKeys(value, ['scopeKeys', 'supportReferences'])
    || !Array.isArray(value.scopeKeys) || !Array.isArray(value.supportReferences)) {
    fail('INVALID_QUERY');
  }
  if (value.scopeKeys.length > PUBLIC_PROJECTION_LOOKUP_LIMITS.scopeKeys
    || value.supportReferences.length > PUBLIC_PROJECTION_LOOKUP_LIMITS.supportReferences) {
    fail('QUERY_LIMIT_EXCEEDED');
  }

  const scopeKeys = value.scopeKeys.map(validateScopeKey);
  const supportReferences = value.supportReferences.map(validateSupportReference);
  if (new Set(scopeKeys.map(scopeKey)).size !== scopeKeys.length
    || new Set(supportReferences.map(supportKey)).size !== supportReferences.length) {
    fail('INVALID_QUERY');
  }
  return { scopeKeys, supportReferences };
}

function validateScopeKey(value: unknown): PublicScopeNameKey {
  if (!isRecord(value) || !hasExactKeys(value, ['entityType', 'entityId'])
    || typeof value.entityType !== 'string' || !scopeEntityTypes.has(value.entityType as PublicScopeEntityType)
    || !isIdentifier(value.entityId)) {
    fail('INVALID_QUERY');
  }
  return { entityType: value.entityType as PublicScopeEntityType, entityId: value.entityId };
}

function validateSupportReference(value: unknown): PublicSupportingEvidenceKey {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      'reportRevisionId', 'permittedTextHash', 'spanStart', 'spanEnd', 'offsetUnit', 'relation',
    ])
    || !isIdentifier(value.reportRevisionId)
    || typeof value.permittedTextHash !== 'string' || !hashPattern.test(value.permittedTextHash)
    || !isSafeInteger(value.spanStart, 0, 10_000_000)
    || !isSafeInteger(value.spanEnd, 1, 10_000_000)
    || value.spanEnd <= value.spanStart
    || value.offsetUnit !== 'unicode_code_points'
    || value.relation !== 'supports') {
    fail('INVALID_QUERY');
  }
  return {
    reportRevisionId: value.reportRevisionId,
    permittedTextHash: value.permittedTextHash,
    spanStart: value.spanStart,
    spanEnd: value.spanEnd,
    offsetUnit: 'unicode_code_points',
    relation: 'supports',
  };
}

async function readScopeNames(
  executor: SqlExecutor,
  keys: readonly PublicScopeNameKey[],
): Promise<PublicScopeNameLookup[]> {
  const result = await executor.query<ScopeNameRow>(
    `SELECT names.entity_type, names.id, names.display_name
     FROM waspada.public_scope_names AS names
     JOIN unnest($1::text[], $2::text[]) AS requested(entity_type, entity_id)
       ON requested.entity_type = names.entity_type AND requested.entity_id = names.id
     ORDER BY names.entity_type, names.id`,
    [keys.map(({ entityType }) => entityType), keys.map(({ entityId }) => entityId)],
  );

  const requested = new Set(keys.map(scopeKey));
  const seen = new Set<string>();
  const rows: PublicScopeNameLookup[] = [];
  for (const row of result.rows) {
    if (typeof row.entity_type !== 'string' || !scopeEntityTypes.has(row.entity_type as PublicScopeEntityType)
      || !isIdentifier(row.id) || !isDisplayName(row.display_name)) {
      fail('LOOKUP_RESULT_INVALID');
    }
    const key = scopeKey({ entityType: row.entity_type as PublicScopeEntityType, entityId: row.id });
    if (!requested.has(key) || seen.has(key)) fail('LOOKUP_RESULT_INVALID');
    seen.add(key);
    rows.push({ entity_type: row.entity_type as PublicScopeEntityType, id: row.id, display_name: row.display_name });
  }
  rows.sort((left, right) => compareStrings(left.entity_type, right.entity_type) || compareStrings(left.id, right.id));
  return rows;
}

async function readSourceAttributions(
  executor: SqlExecutor,
  keys: readonly PublicSupportingEvidenceKey[],
): Promise<PublicSourceAttributionLookup[]> {
  const result = await executor.query<SourceAttributionRow>(
    `SELECT attribution.dataset_kind, attribution.report_revision_id,
            attribution.permitted_text_hash, attribution.span_start, attribution.span_end,
            attribution.offset_unit, attribution.relation, attribution.public_use_approved,
            attribution.display_name, attribution.url, attribution.published_at,
            attribution.observed_at, attribution.excerpt_public_use_approved, attribution.excerpt
     FROM waspada.public_source_attributions AS attribution
     JOIN unnest($1::text[], $2::text[], $3::integer[], $4::integer[])
       AS requested(report_revision_id, permitted_text_hash, span_start, span_end)
       ON requested.report_revision_id = attribution.report_revision_id
      AND requested.permitted_text_hash = attribution.permitted_text_hash
      AND requested.span_start = attribution.span_start
      AND requested.span_end = attribution.span_end
     WHERE attribution.dataset_kind = 'live'
       AND attribution.offset_unit = 'unicode_code_points'
       AND attribution.relation = 'supports'
     ORDER BY attribution.report_revision_id, attribution.permitted_text_hash,
              attribution.span_start, attribution.span_end`,
    [
      keys.map(({ reportRevisionId }) => reportRevisionId),
      keys.map(({ permittedTextHash }) => permittedTextHash),
      keys.map(({ spanStart }) => spanStart),
      keys.map(({ spanEnd }) => spanEnd),
    ],
  );

  const requested = new Set(keys.map(supportKey));
  const seen = new Set<string>();
  const rows: PublicSourceAttributionLookup[] = [];
  for (const row of result.rows) {
    if (row.dataset_kind !== 'live'
      || !isIdentifier(row.report_revision_id)
      || typeof row.permitted_text_hash !== 'string' || !hashPattern.test(row.permitted_text_hash)
      || !isSafeInteger(row.span_start, 0, 10_000_000)
      || !isSafeInteger(row.span_end, 1, 10_000_000)
      || row.span_end <= row.span_start
      || row.offset_unit !== 'unicode_code_points' || row.relation !== 'supports'
      || row.public_use_approved !== true
      || !isDisplayName(row.display_name)
      || !isHttpsUrl(row.url)
      || !isOptionalDateTime(row.published_at) || !isOptionalDateTime(row.observed_at)
      || row.excerpt_public_use_approved !== false || row.excerpt !== null) {
      fail('LOOKUP_RESULT_INVALID');
    }
    const key: PublicSupportingEvidenceKey = {
      reportRevisionId: row.report_revision_id,
      permittedTextHash: row.permitted_text_hash,
      spanStart: row.span_start,
      spanEnd: row.span_end,
      offsetUnit: 'unicode_code_points',
      relation: 'supports',
    };
    const identity = supportKey(key);
    if (!requested.has(identity) || seen.has(identity)) fail('LOOKUP_RESULT_INVALID');
    seen.add(identity);
    rows.push({
      dataset_kind: 'live',
      report_revision_id: row.report_revision_id,
      permitted_text_hash: row.permitted_text_hash,
      span_start: row.span_start,
      span_end: row.span_end,
      offset_unit: 'unicode_code_points',
      relation: 'supports',
      public_use_approved: true,
      display_name: row.display_name,
      url: row.url,
      published_at: row.published_at,
      observed_at: row.observed_at,
      excerpt_public_use_approved: false,
      excerpt: null,
    });
  }
  rows.sort((left, right) => compareStrings(left.report_revision_id, right.report_revision_id)
    || compareStrings(left.permitted_text_hash, right.permitted_text_hash)
    || left.span_start - right.span_start
    || left.span_end - right.span_end);
  return rows;
}

function scopeKey(value: PublicScopeNameKey): string {
  return JSON.stringify([value.entityType, value.entityId]);
}

function supportKey(value: PublicSupportingEvidenceKey): string {
  return JSON.stringify([
    value.reportRevisionId, value.permittedTextHash, value.spanStart, value.spanEnd,
    value.offsetUnit, value.relation,
  ]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= PUBLIC_PROJECTION_LOOKUP_LIMITS.identifierLength
    && identifierPattern.test(value);
}

function isSafeInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function isDisplayName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && Array.from(value).length <= 200
    && value.trim() === value;
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048 || value.trim() !== value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.hostname.length > 0
      && parsed.username.length === 0 && parsed.password.length === 0;
  } catch {
    return false;
  }
}

function isOptionalDateTime(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== 'string') return false;
  const match = dateTimePattern.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)
    || hour > 23 || minute > 59 || second > 59) return false;
  if (match[7] !== undefined && (Number(match[8]) > 23 || Number(match[9]) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code: PublicProjectionLookupErrorCode): never {
  throw new PublicProjectionLookupError(code);
}
