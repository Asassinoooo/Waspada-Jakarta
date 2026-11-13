import type { TransactionalSqlExecutor } from './sql.js';

/**
 * FR-12 source approval. An administrator records approval or revocation of a registry source. The
 * write runs in one transaction: the registry row, a request trace and an audit row.
 *
 * Approval is the registry's `approval_status`, and the existing CHECK constraints tie it to collection
 * and auto-publication settings:
 * - `auto_acquisition_enabled` may be true only while approval is `approved` (`source_registry_auto_acquisition_eligible_check`).
 * - `auto_publication_policy` must be `never` unless approval is `approved`.
 * So a revocation must also switch collection off and set the policy to `never`. The store does that in the
 * same statement and records the previous and new values. Approval never changes those two columns.
 * Public display is decided separately by evaluateSourcePermissions (news-triage.ts) and is never granted here.
 */

export type SourceApprovalTarget = 'approved' | 'revoked';
export type SourceApprovalDatasetKind = 'live' | 'historical' | 'synthetic';

export const SOURCE_APPROVAL_NOTE_MIN_LENGTH = 10;
export const SOURCE_APPROVAL_NOTE_MAX_LENGTH = 500;
const SOURCE_LIST_LIMIT = 200;
const SOURCE_ID_MAX_LENGTH = 200;

export interface SourceApprovalRecord {
  readonly source_id: string;
  readonly display_name: string;
  readonly source_kind: string;
  readonly access_method: string;
  readonly registry_status: string;
  readonly approval_status: string;
  readonly auto_acquisition_enabled: boolean;
  readonly auto_publication_policy: string;
  readonly reuse_basis: readonly string[] | null;
  readonly reuse_license_url: string | null;
  readonly reuse_scope: string | null;
  readonly reuse_reviewer: string | null;
  readonly reuse_reviewed_at: string | null;
  readonly reuse_expires_at: string | null;
}

export interface SourceApprovalWriteInput {
  readonly sourceId: string;
  readonly status: SourceApprovalTarget;
  readonly note: string;
  readonly actorId: string;
  readonly traceId: string;
  readonly auditId: string;
  readonly occurredAt: string;
}

export type SourceApprovalWriteResult =
  | { readonly outcome: 'updated'; readonly before: SourceApprovalRecord; readonly after: SourceApprovalRecord }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'unchanged'; readonly current: SourceApprovalRecord };

export interface SourceApprovalStore {
  listSources(): Promise<readonly SourceApprovalRecord[]>;
  setApproval(input: SourceApprovalWriteInput): Promise<SourceApprovalWriteResult>;
}

interface SourceRow {
  source_id: string;
  display_name: string;
  source_kind: string;
  access_method: string;
  registry_status: string;
  approval_status: string;
  auto_acquisition_enabled: boolean;
  auto_publication_policy: string;
  reuse_basis: string[] | null;
  reuse_license_url: string | null;
  reuse_scope: string | null;
  reuse_reviewer: string | null;
  reuse_reviewed_at: string | null;
  reuse_expires_at: string | null;
}

const SOURCE_COLUMNS = `source_id, display_name, source_kind, access_method, registry_status, approval_status,
  auto_acquisition_enabled, auto_publication_policy, reuse_basis, reuse_license_url, reuse_scope,
  reuse_reviewer, reuse_reviewed_at::text AS reuse_reviewed_at, reuse_expires_at::text AS reuse_expires_at`;

function toRecord(row: SourceRow): SourceApprovalRecord {
  return {
    source_id: row.source_id,
    display_name: row.display_name,
    source_kind: row.source_kind,
    access_method: row.access_method,
    registry_status: row.registry_status,
    approval_status: row.approval_status,
    auto_acquisition_enabled: row.auto_acquisition_enabled === true,
    auto_publication_policy: row.auto_publication_policy,
    reuse_basis: Array.isArray(row.reuse_basis) ? row.reuse_basis : null,
    reuse_license_url: row.reuse_license_url,
    reuse_scope: row.reuse_scope,
    reuse_reviewer: row.reuse_reviewer,
    reuse_reviewed_at: row.reuse_reviewed_at,
    reuse_expires_at: row.reuse_expires_at,
  };
}

function requireText(value: string, label: string, maximum: number): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    throw new TypeError(`${label} is invalid.`);
  }
}

function requireInstant(value: string): void {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new TypeError('Approval timestamp is invalid.');
  }
}

/**
 * Creates the source approval repository for one server-selected dataset. The registry itself has no
 * dataset column, so the dataset scopes the trace and the audit row that every write creates.
 */
export function createSourceApprovalStore(
  executor: TransactionalSqlExecutor,
  datasetKind: SourceApprovalDatasetKind,
): SourceApprovalStore {
  if (datasetKind !== 'live' && datasetKind !== 'historical' && datasetKind !== 'synthetic') {
    throw new TypeError('Source approval dataset must be configured by the server.');
  }

  return {
    async listSources() {
      const result = await executor.query<SourceRow>(
        `SELECT ${SOURCE_COLUMNS}
         FROM waspada.source_registry
         ORDER BY source_id COLLATE "C" ASC
         LIMIT $1`,
        [SOURCE_LIST_LIMIT],
      );
      return result.rows.map(toRecord);
    },

    async setApproval(input) {
      requireText(input.sourceId, 'Source id', SOURCE_ID_MAX_LENGTH);
      requireText(input.actorId, 'Actor id', 128);
      requireText(input.traceId, 'Trace id', 200);
      requireText(input.auditId, 'Audit id', 200);
      requireInstant(input.occurredAt);
      if (input.status !== 'approved' && input.status !== 'revoked') {
        throw new TypeError('Source approval status is invalid.');
      }
      const note = typeof input.note === 'string' ? input.note.trim() : '';
      if (note.length < SOURCE_APPROVAL_NOTE_MIN_LENGTH || note.length > SOURCE_APPROVAL_NOTE_MAX_LENGTH) {
        throw new TypeError('Source approval note must be 10 to 500 characters.');
      }

      return executor.transaction<SourceApprovalWriteResult>(async (transaction) => {
        // Lock the row so the previous status and the audit row describe the same state.
        const locked = await transaction.query<SourceRow>(
          `SELECT ${SOURCE_COLUMNS} FROM waspada.source_registry WHERE source_id = $1 FOR UPDATE`,
          [input.sourceId],
        );
        const current = locked.rows[0];
        if (!current) return { outcome: 'not_found' };
        const before = toRecord(current);
        if (before.approval_status === input.status) return { outcome: 'unchanged', current: before };

        const revoking = input.status === 'revoked';
        const nextAutoAcquisition = revoking ? false : before.auto_acquisition_enabled;
        const nextPolicy = revoking ? 'never' : before.auto_publication_policy;
        const updated = await transaction.query<SourceRow>(
          `UPDATE waspada.source_registry
           SET approval_status = $2, auto_acquisition_enabled = $3, auto_publication_policy = $4
           WHERE source_id = $1 AND approval_status = $5
           RETURNING ${SOURCE_COLUMNS}`,
          [input.sourceId, input.status, nextAutoAcquisition, nextPolicy, before.approval_status],
        );
        const row = updated.rows[0];
        if (!row) throw new Error('Source approval changed concurrently; the write was rolled back.');
        const after = toRecord(row);

        await transaction.query(
          `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, ended_at, outcome, metadata)
           VALUES ($1, $2, $3::timestamptz, $3::timestamptz, 'succeeded', $4::jsonb)`,
          [input.traceId, datasetKind, input.occurredAt,
            JSON.stringify({ kind: 'admin_source_approval' })],
        );
        await transaction.query(
          `INSERT INTO waspada.audit_records
             (dataset_kind, audit_id, trace_id, occurred_at, actor_id, action,
              entity_type, entity_id, reason, details)
           VALUES ($1, $2, $3, $4::timestamptz, $5, $6, 'source', $7, $8, $9::jsonb)`,
          [datasetKind, input.auditId, input.traceId, input.occurredAt, input.actorId,
            `source_approval_${input.status}`, input.sourceId, note,
            JSON.stringify({
              previous_approval_status: before.approval_status,
              approval_status: after.approval_status,
              previous_auto_acquisition_enabled: before.auto_acquisition_enabled,
              auto_acquisition_enabled: after.auto_acquisition_enabled,
              previous_auto_publication_policy: before.auto_publication_policy,
              auto_publication_policy: after.auto_publication_policy,
            })],
        );
        return { outcome: 'updated', before, after };
      });
    },
  };
}
