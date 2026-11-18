import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import { insertPipelineCycleRun, pipelineCycleRunRecordJson, type PipelineCycleRunInput } from '../src/pipeline-cycle-runs.js';
import { createPipelineFlowStore } from '../src/pipeline-flow-store.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

/**
 * HOSTED-30: the hosted flow view reads the latest `--once` run (waspada.pipeline_cycle_runs) and the per-source check
 * times through the read-only flow role (migration 057). The fixtures are synthetic, and a run row holds counts and codes only.
 */

const NOW = new Date('2026-11-18T09:00:00.000Z');
const MIN = 60_000;
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * MIN).toISOString();
const DAY_MS = 24 * 60 * MIN;

function run(overrides: Partial<PipelineCycleRunInput> & Pick<PipelineCycleRunInput, 'runId'>): PipelineCycleRunInput {
  return {
    datasetKind: 'live',
    startedAt: ago(20),
    finishedAt: ago(15),
    elapsedMs: 300_000,
    feedsOk: 15,
    feedsFailed: 1,
    itemsNew: 4,
    aiCompleted: 3,
    aiNotCompleted: 1,
    published: 1,
    held: 0,
    exitCode: 0,
    ...overrides,
  };
}

describe('HOSTED-30 pipeline flow: cycle row and source check times', () => {
  let db: TestDatabase;
  const store = () => createPipelineFlowStore(db.executor);

  before(async () => {
    db = await createTestDatabase();
    const migrations = await readMigrations(new URL('../migrations/', import.meta.url));
    await applyMigrations(db.executor, migrations);
    await seed();
  });

  after(async () => db?.close());

  async function seed(): Promise<void> {
    const exec = db.executor;
    await exec.query(
      `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
       VALUES ('trace-cycle', 'live', $1::timestamptz, 'succeeded', '{}'::jsonb)`,
      [ago(600)],
    );
    // checkedMinutes / successMinutes: minutes before NOW, or null for "never".
    const source = (id: string, kind: string, access: string, approval: string, health: string,
      checkedMinutes: number | null, successMinutes: number | null) => exec.query(
      `INSERT INTO waspada.source_registry (
         source_id, trace_id, registry_version, display_name, source_kind, remit,
         access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
         approval_status, health_status, auto_acquisition_enabled, auto_publication_policy,
         polling_interval_seconds, last_checked_at, last_success_at)
       VALUES ($1, 'trace-cycle', 1, $1, $2, ARRAY['synthetic'], $3, ARRAY['synthetic.invalid'], ARRAY[]::text[],
         ARRAY['public_display'], 'active', $4, $5, ($4 = 'approved'), 'never', 300, $6::timestamptz, $7::timestamptz)`,
      [
        id, kind, access, approval, health,
        checkedMinutes === null ? null : ago(checkedMinutes),
        successMinutes === null ? null : ago(successMinutes),
      ],
    );
    await source('petabencana', 'crowdsourced_platform', 'api', 'approved', 'healthy', 5, 5);
    // Checked three days ago: outside the default 24 hour window, inside 7 days.
    await source('source-bmkg-gempa', 'authority', 'api', 'approved', 'degraded', 3 * 24 * 60, 3 * 24 * 60);
    await source('source-antara-metro', 'newsroom', 'rss', 'approved', 'healthy', 120, 120);
    // An approved feed that was never checked, and a pending feed that must not be counted at all.
    await source('source-rss-never', 'newsroom', 'rss', 'approved', 'unknown', null, null);
    await source('source-rss-pending', 'newsroom', 'rss', 'pending', 'unknown', null, null);

    // Two live runs and one synthetic run. The newest live run is the one the flow view must show.
    await insertPipelineCycleRun(exec, run({
      runId: 'once-older', startedAt: ago(125), finishedAt: ago(120), elapsedMs: 300_000, feedsOk: 15, feedsFailed: 1,
      itemsNew: 4, aiCompleted: 3, aiNotCompleted: 1, published: 1, held: 0,
    }));
    await insertPipelineCycleRun(exec, run({
      runId: 'once-latest', startedAt: ago(14), finishedAt: ago(10), elapsedMs: 240_000, feedsOk: 14, feedsFailed: 2,
      itemsNew: 9, aiCompleted: 7, aiNotCompleted: 2, published: 3, held: 1, exitCode: 0,
      record: { new_items_cap: 40, new_items_used: 12, feeds_not_fetched: 1, poll_errors: 0 },
    }));
    await insertPipelineCycleRun(exec, run({ runId: 'once-synthetic', datasetKind: 'synthetic', startedAt: ago(2), finishedAt: ago(1) }));
  }

  it('shows the latest live run with its counts, record keys and the number of runs recorded', async () => {
    const aggregates = await store().readAggregates({ datasetKind: 'live', now: NOW });
    const latest = aggregates.cycle_run;
    assert.ok(latest, 'the latest live run is read');
    assert.equal(latest.run_id, 'once-latest', 'the synthetic run is never shown on the live dataset');
    assert.equal(latest.finished_at, ago(10));
    assert.equal(latest.started_at, ago(14));
    assert.equal(latest.elapsed_ms, 240_000);
    assert.equal(latest.feeds_ok, 14);
    assert.equal(latest.feeds_failed, 2);
    assert.equal(latest.feeds_not_fetched, 1);
    assert.equal(latest.items_new, 9);
    assert.equal(latest.ai_completed, 7);
    assert.equal(latest.ai_not_completed, 2);
    assert.equal(latest.published, 3);
    assert.equal(latest.held, 1);
    assert.equal(latest.exit_code, 0);
    assert.equal(latest.poll_errors, 0);
    assert.equal(latest.new_items_cap, 40);
    assert.equal(latest.new_items_used, 12);
    assert.equal(latest.runs_recorded, 2, 'two live rows; the synthetic row is not counted');

    const stored = await db.executor.query<{ record_json: unknown }>(
      `SELECT record_json FROM waspada.pipeline_cycle_runs WHERE run_id = 'once-latest'`,
    );
    assert.deepEqual(stored.rows[0]?.record_json, { new_items_cap: 40, new_items_used: 12, feeds_not_fetched: 1, poll_errors: 0 });
  });

  it('counts each approved source by its last check and last success inside the window, and never-checked sources apart', async () => {
    const aggregates = await store().readAggregates({ datasetKind: 'live', now: NOW });
    const byFamily = Object.fromEntries(aggregates.sources.map((row) => [row.family, row]));

    assert.equal(byFamily.petabencana?.checked_24h, 1);
    assert.equal(byFamily.petabencana?.succeeded_24h, 1);
    assert.equal(byFamily.petabencana?.never_checked, 0);

    assert.equal(byFamily.bmkg?.checked_24h, 0, 'a check three days old is outside the 24 hour window');
    assert.equal(byFamily.bmkg?.succeeded_24h, 0);

    assert.equal(byFamily.rss?.sources, 2, 'the pending feed is not an approved source');
    assert.equal(byFamily.rss?.checked_24h, 1);
    assert.equal(byFamily.rss?.succeeded_24h, 1);
    assert.equal(byFamily.rss?.never_checked, 1);
  });

  it('FLOW-RANGE-01: the check counts follow the selected window', async () => {
    const week = await store().readAggregates({ datasetKind: 'live', now: NOW, windowMs: 7 * DAY_MS });
    const bmkg = week.sources.find((row) => row.family === 'bmkg');
    assert.equal(bmkg?.checked_24h, 1, 'the three-day-old check is inside 7 days');
    assert.equal(bmkg?.succeeded_24h, 1);
  });

  it('reports no cycle run for a dataset that has none, and the source counts are still read', async () => {
    const historical = await store().readAggregates({ datasetKind: 'historical', now: NOW });
    assert.equal(historical.cycle_run, null);
    assert.equal(historical.sources.find((row) => row.family === 'petabencana')?.checked_24h, 1);
  });

  it('refuses an invalid run before any SQL is sent, and names the field without its value', async () => {
    const calls: string[] = [];
    const recording = { query: async (statement: string) => { calls.push(statement); return { rows: [] }; } };
    await assert.rejects(insertPipelineCycleRun(recording, run({ runId: 'once-bad-held', held: -1 })), /held must be a whole number/u);
    await assert.rejects(insertPipelineCycleRun(recording, run({ runId: 'once-bad-float', feedsOk: 1.5 })), /feeds_ok must be a whole number/u);
    await assert.rejects(
      insertPipelineCycleRun(recording, run({ runId: 'once-bad-order', startedAt: ago(1), finishedAt: ago(9) })),
      /finished_at must not be earlier than started_at/u,
    );
    await assert.rejects(insertPipelineCycleRun(recording, run({ runId: '' })), /run_id must be 1 to 200 characters/u);
    await assert.rejects(insertPipelineCycleRun(recording, run({ runId: 'once-bad-exit', exitCode: 256 })), /exit_code must be a whole number/u);
    assert.deepEqual(calls, [], 'no statement reached the database');
  });

  it('keeps only the allowed whole-number record keys', () => {
    assert.deepEqual(
      pipelineCycleRunRecordJson({ new_items_cap: 40, new_items_used: null, poll_errors: 0 }),
      { new_items_cap: 40, poll_errors: 0 },
      'a null key is left out and a zero is kept',
    );
    const smuggled = { new_items_cap: 40, title: 'judul sumber', url: 'https://example.invalid/x' } as unknown as Parameters<typeof pipelineCycleRunRecordJson>[0];
    assert.deepEqual(pipelineCycleRunRecordJson(smuggled), { new_items_cap: 40 }, 'text keys are never stored');
  });

  it('lets the L1 ingest writer insert a run, gives it no update right, and gives the flow reader no write right', async () => {
    await db.executor.transaction(async (tx) => {
      await tx.execute('SET LOCAL ROLE waspada_l1_pipeline');
      await insertPipelineCycleRun(tx, run({ runId: 'once-l1-writer', finishedAt: ago(3), startedAt: ago(4) }));
    });
    const seen = await db.executor.query<{ run_id: string }>(
      `SELECT run_id FROM waspada.pipeline_cycle_runs WHERE run_id = 'once-l1-writer'`,
    );
    assert.deepEqual(seen.rows, [{ run_id: 'once-l1-writer' }]);

    await assert.rejects(db.executor.transaction(async (tx) => {
      await tx.execute('SET LOCAL ROLE waspada_l1_pipeline');
      await tx.query(`UPDATE waspada.pipeline_cycle_runs SET held = 9 WHERE run_id = 'once-l1-writer'`);
    }), /permission denied/u);

    await assert.rejects(db.executor.transaction(async (tx) => {
      await tx.execute('SET LOCAL ROLE waspada_l4_pipeline_flow_reader');
      await insertPipelineCycleRun(tx, run({ runId: 'once-reader-write' }));
    }), /permission denied/u);
  });

  it('the flow reader reads the two source check columns and nothing else of source_registry', async () => {
    const reader = (statement: string) => db.executor.transaction(async (tx) => {
      await tx.execute('SET TRANSACTION READ ONLY');
      await tx.execute('SET LOCAL ROLE waspada_l4_pipeline_flow_reader');
      await tx.query(statement);
    });
    await reader('SELECT last_checked_at, last_success_at FROM waspada.source_registry');
    await assert.rejects(reader('SELECT approved_hosts FROM waspada.source_registry'), /permission denied/u);
    await assert.rejects(reader('SELECT display_name FROM waspada.source_registry'), /permission denied/u);
  });

  it('the table refuses a dataset outside the three kinds, a non-object record, and a finish before the start', async () => {
    const exec = db.executor;
    await assert.rejects(
      insertPipelineCycleRun(exec, run({ runId: 'once-bad-kind', datasetKind: 'public' as never })),
      /check constraint/u,
    );
    await assert.rejects(exec.query(
      `INSERT INTO waspada.pipeline_cycle_runs (dataset_kind, run_id, started_at, finished_at, elapsed_ms, feeds_ok, feeds_failed,
         items_new, ai_completed, ai_not_completed, published, held, exit_code, record_json)
       VALUES ('live', 'once-array', now() - interval '1 minute', now(), 1, 0, 0, 0, 0, 0, 0, 0, 0, '[1,2]'::jsonb)`,
    ), /check constraint/u);
    await assert.rejects(exec.query(
      `INSERT INTO waspada.pipeline_cycle_runs (dataset_kind, run_id, started_at, finished_at, elapsed_ms, feeds_ok, feeds_failed,
         items_new, ai_completed, ai_not_completed, published, held, exit_code, record_json)
       VALUES ('live', 'once-reversed', now(), now() - interval '1 minute', 1, 0, 0, 0, 0, 0, 0, 0, 0, '{}'::jsonb)`,
    ), /check constraint/u);
  });
});
