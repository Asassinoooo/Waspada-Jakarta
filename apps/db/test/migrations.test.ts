import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { applyMigrations, readMigrations, type SqlMigration } from '../src/migrations.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

describe('DATA-01 migrations', () => {
  let testDatabase: TestDatabase;
  let migrations: SqlMigration[];

  before(async () => {
    testDatabase = await createTestDatabase();
    migrations = await readMigrations(new URL('../migrations/', import.meta.url));
    const result = await applyMigrations(testDatabase.executor, migrations);
    assert.deepEqual(result.applied, ['001_foundation', '002_acquisition_jobs', '003_evidence_chunk_pipeline_reads']);
    assert.deepEqual(result.skipped, []);
  });

  after(async () => {
    await testDatabase.close();
  });

  it('applies from empty state and is repeatable with checksum protection', async () => {
    const repeated = await applyMigrations(testDatabase.executor, migrations);
    assert.deepEqual(repeated.applied, []);
    assert.deepEqual(repeated.skipped, [
      '001_foundation', '002_acquisition_jobs', '003_evidence_chunk_pipeline_reads',
    ]);

    const count = await testDatabase.executor.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM waspada.schema_migrations',
    );
    assert.equal(count.rows[0]?.count, '3');

    const tampered = migrations.map((migration) => ({
      ...migration,
      sql: `${migration.sql}\n-- modified after application\n`,
    }));
    await assert.rejects(
      applyMigrations(testDatabase.executor, tampered),
      /Checksum mismatch for applied migration 001_foundation/,
    );
  });

  it('rejects a newly introduced migration that sorts before an applied version', async () => {
    const outOfOrder = [
      { version: '000_late_backfill', sql: 'SELECT 1;' },
      ...migrations,
    ];
    await assert.rejects(
      applyMigrations(testDatabase.executor, outOfOrder),
      /Cannot apply migration 000_late_backfill before already applied migration 003_evidence_chunk_pipeline_reads/,
    );

    const ledger = await testDatabase.executor.query<{ version: string }>(
      'SELECT version FROM waspada.schema_migrations ORDER BY version',
    );
    assert.deepEqual(ledger.rows, [
      { version: '001_foundation' },
      { version: '002_acquisition_jobs' },
      { version: '003_evidence_chunk_pipeline_reads' },
    ]);
  });

  it('loads only ordered, named SQL migrations', async () => {
    assert.deepEqual(migrations.map(({ version }) => version), [
      '001_foundation', '002_acquisition_jobs', '003_evidence_chunk_pipeline_reads',
    ]);
    const version = await testDatabase.executor.query<{ version: string; server_version: string }>(
      "SELECT extversion AS version, current_setting('server_version') AS server_version FROM pg_extension WHERE extname = 'postgis'",
    );
    assert.match(version.rows[0]?.version ?? '', /^\d+\.\d+/);
    assert.match(version.rows[0]?.server_version ?? '', /^\d+/);
  });

  it('grants the L1 pipeline only the chunk and embedding metadata columns it reads', async () => {
    const privileges = await testDatabase.executor.query<{
      table_name: string;
      column_name: string;
      can_select: boolean;
    }>(
      `SELECT table_class.relname AS table_name,
              column_meta.attname AS column_name,
              has_column_privilege('waspada_l1_pipeline', table_class.oid,
                                   column_meta.attnum, 'SELECT') AS can_select
       FROM pg_class AS table_class
       JOIN pg_namespace AS table_schema ON table_schema.oid = table_class.relnamespace
       JOIN pg_attribute AS column_meta ON column_meta.attrelid = table_class.oid
       WHERE table_schema.nspname = 'waspada'
         AND table_class.relname IN ('evidence_chunks', 'embedding_runs')
         AND column_meta.attnum > 0 AND NOT column_meta.attisdropped
       ORDER BY table_class.relname, column_meta.attname`,
    );
    const granted = privileges.rows
      .filter((row) => row.can_select)
      .map((row) => `${row.table_name}.${row.column_name}`)
      .sort();
    assert.deepEqual(granted, [
      'embedding_runs.chunk_id',
      'embedding_runs.dataset_kind',
      'embedding_runs.embedding_run_id',
      'embedding_runs.status',
      'evidence_chunks.chunk_id',
      'evidence_chunks.chunk_text_hash',
      'evidence_chunks.chunker_version',
      'evidence_chunks.dataset_kind',
      'evidence_chunks.offset_unit',
      'evidence_chunks.permitted_text_hash',
      'evidence_chunks.report_revision_id',
      'evidence_chunks.span_end',
      'evidence_chunks.span_start',
      'evidence_chunks.status',
    ]);
  });
});
