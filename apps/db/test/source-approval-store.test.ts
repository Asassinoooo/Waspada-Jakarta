import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import { createSourceApprovalStore, type SourceApprovalStore } from '../src/source-approval-store.js';
import type { SqlExecutor, TransactionalSqlExecutor } from '../src/sql.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

/**
 * FR-12 source approval (synthetic fixtures only). The store records an administrator's approval or
 * revocation of a registry source in one transaction: the registry row, a request trace and an audit
 * row. Every assertion reads the rows back from the database.
 *
 * Rule under test (HOSTED-28, owner decision 18 Nov 2026; FR-16): revoke sets the policy to `never` and leaves
 * collection as it is; approve sets the approval status only; neither action changes collection or published events.
 */

/** Records every INSERT, UPDATE and DELETE the store sends, including the statements inside its transaction. */
function recordingExecutor(base: TransactionalSqlExecutor, writes: string[]): TransactionalSqlExecutor {
  const wrap = (executor: SqlExecutor): SqlExecutor => ({
    query<Row extends object = Record<string, unknown>>(statement: string, parameters?: readonly unknown[]) {
      if (/^\s*(insert|update|delete)\b/iu.test(statement)) writes.push(statement);
      return executor.query<Row>(statement, parameters);
    },
    execute(statement: string) {
      if (/^\s*(insert|update|delete)\b/iu.test(statement)) writes.push(statement);
      return executor.execute(statement);
    },
  });
  return {
    ...wrap(base),
    transaction<Result>(work: (transaction: SqlExecutor) => Promise<Result>): Promise<Result> {
      return base.transaction<Result>((transaction) => work(wrap(transaction)));
    },
  };
}

const NOTE = 'Dicek ulang syarat penggunaan sumber ini pada 13 November 2026.';
const ACTOR = 'admin-account-1';

describe('FR-12 source approval store', () => {
  let db: TestDatabase;
  let store: SourceApprovalStore;
  let counter = 0;

  const nextIds = () => {
    counter += 1;
    return { traceId: `trace-approval-${counter}`, auditId: `audit-approval-${counter}` };
  };

  before(async () => {
    db = await createTestDatabase();
    const migrations = await readMigrations(new URL('../migrations/', import.meta.url));
    await applyMigrations(db.executor, migrations);
    await db.executor.query(
      `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
       VALUES ('trace-seed-sources', 'live', '2026-11-01T00:00:00Z', 'succeeded', '{}'::jsonb)`,
    );
    // Pending source with collection off: approval sets the status only, so collection stays off.
    await insertSource('source-pending', 'pending', false, 'never', 'newsroom');
    // Approved, collecting, issuer-notice auto-publication: revoking stops the policy; collection stays on.
    await insertSource('source-approved-live', 'approved', true, 'approved_issuer_notice', 'authority', ['public_display']);
    // Revoked source with collection off: approval sets the status only; collection stays off and the policy stays `never`.
    await insertSource('source-revoked', 'revoked', false, 'never', 'newsroom');
    // Paused and retired registry entries: approval must leave collection off.
    await insertSource('source-paused', 'pending', false, 'never', 'newsroom', ['model_triage'], 'paused');
    await insertSource('source-retired', 'revoked', false, 'never', 'newsroom', ['model_triage'], 'retired');
    store = createSourceApprovalStore(db.executor, 'live');
  });

  after(async () => db?.close());

  async function insertSource(
    sourceId: string,
    approval: string,
    autoAcquisition: boolean,
    policy: string,
    kind: string,
    reuseBasis: string[] = ['model_triage'],
    registryStatus: string = 'active',
  ): Promise<void> {
    await db.executor.query(
      `INSERT INTO waspada.source_registry
         (source_id, trace_id, registry_version, display_name, source_kind, remit,
          access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
          approval_status, health_status, auto_acquisition_enabled, auto_publication_policy,
          polling_interval_seconds)
       VALUES ($1, 'trace-seed-sources', 1, $1, $2, ARRAY['banjir'], 'rss', ARRAY[]::text[],
          ARRAY['synthetic test fixture'], $3::text[], $7, $4, 'unknown', $5, $6,
          CASE WHEN $5 THEN 300 ELSE NULL END)`,
      [sourceId, kind, reuseBasis, approval, autoAcquisition, policy, registryStatus],
    );
  }

  async function registryRow(sourceId: string) {
    const rows = await db.executor.query<{
      approval_status: string;
      auto_acquisition_enabled: boolean;
      auto_publication_policy: string;
    }>(
      `SELECT approval_status, auto_acquisition_enabled, auto_publication_policy
       FROM waspada.source_registry WHERE source_id = $1`,
      [sourceId],
    );
    return rows.rows[0];
  }

  async function auditRows(sourceId: string) {
    const rows = await db.executor.query<{
      dataset_kind: string;
      audit_id: string;
      trace_id: string;
      actor_id: string;
      action: string;
      entity_type: string;
      entity_id: string;
      reason: string;
      details: Record<string, unknown>;
    }>(
      `SELECT dataset_kind, audit_id, trace_id, actor_id, action, entity_type, entity_id, reason, details
       FROM waspada.audit_records WHERE entity_id = $1 ORDER BY occurred_at, audit_id`,
      [sourceId],
    );
    return rows.rows;
  }

  async function traceRow(traceId: string) {
    const rows = await db.executor.query<{ dataset_kind: string; outcome: string; ended_at: string | null }>(
      `SELECT dataset_kind, outcome, ended_at::text AS ended_at FROM waspada.traces WHERE trace_id = $1`,
      [traceId],
    );
    return rows.rows[0];
  }

  it('lists registry sources in source_id order with their approval and collection fields', async () => {
    const sources = await store.listSources();
    assert.deepEqual(sources.map((source) => source.source_id), [
      'source-approved-live', 'source-paused', 'source-pending', 'source-retired', 'source-revoked',
    ]);
    const approved = sources[0]!;
    assert.equal(approved.approval_status, 'approved');
    assert.equal(approved.auto_acquisition_enabled, true);
    assert.equal(approved.auto_publication_policy, 'approved_issuer_notice');
    assert.deepEqual(approved.reuse_basis, ['public_display']);
  });

  it('approving a pending source sets the status only: collection stays off, the policy stays never, and a trace and audit row are read back from the database', async () => {
    const ids = nextIds();
    const result = await store.setApproval({
      sourceId: 'source-pending', status: 'approved', note: NOTE, actorId: ACTOR,
      traceId: ids.traceId, auditId: ids.auditId, occurredAt: '2026-11-13T09:00:00.000Z',
    });
    assert.equal(result.outcome, 'updated');
    if (result.outcome !== 'updated') return;
    assert.equal(result.before.approval_status, 'pending');
    assert.equal(result.after.approval_status, 'approved');

    assert.deepEqual(await registryRow('source-pending'), {
      approval_status: 'approved',
      auto_acquisition_enabled: false,
      auto_publication_policy: 'never',
    }, 'approval does not start collection; the auto-publication policy is not changed');

    const audits = await auditRows('source-pending');
    assert.equal(audits.length, 1);
    const audit = audits[0]!;
    assert.equal(audit.action, 'source_approval_approved');
    assert.equal(audit.entity_type, 'source');
    assert.equal(audit.actor_id, ACTOR);
    assert.equal(audit.reason, NOTE);
    assert.equal(audit.trace_id, ids.traceId);
    assert.equal(audit.dataset_kind, 'live');
    assert.equal(audit.details.previous_approval_status, 'pending');
    assert.equal(audit.details.approval_status, 'approved');
    assert.equal(audit.details.previous_auto_acquisition_enabled, false);
    assert.equal(audit.details.auto_acquisition_enabled, false, 'approval leaves collection unchanged');

    const trace = await traceRow(ids.traceId);
    assert.deepEqual(trace, { dataset_kind: 'live', outcome: 'succeeded', ended_at: trace?.ended_at });
    assert.notEqual(trace?.ended_at, null);
  });

  it('revoking an approved, collecting source stops its issuer-notice auto-publication only: collection stays on, and the audit row records the policy change', async () => {
    const ids = nextIds();
    const result = await store.setApproval({
      sourceId: 'source-approved-live', status: 'revoked', note: NOTE, actorId: ACTOR,
      traceId: ids.traceId, auditId: ids.auditId, occurredAt: '2026-11-13T09:05:00.000Z',
    });
    assert.equal(result.outcome, 'updated');

    assert.deepEqual(await registryRow('source-approved-live'), {
      approval_status: 'revoked',
      auto_acquisition_enabled: true,
      auto_publication_policy: 'never',
    }, 'FR-16: revocation stops publication; collection continues');

    const audit = (await auditRows('source-approved-live')).at(-1)!;
    assert.equal(audit.action, 'source_approval_revoked');
    assert.equal(audit.details.previous_approval_status, 'approved');
    assert.equal(audit.details.approval_status, 'revoked');
    assert.equal(audit.details.previous_auto_acquisition_enabled, true);
    assert.equal(audit.details.auto_acquisition_enabled, true, 'revocation leaves collection unchanged');
    assert.equal(audit.details.previous_auto_publication_policy, 'approved_issuer_notice');
    assert.equal(audit.details.auto_publication_policy, 'never');
  });

  it('revoke then approve leaves collection on throughout, and the audit log holds both transitions', async () => {
    const ids = nextIds();
    const result = await store.setApproval({
      sourceId: 'source-approved-live', status: 'approved', note: NOTE, actorId: ACTOR,
      traceId: ids.traceId, auditId: ids.auditId, occurredAt: '2026-11-13T09:07:00.000Z',
    });
    assert.equal(result.outcome, 'updated');
    if (result.outcome !== 'updated') return;
    assert.equal(result.before.auto_acquisition_enabled, true);
    assert.equal(result.after.auto_acquisition_enabled, true);

    assert.deepEqual(await registryRow('source-approved-live'), {
      approval_status: 'approved',
      auto_acquisition_enabled: true,
      auto_publication_policy: 'never',
    }, 'collection was never off; the policy stays never until an operator sets it again');

    const audits = await auditRows('source-approved-live');
    assert.deepEqual(audits.map((row) => row.action), ['source_approval_revoked', 'source_approval_approved']);
    const approval = audits[1]!;
    assert.equal(approval.details.previous_approval_status, 'revoked');
    assert.equal(approval.details.approval_status, 'approved');
    assert.equal(approval.details.previous_auto_acquisition_enabled, true);
    assert.equal(approval.details.auto_acquisition_enabled, true);
    assert.equal(approval.details.previous_auto_publication_policy, 'never');
    assert.equal(approval.details.auto_publication_policy, 'never');
  });

  it('revoke writes only the registry, trace and audit tables, so published public rows are not touched (structural check; no public rows are seeded here)', async () => {
    const writes: string[] = [];
    const recordingStore = createSourceApprovalStore(recordingExecutor(db.executor, writes), 'live');
    const ids = nextIds();
    const result = await recordingStore.setApproval({
      sourceId: 'source-approved-live', status: 'revoked', note: NOTE, actorId: ACTOR,
      traceId: ids.traceId, auditId: ids.auditId, occurredAt: '2026-11-13T09:20:00.000Z',
    });
    assert.equal(result.outcome, 'updated');
    assert.deepEqual(
      writes.map((sql) => sql.match(/waspada\.(\w+)/u)?.[1]),
      ['source_registry', 'traces', 'audit_records'],
    );
    assert.ok(writes.every((sql) => !/public_/iu.test(sql)), 'no write statement names a public_* table');
    assert.deepEqual(await registryRow('source-approved-live'), {
      approval_status: 'revoked',
      auto_acquisition_enabled: true,
      auto_publication_policy: 'never',
    });
  });

  it('approving a revoked source with collection off sets the status only: collection stays off and the policy stays never', async () => {
    const ids = nextIds();
    const result = await store.setApproval({
      sourceId: 'source-revoked', status: 'approved', note: NOTE, actorId: ACTOR,
      traceId: ids.traceId, auditId: ids.auditId, occurredAt: '2026-11-13T09:10:00.000Z',
    });
    assert.equal(result.outcome, 'updated');
    assert.deepEqual(await registryRow('source-revoked'), {
      approval_status: 'approved',
      auto_acquisition_enabled: false,
      auto_publication_policy: 'never',
    });
  });

  it('approving a paused or retired source keeps collection off, and the audit row records that', async () => {
    for (const [index, sourceId] of ['source-paused', 'source-retired'].entries()) {
      const ids = nextIds();
      const result = await store.setApproval({
        sourceId, status: 'approved', note: NOTE, actorId: ACTOR,
        traceId: ids.traceId, auditId: ids.auditId, occurredAt: `2026-11-13T09:3${index}:00.000Z`,
      });
      assert.equal(result.outcome, 'updated', sourceId);
      assert.deepEqual(await registryRow(sourceId), {
        approval_status: 'approved',
        auto_acquisition_enabled: false,
        auto_publication_policy: 'never',
      }, sourceId);
      const audit = (await auditRows(sourceId)).at(-1)!;
      assert.equal(audit.action, 'source_approval_approved', sourceId);
      assert.equal(audit.details.auto_acquisition_enabled, false, sourceId);
    }
  });

  it('a request that matches the current status changes nothing and writes no audit or trace row', async () => {
    const auditsBefore = (await auditRows('source-revoked')).length;
    const tracesBefore = await db.executor.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM waspada.traces WHERE trace_id LIKE 'trace-approval-%'`,
    );
    const ids = nextIds();
    const result = await store.setApproval({
      sourceId: 'source-revoked', status: 'approved', note: NOTE, actorId: ACTOR,
      traceId: ids.traceId, auditId: ids.auditId, occurredAt: '2026-11-13T09:11:00.000Z',
    });
    assert.equal(result.outcome, 'unchanged');
    assert.equal((await auditRows('source-revoked')).length, auditsBefore);
    const tracesAfter = await db.executor.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM waspada.traces WHERE trace_id LIKE 'trace-approval-%'`,
    );
    assert.equal(tracesAfter.rows[0]?.count, tracesBefore.rows[0]?.count);
    assert.equal(await traceRow(ids.traceId), undefined);
  });

  it('an unknown source is reported as not found and writes nothing', async () => {
    const ids = nextIds();
    const result = await store.setApproval({
      sourceId: 'source-does-not-exist', status: 'approved', note: NOTE, actorId: ACTOR,
      traceId: ids.traceId, auditId: ids.auditId, occurredAt: '2026-11-13T09:12:00.000Z',
    });
    assert.deepEqual(result, { outcome: 'not_found' });
    assert.equal(await traceRow(ids.traceId), undefined);
    assert.equal((await auditRows('source-does-not-exist')).length, 0);
  });

  it('refuses a note outside 10 to 500 characters before touching the database', async () => {
    const ids = nextIds();
    const base = {
      sourceId: 'source-pending', status: 'approved' as const, actorId: ACTOR,
      traceId: ids.traceId, auditId: ids.auditId, occurredAt: '2026-11-13T09:13:00.000Z',
    };
    await assert.rejects(store.setApproval({ ...base, note: 'pendek' }), TypeError);
    await assert.rejects(store.setApproval({ ...base, note: 'x'.repeat(501) }), TypeError);
    assert.equal(await traceRow(ids.traceId), undefined);
    assert.equal((await registryRow('source-pending'))?.approval_status, 'approved');
  });

  it('migration 056: collection needs an active registry entry, not approval, so the CHECK allows collection while pending and refuses it for a paused entry', async () => {
    await insertSource('source-pending-collecting', 'pending', true, 'never', 'newsroom');
    assert.deepEqual(await registryRow('source-pending-collecting'), {
      approval_status: 'pending',
      auto_acquisition_enabled: true,
      auto_publication_policy: 'never',
    });
    await assert.rejects(
      insertSource('source-paused-collecting', 'pending', true, 'never', 'newsroom', ['model_triage'], 'paused'),
      /source_registry_auto_acquisition_eligible_check/,
    );
  });
});
