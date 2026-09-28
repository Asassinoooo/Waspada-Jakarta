import type { DatasetKind, EvidenceRelation } from './ports.js';
import type { SqlExecutor, TransactionalSqlExecutor } from './sql.js';

export const EXTRACTION_CATEGORIES = [
  'crime_personal_security',
  'demonstrations_public_gatherings',
  'crowds_major_events',
  'violence_immediate_threats',
  'disasters_weather',
  'fires_infrastructure_hazards',
  'transport_road_incidents',
  'utilities_essential_services',
  'health_environmental_advisories',
  'group_specific_critical_notices',
] as const;

export type ExtractionCategory = (typeof EXTRACTION_CATEGORIES)[number];
export type ExtractionTagNamespace = 'topic' | 'service' | 'audience' | 'hazard' | 'transport_mode' | 'place_type';
export type ExtractionTimePrecision = 'exact' | 'date' | 'range' | 'unknown';

export interface ExtractionResultEvidence {
  readonly report_revision_id: string;
  readonly permitted_text_hash: string;
  readonly span_start: number;
  readonly span_end: number;
  readonly offset_unit: 'unicode_code_points';
  readonly relation: EvidenceRelation;
}

export interface ExtractionResultTag {
  readonly namespace: ExtractionTagNamespace;
  readonly value: string;
}

export interface ExtractionResultTimeScope {
  readonly start: string | null;
  readonly end: string | null;
  readonly precision: ExtractionTimePrecision;
}

export interface ExtractionResultScope {
  readonly place_ids: readonly string[];
  readonly service_ids: readonly string[];
  readonly institution_ids: readonly string[];
  readonly audience_ids: readonly string[];
  readonly geometry_ids: readonly string[];
}

export interface ExtractionResultModelRun {
  readonly capability: 'extraction';
  readonly model_version: string;
  readonly prompt_version: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
}

/** Closed schema 2.0 storage record; provider identity is intentionally not part of this contract. */
export interface ExtractionResultRecord {
  readonly schema_version: '2.0';
  readonly trace_id: string;
  readonly record_type: 'ExtractionResult';
  readonly dataset_kind: DatasetKind;
  readonly candidate_id: string;
  readonly report_revision_id: string;
  readonly category: ExtractionCategory | null;
  readonly tags: readonly ExtractionResultTag[];
  readonly event_time: ExtractionResultTimeScope;
  readonly scope: ExtractionResultScope;
  readonly evidence: readonly ExtractionResultEvidence[];
  readonly unknown_fields: readonly string[];
  readonly model_run: ExtractionResultModelRun;
}

export interface ExtractionResultRepository {
  createOrVerify(record: ExtractionResultRecord): Promise<ExtractionResultRecord>;
}

export type ExtractionResultReferenceKind = 'trace' | 'report_revision' | 'evidence';
export type ExtractionResultReferenceFailure = 'not_found' | 'hash_mismatch';

export class ExtractionResultValidationError extends Error {
  readonly code = 'invalid_extraction_result' as const;

  constructor(path: string, reason: string) {
    super('invalid_extraction_result:' + path + ':' + reason);
    this.name = 'ExtractionResultValidationError';
  }
}

export class ExtractionResultConflictError extends Error {
  readonly code = 'extraction_result_conflict' as const;

  constructor() {
    super('extraction_result_conflict');
    this.name = 'ExtractionResultConflictError';
  }
}

export class ExtractionResultReferenceError extends Error {
  readonly code = 'extraction_result_reference_error' as const;

  constructor(
    readonly referenceKind: ExtractionResultReferenceKind,
    readonly reason: ExtractionResultReferenceFailure,
  ) {
    super('extraction_result_reference_error:' + referenceKind + ':' + reason);
    this.name = 'ExtractionResultReferenceError';
  }
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const DATASET_KINDS = new Set<DatasetKind>(['live', 'historical', 'synthetic']);
const EXTRACTION_CATEGORY_SET = new Set<ExtractionCategory>(EXTRACTION_CATEGORIES);
const EVIDENCE_RELATIONS = new Set<EvidenceRelation>(['supports', 'contradicts', 'updates', 'context']);
const TAG_NAMESPACES = new Set<ExtractionTagNamespace>([
  'topic', 'service', 'audience', 'hazard', 'transport_mode', 'place_type',
]);
const RECORD_FIELDS = [
  'schema_version', 'trace_id', 'record_type', 'dataset_kind', 'candidate_id',
  'report_revision_id', 'category', 'tags', 'event_time', 'scope', 'evidence',
  'unknown_fields', 'model_run',
] as const;
const EVIDENCE_FIELDS = [
  'report_revision_id', 'permitted_text_hash', 'span_start', 'span_end', 'offset_unit', 'relation',
] as const;
const TAG_FIELDS = ['namespace', 'value'] as const;
const TIME_FIELDS = ['start', 'end', 'precision'] as const;
const SCOPE_FIELDS = ['place_ids', 'service_ids', 'institution_ids', 'audience_ids', 'geometry_ids'] as const;
const MODEL_RUN_FIELDS = ['capability', 'model_version', 'prompt_version', 'input_tokens', 'output_tokens'] as const;
const MAX_EVIDENCE_REFERENCES = 64;
const MAX_MODEL_TOKENS_PER_CALL = 12_000;

export function createSqlExtractionResultRepository(
  executor: TransactionalSqlExecutor,
): ExtractionResultRepository {
  if (!executor || typeof executor.transaction !== 'function') {
    throw new TypeError('Extraction result persistence requires a transactional SQL executor');
  }
  return new SqlExtractionResultRepository(executor);
}

class SqlExtractionResultRepository implements ExtractionResultRepository {
  constructor(private readonly executor: TransactionalSqlExecutor) {}

  async createOrVerify(input: ExtractionResultRecord): Promise<ExtractionResultRecord> {
    const record = validateExtractionResult(input);
    return this.executor.transaction(async (transaction) => {
      if (await verifyExistingExtraction(transaction, record)) return record;

      await requireReportRevision(transaction, record);
      await requireTrace(transaction, record);
      const evidenceIds = await resolveEvidenceReferences(transaction, record);
      const inserted = await transaction.query<{ candidate_id: string }>(
        'INSERT INTO waspada.extraction_results ' +
          '(dataset_kind, candidate_id, trace_id, report_revision_id, category, record_json) ' +
          'VALUES ($1, $2, $3, $4, $5, $6::jsonb) ' +
          'ON CONFLICT (dataset_kind, candidate_id) DO NOTHING ' +
          'RETURNING candidate_id',
        extractionParameters(record),
      );
      if (!inserted.rows[0]) {
        // ON CONFLICT waits for a concurrent creator; verify its committed record and links.
        if (!await verifyExistingExtraction(transaction, record)) throw new ExtractionResultConflictError();
        return record;
      }

      for (const evidenceId of evidenceIds) {
        await transaction.query(
          'INSERT INTO waspada.extraction_evidence (dataset_kind, candidate_id, evidence_ref_id) ' +
            'VALUES ($1, $2, $3)',
          [record.dataset_kind, record.candidate_id, evidenceId],
        );
      }
      return record;
    });
  }
}

function validateExtractionResult(value: unknown): ExtractionResultRecord {
  const record = exactRecord(value, RECORD_FIELDS, 'record');
  if (record.schema_version !== '2.0') invalid('record.schema_version', 'unsupported_version');
  if (record.record_type !== 'ExtractionResult') invalid('record.record_type', 'invalid_record_type');
  const datasetKind = enumValue(record.dataset_kind, DATASET_KINDS, 'record.dataset_kind');
  const traceId = id(record.trace_id, 'record.trace_id');
  const candidateId = id(record.candidate_id, 'record.candidate_id');
  const reportRevisionId = id(record.report_revision_id, 'record.report_revision_id');
  const category = record.category === null
    ? null
    : enumValue(record.category, EXTRACTION_CATEGORY_SET, 'record.category');

  const tags = arrayValue(record.tags, 'record.tags', 100).map((entry, index) =>
    parseTag(entry, 'record.tags[' + index + ']'));
  assertUnique(tags.map((tag) => tag.namespace + ':' + tag.value), 'record.tags', 'duplicate_tag');

  const eventTime = parseTimeScope(record.event_time, 'record.event_time');
  const scope = parseScope(record.scope, 'record.scope');
  const evidence = arrayValue(record.evidence, 'record.evidence', MAX_EVIDENCE_REFERENCES)
    .map((entry, index) => parseEvidenceReference(entry, 'record.evidence[' + index + ']'));
  assertUnique(evidence.map(evidenceKey), 'record.evidence', 'duplicate_reference');
  if (evidence.some((reference) => reference.report_revision_id !== reportRevisionId)) {
    invalid('record.evidence', 'reference_revision_mismatch');
  }

  const unknownFields = uniqueStrings(record.unknown_fields, 'record.unknown_fields', 100, 500);
  if (category === null && !unknownFields.includes('category')) {
    invalid('record.category', 'missing_unknown_field_marker');
  }
  if (eventTime.precision === 'unknown' && !unknownFields.includes('event_time')) {
    invalid('record.event_time', 'missing_unknown_field_marker');
  }

  const modelRun = parseModelRun(record.model_run, 'record.model_run');
  const scopeHasValue = SCOPE_FIELDS.some((field) => scope[field].length > 0);
  const hasProposedField = category !== null || tags.length > 0
    || eventTime.precision !== 'unknown' || scopeHasValue;
  if (hasProposedField && !evidence.some((reference) => reference.relation === 'supports')) {
    invalid('record.evidence', 'proposed_fields_without_support');
  }

  return {
    schema_version: '2.0',
    trace_id: traceId,
    record_type: 'ExtractionResult',
    dataset_kind: datasetKind,
    candidate_id: candidateId,
    report_revision_id: reportRevisionId,
    category,
    tags,
    event_time: eventTime,
    scope,
    evidence,
    unknown_fields: unknownFields,
    model_run: modelRun,
  };
}

function parseEvidenceReference(value: unknown, path: string): ExtractionResultEvidence {
  const record = exactRecord(value, EVIDENCE_FIELDS, path);
  const reportRevisionId = id(record.report_revision_id, path + '.report_revision_id');
  const permittedTextHash = hash(record.permitted_text_hash, path + '.permitted_text_hash');
  const spanStart = integer(record.span_start, path + '.span_start', 0, 10_000_000);
  const spanEnd = integer(record.span_end, path + '.span_end', 1, 10_000_000);
  if (spanEnd <= spanStart) invalid(path, 'empty_or_reversed_span');
  if (record.offset_unit !== 'unicode_code_points') invalid(path + '.offset_unit', 'invalid_offset_unit');
  const relation = enumValue(record.relation, EVIDENCE_RELATIONS, path + '.relation');
  return {
    report_revision_id: reportRevisionId,
    permitted_text_hash: permittedTextHash,
    span_start: spanStart,
    span_end: spanEnd,
    offset_unit: 'unicode_code_points',
    relation,
  };
}

function parseTag(value: unknown, path: string): ExtractionResultTag {
  const record = exactRecord(value, TAG_FIELDS, path);
  const namespace = enumValue(record.namespace, TAG_NAMESPACES, path + '.namespace');
  const tagValue = boundedString(record.value, path + '.value', 64);
  if (!/^[a-z][a-z0-9_]*$/.test(tagValue)) invalid(path + '.value', 'invalid_tag');
  return { namespace, value: tagValue };
}

function parseTimeScope(value: unknown, path: string): ExtractionResultTimeScope {
  const record = exactRecord(value, TIME_FIELDS, path);
  const precision = enumValue(
    record.precision,
    new Set<ExtractionTimePrecision>(['exact', 'date', 'range', 'unknown']),
    path + '.precision',
  );
  if (precision === 'unknown') {
    if (record.start !== null || record.end !== null) invalid(path, 'unknown_time_must_be_null');
    return { start: null, end: null, precision };
  }
  if (precision === 'exact') {
    const start = nullableDateTime(record.start, path + '.start');
    const end = nullableDateTime(record.end, path + '.end');
    if (start === null) invalid(path, 'exact_start_required');
    if (end !== null && instant(end) < instant(start)) invalid(path, 'reversed_interval');
    return { start, end, precision };
  }
  if (precision === 'date') {
    const start = boundedString(record.start, path + '.start', 10);
    if (!validDateOnly(start)) invalid(path + '.start', 'invalid_date');
    const end = record.end === null ? null : boundedString(record.end, path + '.end', 10);
    if (end !== null && (!validDateOnly(end) || instant(end) < instant(start))) {
      invalid(path + '.end', 'invalid_date_or_interval');
    }
    return { start, end, precision };
  }
  const start = dateOrDateTime(record.start, path + '.start');
  const end = dateOrDateTime(record.end, path + '.end');
  if (instant(end) < instant(start)) invalid(path, 'reversed_interval');
  return { start, end, precision };
}

function parseScope(value: unknown, path: string): ExtractionResultScope {
  const record = exactRecord(value, SCOPE_FIELDS, path);
  return {
    place_ids: uniqueIds(record.place_ids, path + '.place_ids', 256),
    service_ids: uniqueIds(record.service_ids, path + '.service_ids', 256),
    institution_ids: uniqueIds(record.institution_ids, path + '.institution_ids', 256),
    audience_ids: uniqueIds(record.audience_ids, path + '.audience_ids', 256),
    geometry_ids: uniqueIds(record.geometry_ids, path + '.geometry_ids', 256),
  };
}

function parseModelRun(value: unknown, path: string): ExtractionResultModelRun {
  const record = exactRecord(value, MODEL_RUN_FIELDS, path);
  if (record.capability !== 'extraction') invalid(path + '.capability', 'invalid_capability');
  const modelVersion = boundedString(record.model_version, path + '.model_version', 200);
  const promptVersion = boundedString(record.prompt_version, path + '.prompt_version', 128);
  const inputTokens = integer(record.input_tokens, path + '.input_tokens', 0, MAX_MODEL_TOKENS_PER_CALL);
  const outputTokens = integer(record.output_tokens, path + '.output_tokens', 0, MAX_MODEL_TOKENS_PER_CALL);
  if (inputTokens + outputTokens > MAX_MODEL_TOKENS_PER_CALL) invalid(path, 'token_budget_exceeded');
  return {
    capability: 'extraction',
    model_version: modelVersion,
    prompt_version: promptVersion,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  };
}

function exactRecord(value: unknown, fields: readonly string[], path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(path, 'expected_object');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(path, 'expected_plain_object');
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) invalid(path, 'unexpected_property');
  const object = value as Record<string, unknown>;
  const expected = new Set(fields);
  for (const key of keys as string[]) {
    if (!expected.has(key)) invalid(path + '.' + key, 'unexpected_property');
  }
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(object, field)) invalid(path + '.' + field, 'missing_property');
  }
  return object;
}

function arrayValue(value: unknown, path: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value)) invalid(path, 'expected_array');
  if (value.length > maximum) invalid(path, 'too_many_items');
  return value;
}

function boundedString(value: unknown, path: string, maximumCodePoints: number, minimumCodePoints = 1): string {
  if (typeof value !== 'string') invalid(path, 'invalid_string');
  const length = Array.from(value).length;
  if (length < minimumCodePoints || length > maximumCodePoints) invalid(path, 'invalid_string');
  return value;
}

function id(value: unknown, path: string): string {
  const parsed = boundedString(value, path, 128);
  if (!ID_PATTERN.test(parsed)) invalid(path, 'invalid_id');
  return parsed;
}

function hash(value: unknown, path: string): string {
  const parsed = boundedString(value, path, 64);
  if (!HASH_PATTERN.test(parsed)) invalid(path, 'invalid_sha256');
  return parsed;
}

function integer(value: unknown, path: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalid(path, 'invalid_integer');
  }
  return value;
}

function enumValue<T extends string>(value: unknown, allowed: ReadonlySet<T>, path: string): T {
  if (typeof value !== 'string' || !allowed.has(value as T)) invalid(path, 'invalid_value');
  return value as T;
}

function uniqueIds(value: unknown, path: string, maximumItems: number): string[] {
  const values = arrayValue(value, path, maximumItems).map((entry, index) => id(entry, path + '[' + index + ']'));
  assertUnique(values, path, 'duplicate_value');
  return values;
}

function uniqueStrings(value: unknown, path: string, maximumItems: number, maximumCodePoints: number): string[] {
  const values = arrayValue(value, path, maximumItems).map((entry, index) =>
    boundedString(entry, path + '[' + index + ']', maximumCodePoints));
  assertUnique(values, path, 'duplicate_value');
  return values;
}

function assertUnique(values: readonly string[], path: string, reason: string): void {
  if (new Set(values).size !== values.length) invalid(path, reason);
}

function validDateOnly(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validDateTime(value: string): boolean {
  const match = DATETIME_PATTERN.exec(value);
  if (!match || !validDateOnly(match[1] + '-' + match[2] + '-' + match[3])) return false;
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const zone = match[7];
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (zone !== 'Z') {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }
  return Number.isFinite(Date.parse(value));
}

function nullableDateTime(value: unknown, path: string): string | null {
  if (value === null) return null;
  const parsed = boundedString(value, path, 40);
  if (!validDateTime(parsed)) invalid(path, 'invalid_datetime');
  return parsed;
}

function dateOrDateTime(value: unknown, path: string): string {
  const parsed = boundedString(value, path, 40);
  if (!validDateOnly(parsed) && !validDateTime(parsed)) invalid(path, 'invalid_date_or_datetime');
  return parsed;
}

function instant(value: string): number {
  return DATE_PATTERN.test(value) ? Date.parse(value + 'T00:00:00Z') : Date.parse(value);
}

function evidenceKey(reference: ExtractionResultEvidence): string {
  return JSON.stringify([
    reference.report_revision_id,
    reference.permitted_text_hash,
    reference.span_start,
    reference.span_end,
    reference.offset_unit,
    reference.relation,
  ]);
}

function extractionParameters(record: ExtractionResultRecord): readonly unknown[] {
  return [
    record.dataset_kind,
    record.candidate_id,
    record.trace_id,
    record.report_revision_id,
    record.category,
    JSON.stringify(record),
  ];
}

async function verifyExistingExtraction(
  executor: SqlExecutor,
  record: ExtractionResultRecord,
): Promise<boolean> {
  const parent = await executor.query<{ matches: boolean }>(
    'SELECT (stored.dataset_kind IS NOT DISTINCT FROM $1::text ' +
      'AND stored.candidate_id IS NOT DISTINCT FROM $2::text ' +
      'AND stored.trace_id IS NOT DISTINCT FROM $3::text ' +
      'AND stored.report_revision_id IS NOT DISTINCT FROM $4::text ' +
      'AND stored.category IS NOT DISTINCT FROM $5::text ' +
      'AND stored.record_json = $6::jsonb) AS matches ' +
      'FROM waspada.extraction_results AS stored ' +
      'WHERE stored.dataset_kind = $1 AND stored.candidate_id = $2',
    extractionParameters(record),
  );
  if (parent.rows.length === 0) return false;
  if (parent.rows[0]?.matches !== true) throw new ExtractionResultConflictError();

  const linkedEvidence = await executor.query<{
    dataset_kind: string;
    report_revision_id: string;
    permitted_text_hash: string;
    span_start: number;
    span_end: number;
    offset_unit: 'unicode_code_points';
    relation: EvidenceRelation;
  }>(
    'SELECT reference.dataset_kind, reference.report_revision_id, reference.permitted_text_hash, ' +
      'reference.span_start, reference.span_end, reference.offset_unit, reference.relation ' +
      'FROM waspada.extraction_evidence AS link ' +
      'JOIN waspada.evidence_references AS reference ' +
      'ON reference.dataset_kind = link.dataset_kind AND reference.evidence_ref_id = link.evidence_ref_id ' +
      'WHERE link.dataset_kind = $1 AND link.candidate_id = $2',
    [record.dataset_kind, record.candidate_id],
  );
  assertSameSet(
    record.evidence.map(evidenceKey),
    linkedEvidence.rows.map((reference) => evidenceKey({
      report_revision_id: reference.report_revision_id,
      permitted_text_hash: reference.permitted_text_hash,
      span_start: reference.span_start,
      span_end: reference.span_end,
      offset_unit: reference.offset_unit,
      relation: reference.relation,
    })),
  );
  return true;
}

async function requireTrace(executor: SqlExecutor, record: ExtractionResultRecord): Promise<void> {
  const result = await executor.query<{ trace_id: string }>(
    'SELECT trace_id FROM waspada.traces WHERE dataset_kind = $1 AND trace_id = $2',
    [record.dataset_kind, record.trace_id],
  );
  if (result.rows.length !== 1) throw new ExtractionResultReferenceError('trace', 'not_found');
}

async function requireReportRevision(executor: SqlExecutor, record: ExtractionResultRecord): Promise<void> {
  const result = await executor.query<{ permitted_text_hash: string }>(
    'SELECT permitted_text_hash FROM waspada.report_revisions ' +
      'WHERE dataset_kind = $1 AND report_revision_id = $2',
    [record.dataset_kind, record.report_revision_id],
  );
  const storedHash = result.rows[0]?.permitted_text_hash;
  if (storedHash === undefined) throw new ExtractionResultReferenceError('report_revision', 'not_found');
  if (record.evidence.some((reference) => reference.permitted_text_hash !== storedHash)) {
    throw new ExtractionResultReferenceError('report_revision', 'hash_mismatch');
  }
}

async function resolveEvidenceReferences(
  executor: SqlExecutor,
  record: ExtractionResultRecord,
): Promise<string[]> {
  const ids: string[] = [];
  for (const reference of record.evidence) {
    const result = await executor.query<{ evidence_ref_id: string }>(
      'SELECT evidence_ref_id::text AS evidence_ref_id FROM waspada.evidence_references ' +
        'WHERE dataset_kind = $1 AND report_revision_id = $2 AND permitted_text_hash = $3 ' +
        'AND span_start = $4 AND span_end = $5 AND offset_unit = $6 AND relation = $7',
      [
        record.dataset_kind,
        reference.report_revision_id,
        reference.permitted_text_hash,
        reference.span_start,
        reference.span_end,
        reference.offset_unit,
        reference.relation,
      ],
    );
    if (result.rows.length !== 1) throw new ExtractionResultReferenceError('evidence', 'not_found');
    ids.push(result.rows[0]!.evidence_ref_id);
  }
  return ids;
}

function assertSameSet(expected: readonly string[], actual: readonly string[]): void {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  if (expected.length !== actual.length || expectedSet.size !== expected.length
    || actualSet.size !== actual.length
    || [...expectedSet].some((value) => !actualSet.has(value))) {
    throw new ExtractionResultConflictError();
  }
}

function invalid(path: string, reason: string): never {
  throw new ExtractionResultValidationError(path, reason);
}
