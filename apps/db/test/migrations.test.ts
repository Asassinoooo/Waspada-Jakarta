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
    assert.deepEqual(result.applied, [
      '001_foundation', '002_acquisition_jobs', '003_evidence_chunk_pipeline_reads',
      '004_l2_grounding_reader', '005_publication_write_receipts_outbox',
    ]);
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
      '004_l2_grounding_reader', '005_publication_write_receipts_outbox',
    ]);

    const count = await testDatabase.executor.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM waspada.schema_migrations',
    );
    assert.equal(count.rows[0]?.count, '5');

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
      /Cannot apply migration 000_late_backfill before already applied migration 005_publication_write_receipts_outbox/,
    );

    const ledger = await testDatabase.executor.query<{ version: string }>(
      'SELECT version FROM waspada.schema_migrations ORDER BY version',
    );
    assert.deepEqual(ledger.rows, [
      { version: '001_foundation' },
      { version: '002_acquisition_jobs' },
      { version: '003_evidence_chunk_pipeline_reads' },
      { version: '004_l2_grounding_reader' },
      { version: '005_publication_write_receipts_outbox' },
    ]);
  });

  it('loads only ordered, named SQL migrations', async () => {
    assert.deepEqual(migrations.map(({ version }) => version), [
      '001_foundation', '002_acquisition_jobs', '003_evidence_chunk_pipeline_reads', '004_l2_grounding_reader',
      '005_publication_write_receipts_outbox',
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

  it('creates a non-login L2 reader with only retrieval-column reads and no writes or sequence access', async () => {
    const roleMigration = migrations.find(({ version }) => version === '004_l2_grounding_reader');
    assert.ok(roleMigration, 'the additive L2 role migration is loaded');
    await testDatabase.executor.execute(roleMigration.sql);

    const role = await testDatabase.executor.query<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
       FROM pg_roles WHERE rolname = 'waspada_l2_grounding_reader'`,
    );
    assert.deepEqual(role.rows[0], {
      rolcanlogin: false,
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolbypassrls: false,
    });

    const schemaPrivileges = await testDatabase.executor.query<{ can_use: boolean; can_create: boolean }>(
      `SELECT has_schema_privilege('waspada_l2_grounding_reader', 'waspada', 'USAGE') AS can_use,
              has_schema_privilege('waspada_l2_grounding_reader', 'waspada', 'CREATE') AS can_create`,
    );
    assert.deepEqual(schemaPrivileges.rows[0], { can_use: true, can_create: false });

    const columnPrivileges = await testDatabase.executor.query<{
      table_name: string;
      column_name: string;
      can_select: boolean;
    }>(
      `SELECT table_class.relname AS table_name,
              column_meta.attname AS column_name,
              has_column_privilege('waspada_l2_grounding_reader', table_class.oid,
                                   column_meta.attnum, 'SELECT') AS can_select
       FROM pg_class AS table_class
       JOIN pg_namespace AS table_schema ON table_schema.oid = table_class.relnamespace
       JOIN pg_attribute AS column_meta ON column_meta.attrelid = table_class.oid
       WHERE table_schema.nspname = 'waspada'
         AND table_class.relkind IN ('r', 'p')
         AND column_meta.attnum > 0 AND NOT column_meta.attisdropped
       ORDER BY table_class.relname, column_meta.attname`,
    );
    const grantedColumns = columnPrivileges.rows
      .filter((row) => row.can_select)
      .map((row) => `${row.table_name}.${row.column_name}`)
      .sort();
    assert.deepEqual(grantedColumns, [
      'embedding_runs.capability',
      'embedding_runs.chunk_id',
      'embedding_runs.created_at',
      'embedding_runs.dataset_kind',
      'embedding_runs.dimensions',
      'embedding_runs.distance_metric',
      'embedding_runs.embedding_run_id',
      'embedding_runs.input_text_hash',
      'embedding_runs.model_version',
      'embedding_runs.provider',
      'embedding_runs.status',
      'embedding_runs.vector_index_version',
      'embedding_vectors.dataset_kind',
      'embedding_vectors.dimensions',
      'embedding_vectors.embedding',
      'embedding_vectors.embedding_run_id',
      'evidence_chunks.chunk_id',
      'evidence_chunks.chunk_text_hash',
      'evidence_chunks.chunker_version',
      'evidence_chunks.dataset_kind',
      'evidence_chunks.permitted_text_hash',
      'evidence_chunks.report_revision_id',
      'evidence_chunks.span_end',
      'evidence_chunks.span_start',
      'evidence_chunks.status',
      'evidence_origins.dataset_kind',
      'evidence_origins.independence_status',
      'evidence_origins.lineage_relation',
      'evidence_origins.origin_id',
      'evidence_origins.origin_kind',
      'evidence_origins.source_id',
      'evidence_references.dataset_kind',
      'evidence_references.evidence_ref_id',
      'evidence_references.offset_unit',
      'evidence_references.permitted_text_hash',
      'evidence_references.relation',
      'evidence_references.report_revision_id',
      'evidence_references.span_end',
      'evidence_references.span_start',
      'extraction_evidence.candidate_id',
      'extraction_evidence.dataset_kind',
      'extraction_evidence.evidence_ref_id',
      'extraction_results.candidate_id',
      'extraction_results.dataset_kind',
      'extraction_results.record_json',
      'geometries.dataset_kind',
      'geometries.display_label',
      'geometries.geometry_id',
      'geometries.precision_basis',
      'geometries.precision_m',
      'geometries.role',
      'geometries.shape',
      'geometry_evidence.dataset_kind',
      'geometry_evidence.evidence_ref_id',
      'geometry_evidence.geometry_id',
      'origin_dependencies.dataset_kind',
      'origin_dependencies.depends_on_origin_id',
      'origin_dependencies.origin_id',
      'origin_evidence.dataset_kind',
      'origin_evidence.evidence_ref_id',
      'origin_evidence.origin_id',
      'report_revisions.dataset_kind',
      'report_revisions.observed_at',
      'report_revisions.permitted_text',
      'report_revisions.permitted_text_hash',
      'report_revisions.published_at',
      'report_revisions.report_revision_id',
      'report_revisions.retrieved_at',
      'report_revisions.revision_status',
      'report_revisions.source_id',
      'report_revisions.valid_from',
      'report_revisions.valid_until',
      'source_registry.approval_status',
      'source_registry.display_name',
      'source_registry.health_status',
      'source_registry.publisher_group_id',
      'source_registry.registry_status',
      'source_registry.source_id',
      'source_registry.source_kind',
    ].sort());

    const relationPrivileges = await testDatabase.executor.query<{
      table_name: string;
      can_select: boolean;
      can_insert: boolean;
      can_update: boolean;
      can_delete: boolean;
    }>(
      `SELECT table_class.relname AS table_name,
              has_table_privilege('waspada_l2_grounding_reader', table_class.oid, 'SELECT') AS can_select,
              has_table_privilege('waspada_l2_grounding_reader', table_class.oid, 'INSERT') AS can_insert,
              has_table_privilege('waspada_l2_grounding_reader', table_class.oid, 'UPDATE') AS can_update,
              has_table_privilege('waspada_l2_grounding_reader', table_class.oid, 'DELETE') AS can_delete
       FROM pg_class AS table_class
       JOIN pg_namespace AS table_schema ON table_schema.oid = table_class.relnamespace
       WHERE table_schema.nspname = 'waspada' AND table_class.relkind IN ('r', 'p')
       ORDER BY table_class.relname`,
    );
    assert.equal(relationPrivileges.rows.some((row) => row.can_select), false,
      'no table-wide SELECT shortcut is granted');
    assert.equal(relationPrivileges.rows.some((row) => row.can_insert || row.can_update || row.can_delete), false,
      'the reader has no table-level writes');

    const sequencePrivileges = await testDatabase.executor.query<{
      can_usage: boolean;
      can_select: boolean;
      can_update: boolean;
    }>(
      `SELECT has_sequence_privilege('waspada_l2_grounding_reader',
                'waspada.evidence_references_evidence_ref_id_seq', 'USAGE') AS can_usage,
              has_sequence_privilege('waspada_l2_grounding_reader',
                'waspada.evidence_references_evidence_ref_id_seq', 'SELECT') AS can_select,
              has_sequence_privilege('waspada_l2_grounding_reader',
                'waspada.evidence_references_evidence_ref_id_seq', 'UPDATE') AS can_update`,
    );
    assert.deepEqual(sequencePrivileges.rows[0], { can_usage: false, can_select: false, can_update: false });
  });
});
