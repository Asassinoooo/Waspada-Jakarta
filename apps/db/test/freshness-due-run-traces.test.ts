import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

const STARTED_AT = '2026-10-02T10:00:00.123456Z';
const FINISHED_AT = '2026-10-02T10:05:00.654321Z';
const TRIGGER = 'freshness_due_evaluation';
const SUCCESS_SUMMARY = { written: 3, replayed: 1, noChange: 2, conflicts: 0, failures: 0 };
const FAILURE_SUMMARY = { written: 1, replayed: 0, noChange: 0, conflicts: 1, failures: 1 };

interface TraceRow {
  readonly trace_id: string;
  readonly dataset_kind: string | null;
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly outcome: string | null;
  readonly metadata: Record<string, unknown>;
}

describe('LIFE-01-FRESHNESS-DUE-RUN-TRACE-CORE', () => {
  let database: TestDatabase;
  let unrelatedBefore: readonly TraceRow[];

  before(async () => {
    database = await createTestDatabase();
    const migrations = await readMigrations(new URL('../migrations/', import.meta.url));
    const result = await applyMigrations(database.executor, migrations);
    assert.ok(result.applied.includes('026_freshness_due_run_traces'));

    await database.executor.query(
      `INSERT INTO waspada.traces
         (trace_id, dataset_kind, started_at, ended_at, outcome, metadata)
       VALUES
         ('trace-unrelated-synthetic', 'synthetic', '2026-10-01T08:00:00Z', NULL, 'open',
          '{"fixture":"preserve-existing-trace"}'::jsonb),
         ('trace-unrelated-live', 'live', '2026-10-01T09:00:00Z', '2026-10-01T09:02:00Z',
          'succeeded', '{"trigger":"manual_import","note":"preserve-existing-metadata"}'::jsonb)`,
    );
    unrelatedBefore = await readUnrelatedTraces();
  });

  after(async () => database?.close());

  it('uses safe SECURITY DEFINER functions and grants execute only to the freshness writer', async () => {
    const functions = await database.executor.query<{
      proname: string;
      prosecdef: boolean;
      proconfig: string[] | null;
    }>(
      `SELECT procedure.proname, procedure.prosecdef, procedure.proconfig
       FROM pg_catalog.pg_proc AS procedure
       JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
       WHERE namespace.nspname = 'waspada'
         AND procedure.proname IN (
           'begin_freshness_due_evaluation_run',
           'finalize_freshness_due_evaluation_run'
         )
       ORDER BY procedure.proname`,
    );
    assert.equal(functions.rows.length, 2);
    for (const procedure of functions.rows) {
      assert.equal(procedure.prosecdef, true);
      assert.ok(procedure.proconfig?.includes('search_path=pg_catalog'));
    }

    const privileges = await database.executor.query<{
      proname: string;
      role_name: string;
      can_execute: boolean;
    }>(
      `SELECT procedure.proname, roles.role_name,
              has_function_privilege(roles.role_name, procedure.oid, 'EXECUTE') AS can_execute
       FROM pg_catalog.pg_proc AS procedure
       JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
       CROSS JOIN (VALUES
         ('waspada_l4_freshness_writer'),
         ('waspada_public_reader'),
         ('waspada_l1_pipeline'),
         ('waspada_l2_grounding_reader'),
         ('waspada_l4_publication_writer'),
         ('waspada_l4_moderator_publication_writer')
       ) AS roles(role_name)
       WHERE namespace.nspname = 'waspada'
         AND procedure.proname IN (
           'begin_freshness_due_evaluation_run',
           'finalize_freshness_due_evaluation_run'
         )
       ORDER BY procedure.proname, roles.role_name`,
    );
    assert.equal(privileges.rows.length, 12);
    for (const privilege of privileges.rows) {
      assert.equal(
        privilege.can_execute,
        privilege.role_name === 'waspada_l4_freshness_writer',
        privilege.role_name + ' execute privilege for ' + privilege.proname,
      );
    }

    const traceWrites = await database.executor.query<{
      attname: string;
      can_insert: boolean;
      can_update: boolean;
    }>(
      `SELECT attribute.attname,
              has_column_privilege(
                'waspada_l4_freshness_writer', attribute.attrelid, attribute.attname, 'INSERT'
              ) AS can_insert,
              has_column_privilege(
                'waspada_l4_freshness_writer', attribute.attrelid, attribute.attname, 'UPDATE'
              ) AS can_update
       FROM pg_catalog.pg_attribute AS attribute
       WHERE attribute.attrelid = 'waspada.traces'::regclass
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
       ORDER BY attribute.attnum`,
    );
    assert.ok(traceWrites.rows.length > 0);
    assert.ok(traceWrites.rows.every(({ can_insert, can_update }) => !can_insert && !can_update));
    const tablePrivileges = await database.executor.query<{
      can_insert: boolean;
      can_update: boolean;
      l1_insert: boolean;
      l1_end_update: boolean;
      publication_insert: boolean;
      publication_end_update: boolean;
    }>(
      `SELECT
         has_table_privilege('waspada_l4_freshness_writer', 'waspada.traces', 'INSERT') AS can_insert,
         has_table_privilege('waspada_l4_freshness_writer', 'waspada.traces', 'UPDATE') AS can_update,
         has_table_privilege('waspada_l1_pipeline', 'waspada.traces', 'INSERT') AS l1_insert,
         has_column_privilege('waspada_l1_pipeline', 'waspada.traces', 'ended_at', 'UPDATE') AS l1_end_update,
         has_table_privilege('waspada_l4_publication_writer', 'waspada.traces', 'INSERT') AS publication_insert,
         has_column_privilege('waspada_l4_publication_writer', 'waspada.traces', 'ended_at', 'UPDATE') AS publication_end_update`,
    );
    assert.deepEqual(tablePrivileges.rows[0], {
      can_insert: false,
      can_update: false,
      l1_insert: true,
      l1_end_update: true,
      publication_insert: true,
      publication_end_update: true,
    });

    await database.executor.execute('SET ROLE waspada_public_reader');
    try {
      await assert.rejects(
        beginRun('trace-public-reader-denied', STARTED_AT),
        /permission denied/i,
      );
    } finally {
      await database.executor.execute('RESET ROLE');
    }

    await database.executor.execute('SET ROLE waspada_l4_freshness_writer');
    try {
      assert.equal(await beginRun('freshness-due-run-role-call', STARTED_AT), 'open');
      await assert.rejects(
        database.executor.query(
          `INSERT INTO waspada.traces
             (trace_id, dataset_kind, started_at, outcome, metadata)
           VALUES ('trace-direct-insert-denied', 'live', $1, 'open', '{}'::jsonb)`,
          [STARTED_AT],
        ),
        /permission denied/i,
      );
      await assert.rejects(
        database.executor.query(
          `UPDATE waspada.traces SET ended_at = $1 WHERE trace_id = 'freshness-due-run-role-call'`,
          [FINISHED_AT],
        ),
        /permission denied/i,
      );
    } finally {
      await database.executor.execute('RESET ROLE');
    }
  });

  it('creates fixed live metadata, replays and resumes the exact open identity', async () => {
    const traceId = 'freshness-due-run-open';
    assert.equal(await beginRun('x'.repeat(128), STARTED_AT), 'open');
    assert.equal(await beginRun(traceId, STARTED_AT), 'open');
    const created = await readTrace(traceId);
    assert.equal(created.dataset_kind, 'live');
    assert.equal(Date.parse(created.started_at), Date.parse(STARTED_AT));
    assert.equal(created.ended_at, null);
    assert.equal(created.outcome, 'open');
    assert.deepEqual(created.metadata, { trigger: TRIGGER });

    assert.equal(await beginRun(traceId, STARTED_AT), 'open');
    assert.equal(await beginRun(traceId, STARTED_AT), 'open', 'an open run can resume after interruption');
    assert.deepEqual(await readTrace(traceId), created);

    await assert.rejects(
      beginRun(traceId, '2026-10-02T10:00:01.123456Z'),
      /freshness due evaluation trace identity conflict/i,
    );
    await assert.rejects(
      beginRun('trace-unrelated-synthetic', STARTED_AT),
      /freshness due evaluation trace identity conflict/i,
    );
  });

  it('finalizes a successful run and accepts only an exact final-state replay', async () => {
    const traceId = 'freshness-due-run-success';
    assert.equal(await beginRun(traceId, STARTED_AT), 'open');
    assert.equal(
      await finalizeRun(traceId, STARTED_AT, FINISHED_AT, 'succeeded', SUCCESS_SUMMARY),
      'succeeded',
    );

    const completed = await readTrace(traceId);
    assert.equal(completed.dataset_kind, 'live');
    assert.equal(Date.parse(completed.started_at), Date.parse(STARTED_AT));
    assert.equal(Date.parse(completed.ended_at ?? ''), Date.parse(FINISHED_AT));
    assert.equal(completed.outcome, 'succeeded');
    assert.deepEqual(completed.metadata, { trigger: TRIGGER, summary: SUCCESS_SUMMARY });

    assert.equal(
      await finalizeRun(traceId, STARTED_AT, FINISHED_AT, 'succeeded', SUCCESS_SUMMARY),
      'succeeded',
    );
    assert.deepEqual(await readTrace(traceId), completed);
    assert.equal(await beginRun(traceId, STARTED_AT), 'succeeded', 'begin reports terminal status without reopening');

    await assert.rejects(
      finalizeRun(traceId, STARTED_AT, FINISHED_AT, 'failed', SUCCESS_SUMMARY),
      /freshness due evaluation trace/i,
    );
    await assert.rejects(
      finalizeRun(traceId, STARTED_AT, '2026-10-02T10:06:00Z', 'succeeded', SUCCESS_SUMMARY),
      /freshness due evaluation trace/i,
    );
    await assert.rejects(
      finalizeRun(traceId, STARTED_AT, FINISHED_AT, 'succeeded', { ...SUCCESS_SUMMARY, written: 4 }),
      /freshness due evaluation trace/i,
    );
    await assert.rejects(
      finalizeRun(traceId, '2026-10-02T10:00:01Z', FINISHED_AT, 'succeeded', SUCCESS_SUMMARY),
      /freshness due evaluation trace identity conflict/i,
    );
    assert.deepEqual(await readTrace(traceId), completed);
    await assert.rejects(
      beginRun(traceId, '2026-10-02T10:00:01Z'),
      /freshness due evaluation trace identity conflict/i,
    );
  });

  it('finalizes failed runs and replays the exact failure summary', async () => {
    const traceId = 'freshness-due-run-failure';
    assert.equal(await beginRun(traceId, STARTED_AT), 'open');
    assert.equal(
      await finalizeRun(traceId, STARTED_AT, FINISHED_AT, 'failed', FAILURE_SUMMARY),
      'failed',
    );
    assert.equal(
      await finalizeRun(traceId, STARTED_AT, FINISHED_AT, 'failed', FAILURE_SUMMARY),
      'failed',
    );
    const row = await readTrace(traceId);
    assert.equal(row.outcome, 'failed');
    assert.deepEqual(row.metadata, { trigger: TRIGGER, summary: FAILURE_SUMMARY });
  });

  it('rejects invalid IDs, instants, outcomes and open-run count summaries', async () => {
    for (const invalidId of ['', 'bad/id', 'run with spaces', 'x'.repeat(129)]) {
      await assert.rejects(
        beginRun(invalidId, STARTED_AT),
        /invalid freshness due evaluation run input/i,
      );
    }
    await assert.rejects(beginRun(null, STARTED_AT), /invalid freshness due evaluation run input/i);
    await assert.rejects(beginRun('trace-invalid-null-time', null), /invalid freshness due evaluation run input/i);
    await assert.rejects(
      beginRun('trace-invalid-infinite-time', 'infinity'),
      /invalid freshness due evaluation run input/i,
    );
    await assert.rejects(
      beginRun('trace-invalid-time-text', 'not-a-timestamp'),
      /date.time field value out of range|invalid input syntax|date.time/i,
    );

    await assert.rejects(
      finalizeRun('trace-does-not-exist', STARTED_AT, FINISHED_AT, 'succeeded', SUCCESS_SUMMARY),
      /freshness due evaluation trace identity conflict/i,
    );
    const traceId = 'freshness-due-run-invalid-summary';
    assert.equal(await beginRun(traceId, STARTED_AT), 'open');
    await assert.rejects(
      finalizeRun(traceId, STARTED_AT, '2026-10-02T09:59:59Z', 'succeeded', SUCCESS_SUMMARY),
      /invalid freshness due evaluation run input/i,
    );
    await assert.rejects(
      finalizeRun(traceId, STARTED_AT, FINISHED_AT, 'cancelled', SUCCESS_SUMMARY),
      /invalid freshness due evaluation run input/i,
    );

    await database.executor.query(
      `INSERT INTO waspada.traces
         (trace_id, dataset_kind, started_at, outcome, metadata)
       VALUES ('trace-null-outcome', 'live', $1, NULL, $2::jsonb)`,
      [STARTED_AT, JSON.stringify({ trigger: TRIGGER })],
    );
    await assert.rejects(
      finalizeRun('trace-null-outcome', STARTED_AT, FINISHED_AT, 'succeeded', SUCCESS_SUMMARY),
      /freshness due evaluation trace is not the exact open run/i,
    );
    const invalidSummaries: unknown[] = [
      { written: 1, replayed: 0, noChange: 0, conflicts: 0 },
      { written: 1, replayed: 0, noChange: 0, conflicts: 0, failures: 0, eventId: 'private-event' },
      { written: -1, replayed: 0, noChange: 0, conflicts: 0, failures: 0 },
      { written: 1.5, replayed: 0, noChange: 0, conflicts: 0, failures: 0 },
      { written: '1', replayed: 0, noChange: 0, conflicts: 0, failures: 0 },
      { written: 2147483648, replayed: 0, noChange: 0, conflicts: 0, failures: 0 },
      null,
      ['1', 0, 0, 0, 0],
    ];
    for (const summary of invalidSummaries) {
      await assert.rejects(
        finalizeRun(traceId, STARTED_AT, FINISHED_AT, 'succeeded', summary),
        /invalid freshness due evaluation count summary/i,
      );
    }
    const stillOpen = await readTrace(traceId);
    assert.equal(stillOpen.outcome, 'open');
    assert.equal(stillOpen.ended_at, null);
    assert.deepEqual(stillOpen.metadata, { trigger: TRIGGER });
  });

  it('leaves unrelated trace rows and existing role grants untouched', async () => {
    assert.deepEqual(await readUnrelatedTraces(), unrelatedBefore);
    const directPrivileges = await database.executor.query<{
      l1_can_execute_begin: boolean;
      publication_can_execute_finish: boolean;
    }>(
      `SELECT
         has_function_privilege(
           'waspada_l1_pipeline',
           'waspada.begin_freshness_due_evaluation_run(text,timestamptz)'::regprocedure,
           'EXECUTE'
         ) AS l1_can_execute_begin,
         has_function_privilege(
           'waspada_l4_publication_writer',
           'waspada.finalize_freshness_due_evaluation_run(text,timestamptz,timestamptz,text,jsonb)'::regprocedure,
           'EXECUTE'
         ) AS publication_can_execute_finish`,
    );
    assert.deepEqual(directPrivileges.rows[0], {
      l1_can_execute_begin: false,
      publication_can_execute_finish: false,
    });
  });

  async function beginRun(traceId: string | null, startedAt: string | null): Promise<string> {
    const result = await database.executor.query<{ status: string }>(
      `SELECT waspada.begin_freshness_due_evaluation_run(
         $1::text, $2::timestamptz
       ) AS status`,
      [traceId, startedAt],
    );
    return result.rows[0]!.status;
  }

  async function finalizeRun(
    traceId: string | null,
    startedAt: string | null,
    finishedAt: string | null,
    outcome: string | null,
    summary: unknown,
  ): Promise<string> {
    const result = await database.executor.query<{ status: string }>(
      `SELECT waspada.finalize_freshness_due_evaluation_run(
         $1::text, $2::timestamptz, $3::timestamptz, $4::text, $5::jsonb
       ) AS status`,
      [traceId, startedAt, finishedAt, outcome, JSON.stringify(summary) ?? null],
    );
    return result.rows[0]!.status;
  }

  async function readTrace(traceId: string): Promise<TraceRow> {
    const result = await database.executor.query<TraceRow>(
      `SELECT trace_id, dataset_kind, started_at::text AS started_at,
              ended_at::text AS ended_at, outcome, metadata
       FROM waspada.traces
       WHERE trace_id = $1`,
      [traceId],
    );
    assert.ok(result.rows[0], 'trace exists: ' + traceId);
    return result.rows[0]!;
  }

  async function readUnrelatedTraces(): Promise<readonly TraceRow[]> {
    const result = await database.executor.query<TraceRow>(
      `SELECT trace_id, dataset_kind, started_at::text AS started_at,
              ended_at::text AS ended_at, outcome, metadata
       FROM waspada.traces
       WHERE trace_id IN ('trace-unrelated-synthetic', 'trace-unrelated-live')
       ORDER BY trace_id`,
    );
    return result.rows;
  }
});
