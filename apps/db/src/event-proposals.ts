import { createHash } from 'node:crypto';
import type { DatasetKind } from './ports.js';
import type { SqlExecutor, TransactionalSqlExecutor } from './sql.js';

export type ProposalTime =
  | { readonly precision: 'exact'; readonly start: string; readonly end: string | null }
  | { readonly precision: 'date'; readonly start: string; readonly end: string | null }
  | { readonly precision: 'range'; readonly start: string; readonly end: string }
  | { readonly precision: 'unknown'; readonly start: null; readonly end: null };

export interface ProposalEvidenceReference {
  readonly report_revision_id: string;
  readonly permitted_text_hash: string;
  readonly span_start: number;
  readonly span_end: number;
  readonly offset_unit: 'unicode_code_points';
  readonly relation: 'supports' | 'contradicts' | 'updates' | 'context';
}
export interface ProposalClaim {
  readonly claim_id: string;
  readonly text: string;
  readonly event_time: ProposalTime;
  readonly validity: { readonly valid_from: string | null; readonly valid_until: string | null };
  readonly scope: {
    readonly place_ids: readonly string[]; readonly service_ids: readonly string[];
    readonly institution_ids: readonly string[]; readonly audience_ids: readonly string[];
    readonly geometry_ids: readonly string[];
  };
  readonly qualifiers: readonly string[];
  readonly support: readonly ProposalEvidenceReference[];
  readonly contradictions: readonly ProposalEvidenceReference[];
  readonly context_evidence: readonly ProposalEvidenceReference[];
  readonly origin_ids: readonly string[];
  readonly support_assessment: 'supported' | 'uncertain' | 'disputed';
  readonly evidence_label: 'issuer_notice' | 'attributed_report' | 'independent_corroboration' | 'crowdsourced_observation' | 'under_review';
}
export interface ProposalModelRun {
  readonly capability: 'parser' | 'extraction' | 'reasoning';
  readonly model_version: string | null;
  readonly prompt_version: string | null;
  readonly input_tokens: number;
  readonly output_tokens: number;
}
export interface EventProposal {
  readonly schema_version: '2.0';
  readonly trace_id: string;
  readonly record_type: 'EventProposal';
  readonly dataset_kind: DatasetKind;
  readonly proposal_id: string;
  readonly candidate_id: string;
  readonly context_id: string;
  readonly event_id: string | null;
  readonly base_event_version: number | null;
  readonly investigation_id: string | null;
  readonly claims: readonly ProposalClaim[];
  readonly unresolved_fields: readonly string[];
  readonly model_runs: readonly ProposalModelRun[];
  readonly proposed_at: string;
}
export interface EventProposalRepository {
  createOrVerify(input: EventProposal): Promise<EventProposal>;
}

/** Read-only capability for the exact persisted live proposal used by Layer 4. */
export interface EventProposalReader {
  readLive(proposalId: string): Promise<EventProposal | null>;
}

export type EventProposalReferenceKind = 'trace' | 'candidate' | 'context' | 'evidence' | 'origin' | 'event' | 'investigation';

export class EventProposalValidationError extends Error {
  readonly code = 'invalid_event_proposal' as const;
  constructor(path: string, reason: string) {
    super('invalid_event_proposal:' + path + ':' + reason);
    this.name = 'EventProposalValidationError';
  }
}
export class EventProposalReferenceError extends Error {
  readonly code = 'event_proposal_reference_not_found' as const;
  constructor(readonly referenceKind: EventProposalReferenceKind) {
    super('event_proposal_reference_not_found:' + referenceKind);
    this.name = 'EventProposalReferenceError';
  }
}
export class EventProposalConflictError extends Error {
  readonly code = 'event_proposal_conflict' as const;
  constructor() { super('event_proposal_conflict'); this.name = 'EventProposalConflictError'; }
}
export class EventProposalStorageError extends Error {
  readonly code = 'event_proposal_storage_error' as const;
  constructor() { super('event_proposal_storage_error'); this.name = 'EventProposalStorageError'; }
}

export type EventProposalReaderFailure = 'invalid_proposal_id' | 'invalid_persisted_proposal' | 'proposal_read_failed';

export class EventProposalReaderError extends Error {
  readonly code = 'event_proposal_reader_error' as const;
  constructor(readonly failure: EventProposalReaderFailure) {
    super('event_proposal_reader_error');
    this.name = 'EventProposalReaderError';
  }
}

const DATASETS = new Set(['live', 'historical', 'synthetic']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const TOP_FIELDS = ['schema_version', 'trace_id', 'record_type', 'dataset_kind', 'proposal_id',
  'candidate_id', 'context_id', 'event_id', 'base_event_version', 'investigation_id',
  'claims', 'unresolved_fields', 'model_runs', 'proposed_at'] as const;
const CLAIM_FIELDS = ['claim_id', 'text', 'event_time', 'validity', 'scope', 'qualifiers',
  'support', 'contradictions', 'context_evidence', 'origin_ids', 'support_assessment', 'evidence_label'] as const;
const EVIDENCE_FIELDS = ['report_revision_id', 'permitted_text_hash', 'span_start', 'span_end',
  'offset_unit', 'relation'] as const;
const SCOPE_FIELDS = ['place_ids', 'service_ids', 'institution_ids', 'audience_ids', 'geometry_ids'] as const;
const MODEL_FIELDS = ['capability', 'model_version', 'prompt_version', 'input_tokens', 'output_tokens'] as const;
const DAY_US = 86_400_000_000n;

export function createSqlEventProposalRepository(executor: TransactionalSqlExecutor): EventProposalRepository {
  if (!executor || typeof executor.transaction !== 'function') {
    throw new TypeError('Event proposal persistence requires a transactional SQL executor');
  }
  return new SqlEventProposalRepository(executor);
}

interface EventProposalRow {
  readonly dataset_kind: unknown;
  readonly proposal_id: unknown;
  readonly trace_id: unknown;
  readonly candidate_id: unknown;
  readonly context_id: unknown;
  readonly event_id: unknown;
  readonly base_event_version: unknown;
  readonly record_json: unknown;
}

/** Reads only the exact live proposal columns already granted to the L4 writer role. */
export function createSqlEventProposalReader(executor: SqlExecutor): EventProposalReader {
  if (!executor || typeof executor.query !== 'function') {
    throw new TypeError('Event proposal reading requires a SQL executor');
  }

  return {
    async readLive(proposalId: string): Promise<EventProposal | null> {
      try {
        id(proposalId, 'proposal.proposal_id');
      } catch {
        throw new EventProposalReaderError('invalid_proposal_id');
      }

      let rows: readonly EventProposalRow[];
      try {
        const result = await executor.query<EventProposalRow>(
          'SELECT dataset_kind, proposal_id, trace_id, candidate_id, context_id, event_id, base_event_version, record_json ' +
          "FROM waspada.event_proposals WHERE dataset_kind = 'live' AND proposal_id = $1",
          [proposalId],
        );
        rows = result.rows;
      } catch {
        throw new EventProposalReaderError('proposal_read_failed');
      }

      if (rows.length === 0) return null;
      if (rows.length !== 1) throw new EventProposalReaderError('invalid_persisted_proposal');

      try {
        const row = rows[0]!;
        const proposal = snapshotProposal(row.record_json);
        if (row.dataset_kind !== 'live'
          || row.proposal_id !== proposalId
          || row.dataset_kind !== proposal.dataset_kind
          || row.proposal_id !== proposal.proposal_id
          || row.trace_id !== proposal.trace_id
          || row.candidate_id !== proposal.candidate_id
          || row.context_id !== proposal.context_id
          || row.event_id !== proposal.event_id
          || row.base_event_version !== proposal.base_event_version) {
          throw new EventProposalReaderError('invalid_persisted_proposal');
        }
        return proposal;
      } catch (error) {
        if (error instanceof EventProposalReaderError) throw error;
        throw new EventProposalReaderError('invalid_persisted_proposal');
      }
    },
  };
}

class SqlEventProposalRepository implements EventProposalRepository {
  constructor(private readonly executor: TransactionalSqlExecutor) {}
  async createOrVerify(input: EventProposal): Promise<EventProposal> {
    const proposal = snapshotProposal(input);
    try {
      return await this.executor.transaction(async (tx) => {
        const lock = identityLock(proposal);
        await tx.query('SELECT pg_advisory_xact_lock($1::integer, $2::integer)', lock);
        const lineage = await resolveLineage(tx, proposal);
        if (await verifyStoredProposal(tx, proposal, lineage)) return proposal;
        const inserted = await tx.query<{ proposal_id: string }>(
          'INSERT INTO waspada.event_proposals ' +
          '(dataset_kind, proposal_id, trace_id, candidate_id, context_id, event_id, base_event_version, investigation_id, proposed_at, record_json) ' +
          'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10::jsonb) ' +
          'ON CONFLICT (dataset_kind, proposal_id) DO NOTHING RETURNING proposal_id',
          proposalParameters(proposal),
        );
        if (!inserted.rows[0]) {
          if (!await verifyStoredProposal(tx, proposal, lineage)) throw new EventProposalConflictError();
          return proposal;
        }
        for (const claim of proposal.claims) {
          await tx.query(
            'INSERT INTO waspada.proposal_claims ' +
            '(dataset_kind, proposal_id, claim_id, support_assessment, evidence_label, claim_text, record_json) ' +
            'VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)',
            [proposal.dataset_kind, proposal.proposal_id, claim.claim_id, claim.support_assessment,
              claim.evidence_label, claim.text, JSON.stringify(claim)],
          );
        }
        for (const link of lineage.evidenceLinks) {
          await tx.query(
            'INSERT INTO waspada.proposal_claim_evidence ' +
            '(dataset_kind, proposal_id, claim_id, evidence_kind, evidence_ref_id) VALUES ($1,$2,$3,$4,$5::bigint)',
            [proposal.dataset_kind, proposal.proposal_id, link.claimId, link.kind, link.evidenceRefId],
          );
        }
        for (const link of lineage.originLinks) {
          await tx.query(
            'INSERT INTO waspada.proposal_claim_origins (dataset_kind, proposal_id, claim_id, origin_id) VALUES ($1,$2,$3,$4)',
            [proposal.dataset_kind, proposal.proposal_id, link.claimId, link.originId],
          );
        }
        return proposal;
      });
    } catch (error) {
      if (error instanceof EventProposalValidationError || error instanceof EventProposalReferenceError
        || error instanceof EventProposalConflictError || error instanceof EventProposalStorageError) throw error;
      throw new EventProposalStorageError();
    }
  }
}

interface EvidenceLink { readonly claimId: string; readonly kind: 'support' | 'contradiction' | 'context'; readonly evidenceRefId: string; }
interface OriginLink { readonly claimId: string; readonly originId: string; }
interface ResolvedLineage { readonly evidenceLinks: readonly EvidenceLink[]; readonly originLinks: readonly OriginLink[]; }

function snapshotProposal(input: unknown): EventProposal {
  try {
    const r = exactObject(input, TOP_FIELDS, 'proposal');
    if (r.schema_version !== '2.0') invalid('proposal.schema_version', 'unsupported_version');
    if (r.record_type !== 'EventProposal') invalid('proposal.record_type', 'invalid_record_type');
    if (typeof r.dataset_kind !== 'string' || !DATASETS.has(r.dataset_kind)) invalid('proposal.dataset_kind', 'invalid_dataset_kind');
    const dataset = r.dataset_kind as DatasetKind;
    const traceId = id(r.trace_id, 'proposal.trace_id');
    const proposalId = id(r.proposal_id, 'proposal.proposal_id');
    const candidateId = id(r.candidate_id, 'proposal.candidate_id');
    const contextId = id(r.context_id, 'proposal.context_id');
    const eventId = r.event_id === null ? null : id(r.event_id, 'proposal.event_id');
    const baseVersion = r.base_event_version === null ? null : int(r.base_event_version, 'proposal.base_event_version', 1, 2_147_483_647);
    if ((eventId === null) !== (baseVersion === null)) invalid('proposal.event_target', 'incomplete_pair');
    const investigationId = r.investigation_id === null ? null : id(r.investigation_id, 'proposal.investigation_id');
    const claimValues = array(r.claims, 'proposal.claims');
    if (claimValues.length > 20) invalid('proposal.claims', 'too_many_items');
    const claims = claimValues.map((v, i) => parseClaim(v, 'proposal.claims[' + i + ']'));
    unique(claims.map((c) => c.claim_id), 'proposal.claims', 'duplicate_claim_id');
    const totalRefs = claims.reduce((n, c) => n + c.support.length + c.contradictions.length + c.context_evidence.length, 0);
    if (totalRefs > 200) invalid('proposal.claims', 'proposal_reference_budget_exceeded');
    const unresolvedFields = stringList(r.unresolved_fields, 'proposal.unresolved_fields', 100);
    const runValues = array(r.model_runs, 'proposal.model_runs');
    if (runValues.length > 20) invalid('proposal.model_runs', 'too_many_items');
    const modelRuns = runValues.map((v, i) => parseModelRun(v, 'proposal.model_runs[' + i + ']'));
    const proposedAt = dateTime(r.proposed_at, 'proposal.proposed_at').source;
    return {
      schema_version: '2.0', trace_id: traceId, record_type: 'EventProposal', dataset_kind: dataset,
      proposal_id: proposalId, candidate_id: candidateId, context_id: contextId,
      event_id: eventId, base_event_version: baseVersion, investigation_id: investigationId,
      claims, unresolved_fields: unresolvedFields, model_runs: modelRuns, proposed_at: proposedAt,
    };
  } catch (error) {
    if (error instanceof EventProposalValidationError) throw error;
    throw new EventProposalValidationError('proposal', 'unreadable_input');
  }
}

function parseClaim(value: unknown, path: string): ProposalClaim {
  const r = exactObject(value, CLAIM_FIELDS, path);
  const claimId = id(r.claim_id, path + '.claim_id');
  const text = string(r.text, path + '.text', 1, 4000);
  const eventTime = parseTime(r.event_time, path + '.event_time');
  const v = exactObject(r.validity, ['valid_from', 'valid_until'], path + '.validity');
  const validFrom = v.valid_from === null ? null : dateTime(v.valid_from, path + '.validity.valid_from').source;
  const validUntil = v.valid_until === null ? null : dateTime(v.valid_until, path + '.validity.valid_until').source;
  if (validFrom && validUntil && dateTime(validFrom, path).micros >= dateTime(validUntil, path).micros) invalid(path + '.validity', 'reversed_interval');
  const s = exactObject(r.scope, SCOPE_FIELDS, path + '.scope');
  const scope = {
    place_ids: idList(s.place_ids, path + '.scope.place_ids', 100),
    service_ids: idList(s.service_ids, path + '.scope.service_ids', 100),
    institution_ids: idList(s.institution_ids, path + '.scope.institution_ids', 100),
    audience_ids: idList(s.audience_ids, path + '.scope.audience_ids', 100),
    geometry_ids: idList(s.geometry_ids, path + '.scope.geometry_ids', 100),
  };
  const qualifiers = stringList(r.qualifiers, path + '.qualifiers', 100);
  const support = parseEvidenceList(r.support, path + '.support', 'supports');
  if (!support.length) invalid(path + '.support', 'empty_support');
  const contradictions = parseEvidenceList(r.contradictions, path + '.contradictions', 'contradicts');
  const contextEvidence = parseEvidenceList(r.context_evidence, path + '.context_evidence', 'updates_or_context');
  if (support.length + contradictions.length + contextEvidence.length > 100) invalid(path, 'too_many_evidence_references');
  const originIds = idList(r.origin_ids, path + '.origin_ids', 100);
  if (!originIds.length) invalid(path + '.origin_ids', 'empty_origins');
  const assessment = r.support_assessment;
  if (assessment !== 'supported' && assessment !== 'uncertain' && assessment !== 'disputed') invalid(path + '.support_assessment', 'invalid_assessment');
  const label = r.evidence_label;
  if (label !== 'issuer_notice' && label !== 'attributed_report' && label !== 'independent_corroboration'
    && label !== 'crowdsourced_observation' && label !== 'under_review') invalid(path + '.evidence_label', 'invalid_label');
  return { claim_id: claimId, text, event_time: eventTime,
    validity: { valid_from: validFrom, valid_until: validUntil }, scope, qualifiers, support,
    contradictions, context_evidence: contextEvidence, origin_ids: originIds,
    support_assessment: assessment, evidence_label: label };
}
function parseEvidenceList(value: unknown, path: string, expected: 'supports' | 'contradicts' | 'updates_or_context'): ProposalEvidenceReference[] {
  const values = array(value, path);
  if (values.length > 100) invalid(path, 'too_many_items');
  const refs = values.map((v, i) => parseEvidence(v, path + '[' + i + ']'));
  for (const ref of refs) {
    if ((expected !== 'updates_or_context' && ref.relation !== expected)
      || (expected === 'updates_or_context' && ref.relation !== 'updates' && ref.relation !== 'context')) invalid(path, 'relation_mismatch');
  }
  unique(refs.map(evidenceKey), path, 'duplicate_reference');
  return refs;
}
function parseEvidence(value: unknown, path: string): ProposalEvidenceReference {
  const r = exactObject(value, EVIDENCE_FIELDS, path);
  const revision = id(r.report_revision_id, path + '.report_revision_id');
  if (typeof r.permitted_text_hash !== 'string' || !HASH.test(r.permitted_text_hash)) invalid(path + '.permitted_text_hash', 'invalid_sha256');
  const start = int(r.span_start, path + '.span_start', 0, 10_000_000);
  const end = int(r.span_end, path + '.span_end', 1, 10_000_000);
  if (end <= start) invalid(path, 'empty_or_reversed_span');
  if (r.offset_unit !== 'unicode_code_points') invalid(path + '.offset_unit', 'invalid_offset_unit');
  const relation = r.relation;
  if (relation !== 'supports' && relation !== 'contradicts' && relation !== 'updates' && relation !== 'context') invalid(path + '.relation', 'invalid_relation');
  return { report_revision_id: revision, permitted_text_hash: r.permitted_text_hash,
    span_start: start, span_end: end, offset_unit: 'unicode_code_points', relation };
}
function parseTime(value: unknown, path: string): ProposalTime {
  const r = exactObject(value, ['start', 'end', 'precision'], path);
  if (r.precision === 'unknown') {
    if (r.start !== null || r.end !== null) invalid(path, 'invalid_unknown_time');
    return { precision: 'unknown', start: null, end: null };
  }
  if (r.precision === 'exact') {
    const start = dateTime(r.start, path + '.start');
    const end = r.end === null ? null : dateTime(r.end, path + '.end');
    if (end && start.micros >= end.micros) invalid(path, 'reversed_interval');
    return { precision: 'exact', start: start.source, end: end?.source ?? null };
  }
  if (r.precision === 'date') {
    const start = dateOnly(r.start, path + '.start');
    const end = r.end === null ? null : dateOnly(r.end, path + '.end');
    if (end && start.day >= end.day) invalid(path, 'reversed_interval');
    return { precision: 'date', start: start.source, end: end?.source ?? null };
  }
  if (r.precision === 'range') {
    const start = endpoint(r.start, path + '.start');
    const end = endpoint(r.end, path + '.end');
    if (start.micros >= end.micros) invalid(path, 'reversed_interval');
    return { precision: 'range', start: start.source, end: end.source };
  }
  invalid(path + '.precision', 'invalid_precision');
}
function endpoint(value: unknown, path: string): { source: string; micros: bigint } {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const d = dateOnly(value, path); return { source: d.source, micros: d.day * DAY_US };
  }
  const d = dateTime(value, path); return { source: d.source, micros: d.micros };
}
function dateOnly(value: unknown, path: string): { source: string; day: bigint } {
  if (typeof value !== 'string') invalid(path, 'invalid_date');
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) invalid(path, 'invalid_date');
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > monthDays(y, mo)) invalid(path, 'invalid_date');
  return { source: scalarString(value, path, 10, 10), day: daysFromCivil(y, mo, d) };
}
function dateTime(value: unknown, path: string): { source: string; micros: bigint } {
  if (typeof value !== 'string') invalid(path, 'invalid_datetime');
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m) invalid(path, 'invalid_datetime');
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  const hh = Number(m[4]); const mm = Number(m[5]); const ss = Number(m[6]);
  if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > monthDays(y, mo) || hh > 23 || mm > 59 || ss > 59) invalid(path, 'invalid_datetime');
  const fraction = (m[7] ?? '').padEnd(6, '0');
  let offset = 0;
  if (m[8] !== 'Z') {
    const oh = Number(m[8]!.slice(1, 3)); const om = Number(m[8]!.slice(4, 6));
    if (oh > 23 || om > 59) invalid(path, 'invalid_timezone_offset');
    offset = (m[8]![0] === '+' ? 1 : -1) * (oh * 60 + om);
  }
  const micros = daysFromCivil(y, mo, d) * DAY_US + BigInt(hh * 3600 + mm * 60 + ss) * 1_000_000n
    + BigInt(fraction || '0') - BigInt(offset) * 60_000_000n;
  if (micros < daysFromCivil(1, 1, 1) * DAY_US || micros >= daysFromCivil(10000, 1, 1) * DAY_US) invalid(path, 'utc_year_out_of_range');
  return { source: scalarString(value, path, 20, 35), micros };
}
function monthDays(y: number, m: number): number {
  if (m === 2) return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}
function daysFromCivil(year: number, month: number, day: number): bigint {
  let y = year; if (month <= 2) y -= 1;
  const era = Math.floor(y / 400); const yoe = y - era * 400;
  const mp = month + (month > 2 ? -3 : 9);
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  return BigInt(era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719468);
}
function parseModelRun(value: unknown, path: string): ProposalModelRun {
  const r = exactObject(value, MODEL_FIELDS, path);
  if (r.capability !== 'parser' && r.capability !== 'extraction' && r.capability !== 'reasoning') invalid(path + '.capability', 'invalid_capability');
  const model = nullableLabel(r.model_version, path + '.model_version');
  const prompt = nullableLabel(r.prompt_version, path + '.prompt_version');
  const input = int(r.input_tokens, path + '.input_tokens', 0, 12_000);
  const output = int(r.output_tokens, path + '.output_tokens', 0, 12_000);
  if (input + output > 12_000) invalid(path, 'token_budget_exceeded');
  return { capability: r.capability, model_version: model, prompt_version: prompt, input_tokens: input, output_tokens: output };
}
function nullableLabel(v: unknown, path: string): string | null { return v === null ? null : string(v, path, 1, 200); }

function exactObject(value: unknown, fields: readonly string[], path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(path, 'expected_object');
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) invalid(path, 'expected_plain_object');
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) invalid(path, 'unexpected_property');
  const allowed = new Set(fields); const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    if (!allowed.has(key)) invalid(path, 'unexpected_property');
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!desc || !('value' in desc) || !desc.enumerable) invalid(path, 'invalid_property');
    out[key] = desc.value;
  }
  for (const field of fields) if (!Object.prototype.hasOwnProperty.call(out, field)) invalid(path + '.' + field, 'missing_property');
  return out;
}
function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) invalid(path, 'expected_array');
  const len = value.length;
  if (!Number.isSafeInteger(len) || len > 10_000) invalid(path, 'invalid_array_length');
  const keys = Reflect.ownKeys(value); const out: unknown[] = [];
  for (let i = 0; i < len; i += 1) {
    if (!keys.includes(String(i))) invalid(path, 'sparse_array');
    const desc = Object.getOwnPropertyDescriptor(value, String(i));
    if (!desc || !('value' in desc) || !desc.enumerable) invalid(path, 'invalid_array_item');
    out.push(desc.value);
  }
  if (keys.some((key) => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= len))) invalid(path, 'unexpected_array_property');
  return out;
}
function id(v: unknown, path: string): string {
  if (typeof v !== 'string' || !ID.test(v)) invalid(path, 'invalid_id');
  return scalarString(v, path, 1, 128);
}
function int(v: unknown, path: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) invalid(path, 'invalid_integer');
  return v;
}
function string(v: unknown, path: string, min: number, max: number): string { return scalarString(v, path, min, max); }
function scalarString(v: unknown, path: string, min: number, max: number): string {
  if (typeof v !== 'string' || v.includes('\0')) invalid(path, 'invalid_string');
  let count = 0;
  for (const ch of v) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0xd800 && cp <= 0xdfff) invalid(path, 'invalid_unicode_scalar');
    count += 1;
  }
  if (count < min || count > max) invalid(path, 'string_length_out_of_range');
  return v;
}
function idList(v: unknown, path: string, max: number): string[] {
  const values = array(v, path);
  if (values.length > max) invalid(path, 'too_many_items');
  const ids = values.map((x, i) => id(x, path + '[' + i + ']'));
  unique(ids, path, 'duplicate_value'); return ids;
}
function stringList(v: unknown, path: string, max: number): string[] {
  const values = array(v, path);
  if (values.length > max) invalid(path, 'too_many_items');
  return values.map((x, i) => string(x, path + '[' + i + ']', 1, 500));
}
function unique(values: readonly string[], path: string, why: string): void {
  if (new Set(values).size !== values.length) invalid(path, why);
}
function evidenceKey(r: ProposalEvidenceReference): string {
  return JSON.stringify([r.report_revision_id, r.permitted_text_hash, r.span_start, r.span_end, r.offset_unit, r.relation]);
}
function invalid(path: string, reason: string): never { throw new EventProposalValidationError(path, reason); }
function identityLock(p: EventProposal): readonly number[] {
  const digest = createHash('sha256').update(JSON.stringify([p.dataset_kind, p.proposal_id])).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}
function proposalParameters(p: EventProposal): readonly unknown[] {
  return [p.dataset_kind, p.proposal_id, p.trace_id, p.candidate_id, p.context_id,
    p.event_id, p.base_event_version, p.investigation_id, p.proposed_at, JSON.stringify(p)];
}

async function resolveLineage(tx: SqlExecutor, p: EventProposal): Promise<ResolvedLineage> {
  const trace = await tx.query<{ trace_id: string }>('SELECT trace_id FROM waspada.traces WHERE trace_id=$1 AND dataset_kind=$2', [p.trace_id, p.dataset_kind]);
  if (trace.rows.length !== 1) throw new EventProposalReferenceError('trace');
  const candidate = await tx.query<{ candidate_id: string }>('SELECT candidate_id FROM waspada.extraction_results WHERE dataset_kind=$1 AND candidate_id=$2', [p.dataset_kind, p.candidate_id]);
  if (candidate.rows.length !== 1) throw new EventProposalReferenceError('candidate');
  const context = await tx.query<{ trace_id: string; candidate_id: string }>(
    'SELECT trace_id,candidate_id FROM waspada.grounding_contexts WHERE dataset_kind=$1 AND context_id=$2',
    [p.dataset_kind, p.context_id],
  );
  if (context.rows.length !== 1 || context.rows[0]?.trace_id !== p.trace_id || context.rows[0]?.candidate_id !== p.candidate_id) {
    throw new EventProposalReferenceError('context');
  }
  const resolved = new Map<string, string>();
  for (const claim of p.claims) for (const ref of [...claim.support, ...claim.contradictions, ...claim.context_evidence]) {
    const key = evidenceKey(ref);
    if (resolved.has(key)) continue;
    const rows = await tx.query<{ evidence_ref_id: string }>(
      'SELECT e.evidence_ref_id::text AS evidence_ref_id FROM waspada.grounding_evidence g ' +
      'JOIN waspada.evidence_references e ON e.dataset_kind=g.dataset_kind AND e.evidence_ref_id=g.evidence_ref_id ' +
      'WHERE g.dataset_kind=$1 AND g.context_id=$2 AND e.report_revision_id=$3 AND e.permitted_text_hash=$4 ' +
      'AND e.span_start=$5 AND e.span_end=$6 AND e.offset_unit=$7 AND e.relation=$8',
      [p.dataset_kind, p.context_id, ref.report_revision_id, ref.permitted_text_hash, ref.span_start,
        ref.span_end, ref.offset_unit, ref.relation],
    );
    if (rows.rows.length !== 1) throw new EventProposalReferenceError('evidence');
    resolved.set(key, String(rows.rows[0]!.evidence_ref_id));
  }
  if (p.event_id !== null && p.base_event_version !== null) {
    const event = await tx.query<{ event_id: string }>('SELECT event_id FROM waspada.event_versions WHERE dataset_kind=$1 AND event_id=$2 AND version=$3', [p.dataset_kind, p.event_id, p.base_event_version]);
    const link = await tx.query<{ event_id: string }>(
      'SELECT event_id FROM waspada.grounding_candidate_events WHERE dataset_kind=$1 AND context_id=$2 AND event_id=$3 AND event_version=$4',
      [p.dataset_kind, p.context_id, p.event_id, p.base_event_version],
    );
    if (event.rows.length !== 1 || link.rows.length !== 1) throw new EventProposalReferenceError('event');
  }
  if (p.investigation_id !== null) await requireInvestigationLineage(tx, p);

  const evidenceLinks: EvidenceLink[] = []; const originLinks: OriginLink[] = [];
  for (const claim of p.claims) {
    const supportIds = claim.support.map((ref) => resolved.get(evidenceKey(ref))!);
    for (const [refs, kind] of [[claim.support, 'support'], [claim.contradictions, 'contradiction'], [claim.context_evidence, 'context']] as const) {
      for (const ref of refs) evidenceLinks.push({ claimId: claim.claim_id, kind, evidenceRefId: resolved.get(evidenceKey(ref))! });
    }
    const origins = await tx.query<{ origin_id: string }>(
      'SELECT origin_id FROM waspada.evidence_origins WHERE dataset_kind=$1 AND origin_id=ANY($2::text[])',
      [p.dataset_kind, [...claim.origin_ids]],
    );
    if (origins.rows.length !== claim.origin_ids.length) throw new EventProposalReferenceError('origin');
    const lineage = await tx.query<{ origin_id: string; evidence_ref_id: string }>(
      'SELECT origin_id,evidence_ref_id::text AS evidence_ref_id FROM waspada.origin_evidence ' +
      'WHERE dataset_kind=$1 AND origin_id=ANY($2::text[]) AND evidence_ref_id=ANY($3::bigint[])',
      [p.dataset_kind, [...claim.origin_ids], supportIds],
    );
    const coverage = new Set(lineage.rows.map((x) => x.origin_id + '\0' + x.evidence_ref_id));
    for (const originId of claim.origin_ids) {
      if (!supportIds.some((evidenceId) => coverage.has(originId + '\0' + evidenceId))) throw new EventProposalReferenceError('origin');
      originLinks.push({ claimId: claim.claim_id, originId });
    }
    for (const evidenceId of supportIds) {
      if (!claim.origin_ids.some((originId) => coverage.has(originId + '\0' + evidenceId))) throw new EventProposalReferenceError('origin');
    }
  }
  return { evidenceLinks, originLinks };
}

async function requireInvestigationLineage(tx: SqlExecutor, p: EventProposal): Promise<void> {
  const request = await tx.query<{ trace_id: string; candidate_id: string; context_id: string; event_id: string | null; event_version: number | null }>(
    'SELECT trace_id,candidate_id,context_id,event_id,event_version FROM waspada.investigation_requests WHERE dataset_kind=$1 AND investigation_id=$2',
    [p.dataset_kind, p.investigation_id],
  );
  const r = request.rows[0];
  if (!r || r.candidate_id !== p.candidate_id || r.event_id !== p.event_id || r.event_version !== p.base_event_version) {
    throw new EventProposalReferenceError('investigation');
  }
  if (r.context_id === p.context_id && r.trace_id === p.trace_id) return;
  const checkpoint = await tx.query<{ checkpoint_id: string }>(
    'SELECT checkpoint_id FROM waspada.investigation_checkpoints WHERE dataset_kind=$1 AND investigation_id=$2 ' +
    'AND context_id=$3 AND trace_id=$4 AND candidate_id=$5 ' +
    'AND event_id IS NOT DISTINCT FROM $6::text AND event_version IS NOT DISTINCT FROM $7::integer',
    [p.dataset_kind, p.investigation_id, p.context_id, p.trace_id, p.candidate_id, p.event_id, p.base_event_version],
  );
  if (checkpoint.rows.length === 0) throw new EventProposalReferenceError('investigation');
}

async function verifyStoredProposal(tx: SqlExecutor, p: EventProposal, lineage: ResolvedLineage): Promise<boolean> {
  const parent = await tx.query<{ matches: boolean }>(
    'SELECT (stored.dataset_kind IS NOT DISTINCT FROM $1::text AND stored.proposal_id IS NOT DISTINCT FROM $2::text ' +
    'AND stored.trace_id IS NOT DISTINCT FROM $3::text AND stored.candidate_id IS NOT DISTINCT FROM $4::text ' +
    'AND stored.context_id IS NOT DISTINCT FROM $5::text AND stored.event_id IS NOT DISTINCT FROM $6::text ' +
    'AND stored.base_event_version IS NOT DISTINCT FROM $7::integer AND stored.investigation_id IS NOT DISTINCT FROM $8::text ' +
    'AND stored.proposed_at IS NOT DISTINCT FROM $9::timestamptz AND stored.record_json=$10::jsonb) AS matches ' +
    'FROM waspada.event_proposals stored WHERE stored.dataset_kind=$1 AND stored.proposal_id=$2',
    proposalParameters(p),
  );
  if (!parent.rows.length) return false;
  if (parent.rows[0]?.matches !== true) throw new EventProposalConflictError();
  const claims = await tx.query<{ claim_id: string; support_assessment: string; evidence_label: string; claim_text: string; record_matches: boolean }>(
    'SELECT stored.claim_id,stored.support_assessment,stored.evidence_label,stored.claim_text,(stored.record_json=input.value) AS record_matches ' +
    'FROM waspada.proposal_claims stored LEFT JOIN LATERAL jsonb_array_elements($3::jsonb) input(value) ' +
    'ON input.value->>\'claim_id\'=stored.claim_id WHERE stored.dataset_kind=$1 AND stored.proposal_id=$2',
    [p.dataset_kind, p.proposal_id, JSON.stringify(p.claims)],
  );
  if (claims.rows.length !== p.claims.length) throw new EventProposalConflictError();
  const expected = new Map(p.claims.map((c) => [c.claim_id, c]));
  for (const row of claims.rows) {
    const claim = expected.get(row.claim_id);
    if (!claim || row.support_assessment !== claim.support_assessment || row.evidence_label !== claim.evidence_label
      || row.claim_text !== claim.text || row.record_matches !== true) throw new EventProposalConflictError();
  }
  const expectedEvidence = lineage.evidenceLinks.map((x) => JSON.stringify([x.claimId, x.kind, x.evidenceRefId]));
  const storedEvidence = await tx.query<{ claim_id: string; evidence_kind: string; evidence_ref_id: string }>(
    'SELECT claim_id,evidence_kind,evidence_ref_id::text AS evidence_ref_id FROM waspada.proposal_claim_evidence WHERE dataset_kind=$1 AND proposal_id=$2',
    [p.dataset_kind, p.proposal_id],
  );
  sameSet(expectedEvidence, storedEvidence.rows.map((x) => JSON.stringify([x.claim_id, x.evidence_kind, x.evidence_ref_id])));
  const expectedOrigins = lineage.originLinks.map((x) => JSON.stringify([x.claimId, x.originId]));
  const storedOrigins = await tx.query<{ claim_id: string; origin_id: string }>(
    'SELECT claim_id,origin_id FROM waspada.proposal_claim_origins WHERE dataset_kind=$1 AND proposal_id=$2',
    [p.dataset_kind, p.proposal_id],
  );
  sameSet(expectedOrigins, storedOrigins.rows.map((x) => JSON.stringify([x.claim_id, x.origin_id])));
  return true;
}
function sameSet(expected: readonly string[], actual: readonly string[]): void {
  if (expected.length !== actual.length || new Set(expected).size !== expected.length
    || new Set(actual).size !== actual.length || expected.some((x) => !actual.includes(x))) throw new EventProposalConflictError();
}
