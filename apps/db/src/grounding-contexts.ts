import type { DatasetKind, EvidenceRelation, RevisionStatus } from './ports.js';
import type { SqlExecutor, TransactionalSqlExecutor } from './sql.js';

export interface GroundingEvidenceReference {
  readonly report_revision_id: string;
  readonly permitted_text_hash: string;
  readonly span_start: number;
  readonly span_end: number;
  readonly offset_unit: 'unicode_code_points';
  readonly relation: EvidenceRelation;
}

export interface GroundingRevisionState {
  readonly report_revision_id: string;
  readonly revision_status: RevisionStatus;
}

export interface GroundingCandidateEvent {
  readonly event_id: string;
  readonly event_version: number;
}

/** The exact schema 2.0 storage record; it intentionally contains no retrieved excerpt text. */
export interface GroundingContextRecord {
  readonly schema_version: '2.0';
  readonly trace_id: string;
  readonly record_type: 'GroundingContext';
  readonly dataset_kind: DatasetKind;
  readonly context_id: string;
  readonly candidate_id: string;
  readonly evidence: readonly GroundingEvidenceReference[];
  readonly revision_states: readonly GroundingRevisionState[];
  readonly candidate_events: readonly GroundingCandidateEvent[];
  readonly prior_decision_ids: readonly string[];
  readonly missing_fields: readonly string[];
  readonly conflicts: readonly string[];
  readonly retrieval_version: string;
  readonly index_version: string;
  readonly sufficient: boolean;
}

export interface GroundingContextRepository {
  createOrVerify(record: GroundingContextRecord): Promise<GroundingContextRecord>;
}

export type GroundingContextReferenceKind = 'evidence' | 'candidate_event' | 'prior_decision';

export class GroundingContextValidationError extends Error {
  readonly code = 'invalid_grounding_context' as const;

  constructor(path: string, reason: string) {
    super('invalid_grounding_context:' + path + ':' + reason);
    this.name = 'GroundingContextValidationError';
  }
}

export class GroundingContextConflictError extends Error {
  readonly code = 'grounding_context_conflict' as const;

  constructor() {
    super('grounding_context_conflict');
    this.name = 'GroundingContextConflictError';
  }
}

export class GroundingContextReferenceError extends Error {
  readonly code = 'grounding_context_reference_not_found' as const;

  constructor(readonly referenceKind: GroundingContextReferenceKind) {
    super('grounding_context_reference_not_found:' + referenceKind);
    this.name = 'GroundingContextReferenceError';
  }
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const DATASET_KINDS = new Set<DatasetKind>(['live', 'historical', 'synthetic']);
const EVIDENCE_RELATIONS = new Set<EvidenceRelation>(['supports', 'contradicts', 'updates', 'context']);
const REVISION_STATUSES = new Set<RevisionStatus>([
  'unreviewed', 'eligible', 'quarantined', 'superseded', 'retracted',
]);
const CONTEXT_FIELDS = [
  'schema_version',
  'trace_id',
  'record_type',
  'dataset_kind',
  'context_id',
  'candidate_id',
  'evidence',
  'revision_states',
  'candidate_events',
  'prior_decision_ids',
  'missing_fields',
  'conflicts',
  'retrieval_version',
  'index_version',
  'sufficient',
] as const;
const EVIDENCE_FIELDS = [
  'report_revision_id', 'permitted_text_hash', 'span_start', 'span_end', 'offset_unit', 'relation',
] as const;
const REVISION_STATE_FIELDS = ['report_revision_id', 'revision_status'] as const;
const CANDIDATE_EVENT_FIELDS = ['event_id', 'event_version'] as const;

export function createSqlGroundingContextRepository(
  executor: TransactionalSqlExecutor,
): GroundingContextRepository {
  if (!executor || typeof executor.transaction !== 'function') {
    throw new TypeError('Grounding context persistence requires a transactional SQL executor');
  }
  return new SqlGroundingContextRepository(executor);
}

class SqlGroundingContextRepository implements GroundingContextRepository {
  constructor(private readonly executor: TransactionalSqlExecutor) {}

  async createOrVerify(input: GroundingContextRecord): Promise<GroundingContextRecord> {
    const record = validateGroundingContext(input);
    return this.executor.transaction(async (transaction) => {
      const existingMatches = await verifyExistingContext(transaction, record);
      if (existingMatches) return record;

      const evidenceIds = await resolveEvidenceReferences(transaction, record);
      await requireCandidateEvents(transaction, record);
      await requirePriorDecisions(transaction, record);

      const inserted = await transaction.query<{ context_id: string }>(
        'INSERT INTO waspada.grounding_contexts ' +
          '(dataset_kind, context_id, trace_id, candidate_id, retrieval_version, index_version, sufficient, record_json) ' +
          'VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) ' +
          'ON CONFLICT (dataset_kind, context_id) DO NOTHING ' +
          'RETURNING context_id',
        contextParameters(record),
      );
      if (!inserted.rows[0]) {
        // A concurrent creator won the unique-key race. Its transaction is
        // committed before ON CONFLICT returns, so verify its complete result.
        if (!await verifyExistingContext(transaction, record)) throw new GroundingContextConflictError();
        return record;
      }

      for (const evidenceRefId of evidenceIds) {
        await transaction.query(
          'INSERT INTO waspada.grounding_evidence (dataset_kind, context_id, evidence_ref_id) ' +
            'VALUES ($1, $2, $3)',
          [record.dataset_kind, record.context_id, evidenceRefId],
        );
      }
      for (const candidateEvent of record.candidate_events) {
        await transaction.query(
          'INSERT INTO waspada.grounding_candidate_events ' +
            '(dataset_kind, context_id, event_id, event_version) VALUES ($1, $2, $3, $4)',
          [record.dataset_kind, record.context_id, candidateEvent.event_id, candidateEvent.event_version],
        );
      }
      for (const decisionId of record.prior_decision_ids) {
        await transaction.query(
          'INSERT INTO waspada.grounding_prior_decisions (dataset_kind, context_id, decision_id) ' +
            'VALUES ($1, $2, $3)',
          [record.dataset_kind, record.context_id, decisionId],
        );
      }
      return record;
    });
  }
}

function validateGroundingContext(value: unknown): GroundingContextRecord {
  const record = exactRecord(value, CONTEXT_FIELDS, 'context');
  if (record.schema_version !== '2.0') invalid('context.schema_version', 'unsupported_version');
  if (record.record_type !== 'GroundingContext') invalid('context.record_type', 'invalid_record_type');
  const datasetKind = record.dataset_kind;
  if (typeof datasetKind !== 'string' || !DATASET_KINDS.has(datasetKind as DatasetKind)) {
    invalid('context.dataset_kind', 'invalid_dataset_kind');
  }
  const traceId = id(record.trace_id, 'context.trace_id');
  const contextId = id(record.context_id, 'context.context_id');
  const candidateId = id(record.candidate_id, 'context.candidate_id');
  const evidence = arrayValue(record.evidence, 'context.evidence')
    .map((entry, index) => parseEvidenceReference(entry, 'context.evidence[' + index + ']'));
  if (evidence.length > 8) invalid('context.evidence', 'too_many_items');
  assertUnique(evidence.map(evidenceKey), 'context.evidence', 'duplicate_reference');
  const revisionStates = arrayValue(record.revision_states, 'context.revision_states')
    .map((entry, index) => parseRevisionState(entry, 'context.revision_states[' + index + ']'));
  assertUnique(revisionStates.map((state) => state.report_revision_id),
    'context.revision_states', 'duplicate_revision');
  const candidateEvents = arrayValue(record.candidate_events, 'context.candidate_events')
    .map((entry, index) => parseCandidateEvent(entry, 'context.candidate_events[' + index + ']'));
  assertUnique(candidateEvents.map(candidateEventKey),
    'context.candidate_events', 'duplicate_event_link');
  const priorDecisionIds = uniqueIds(record.prior_decision_ids, 'context.prior_decision_ids');
  const missingFields = uniqueStrings(record.missing_fields, 'context.missing_fields');
  const conflicts = uniqueStrings(record.conflicts, 'context.conflicts');
  const retrievalVersion = id(record.retrieval_version, 'context.retrieval_version');
  const indexVersion = id(record.index_version, 'context.index_version');
  if (typeof record.sufficient !== 'boolean') invalid('context.sufficient', 'invalid_boolean');

  return {
    schema_version: '2.0',
    trace_id: traceId,
    record_type: 'GroundingContext',
    dataset_kind: datasetKind as DatasetKind,
    context_id: contextId,
    candidate_id: candidateId,
    evidence,
    revision_states: revisionStates,
    candidate_events: candidateEvents,
    prior_decision_ids: priorDecisionIds,
    missing_fields: missingFields,
    conflicts,
    retrieval_version: retrievalVersion,
    index_version: indexVersion,
    sufficient: record.sufficient,
  };
}

function parseEvidenceReference(value: unknown, path: string): GroundingEvidenceReference {
  const record = exactRecord(value, EVIDENCE_FIELDS, path);
  const reportRevisionId = id(record.report_revision_id, path + '.report_revision_id');
  const permittedTextHash = hash(record.permitted_text_hash, path + '.permitted_text_hash');
  const spanStart = integer(record.span_start, path + '.span_start', 0, 10_000_000);
  const spanEnd = integer(record.span_end, path + '.span_end', 1, 10_000_000);
  if (spanEnd <= spanStart) invalid(path, 'empty_or_reversed_span');
  if (record.offset_unit !== 'unicode_code_points') invalid(path + '.offset_unit', 'invalid_offset_unit');
  if (typeof record.relation !== 'string' || !EVIDENCE_RELATIONS.has(record.relation as EvidenceRelation)) {
    invalid(path + '.relation', 'invalid_relation');
  }
  return {
    report_revision_id: reportRevisionId,
    permitted_text_hash: permittedTextHash,
    span_start: spanStart,
    span_end: spanEnd,
    offset_unit: 'unicode_code_points',
    relation: record.relation as EvidenceRelation,
  };
}

function parseRevisionState(value: unknown, path: string): GroundingRevisionState {
  const record = exactRecord(value, REVISION_STATE_FIELDS, path);
  const reportRevisionId = id(record.report_revision_id, path + '.report_revision_id');
  if (typeof record.revision_status !== 'string'
    || !REVISION_STATUSES.has(record.revision_status as RevisionStatus)) {
    invalid(path + '.revision_status', 'invalid_revision_status');
  }
  return {
    report_revision_id: reportRevisionId,
    revision_status: record.revision_status as RevisionStatus,
  };
}

function parseCandidateEvent(value: unknown, path: string): GroundingCandidateEvent {
  const record = exactRecord(value, CANDIDATE_EVENT_FIELDS, path);
  return {
    event_id: id(record.event_id, path + '.event_id'),
    event_version: integer(record.event_version, path + '.event_version', 1, 2_147_483_647),
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

function arrayValue(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) invalid(path, 'expected_array');
  return value;
}

function id(value: unknown, path: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) invalid(path, 'invalid_id');
  return value;
}

function hash(value: unknown, path: string): string {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) invalid(path, 'invalid_sha256');
  return value;
}

function integer(value: unknown, path: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    invalid(path, 'invalid_integer');
  }
  return value;
}

function uniqueIds(value: unknown, path: string): string[] {
  const values = arrayValue(value, path).map((entry, index) => id(entry, path + '[' + index + ']'));
  assertUnique(values, path, 'duplicate_value');
  return values;
}

function uniqueStrings(value: unknown, path: string): string[] {
  const values = arrayValue(value, path).map((entry, index) => {
    if (typeof entry !== 'string' || entry.length < 1 || entry.length > 500) {
      invalid(path + '[' + index + ']', 'invalid_string');
    }
    return entry;
  });
  assertUnique(values, path, 'duplicate_value');
  return values;
}

function assertUnique(values: readonly string[], path: string, reason: string): void {
  if (new Set(values).size !== values.length) invalid(path, reason);
}

function evidenceKey(reference: GroundingEvidenceReference): string {
  return JSON.stringify([
    reference.report_revision_id,
    reference.permitted_text_hash,
    reference.span_start,
    reference.span_end,
    reference.offset_unit,
    reference.relation,
  ]);
}

function contextParameters(record: GroundingContextRecord): readonly unknown[] {
  return [
    record.dataset_kind,
    record.context_id,
    record.trace_id,
    record.candidate_id,
    record.retrieval_version,
    record.index_version,
    record.sufficient,
    JSON.stringify(record),
  ];
}

async function verifyExistingContext(
  executor: SqlExecutor,
  record: GroundingContextRecord,
): Promise<boolean> {
  const parent = await executor.query<{ matches: boolean }>(
    'SELECT (context.dataset_kind IS NOT DISTINCT FROM $1::text ' +
      'AND context.context_id IS NOT DISTINCT FROM $2::text ' +
      'AND context.trace_id IS NOT DISTINCT FROM $3::text ' +
      'AND context.candidate_id IS NOT DISTINCT FROM $4::text ' +
      'AND context.retrieval_version IS NOT DISTINCT FROM $5::text ' +
      'AND context.index_version IS NOT DISTINCT FROM $6::text ' +
      'AND context.sufficient IS NOT DISTINCT FROM $7::boolean ' +
      'AND context.record_json = $8::jsonb) AS matches ' +
      'FROM waspada.grounding_contexts AS context ' +
      'WHERE context.dataset_kind = $1 AND context.context_id = $2',
    contextParameters(record),
  );
  if (parent.rows.length === 0) return false;
  if (parent.rows[0]?.matches !== true) throw new GroundingContextConflictError();

  const linkedEvidence = await executor.query<{
    report_revision_id: string;
    permitted_text_hash: string;
    span_start: number;
    span_end: number;
    offset_unit: 'unicode_code_points';
    relation: EvidenceRelation;
  }>(
    'SELECT evidence.report_revision_id, evidence.permitted_text_hash, evidence.span_start, ' +
      'evidence.span_end, evidence.offset_unit, evidence.relation ' +
      'FROM waspada.grounding_evidence AS link ' +
      'JOIN waspada.evidence_references AS evidence ' +
      'ON evidence.dataset_kind = link.dataset_kind AND evidence.evidence_ref_id = link.evidence_ref_id ' +
      'WHERE link.dataset_kind = $1 AND link.context_id = $2',
    [record.dataset_kind, record.context_id],
  );
  assertSameSet(
    record.evidence.map(evidenceKey),
    linkedEvidence.rows.map(evidenceKey),
  );

  const linkedEvents = await executor.query<{ event_id: string; event_version: number }>(
    'SELECT event_id, event_version FROM waspada.grounding_candidate_events ' +
      'WHERE dataset_kind = $1 AND context_id = $2',
    [record.dataset_kind, record.context_id],
  );
  assertSameSet(
    record.candidate_events.map(candidateEventKey),
    linkedEvents.rows.map(candidateEventKey),
  );

  const linkedDecisions = await executor.query<{ decision_id: string }>(
    'SELECT decision_id FROM waspada.grounding_prior_decisions ' +
      'WHERE dataset_kind = $1 AND context_id = $2',
    [record.dataset_kind, record.context_id],
  );
  assertSameSet(
    record.prior_decision_ids,
    linkedDecisions.rows.map(({ decision_id }) => decision_id),
  );
  return true;
}

function candidateEventKey(event: GroundingCandidateEvent): string {
  return JSON.stringify([event.event_id, event.event_version]);
}

function assertSameSet(expected: readonly string[], actual: readonly string[]): void {
  if (expected.length !== actual.length) throw new GroundingContextConflictError();
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  if (expectedSet.size !== expected.length || actualSet.size !== actual.length
    || [...expectedSet].some((value) => !actualSet.has(value))) {
    throw new GroundingContextConflictError();
  }
}

async function resolveEvidenceReferences(
  executor: SqlExecutor,
  record: GroundingContextRecord,
): Promise<string[]> {
  const ids: string[] = [];
  for (const reference of record.evidence) {
    const result = await executor.query<{ evidence_ref_id: string | number | bigint }>(
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
    if (result.rows.length !== 1) throw new GroundingContextReferenceError('evidence');
    ids.push(String(result.rows[0]!.evidence_ref_id));
  }
  return ids;
}

async function requireCandidateEvents(executor: SqlExecutor, record: GroundingContextRecord): Promise<void> {
  for (const candidateEvent of record.candidate_events) {
    const result = await executor.query<{ event_id: string }>(
      'SELECT event_id FROM waspada.event_versions ' +
        'WHERE dataset_kind = $1 AND event_id = $2 AND version = $3',
      [record.dataset_kind, candidateEvent.event_id, candidateEvent.event_version],
    );
    if (result.rows.length !== 1) throw new GroundingContextReferenceError('candidate_event');
  }
}

async function requirePriorDecisions(executor: SqlExecutor, record: GroundingContextRecord): Promise<void> {
  for (const decisionId of record.prior_decision_ids) {
    const result = await executor.query<{ decision_id: string }>(
      'SELECT decision_id FROM waspada.publication_decisions ' +
        'WHERE dataset_kind = $1 AND decision_id = $2',
      [record.dataset_kind, decisionId],
    );
    if (result.rows.length !== 1) throw new GroundingContextReferenceError('prior_decision');
  }
}

function invalid(path: string, reason: string): never {
  throw new GroundingContextValidationError(path, reason);
}
