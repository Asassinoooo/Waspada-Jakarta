import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import {
  createSourceRevisionFreshnessRunStateRepository,
  SourceRevisionFreshnessRunStateInputError,
  SourceRevisionFreshnessRunStateStorageError,
  type SourceRevisionFreshnessRunCounts,
} from '../src/source-revision-freshness-run-state.js';
import type { SourceRevisionReviewCandidateCursor } from '../src/source-revision-review-candidate-reader.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

const STARTED_AT = '2026-10-05T12:00:00.123456Z';
const FINISHED_AT = '2026-10-05T12:01:00.654321Z';
const OPEN_METADATA = { trigger: 'source_revision_freshness_transition' };
const SUCCESS_SUMMARY: SourceRevisionFreshnessRunCounts = {
  candidates: 1,
  invalidatingCandidates: 1,
  selectedTargets: 1,
  duplicateCandidates: 0,
  skippedCandidates: 0,
  written: 1,
  replayed: 0,
  noChange: 0,
};
const EMPTY_SUCCESS_SUMMARY: SourceRevisionFreshnessRunCounts = {
  candidates: 0,
  invalidatingCandidates: 0,
  selectedTargets: 0,
  duplicateCandidates: 0,
  skippedCandidates: 0,
  written: 0,
  replayed: 0,
  noChange: 0,
};
const FAILED_SUMMARY: SourceRevisionFreshnessRunCounts = {
  candidates: 1,
  invalidatingCandidates: 1,
  selectedTargets: 1,
  duplicateCandidates: 0,
  skippedCandidates: 0,
  written: 0,
  replayed: 0,
  noChange: 0,
};
const CURSOR_ONE: SourceRevisionReviewCandidateCursor = {
  observationId: 'obs-001',
  eventId: 'event-001',
  eventVersion: 1,
  target: { kind: 'event_claim_set' },
};
const CURSOR_TWO: SourceRevisionReviewCandidateCursor = {
  observationId: 'obs-002',
  eventId: 'event-002',
  eventVersion: 2,
  target: { kind: 'impact', impactId: 'impact-002', impactVersion: 1 },
};

interface TraceRow {
  readonly trace_id: string;
  readonly dataset_kind: string | null;
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly outcome: string | null;
  readonly metadata: Record<string, unknown>;
}

describe('LIFE-01-SOURCE-REVISION-FRESHNESS-RUN-STATE-CORE', () => {
  let database: TestDatabase;
  const repo = () => createSourceRevisionFreshnessRunStateRepository(database.executor);

  before(async () => {
    database = await createTestDatabase();
    const migrations = await readMigrations(new URL('../migrations/', import.meta.url));
    const result = await applyMigrations(database.executor, migrations);
    assert.ok(result.applied.includes('033_source_revision_freshness_run_state'));
  });

  beforeEach(async () => {
    await database.executor.execute('RESET ROLE');
    await database.executor.execute('DELETE FROM waspada.source_revision_freshness_run_advances');
    await database.executor.execute('DELETE FROM waspada.source_revision_freshness_run_inputs');
    await database.executor.execute(
      'UPDATE waspada.source_revision_freshness_cursor_checkpoint SET cursor = NULL WHERE singleton = true',
    );
    await database.executor.execute("DELETE FROM waspada.traces WHERE trace_id LIKE 'source-run-%'");
  });

  after(async () => database?.close());

  it('uses fixed SECURITY DEFINER functions with a pinned search path', async () => {
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
           'begin_source_revision_freshness_run',
           'advance_source_revision_freshness_run',
           'finalize_source_revision_freshness_run'
         )
       ORDER BY procedure.proname`,
    );
    assert.equal(functions.rows.length, 3);
    for (const procedure of functions.rows) {
      assert.equal(procedure.prosecdef, true);
      assert.ok(procedure.proconfig?.includes('search_path=pg_catalog'));
    }
  });

  it('snapshots the initial cursor once and resumes that same cursor after advancement', async () => {
    const repository = repo();
    const begun = await repository.begin({ traceId: 'source-run-open', startedAt: STARTED_AT });
    assert.deepEqual(begun, { status: 'open', inputCursor: null });
    assert.deepEqual(
      await repository.begin({ traceId: 'source-run-open', startedAt: STARTED_AT }),
      { status: 'open', inputCursor: null },
    );
    assert.equal(await repository.advance({
      traceId: 'source-run-open', startedAt: STARTED_AT, inputCursor: null, nextCursor: CURSOR_ONE,
    }), 'advanced');
    assert.deepEqual(
      await repository.begin({ traceId: 'source-run-open', startedAt: STARTED_AT }),
      { status: 'open', inputCursor: null },
      'an open retry receives the immutable input snapshot after global progress moved',
    );

    const trace = await readTrace(database, 'source-run-open');
    assert.equal(trace.dataset_kind, 'live');
    assert.equal(trace.ended_at, null);
    assert.equal(trace.outcome, 'open');
    assert.deepEqual(trace.metadata, OPEN_METADATA);
    assert.equal(JSON.stringify(trace.metadata).includes('obs-001'), false,
      'the cursor never enters trace metadata');
    assert.deepEqual(await readCheckpoint(database), CURSOR_ONE);
  });

  it('allows one page CAS, exact output replay, and conflicts for stale or changed output', async () => {
    const repository = repo();
    await repository.begin({ traceId: 'source-run-cas-a', startedAt: STARTED_AT });
    await repository.begin({ traceId: 'source-run-cas-b', startedAt: STARTED_AT });

    assert.equal(await repository.advance({
      traceId: 'source-run-cas-a', startedAt: STARTED_AT, inputCursor: null, nextCursor: CURSOR_ONE,
    }), 'advanced');
    assert.equal(await repository.advance({
      traceId: 'source-run-cas-a', startedAt: STARTED_AT, inputCursor: null, nextCursor: CURSOR_ONE,
    }), 'replayed');
    assert.equal(await repository.advance({
      traceId: 'source-run-cas-a', startedAt: STARTED_AT, inputCursor: null, nextCursor: CURSOR_TWO,
    }), 'conflict', 'a run cannot store a different second page result');
    assert.equal(await repository.advance({
      traceId: 'source-run-cas-b', startedAt: STARTED_AT, inputCursor: null, nextCursor: CURSOR_TWO,
    }), 'conflict', 'a stale run cannot advance after another run changed the checkpoint');
    assert.deepEqual(await readCheckpoint(database), CURSOR_ONE);
  });

  it('resets at the end of a sweep and distinguishes a null-output replay from an unadvanced run', async () => {
    const repository = repo();
    const seedStart = '2026-10-05T12:01:00.000001Z';
    await repository.begin({ traceId: 'source-run-reset-seed', startedAt: seedStart });
    assert.equal(await repository.advance({
      traceId: 'source-run-reset-seed', startedAt: seedStart,
      inputCursor: null, nextCursor: CURSOR_ONE,
    }), 'advanced');
    assert.equal(await repository.finalize({
      traceId: 'source-run-reset-seed', startedAt: seedStart,
      finishedAt: '2026-10-05T12:01:30.000001Z', outcome: 'succeeded', summary: SUCCESS_SUMMARY,
    }), 'succeeded');

    const nextStart = '2026-10-05T12:02:00.000001Z';
    const resetStart = '2026-10-05T12:03:00.000001Z';
    assert.deepEqual(
      await repository.begin({ traceId: 'source-run-reset-page', startedAt: nextStart }),
      { status: 'open', inputCursor: CURSOR_ONE },
    );
    assert.equal(await repository.advance({
      traceId: 'source-run-reset-page', startedAt: nextStart,
      inputCursor: CURSOR_ONE, nextCursor: null,
    }), 'advanced');
    assert.equal(await repository.advance({
      traceId: 'source-run-reset-page', startedAt: nextStart,
      inputCursor: CURSOR_ONE, nextCursor: null,
    }), 'replayed');
    assert.equal(await readCheckpoint(database), null);

    assert.deepEqual(
      await repository.begin({ traceId: 'source-run-reset-next', startedAt: resetStart }),
      { status: 'open', inputCursor: null },
      'a later slot starts a new sweep from null',
    );
  });

  it('finalizes only after a completed page and replays exact terminal state', async () => {
    const repository = repo();
    const traceId = 'source-run-complete';
    const startedAt = '2026-10-05T12:04:00.000001Z';
    const finishedAt = '2026-10-05T12:04:30.000001Z';
    await repository.begin({ traceId, startedAt });
    assert.equal(await repository.advance({ traceId, startedAt, inputCursor: null, nextCursor: null }), 'advanced');
    assert.equal(await repository.finalize({
      traceId, startedAt, finishedAt, outcome: 'succeeded', summary: EMPTY_SUCCESS_SUMMARY,
    }), 'succeeded');
    assert.equal(await repository.finalize({
      traceId, startedAt, finishedAt, outcome: 'succeeded', summary: EMPTY_SUCCESS_SUMMARY,
    }), 'succeeded');
    assert.deepEqual(await repository.begin({ traceId, startedAt }), { status: 'succeeded', inputCursor: null });

    const trace = await readTrace(database, traceId);
    assert.equal(trace.dataset_kind, 'live');
    assert.equal(trace.outcome, 'succeeded');
    assert.equal(Date.parse(trace.ended_at ?? ''), Date.parse(finishedAt));
    assert.deepEqual(trace.metadata, {
      ...OPEN_METADATA,
      summary: EMPTY_SUCCESS_SUMMARY,
    });
    assert.equal(JSON.stringify(trace.metadata).includes('cursor'), false);
    assert.equal(JSON.stringify(trace.metadata).includes('observationId'), false);

    await assert.rejects(
      repository.finalize({
        traceId, startedAt, finishedAt, outcome: 'succeeded', summary: SUCCESS_SUMMARY,
      }),
      SourceRevisionFreshnessRunStateStorageError,
      'changed terminal count summary conflicts',
    );
    await assert.rejects(
      repository.begin({ traceId, startedAt: '2026-10-05T12:04:00.000002Z' }),
      SourceRevisionFreshnessRunStateStorageError,
      'changed run time conflicts',
    );
  });

  it('leaves the checkpoint unchanged when a page fails', async () => {
    const repository = repo();
    const traceId = 'source-run-failed';
    const startedAt = '2026-10-05T12:05:00.000001Z';
    const finishedAt = '2026-10-05T12:05:30.000001Z';
    await repository.begin({ traceId, startedAt });
    assert.equal(await repository.finalize({
      traceId, startedAt, finishedAt, outcome: 'failed', summary: FAILED_SUMMARY,
    }), 'failed');
    assert.equal(await readCheckpoint(database), null);
    assert.deepEqual(await repository.begin({ traceId, startedAt }), { status: 'failed', inputCursor: null });
    assert.equal(await repository.advance({
      traceId, startedAt, inputCursor: null, nextCursor: CURSOR_ONE,
    }), 'conflict', 'a terminal failed page cannot advance later');
  });

  it('rejects malformed cursor shapes, backwards keys, and invalid count summaries', async () => {
    const repository = repo();
    await assert.rejects(
      repository.advance({
        traceId: 'source-run-invalid', startedAt: STARTED_AT, inputCursor: null,
        nextCursor: { ...CURSOR_ONE, extra: true },
      }),
      SourceRevisionFreshnessRunStateInputError,
    );
    await assert.rejects(
      repository.advance({
        traceId: 'source-run-invalid', startedAt: STARTED_AT,
        inputCursor: CURSOR_TWO, nextCursor: CURSOR_ONE,
      }),
      SourceRevisionFreshnessRunStateInputError,
    );
    await assert.rejects(
      repository.finalize({
        traceId: 'source-run-invalid', startedAt: STARTED_AT,
        finishedAt: FINISHED_AT, outcome: 'succeeded',
        summary: { ...EMPTY_SUCCESS_SUMMARY, extra: 1 },
      }),
      SourceRevisionFreshnessRunStateInputError,
    );
    await assert.rejects(
      repository.finalize({
        traceId: 'source-run-invalid', startedAt: STARTED_AT,
        finishedAt: FINISHED_AT, outcome: 'succeeded',
        summary: { ...EMPTY_SUCCESS_SUMMARY, candidates: 1 },
      }),
      SourceRevisionFreshnessRunStateInputError,
      'successful counts must account for every candidate and selected target',
    );

    const malformedCursor = JSON.stringify({
      ...CURSOR_ONE,
      target: { kind: 'event_claim_set', impactId: 'unexpected' },
    });
    await assert.rejects(
      database.executor.query(
        `SELECT waspada.advance_source_revision_freshness_run($1, $2, NULL, $3::jsonb)`,
        ['source-run-invalid-sql', STARTED_AT, malformedCursor],
      ),
      /invalid source-revision freshness advance input/iu,
    );
  });

  it('requires explicit finite RFC3339 times and exact summary bounds', async () => {
    const repository = repo();
    await assert.rejects(
      database.executor.query(
        'SELECT * FROM waspada.begin_source_revision_freshness_run($1, $2)',
        ['source-run-time-year-zero', '0000-01-01T00:00:00Z'],
      ),
      /invalid source-revision freshness run input/iu,
      'the SQL function rejects year zero even when called directly',
    );
    await assert.rejects(
      repository.begin({ traceId: 'source-run-time-invalid', startedAt: '2026-10-05T12:00:00' }),
      SourceRevisionFreshnessRunStateInputError,
    );
    await assert.rejects(
      repository.begin({ traceId: 'source-run-time-invalid', startedAt: 'infinity' }),
      SourceRevisionFreshnessRunStateInputError,
    );
    await assert.rejects(
      repository.finalize({
        traceId: 'source-run-time-invalid', startedAt: FINISHED_AT,
        finishedAt: STARTED_AT, outcome: 'succeeded', summary: EMPTY_SUCCESS_SUMMARY,
      }),
      SourceRevisionFreshnessRunStateInputError,
    );
    await assert.rejects(
      repository.finalize({
        traceId: 'source-run-time-invalid', startedAt: STARTED_AT,
        finishedAt: FINISHED_AT, outcome: 'failed',
        summary: { ...FAILED_SUMMARY, written: 101 },
      }),
      SourceRevisionFreshnessRunStateInputError,
    );
  });

  it('keeps checkpoint and run input tables inaccessible to application roles', async () => {
    await database.executor.execute('SET ROLE waspada_public_reader');
    try {
      await assert.rejects(
        repo().begin({ traceId: 'source-run-public-denied', startedAt: STARTED_AT }),
        SourceRevisionFreshnessRunStateStorageError,
      );
      await assert.rejects(
        database.executor.query('SELECT cursor FROM waspada.source_revision_freshness_cursor_checkpoint'),
        /permission denied/iu,
      );
    } finally {
      await database.executor.execute('RESET ROLE');
    }

    await database.executor.execute('SET ROLE waspada_l4_freshness_writer');
    try {
      const repository = repo();
      const begun = await repository.begin({ traceId: 'source-run-role-call', startedAt: STARTED_AT });
      assert.deepEqual(begun, { status: 'open', inputCursor: null });
      await assert.rejects(
        database.executor.query('SELECT input_cursor FROM waspada.source_revision_freshness_run_inputs'),
        /permission denied/iu,
      );
      await assert.rejects(
        database.executor.query(
          `INSERT INTO waspada.source_revision_freshness_run_inputs (trace_id, started_at)
           VALUES ('source-run-direct-insert', $1)`, [STARTED_AT],
        ),
        /permission denied/iu,
      );
      await assert.rejects(
        database.executor.query(
          `UPDATE waspada.source_revision_freshness_run_inputs
           SET input_cursor = NULL WHERE trace_id = 'source-run-role-call'`,
        ),
        /permission denied/iu,
        'run input snapshots cannot be changed directly',
      );
      await assert.rejects(
        database.executor.query(
          'UPDATE waspada.source_revision_freshness_cursor_checkpoint SET cursor = NULL',
        ),
        /permission denied/iu,
      );
      await assert.rejects(
        database.executor.query(
          `DELETE FROM waspada.source_revision_freshness_run_inputs
           WHERE trace_id = 'source-run-role-call'`,
        ),
        /permission denied/iu,
      );
      await assert.rejects(
        database.executor.execute('TRUNCATE waspada.source_revision_freshness_run_advances'),
        /permission denied/iu,
      );
      assert.equal(await repository.advance({
        traceId: 'source-run-role-call', startedAt: STARTED_AT, inputCursor: null, nextCursor: null,
      }), 'advanced', 'the writer can use the fixed-purpose page CAS function');
    } finally {
      await database.executor.execute('RESET ROLE');
    }
  });
});

async function readCheckpoint(database: TestDatabase): Promise<SourceRevisionReviewCandidateCursor | null> {
  const result = await database.executor.query<{ cursor: unknown }>(
    'SELECT cursor FROM waspada.source_revision_freshness_cursor_checkpoint WHERE singleton = true',
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0]?.cursor as SourceRevisionReviewCandidateCursor | null;
}

async function readTrace(database: TestDatabase, traceId: string): Promise<TraceRow> {
  const result = await database.executor.query<TraceRow>(
    `SELECT trace_id, dataset_kind, started_at, ended_at, outcome, metadata
     FROM waspada.traces WHERE trace_id = $1`,
    [traceId],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0]!;
}
