import { createHash } from 'node:crypto';
import { createSqlEvidenceRetrievalRepository, type EvidenceRetrievalRepository } from './evidence-retrieval.js';
import { createSqlEvidenceChunkRepository, type EvidenceChunkRepository } from './evidence-chunks.js';
import { SqlAcquisitionJobRepository, type AcquisitionJobRepository } from './queue.js';
import type { SqlExecutor } from './sql.js';

export type DatasetKind = 'live' | 'historical' | 'synthetic';
export type JsonObject = Readonly<Record<string, unknown>>;

export type RegistryStatus = 'active' | 'paused' | 'retired';
export type ApprovalStatus = 'pending' | 'approved' | 'suspended' | 'revoked';
export type HealthStatus = 'unknown' | 'healthy' | 'degraded' | 'unavailable';
export type RevisionStatus = 'unreviewed' | 'eligible' | 'quarantined' | 'superseded' | 'retracted';
export type EvidenceRelation = 'supports' | 'contradicts' | 'context';

export interface SourceRegistryRecord {
  readonly sourceId: string;
  readonly traceId: string;
  readonly registryVersion: number;
  readonly displayName: string;
  readonly sourceKind: 'authority' | 'operator' | 'newsroom' | 'institution' | 'crowdsourced_platform' | 'other';
  readonly publisherGroupId: string | null;
  readonly remit: readonly string[];
  readonly accessMethod: 'api' | 'rss' | 'public_web' | 'moderator_submission' | 'manual_fixture';
  readonly approvedHosts: readonly string[];
  readonly accessRestrictions: readonly string[];
  readonly reuseBasis: readonly string[];
  readonly registryStatus: RegistryStatus;
  readonly approvalStatus: ApprovalStatus;
  readonly healthStatus: HealthStatus;
  readonly autoAcquisitionEnabled: boolean;
  readonly autoPublicationPolicy: 'never' | 'approved_issuer_notice';
  readonly pollingIntervalSeconds: number | null;
  readonly lastCheckedAt: string | null;
  readonly lastSuccessAt: string | null;
}

export interface NewReportRevision {
  readonly datasetKind: DatasetKind;
  readonly reportRevisionId: string;
  readonly traceId: string;
  readonly sourceId: string;
  readonly canonicalUrl: string;
  readonly sourceRevisionKey: string | null;
  readonly contentHash: string;
  readonly permittedText: string;
  readonly permittedTextHash: string;
  readonly normalizationVersion: string;
  readonly publishedAt: string | null;
  readonly observedAt: string | null;
  readonly retrievedAt: string;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
  readonly supersedesId: string | null;
  readonly revisionStatus: RevisionStatus;
  readonly recordJson: JsonObject;
}

export interface ReportRevisionRecord extends NewReportRevision {}

export interface NewEvidenceReference {
  readonly datasetKind: DatasetKind;
  readonly traceId: string;
  readonly reportRevisionId: string;
  readonly permittedTextHash: string;
  readonly spanStart: number;
  readonly spanEnd: number;
  readonly relation: EvidenceRelation;
}

export interface TraceRecord {
  readonly traceId: string;
  readonly datasetKind: DatasetKind | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly outcome: 'open' | 'succeeded' | 'failed' | 'cancelled' | null;
  readonly metadata: JsonObject;
}

export interface AuditRecord {
  readonly datasetKind: DatasetKind;
  readonly auditId: string;
  readonly traceId: string;
  readonly occurredAt: string;
  readonly actorId: string | null;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly reason: string | null;
  readonly details: JsonObject;
}

export interface SourceRegistryRepository {
  findById(sourceId: string): Promise<SourceRegistryRecord | null>;
}

export interface ReportRevisionRepository {
  create(input: NewReportRevision): Promise<void>;
  findById(datasetKind: DatasetKind, reportRevisionId: string): Promise<ReportRevisionRecord | null>;
  createEvidenceReference(input: NewEvidenceReference): Promise<string>;
}

export interface TraceAuditRepository {
  createTrace(input: TraceRecord): Promise<void>;
  finishTrace(
    traceId: string,
    datasetKind: DatasetKind | null,
    endedAt: string,
    outcome: Exclude<TraceRecord['outcome'], 'open' | null>,
    metadata: JsonObject,
  ): Promise<boolean>;
  appendAuditRecord(input: AuditRecord): Promise<void>;
  listAuditByTraceId(traceId: string, datasetKind: DatasetKind): Promise<readonly AuditRecord[]>;
}

export interface RepositoryPorts {
  readonly sourceRegistry: SourceRegistryRepository;
  readonly reportRevisions: ReportRevisionRepository;
  readonly evidenceChunks: EvidenceChunkRepository;
  readonly evidenceRetrieval: EvidenceRetrievalRepository;
  readonly tracesAndAudit: TraceAuditRepository;
  readonly acquisitionJobs: AcquisitionJobRepository;
}

export function createRepositoryPorts(executor: SqlExecutor): RepositoryPorts {
  return {
    sourceRegistry: new SqlSourceRegistryRepository(executor),
    reportRevisions: new SqlReportRevisionRepository(executor),
    evidenceChunks: createSqlEvidenceChunkRepository(executor),
    evidenceRetrieval: createSqlEvidenceRetrievalRepository(executor),
    tracesAndAudit: new SqlTraceAuditRepository(executor),
    acquisitionJobs: new SqlAcquisitionJobRepository(executor),
  };
}

class SqlSourceRegistryRepository implements SourceRegistryRepository {
  constructor(private readonly executor: SqlExecutor) {}

  async findById(sourceId: string): Promise<SourceRegistryRecord | null> {
    const result = await this.executor.query<SourceRegistryRecordRow>(
      `SELECT source_id, trace_id, registry_version, display_name, source_kind,
              publisher_group_id, remit, access_method, approved_hosts, access_restrictions,
              reuse_basis, registry_status, approval_status, health_status,
              auto_acquisition_enabled, auto_publication_policy, polling_interval_seconds,
              last_checked_at::text AS last_checked_at, last_success_at::text AS last_success_at
       FROM waspada.source_registry
       WHERE source_id = $1`,
      [sourceId],
    );
    const row = result.rows[0];
    return row ? mapSourceRegistry(row) : null;
  }
}

class SqlReportRevisionRepository implements ReportRevisionRepository {
  constructor(private readonly executor: SqlExecutor) {}

  async create(input: NewReportRevision): Promise<void> {
    validateRevision(input);
    await this.executor.query(
      `INSERT INTO waspada.report_revisions
         (dataset_kind, report_revision_id, trace_id, source_id, canonical_url,
          source_revision_key, content_hash, permitted_text, permitted_text_hash,
          normalization_version, published_at, observed_at, retrieved_at, valid_from,
          valid_until, supersedes_id, revision_status, record_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb)`,
      [
        input.datasetKind,
        input.reportRevisionId,
        input.traceId,
        input.sourceId,
        input.canonicalUrl,
        input.sourceRevisionKey,
        input.contentHash,
        input.permittedText,
        input.permittedTextHash,
        input.normalizationVersion,
        input.publishedAt,
        input.observedAt,
        input.retrievedAt,
        input.validFrom,
        input.validUntil,
        input.supersedesId,
        input.revisionStatus,
        JSON.stringify(input.recordJson),
      ],
    );
  }

  async findById(datasetKind: DatasetKind, reportRevisionId: string): Promise<ReportRevisionRecord | null> {
    const result = await this.executor.query<ReportRevisionRecordRow>(
      `SELECT dataset_kind, report_revision_id, trace_id, source_id, canonical_url,
              source_revision_key, content_hash, permitted_text, permitted_text_hash,
              normalization_version, published_at::text AS published_at,
              observed_at::text AS observed_at, retrieved_at::text AS retrieved_at,
              valid_from::text AS valid_from, valid_until::text AS valid_until,
              supersedes_id, revision_status, record_json
       FROM waspada.report_revisions
       WHERE dataset_kind = $1 AND report_revision_id = $2`,
      [datasetKind, reportRevisionId],
    );
    const row = result.rows[0];
    return row ? mapReportRevision(row) : null;
  }

  async createEvidenceReference(input: NewEvidenceReference): Promise<string> {
    const revision = await this.findById(input.datasetKind, input.reportRevisionId);
    if (!revision) {
      throw new Error(`Report revision not found in dataset ${input.datasetKind}: ${input.reportRevisionId}`);
    }
    if (revision.permittedTextHash !== input.permittedTextHash) {
      throw new Error('Evidence reference hash does not match its immutable report revision');
    }
    const codePointLength = Array.from(revision.permittedText).length;
    if (!Number.isInteger(input.spanStart) || !Number.isInteger(input.spanEnd)
      || input.spanStart < 0 || input.spanEnd <= input.spanStart || input.spanEnd > codePointLength) {
      throw new Error('Evidence span must be a non-empty Unicode code-point range within the report revision');
    }

    const result = await this.executor.query<{ evidence_ref_id: string | number | bigint }>(
      `INSERT INTO waspada.evidence_references
         (dataset_kind, trace_id, report_revision_id, permitted_text_hash,
          span_start, span_end, offset_unit, relation)
       VALUES ($1, $2, $3, $4, $5, $6, 'unicode_code_points', $7)
       RETURNING evidence_ref_id`,
      [input.datasetKind, input.traceId, input.reportRevisionId, input.permittedTextHash,
        input.spanStart, input.spanEnd, input.relation],
    );
    const id = result.rows[0]?.evidence_ref_id;
    if (id === undefined) throw new Error('Database did not return the evidence reference ID');
    return String(id);
  }
}

class SqlTraceAuditRepository implements TraceAuditRepository {
  constructor(private readonly executor: SqlExecutor) {}

  async createTrace(input: TraceRecord): Promise<void> {
    await this.executor.query(
      `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, ended_at, outcome, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [input.traceId, input.datasetKind, input.startedAt, input.endedAt, input.outcome, JSON.stringify(input.metadata)],
    );
  }

  async finishTrace(
    traceId: string,
    datasetKind: DatasetKind | null,
    endedAt: string,
    outcome: Exclude<TraceRecord['outcome'], 'open' | null>,
    metadata: JsonObject,
  ): Promise<boolean> {
    const result = await this.executor.query<{ trace_id: string }>(
      `UPDATE waspada.traces
       SET ended_at = $3, outcome = $4, metadata = $5::jsonb
       WHERE trace_id = $1 AND dataset_kind IS NOT DISTINCT FROM $2
         AND ended_at IS NULL AND (outcome IS NULL OR outcome = 'open')
       RETURNING trace_id`,
      [traceId, datasetKind, endedAt, outcome, JSON.stringify(metadata)],
    );
    return result.rows.length === 1;
  }

  async appendAuditRecord(input: AuditRecord): Promise<void> {
    await this.executor.query(
      `INSERT INTO waspada.audit_records
         (dataset_kind, audit_id, trace_id, occurred_at, actor_id, action,
          entity_type, entity_id, reason, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
      [input.datasetKind, input.auditId, input.traceId, input.occurredAt, input.actorId,
        input.action, input.entityType, input.entityId, input.reason, JSON.stringify(input.details)],
    );
  }

  async listAuditByTraceId(traceId: string, datasetKind: DatasetKind): Promise<readonly AuditRecord[]> {
    const result = await this.executor.query<AuditRecordRow>(
      `SELECT dataset_kind, audit_id, trace_id, occurred_at::text AS occurred_at,
              actor_id, action, entity_type, entity_id, reason, details
       FROM waspada.audit_records
       WHERE trace_id = $1 AND dataset_kind = $2
       ORDER BY occurred_at, audit_id`,
      [traceId, datasetKind],
    );
    return result.rows.map(mapAuditRecord);
  }
}

function validateRevision(input: NewReportRevision): void {
  if (!/^[0-9a-f]{64}$/.test(input.permittedTextHash)) {
    throw new Error('permitted_text_hash must be a lowercase SHA-256 digest');
  }
  const actualHash = createHash('sha256').update(input.permittedText, 'utf8').digest('hex');
  if (actualHash !== input.permittedTextHash) {
    throw new Error('permitted_text_hash does not match the exact permitted_text');
  }
  if (input.validFrom !== null && input.validUntil !== null
    && Date.parse(input.validFrom) >= Date.parse(input.validUntil)) {
    throw new Error('valid_from must be earlier than valid_until');
  }
}

interface SourceRegistryRecordRow {
  source_id: string;
  trace_id: string;
  registry_version: number;
  display_name: string;
  source_kind: SourceRegistryRecord['sourceKind'];
  publisher_group_id: string | null;
  remit: string[];
  access_method: SourceRegistryRecord['accessMethod'];
  approved_hosts: string[];
  access_restrictions: string[];
  reuse_basis: string[];
  registry_status: RegistryStatus;
  approval_status: ApprovalStatus;
  health_status: HealthStatus;
  auto_acquisition_enabled: boolean;
  auto_publication_policy: SourceRegistryRecord['autoPublicationPolicy'];
  polling_interval_seconds: number | null;
  last_checked_at: string | null;
  last_success_at: string | null;
}

interface ReportRevisionRecordRow {
  dataset_kind: DatasetKind;
  report_revision_id: string;
  trace_id: string;
  source_id: string;
  canonical_url: string;
  source_revision_key: string | null;
  content_hash: string;
  permitted_text: string;
  permitted_text_hash: string;
  normalization_version: string;
  published_at: string | null;
  observed_at: string | null;
  retrieved_at: string;
  valid_from: string | null;
  valid_until: string | null;
  supersedes_id: string | null;
  revision_status: RevisionStatus;
  record_json: JsonObject;
}

interface AuditRecordRow {
  dataset_kind: DatasetKind;
  audit_id: string;
  trace_id: string;
  occurred_at: string;
  actor_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  reason: string | null;
  details: JsonObject;
}

function mapSourceRegistry(row: SourceRegistryRecordRow): SourceRegistryRecord {
  return {
    sourceId: row.source_id,
    traceId: row.trace_id,
    registryVersion: row.registry_version,
    displayName: row.display_name,
    sourceKind: row.source_kind,
    publisherGroupId: row.publisher_group_id,
    remit: row.remit,
    accessMethod: row.access_method,
    approvedHosts: row.approved_hosts,
    accessRestrictions: row.access_restrictions,
    reuseBasis: row.reuse_basis,
    registryStatus: row.registry_status,
    approvalStatus: row.approval_status,
    healthStatus: row.health_status,
    autoAcquisitionEnabled: row.auto_acquisition_enabled,
    autoPublicationPolicy: row.auto_publication_policy,
    pollingIntervalSeconds: row.polling_interval_seconds,
    lastCheckedAt: row.last_checked_at,
    lastSuccessAt: row.last_success_at,
  };
}

function mapReportRevision(row: ReportRevisionRecordRow): ReportRevisionRecord {
  return {
    datasetKind: row.dataset_kind,
    reportRevisionId: row.report_revision_id,
    traceId: row.trace_id,
    sourceId: row.source_id,
    canonicalUrl: row.canonical_url,
    sourceRevisionKey: row.source_revision_key,
    contentHash: row.content_hash,
    permittedText: row.permitted_text,
    permittedTextHash: row.permitted_text_hash,
    normalizationVersion: row.normalization_version,
    publishedAt: row.published_at,
    observedAt: row.observed_at,
    retrievedAt: row.retrieved_at,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    supersedesId: row.supersedes_id,
    revisionStatus: row.revision_status,
    recordJson: row.record_json,
  };
}

function mapAuditRecord(row: AuditRecordRow): AuditRecord {
  return {
    datasetKind: row.dataset_kind,
    auditId: row.audit_id,
    traceId: row.trace_id,
    occurredAt: row.occurred_at,
    actorId: row.actor_id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    reason: row.reason,
    details: row.details,
  };
}
