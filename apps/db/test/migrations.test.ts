import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { applyMigrations, readMigrations, type SqlMigration } from '../src/migrations.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

describe('DATA-01 migrations', () => {
  let testDatabase: TestDatabase;
  let migrations: SqlMigration[];

  before(async () => {
    testDatabase = await createTestDatabase();
    migrations = await readMigrations(new URL('../migrations/', import.meta.url));
    const through006 = migrations.filter(({ version }) =>
      version !== '007_l1_write_idempotency'
      && version !== '008_l3_investigation_ledger'
      && version !== '009_evidence_reference_updates_relation'
      && version !== '010_l2_grounding_context_writer'
      && version !== '011_public_projection_lookups');
    const result = await applyMigrations(testDatabase.executor, through006);
    assert.deepEqual(result.applied, [
      '001_foundation', '002_acquisition_jobs', '003_evidence_chunk_pipeline_reads',
      '004_l2_grounding_reader', '005_publication_write_receipts_outbox', '006_l1_geometry_evidence_reads',
    ]);
    assert.deepEqual(result.skipped, []);
  });

  after(async () => {
    await testDatabase.close();
  });

  it('updates only the relation constraint transactionally and preserves all four values on reapplication', async () => {
    const migrationDatabase = await createTestDatabase();
    try {
      const relationMigration = migrations.find(({ version }) =>
        version === '009_evidence_reference_updates_relation');
      assert.ok(relationMigration, 'the additive evidence relation migration is loaded');
      const beforeRelationMigration = migrations.filter(({ version }) =>
        version !== '009_evidence_reference_updates_relation'
        && version !== '010_l2_grounding_context_writer'
        && version !== '011_public_projection_lookups');
      await applyMigrations(migrationDatabase.executor, beforeRelationMigration);

      await migrationDatabase.executor.query(
        `INSERT INTO waspada.traces
           (trace_id, dataset_kind, started_at, outcome, metadata)
         VALUES ('trace-relation-migration', 'synthetic', '2026-09-26T10:00:00Z', 'open',
           '{"fixture":"synthetic-test-only"}'::jsonb)`,
      );
      await migrationDatabase.executor.query(
        `INSERT INTO waspada.source_registry
           (source_id, trace_id, registry_version, display_name, source_kind, remit,
            access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
            approval_status, health_status, auto_acquisition_enabled, auto_publication_policy)
         VALUES ('source-relation-migration', 'trace-relation-migration', 1,
           'Synthetic evidence relation fixture', 'other', ARRAY['migration test'],
           'manual_fixture', ARRAY[]::text[], ARRAY['synthetic rows only'], ARRAY['test fixture'],
           'active', 'approved', 'unknown', false, 'never')`,
      );
      const permittedText = 'Synthetic relation fixture.';
      const permittedTextHash = sha256(permittedText);
      await migrationDatabase.executor.query(
        `INSERT INTO waspada.report_revisions
           (dataset_kind, report_revision_id, trace_id, source_id, canonical_url,
            source_revision_key, content_hash, permitted_text, permitted_text_hash,
            normalization_version, retrieved_at, revision_status, record_json)
         VALUES ('synthetic', 'revision-relation-migration', 'trace-relation-migration',
           'source-relation-migration', 'https://synthetic.invalid/relation-migration',
           NULL, $1, $2, $3, 'normalization-test-v1', '2026-09-26T10:01:00Z',
           'unreviewed', '{"fixture":"synthetic-test-only"}'::jsonb)`,
        [sha256('synthetic source fixture'), permittedText, permittedTextHash],
      );
      await migrationDatabase.executor.query(
        `INSERT INTO waspada.evidence_references
           (dataset_kind, trace_id, report_revision_id, permitted_text_hash,
            span_start, span_end, offset_unit, relation)
         VALUES ('synthetic', 'trace-relation-migration', 'revision-relation-migration', $1,
                   0, 1, 'unicode_code_points', 'supports'),
                ('synthetic', 'trace-relation-migration', 'revision-relation-migration', $1,
                   0, 1, 'unicode_code_points', 'contradicts'),
                ('synthetic', 'trace-relation-migration', 'revision-relation-migration', $1,
                   0, 1, 'unicode_code_points', 'context')`,
        [permittedTextHash],
      );

      const readEvidenceRows = () => migrationDatabase.executor.query<{
        evidence_ref_id: string;
        dataset_kind: string;
        trace_id: string;
        report_revision_id: string;
        permitted_text_hash: string;
        span_start: number;
        span_end: number;
        offset_unit: string;
        relation: string;
      }>(
        `SELECT evidence_ref_id::text AS evidence_ref_id, dataset_kind, trace_id,
                report_revision_id, permitted_text_hash, span_start, span_end,
                offset_unit, relation
         FROM waspada.evidence_references ORDER BY evidence_ref_id`,
      );
      const readReferenceConstraints = () => migrationDatabase.executor.query<{
        conname: string;
        definition: string;
      }>(
        `SELECT conname, pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
         WHERE conrelid = 'waspada.evidence_references'::regclass
         ORDER BY conname`,
      );
      const readRoleState = () => readEvidenceRelationRoleSnapshot(migrationDatabase);
      const originalRows = await readEvidenceRows();
      const originalConstraints = await readReferenceConstraints();
      const originalRoleState = await readRoleState();

      await assert.rejects(
        applyMigrations(migrationDatabase.executor, [
          ...beforeRelationMigration,
          { ...relationMigration, sql: `${relationMigration.sql}\nSELECT 1 / 0;` },
        ]),
        /division by zero/i,
      );
      const failedLedgerEntry = await migrationDatabase.executor.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM waspada.schema_migrations
         WHERE version = '009_evidence_reference_updates_relation'`,
      );
      assert.equal(failedLedgerEntry.rows[0]?.count, '0');
      assert.deepEqual((await readEvidenceRows()).rows, originalRows.rows,
        'a failed migration transaction leaves existing references untouched');
      assert.deepEqual((await readReferenceConstraints()).rows, originalConstraints.rows,
        'a failed migration transaction restores the original constraint');
      assert.deepEqual(await readRoleState(), originalRoleState,
        'a failed migration does not alter the L1/L2 role state');
      await assert.rejects(
        migrationDatabase.executor.query(
          `INSERT INTO waspada.evidence_references
             (dataset_kind, trace_id, report_revision_id, permitted_text_hash,
              span_start, span_end, offset_unit, relation)
           VALUES ('synthetic', 'trace-relation-migration', 'revision-relation-migration',
              $1, 0, 1, 'unicode_code_points', 'updates')`,
          [permittedTextHash],
        ),
        /check constraint/i,
      );

      const applied = await applyMigrations(migrationDatabase.executor, migrations);
      assert.deepEqual(applied.applied, [
        '009_evidence_reference_updates_relation',
        '010_l2_grounding_context_writer',
        '011_public_projection_lookups',
      ]);
      assert.deepEqual(applied.skipped, beforeRelationMigration.map(({ version }) => version));
      assert.deepEqual((await readEvidenceRows()).rows, originalRows.rows,
        'the forward migration leaves existing evidence references unchanged');
      const updatedConstraints = await readReferenceConstraints();
      assert.deepEqual(
        updatedConstraints.rows.filter(({ conname }) => conname !== 'evidence_references_relation_check'),
        originalConstraints.rows.filter(({ conname }) => conname !== 'evidence_references_relation_check'),
        'the migration changes only the relation check constraint',
      );
      assert.match(
        updatedConstraints.rows.find(({ conname }) => conname === 'evidence_references_relation_check')?.definition ?? '',
        /updates/,
      );

      await migrationDatabase.executor.query(
        `INSERT INTO waspada.evidence_references
           (dataset_kind, trace_id, report_revision_id, permitted_text_hash,
            span_start, span_end, offset_unit, relation)
         VALUES ('synthetic', 'trace-relation-migration', 'revision-relation-migration',
            $1, 0, 1, 'unicode_code_points', 'updates')`,
        [permittedTextHash],
      );
      const acceptedRows = await readEvidenceRows();
      assert.deepEqual(acceptedRows.rows.map(({ relation }) => relation), [
        'supports', 'contradicts', 'context', 'updates',
      ]);
      await assert.rejects(
        migrationDatabase.executor.query(
          `INSERT INTO waspada.evidence_references
             (dataset_kind, trace_id, report_revision_id, permitted_text_hash,
              span_start, span_end, offset_unit, relation)
           VALUES ('synthetic', 'trace-relation-migration', 'revision-relation-migration',
              $1, 1, 2, 'unicode_code_points', 'unrelated')`,
          [permittedTextHash],
        ),
        /check constraint/i,
      );
      assert.deepEqual(await readRoleState(), originalRoleState,
        'the L1/L2 roles and relation-column privileges remain unchanged');

      await migrationDatabase.executor.transaction((transaction) => transaction.execute(relationMigration.sql));
      assert.deepEqual((await readEvidenceRows()).rows, acceptedRows.rows,
        'reapplying the SQL migration is safe and preserves every relation and identity');
      assert.deepEqual(await readRoleState(), originalRoleState,
        'reapplying the constraint migration leaves the L1/L2 roles unchanged');
    } finally {
      await migrationDatabase.close();
    }
  });

  it('refuses duplicate legacy evidence identities without changing either row', async () => {
    await testDatabase.executor.query(
      `INSERT INTO waspada.traces
         (trace_id, dataset_kind, started_at, outcome, metadata)
       VALUES ('trace-legacy-evidence-a', 'synthetic', '2026-09-25T10:00:00Z', 'open', '{"fixture":"synthetic"}'::jsonb),
              ('trace-legacy-evidence-b', 'synthetic', '2026-09-25T10:01:00Z', 'open', '{"fixture":"synthetic"}'::jsonb)`,
    );
    await testDatabase.executor.query(
      `INSERT INTO waspada.source_registry
         (source_id, trace_id, registry_version, display_name, source_kind, remit,
          access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
          approval_status, health_status, auto_acquisition_enabled, auto_publication_policy)
       VALUES ('source-legacy-evidence', 'trace-legacy-evidence-a', 1, 'Synthetic migration fixture',
          'other', ARRAY['migration test'], 'manual_fixture', ARRAY[]::text[],
          ARRAY['synthetic rows only'], ARRAY['test fixture'], 'active', 'approved',
          'unknown', false, 'never')`,
    );
    const text = 'Legacy fixture text';
    const textHash = sha256(text);
    await testDatabase.executor.query(
      `INSERT INTO waspada.report_revisions
         (dataset_kind, report_revision_id, trace_id, source_id, canonical_url,
          source_revision_key, content_hash, permitted_text, permitted_text_hash,
          normalization_version, retrieved_at, revision_status, record_json)
       VALUES ('synthetic', 'revision-legacy-evidence', 'trace-legacy-evidence-a',
          'source-legacy-evidence', 'https://synthetic.invalid/legacy', 'legacy-fixture',
          $1, $2, $3, 'normalization-test-v1', '2026-09-25T10:02:00Z', 'unreviewed',
          '{"fixture":"synthetic"}'::jsonb)`,
      [sha256('synthetic legacy source bytes'), text, textHash],
    );
    await testDatabase.executor.query(
      `INSERT INTO waspada.evidence_references
         (dataset_kind, trace_id, report_revision_id, permitted_text_hash,
          span_start, span_end, offset_unit, relation)
       VALUES ('synthetic', 'trace-legacy-evidence-a', 'revision-legacy-evidence', $1,
                  0, 6, 'unicode_code_points', 'supports'),
              ('synthetic', 'trace-legacy-evidence-b', 'revision-legacy-evidence', $1,
                  0, 6, 'unicode_code_points', 'supports')`,
      [textHash],
    );

    const beforeRows = await testDatabase.executor.query<{
      evidence_ref_id: string;
      trace_id: string;
    }>(
      `SELECT evidence_ref_id::text AS evidence_ref_id, trace_id
       FROM waspada.evidence_references ORDER BY evidence_ref_id`,
    );
    assert.equal(beforeRows.rows.length, 2);
    await assert.rejects(
      applyMigrations(testDatabase.executor, migrations),
      /007_l1_write_idempotency refuses pre-existing duplicate natural evidence-reference identities/,
    );

    const afterFailure = await testDatabase.executor.query<{
      evidence_ref_id: string;
      trace_id: string;
    }>(
      `SELECT evidence_ref_id::text AS evidence_ref_id, trace_id
       FROM waspada.evidence_references ORDER BY evidence_ref_id`,
    );
    assert.deepEqual(afterFailure.rows, beforeRows.rows);
    const migrationLedger = await testDatabase.executor.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM waspada.schema_migrations WHERE version = '007_l1_write_idempotency'",
    );
    assert.equal(migrationLedger.rows[0]?.count, '0');

    // Keep the failed legacy database untouched and release it before opening the clean test database.
    await testDatabase.close();
    testDatabase = await createTestDatabase();
    const cleanDatabaseMigrations = await applyMigrations(testDatabase.executor, migrations);
    assert.deepEqual(cleanDatabaseMigrations.applied, [
      '001_foundation', '002_acquisition_jobs', '003_evidence_chunk_pipeline_reads',
      '004_l2_grounding_reader', '005_publication_write_receipts_outbox',
      '006_l1_geometry_evidence_reads', '007_l1_write_idempotency',
      '008_l3_investigation_ledger', '009_evidence_reference_updates_relation',
      '010_l2_grounding_context_writer', '011_public_projection_lookups',
    ]);
  });

  it('applies from empty state and is repeatable with checksum protection', async () => {
    const repeated = await applyMigrations(testDatabase.executor, migrations);
    assert.deepEqual(repeated.applied, []);
    assert.deepEqual(repeated.skipped, [
      '001_foundation', '002_acquisition_jobs', '003_evidence_chunk_pipeline_reads',
      '004_l2_grounding_reader', '005_publication_write_receipts_outbox', '006_l1_geometry_evidence_reads',
      '007_l1_write_idempotency',
      '008_l3_investigation_ledger', '009_evidence_reference_updates_relation',
      '010_l2_grounding_context_writer', '011_public_projection_lookups',
    ]);

    const count = await testDatabase.executor.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM waspada.schema_migrations',
    );
    assert.equal(count.rows[0]?.count, '11');

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
      /Cannot apply migration 000_late_backfill before already applied migration 011_public_projection_lookups/,
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
      { version: '006_l1_geometry_evidence_reads' },
      { version: '007_l1_write_idempotency' },
      { version: '008_l3_investigation_ledger' },
      { version: '009_evidence_reference_updates_relation' },
      { version: '010_l2_grounding_context_writer' },
      { version: '011_public_projection_lookups' },
    ]);
  });

  it('loads only ordered, named SQL migrations', async () => {
    assert.deepEqual(migrations.map(({ version }) => version), [
      '001_foundation', '002_acquisition_jobs', '003_evidence_chunk_pipeline_reads', '004_l2_grounding_reader',
      '005_publication_write_receipts_outbox', '006_l1_geometry_evidence_reads', '007_l1_write_idempotency',
      '008_l3_investigation_ledger', '009_evidence_reference_updates_relation',
      '010_l2_grounding_context_writer', '011_public_projection_lookups',
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

  it('grants L1 only geometry and support columns, with no table-level reads or geometry mutations', async () => {
    const columns = await testDatabase.executor.query<{
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
         AND table_class.relname IN ('evidence_references', 'geometries', 'geometry_evidence')
         AND column_meta.attnum > 0 AND NOT column_meta.attisdropped
       ORDER BY table_class.relname, column_meta.attname`,
    );
    const granted = columns.rows
      .filter((row) => row.can_select)
      .map((row) => `${row.table_name}.${row.column_name}`)
      .sort();
    assert.deepEqual(granted, [
      'evidence_references.dataset_kind',
      'evidence_references.evidence_ref_id',
      'evidence_references.offset_unit',
      'evidence_references.permitted_text_hash',
      'evidence_references.relation',
      'evidence_references.report_revision_id',
      'evidence_references.span_end',
      'evidence_references.span_start',
      'geometries.coordinate_reference_system',
      'geometries.dataset_kind',
      'geometries.display_label',
      'geometries.geometry_id',
      'geometries.precision_basis',
      'geometries.precision_m',
      'geometries.record_json',
      'geometries.role',
      'geometries.shape',
      'geometries.trace_id',
      'geometry_evidence.dataset_kind',
      'geometry_evidence.evidence_ref_id',
      'geometry_evidence.geometry_id',
    ]);

    const tablePrivileges = await testDatabase.executor.query<{
      table_name: string;
      can_select: boolean;
      can_update: boolean;
      can_delete: boolean;
    }>(
      `SELECT table_class.relname AS table_name,
              has_table_privilege('waspada_l1_pipeline', table_class.oid, 'SELECT') AS can_select,
              has_table_privilege('waspada_l1_pipeline', table_class.oid, 'UPDATE') AS can_update,
              has_table_privilege('waspada_l1_pipeline', table_class.oid, 'DELETE') AS can_delete
       FROM pg_class AS table_class
       JOIN pg_namespace AS table_schema ON table_schema.oid = table_class.relnamespace
       WHERE table_schema.nspname = 'waspada'
         AND table_class.relname IN ('evidence_references', 'geometries', 'geometry_evidence')
       ORDER BY table_class.relname`,
    );
    assert.deepEqual(tablePrivileges.rows, [
      { table_name: 'evidence_references', can_select: false, can_update: false, can_delete: false },
      { table_name: 'geometries', can_select: false, can_update: false, can_delete: false },
      { table_name: 'geometry_evidence', can_select: false, can_update: false, can_delete: false },
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

  it('creates a NOLOGIN L3 coordinator with only ledger and grounding columns', async () => {
    const role = await testDatabase.executor.query<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
       FROM pg_roles WHERE rolname = 'waspada_l3_coordinator'`,
    );
    assert.deepEqual(role.rows[0], {
      rolcanlogin: false, rolsuper: false, rolcreatedb: false,
      rolcreaterole: false, rolreplication: false, rolbypassrls: false,
    });

    const schema = await testDatabase.executor.query<{ can_use: boolean; can_create: boolean }>(
      `SELECT has_schema_privilege('waspada_l3_coordinator', 'waspada', 'USAGE') AS can_use,
              has_schema_privilege('waspada_l3_coordinator', 'waspada', 'CREATE') AS can_create`,
    );
    assert.deepEqual(schema.rows[0], { can_use: true, can_create: false });

    const columns = await testDatabase.executor.query<{
      table_name: string;
      column_name: string;
      can_select: boolean;
      can_insert: boolean;
      can_update: boolean;
    }>(
      `SELECT table_class.relname AS table_name, column_meta.attname AS column_name,
              has_column_privilege('waspada_l3_coordinator', table_class.oid, column_meta.attnum, 'SELECT') AS can_select,
              has_column_privilege('waspada_l3_coordinator', table_class.oid, column_meta.attnum, 'INSERT') AS can_insert,
              has_column_privilege('waspada_l3_coordinator', table_class.oid, column_meta.attnum, 'UPDATE') AS can_update
       FROM pg_class AS table_class
       JOIN pg_namespace AS table_schema ON table_schema.oid = table_class.relnamespace
       JOIN pg_attribute AS column_meta ON column_meta.attrelid = table_class.oid
       WHERE table_schema.nspname = 'waspada'
         AND table_class.relname IN ('extraction_results', 'grounding_contexts',
           'investigation_requests', 'investigation_checkpoints', 'investigation_action_reservations')
         AND column_meta.attnum > 0 AND NOT column_meta.attisdropped
       ORDER BY table_class.relname, column_meta.attname`,
    );

    const expected = new Set<string>();
    const expect = (table: string, privilege: 'select' | 'insert' | 'update', names: readonly string[]) => {
      for (const name of names) expected.add(`${table}.${name}.${privilege}`);
    };
    expect('extraction_results', 'select', ['dataset_kind', 'candidate_id']);
    expect('grounding_contexts', 'select', ['dataset_kind', 'context_id', 'trace_id', 'candidate_id', 'sufficient']);
    expect('investigation_requests', 'select', [
      'dataset_kind', 'investigation_id', 'trace_id', 'candidate_id', 'context_id', 'event_id', 'event_version',
      'questions', 'budget_policy_version', 'limit_tool_attempts', 'limit_reasoning_turns', 'limit_active_seconds',
      'limit_model_tokens', 'consumed_tool_attempts', 'consumed_reasoning_turns', 'consumed_active_seconds',
      'consumed_model_tokens', 'reserved_tool_attempts', 'reserved_reasoning_turns', 'reserved_active_seconds',
      'reserved_model_tokens', 'requested_at', 'record_json',
    ]);
    expect('investigation_requests', 'insert', [
      'dataset_kind', 'investigation_id', 'trace_id', 'candidate_id', 'context_id', 'event_id', 'event_version',
      'questions', 'budget_policy_version', 'limit_tool_attempts', 'limit_reasoning_turns', 'limit_active_seconds',
      'limit_model_tokens', 'requested_at', 'record_json',
    ]);
    expect('investigation_requests', 'update', [
      'consumed_tool_attempts', 'consumed_reasoning_turns', 'consumed_active_seconds', 'consumed_model_tokens',
      'reserved_tool_attempts', 'reserved_reasoning_turns', 'reserved_active_seconds', 'reserved_model_tokens',
    ]);
    const checkpointColumns = [
      'dataset_kind', 'checkpoint_id', 'investigation_id', 'checkpoint_version', 'trace_id', 'candidate_id',
      'context_id', 'event_id', 'event_version', 'case_status', 'stop_reason', 'budget_policy_version',
      'limit_tool_attempts', 'limit_reasoning_turns', 'limit_active_seconds', 'limit_model_tokens',
      'consumed_tool_attempts', 'consumed_reasoning_turns', 'consumed_active_seconds', 'consumed_model_tokens',
      'reserved_tool_attempts', 'reserved_reasoning_turns', 'reserved_active_seconds', 'reserved_model_tokens',
      'attempts', 'reasoning_runs', 'created_at', 'updated_at', 'completed_at', 'record_json',
    ];
    expect('investigation_checkpoints', 'select', checkpointColumns);
    expect('investigation_checkpoints', 'insert', checkpointColumns);
    const reservationColumns = [
      'dataset_kind', 'reservation_id', 'investigation_id', 'action_kind', 'action_name',
      'expected_checkpoint_version', 'reserved_tool_attempts', 'reserved_reasoning_turns',
      'reserved_active_seconds', 'reserved_model_tokens', 'reservation_status', 'outcome',
      'actual_active_seconds', 'actual_model_tokens', 'created_at', 'started_at', 'finished_at',
      'reconciled_checkpoint_version',
    ];
    expect('investigation_action_reservations', 'select', reservationColumns);
    expect('investigation_action_reservations', 'insert', [
      'dataset_kind', 'reservation_id', 'investigation_id', 'action_kind', 'action_name',
      'expected_checkpoint_version', 'reserved_tool_attempts', 'reserved_reasoning_turns',
      'reserved_active_seconds', 'reserved_model_tokens', 'reservation_status', 'created_at',
    ]);
    expect('investigation_action_reservations', 'update', [
      'reservation_status', 'outcome', 'actual_active_seconds', 'actual_model_tokens',
      'started_at', 'finished_at', 'reconciled_checkpoint_version',
    ]);

    const granted = new Set<string>();
    for (const row of columns.rows) {
      for (const [privilege, grantedPrivilege] of [
        ['select', row.can_select], ['insert', row.can_insert], ['update', row.can_update],
      ] as const) {
        if (grantedPrivilege) granted.add(`${row.table_name}.${row.column_name}.${privilege}`);
      }
    }
    assert.deepEqual([...granted].sort(), [...expected].sort());

    const tables = await testDatabase.executor.query<{
      table_name: string;
      can_select: boolean;
      can_insert: boolean;
      can_update: boolean;
      can_delete: boolean;
    }>(
      `SELECT table_class.relname AS table_name,
              has_table_privilege('waspada_l3_coordinator', table_class.oid, 'SELECT') AS can_select,
              has_table_privilege('waspada_l3_coordinator', table_class.oid, 'INSERT') AS can_insert,
              has_table_privilege('waspada_l3_coordinator', table_class.oid, 'UPDATE') AS can_update,
              has_table_privilege('waspada_l3_coordinator', table_class.oid, 'DELETE') AS can_delete
       FROM pg_class AS table_class
       JOIN pg_namespace AS table_schema ON table_schema.oid = table_class.relnamespace
       WHERE table_schema.nspname = 'waspada' AND table_class.relkind IN ('r', 'p')
       ORDER BY table_class.relname`,
    );
    assert.equal(tables.rows.some((row) => row.can_select || row.can_insert || row.can_update || row.can_delete), false,
      'no table-level privilege shortcut is granted');

    const publication = await testDatabase.executor.query<{ can_select: boolean; can_insert: boolean; can_update: boolean; can_delete: boolean }>(
      `SELECT has_table_privilege('waspada_l3_coordinator', 'waspada.event_versions', 'SELECT') AS can_select,
              has_table_privilege('waspada_l3_coordinator', 'waspada.event_versions', 'INSERT') AS can_insert,
              has_table_privilege('waspada_l3_coordinator', 'waspada.event_versions', 'UPDATE') AS can_update,
              has_table_privilege('waspada_l3_coordinator', 'waspada.event_versions', 'DELETE') AS can_delete`,
    );
    assert.deepEqual(publication.rows[0], { can_select: false, can_insert: false, can_update: false, can_delete: false });
  });
});

async function readEvidenceRelationRoleSnapshot(testDatabase: TestDatabase) {
  const roleAttributes = await testDatabase.executor.query<{
    rolname: string;
    rolcanlogin: boolean;
    rolsuper: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
    rolreplication: boolean;
    rolbypassrls: boolean;
  }>(
    `SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
     FROM pg_roles
     WHERE rolname IN ('waspada_l1_pipeline', 'waspada_l2_grounding_reader')
     ORDER BY rolname`,
  );
  const relationPrivileges = await testDatabase.executor.query<{
    role_name: string;
    can_select_table: boolean;
    can_select_relation: boolean;
    can_insert_relation: boolean;
    can_update_relation: boolean;
    can_delete_table: boolean;
  }>(
    `SELECT role_name,
            has_table_privilege(role_name, 'waspada.evidence_references', 'SELECT') AS can_select_table,
            has_column_privilege(role_name, 'waspada.evidence_references', 'relation', 'SELECT') AS can_select_relation,
            has_column_privilege(role_name, 'waspada.evidence_references', 'relation', 'INSERT') AS can_insert_relation,
            has_column_privilege(role_name, 'waspada.evidence_references', 'relation', 'UPDATE') AS can_update_relation,
            has_table_privilege(role_name, 'waspada.evidence_references', 'DELETE') AS can_delete_table
     FROM (VALUES ('waspada_l1_pipeline'), ('waspada_l2_grounding_reader')) AS roles(role_name)
     ORDER BY role_name`,
  );
  return { roleAttributes: roleAttributes.rows, relationPrivileges: relationPrivileges.rows };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
