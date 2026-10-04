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
      && version !== '011_public_projection_lookups'
      && version !== '012_public_geometry_reader'
      && version !== '013_public_event_history_reader'
      && version !== '014_public_event_history_review_metadata'
      && version !== '015_public_geojson_candidates'
      && version !== '016_public_update_feed_order'
      && version !== '017_moderator_publication_writer_role'
      && version !== '018_l1_extraction_result_verification'
      && version !== '019_l3_progress_fingerprints'
      && version !== '020_public_event_freshness_aggregate'
      && version !== '021_l1_scheduler_namespace_read'
      && version !== '022_l1_embedding_verification_reads'
      && version !== '023_l2_event_proposal_writer'
      && version !== '024_freshness_transition_ledger'
      && version !== '025_freshness_current_public_overlay'
      && version !== '026_freshness_due_run_traces'
      && version !== '027_publication_outbox_delivery'
      && version !== '028_report_revision_impact_reader'
      && version !== '029_source_revision_observations'
      && version !== '030_l2_source_revision_grounding_gate'
      && version !== '031_source_revision_review_candidate_reader');
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
        && version !== '011_public_projection_lookups'
        && version !== '012_public_geometry_reader'
        && version !== '013_public_event_history_reader'
        && version !== '014_public_event_history_review_metadata'
        && version !== '015_public_geojson_candidates'
        && version !== '016_public_update_feed_order'
        && version !== '017_moderator_publication_writer_role'
        && version !== '018_l1_extraction_result_verification'
        && version !== '019_l3_progress_fingerprints'
        && version !== '020_public_event_freshness_aggregate'
        && version !== '021_l1_scheduler_namespace_read'
        && version !== '022_l1_embedding_verification_reads'
        && version !== '023_l2_event_proposal_writer'
        && version !== '024_freshness_transition_ledger'
        && version !== '025_freshness_current_public_overlay'
        && version !== '026_freshness_due_run_traces'
        && version !== '027_publication_outbox_delivery'
        && version !== '028_report_revision_impact_reader'
        && version !== '029_source_revision_observations'
        && version !== '030_l2_source_revision_grounding_gate'
        && version !== '031_source_revision_review_candidate_reader');
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
        '012_public_geometry_reader',
        '013_public_event_history_reader',
        '014_public_event_history_review_metadata',
        '015_public_geojson_candidates',
        '016_public_update_feed_order',
        '017_moderator_publication_writer_role',
        '018_l1_extraction_result_verification', '019_l3_progress_fingerprints',
        '020_public_event_freshness_aggregate',
        '021_l1_scheduler_namespace_read',
        '022_l1_embedding_verification_reads',
        '023_l2_event_proposal_writer',
        '024_freshness_transition_ledger',
        '025_freshness_current_public_overlay',
        '026_freshness_due_run_traces',
        '027_publication_outbox_delivery',
        '028_report_revision_impact_reader',
        '029_source_revision_observations',
        '030_l2_source_revision_grounding_gate',
        '031_source_revision_review_candidate_reader',
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
      '012_public_geometry_reader', '013_public_event_history_reader',
      '014_public_event_history_review_metadata', '015_public_geojson_candidates',
      '016_public_update_feed_order',
      '017_moderator_publication_writer_role',
      '018_l1_extraction_result_verification', '019_l3_progress_fingerprints',
      '020_public_event_freshness_aggregate',
      '021_l1_scheduler_namespace_read',
      '022_l1_embedding_verification_reads',
      '023_l2_event_proposal_writer',
      '024_freshness_transition_ledger',
      '025_freshness_current_public_overlay',
      '026_freshness_due_run_traces',
      '027_publication_outbox_delivery',
      '028_report_revision_impact_reader',
      '029_source_revision_observations',
      '030_l2_source_revision_grounding_gate',
      '031_source_revision_review_candidate_reader',
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
      '012_public_geometry_reader', '013_public_event_history_reader',
      '014_public_event_history_review_metadata', '015_public_geojson_candidates',
      '016_public_update_feed_order',
      '017_moderator_publication_writer_role',
      '018_l1_extraction_result_verification', '019_l3_progress_fingerprints',
      '020_public_event_freshness_aggregate',
      '021_l1_scheduler_namespace_read',
      '022_l1_embedding_verification_reads',
      '023_l2_event_proposal_writer',
      '024_freshness_transition_ledger',
      '025_freshness_current_public_overlay',
      '026_freshness_due_run_traces',
      '027_publication_outbox_delivery',
      '028_report_revision_impact_reader',
      '029_source_revision_observations',
      '030_l2_source_revision_grounding_gate',
      '031_source_revision_review_candidate_reader',
    ]);

    const count = await testDatabase.executor.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM waspada.schema_migrations',
    );
    assert.equal(count.rows[0]?.count, '31');

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
      /Cannot apply migration 000_late_backfill before already applied migration 031_source_revision_review_candidate_reader/,
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
      { version: '012_public_geometry_reader' },
      { version: '013_public_event_history_reader' },
      { version: '014_public_event_history_review_metadata' },
      { version: '015_public_geojson_candidates' },
      { version: '016_public_update_feed_order' },
      { version: '017_moderator_publication_writer_role' },
      { version: '018_l1_extraction_result_verification' },
      { version: '019_l3_progress_fingerprints' },
      { version: '020_public_event_freshness_aggregate' },
      { version: '021_l1_scheduler_namespace_read' },
      { version: '022_l1_embedding_verification_reads' },
      { version: '023_l2_event_proposal_writer' },
      { version: '024_freshness_transition_ledger' },
      { version: '025_freshness_current_public_overlay' },
      { version: '026_freshness_due_run_traces' },
      { version: '027_publication_outbox_delivery' },
      { version: '028_report_revision_impact_reader' },
      { version: '029_source_revision_observations' },
      { version: '030_l2_source_revision_grounding_gate' },
      { version: '031_source_revision_review_candidate_reader' },
    ]);
  });

  it('loads only ordered, named SQL migrations', async () => {
    assert.deepEqual(migrations.map(({ version }) => version), [
      '001_foundation', '002_acquisition_jobs', '003_evidence_chunk_pipeline_reads', '004_l2_grounding_reader',
      '005_publication_write_receipts_outbox', '006_l1_geometry_evidence_reads', '007_l1_write_idempotency',
      '008_l3_investigation_ledger', '009_evidence_reference_updates_relation',
      '010_l2_grounding_context_writer', '011_public_projection_lookups',
      '012_public_geometry_reader', '013_public_event_history_reader',
      '014_public_event_history_review_metadata', '015_public_geojson_candidates',
      '016_public_update_feed_order',
      '017_moderator_publication_writer_role',
      '018_l1_extraction_result_verification', '019_l3_progress_fingerprints',
      '020_public_event_freshness_aggregate',
      '021_l1_scheduler_namespace_read',
      '022_l1_embedding_verification_reads',
      '023_l2_event_proposal_writer',
      '024_freshness_transition_ledger',
      '025_freshness_current_public_overlay',
      '026_freshness_due_run_traces',
      '027_publication_outbox_delivery',
      '028_report_revision_impact_reader',
      '029_source_revision_observations',
      '030_l2_source_revision_grounding_gate',
      '031_source_revision_review_candidate_reader',
    ]);
    const version = await testDatabase.executor.query<{ version: string; server_version: string }>(
      "SELECT extversion AS version, current_setting('server_version') AS server_version FROM pg_extension WHERE extname = 'postgis'",
    );
    assert.match(version.rows[0]?.version ?? '', /^\d+\.\d+/);
    assert.match(version.rows[0]?.server_version ?? '', /^\d+/);
  });

  it('adds a standalone report-revision reader without changing existing role privileges', async () => {
    const readerMigration = migrations.find(({ version }) => version === '028_report_revision_impact_reader');
    assert.ok(readerMigration, 'the report-revision reader migration is loaded');
    const migrationDatabase = await createTestDatabase();
    try {
      await applyMigrations(migrationDatabase.executor,
        migrations.filter(({ version }) => version !== readerMigration.version
          && version !== '029_source_revision_observations'
          && version !== '030_l2_source_revision_grounding_gate'
          && version !== '031_source_revision_review_candidate_reader'));
      const snapshotExistingRoles = async () => {
        const roleState = await migrationDatabase.executor.query<{ state: string }>(
          `SELECT rolname || ':' || rolinherit || ':' || rolcanlogin || ':' || rolsuper
                    || ':' || rolcreatedb || ':' || rolcreaterole || ':' || rolreplication
                    || ':' || rolbypassrls AS state
           FROM pg_roles
           WHERE left(rolname, 8) = 'waspada_'
             AND rolname <> 'waspada_l4_report_revision_impact_reader'
           ORDER BY state`,
        );
        const schemaState = await migrationDatabase.executor.query<{ state: string }>(
          `SELECT role.rolname || ':' ||
                    has_schema_privilege(role.rolname, 'waspada', 'USAGE') || ':' ||
                    has_schema_privilege(role.rolname, 'waspada', 'CREATE') AS state
           FROM pg_roles AS role
           WHERE left(role.rolname, 8) = 'waspada_'
             AND role.rolname <> 'waspada_l4_report_revision_impact_reader'
           ORDER BY state`,
        );
        const objectState = await migrationDatabase.executor.query<{ state: string }>(
          `SELECT role.rolname || ':' || relation.relname || ':' || attribute.attname
                    || ':' || has_table_privilege(role.rolname, relation.oid, 'SELECT')
                    || ':' || has_table_privilege(role.rolname, relation.oid, 'INSERT')
                    || ':' || has_table_privilege(role.rolname, relation.oid, 'UPDATE')
                    || ':' || has_table_privilege(role.rolname, relation.oid, 'DELETE')
                    || ':' || has_table_privilege(role.rolname, relation.oid, 'TRUNCATE')
                    || ':' || has_column_privilege(role.rolname, relation.oid, attribute.attnum, 'SELECT')
                    || ':' || has_column_privilege(role.rolname, relation.oid, attribute.attnum, 'INSERT')
                    || ':' || has_column_privilege(role.rolname, relation.oid, attribute.attnum, 'UPDATE') AS state
           FROM pg_roles AS role
           CROSS JOIN pg_class AS relation
           JOIN pg_namespace AS schema ON schema.oid = relation.relnamespace
           JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid
           WHERE left(role.rolname, 8) = 'waspada_'
             AND role.rolname <> 'waspada_l4_report_revision_impact_reader'
             AND schema.nspname = 'waspada'
             AND relation.relname IN (
               'event_versions', 'event_claim_evidence', 'evidence_references',
               'event_impact_refs', 'impact_claim_support'
             )
             AND attribute.attnum > 0
             AND NOT attribute.attisdropped
           ORDER BY state`,
        );
        const memberships = await migrationDatabase.executor.query<{ state: string }>(
          `SELECT granted.rolname || '->' || member.rolname AS state
           FROM pg_auth_members AS membership
           JOIN pg_roles AS granted ON granted.oid = membership.roleid
           JOIN pg_roles AS member ON member.oid = membership.member
           WHERE left(granted.rolname, 8) = 'waspada_'
              OR left(member.rolname, 8) = 'waspada_'
           ORDER BY state`,
        );
        return {
          roles: roleState.rows.map(({ state }) => state),
          schema: schemaState.rows.map(({ state }) => state),
          objects: objectState.rows.map(({ state }) => state),
          memberships: memberships.rows.map(({ state }) => state),
        };
      };

      const before = await snapshotExistingRoles();
      const applied = await applyMigrations(migrationDatabase.executor,
        migrations.filter(({ version }) => version !== '029_source_revision_observations'
          && version !== '030_l2_source_revision_grounding_gate'
          && version !== '031_source_revision_review_candidate_reader'));
      assert.deepEqual(applied.applied, ['028_report_revision_impact_reader']);
      assert.deepEqual(await snapshotExistingRoles(), before,
        'migration 028 does not broaden or alter an existing role');
      const role = await migrationDatabase.executor.query<{
        rolcanlogin: boolean;
        rolinherit: boolean;
        rolsuper: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolreplication: boolean;
        rolbypassrls: boolean;
      }>(
        "SELECT rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = 'waspada_l4_report_revision_impact_reader'",
      );
      assert.deepEqual(role.rows[0], {
        rolcanlogin: false, rolinherit: false, rolsuper: false, rolcreatedb: false,
        rolcreaterole: false, rolreplication: false, rolbypassrls: false,
      });
      const sourceText = await migrationDatabase.executor.query<{ can_select: boolean }>(
        "SELECT has_column_privilege('waspada_l4_report_revision_impact_reader', 'waspada.report_revisions', 'permitted_text', 'SELECT') AS can_select",
      );
      assert.equal(sourceText.rows[0]?.can_select, false);
    } finally {
      await migrationDatabase.close();
    }
  });

  it('grants only the existing L1 pipeline role access to source-observation metadata', async () => {
    const observationMigration = migrations.find(({ version }) =>
      version === '029_source_revision_observations');
    assert.ok(observationMigration, 'the source-observation migration is loaded');
    const migrationDatabase = await createTestDatabase();
    try {
      await applyMigrations(migrationDatabase.executor,
        migrations.filter(({ version }) => version !== observationMigration.version
          && version !== '030_l2_source_revision_grounding_gate'
          && version !== '031_source_revision_review_candidate_reader'));
      const snapshotExistingSecurity = async () => {
        const roles = await migrationDatabase.executor.query<{ state: string }>(
          `SELECT rolname || ':' || rolinherit || ':' || rolcanlogin || ':' || rolsuper
                    || ':' || rolcreatedb || ':' || rolcreaterole || ':' || rolreplication
                    || ':' || rolbypassrls AS state
           FROM pg_roles WHERE left(rolname, 8) = 'waspada_' ORDER BY state`,
        );
        const schemas = await migrationDatabase.executor.query<{ state: string }>(
          `SELECT role.rolname || ':' ||
                    has_schema_privilege(role.rolname, 'waspada', 'USAGE') || ':' ||
                    has_schema_privilege(role.rolname, 'waspada', 'CREATE') AS state
           FROM pg_roles AS role WHERE left(role.rolname, 8) = 'waspada_' ORDER BY state`,
        );
        const objects = await migrationDatabase.executor.query<{ state: string }>(
          `SELECT role.rolname || ':' || relation.relname || ':' || attribute.attname
                    || ':' || has_table_privilege(role.rolname, relation.oid, 'SELECT')
                    || ':' || has_table_privilege(role.rolname, relation.oid, 'INSERT')
                    || ':' || has_table_privilege(role.rolname, relation.oid, 'UPDATE')
                    || ':' || has_table_privilege(role.rolname, relation.oid, 'DELETE')
                    || ':' || has_table_privilege(role.rolname, relation.oid, 'TRUNCATE')
                    || ':' || has_column_privilege(role.rolname, relation.oid, attribute.attnum, 'SELECT')
                    || ':' || has_column_privilege(role.rolname, relation.oid, attribute.attnum, 'INSERT')
                    || ':' || has_column_privilege(role.rolname, relation.oid, attribute.attnum, 'UPDATE')
                    || ':' || has_column_privilege(role.rolname, relation.oid, attribute.attnum, 'REFERENCES') AS state
           FROM pg_roles AS role
           CROSS JOIN pg_class AS relation
           JOIN pg_namespace AS schema ON schema.oid = relation.relnamespace
           JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid
           WHERE left(role.rolname, 8) = 'waspada_'
             AND schema.nspname = 'waspada'
             AND relation.relkind IN ('r', 'p', 'v', 'm')
             AND relation.relname <> 'report_revision_source_observations'
             AND attribute.attnum > 0 AND NOT attribute.attisdropped
           ORDER BY state`,
        );
        const memberships = await migrationDatabase.executor.query<{ state: string }>(
          `SELECT granted.rolname || '->' || member.rolname AS state
           FROM pg_auth_members AS membership
           JOIN pg_roles AS granted ON granted.oid = membership.roleid
           JOIN pg_roles AS member ON member.oid = membership.member
           WHERE left(granted.rolname, 8) = 'waspada_'
              OR left(member.rolname, 8) = 'waspada_'
           ORDER BY state`,
        );
        return {
          roles: roles.rows.map(({ state }) => state),
          schemas: schemas.rows.map(({ state }) => state),
          objects: objects.rows.map(({ state }) => state),
          memberships: memberships.rows.map(({ state }) => state),
        };
      };

      const before = await snapshotExistingSecurity();
      const applied = await applyMigrations(migrationDatabase.executor,
        migrations.filter(({ version }) => version !== '030_l2_source_revision_grounding_gate'
          && version !== '031_source_revision_review_candidate_reader'));
      assert.deepEqual(applied.applied, ['029_source_revision_observations']);
      assert.deepEqual(await snapshotExistingSecurity(), before,
        'migration 029 does not change existing role attributes, memberships, schema grants, or object grants');

      const columns = await migrationDatabase.executor.query<{
        column_name: string;
        can_select: boolean;
        can_insert: boolean;
        can_update: boolean;
      }>(
        `SELECT attribute.attname AS column_name,
                has_column_privilege('waspada_l1_pipeline', relation.oid, attribute.attnum, 'SELECT') AS can_select,
                has_column_privilege('waspada_l1_pipeline', relation.oid, attribute.attnum, 'INSERT') AS can_insert,
                has_column_privilege('waspada_l1_pipeline', relation.oid, attribute.attnum, 'UPDATE') AS can_update
         FROM pg_class AS relation
         JOIN pg_namespace AS schema ON schema.oid = relation.relnamespace
         JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid
         WHERE schema.nspname = 'waspada'
           AND relation.relname = 'report_revision_source_observations'
           AND attribute.attnum > 0 AND NOT attribute.attisdropped
         ORDER BY attribute.attname`,
      );
      assert.deepEqual(columns.rows.filter(({ can_select }) => can_select)
        .map(({ column_name }) => column_name), [
        'asserted_state', 'assertion_report_revision_id', 'dataset_kind', 'observation_id',
        'publisher_observed_at', 'recorded_at', 'replacement_report_revision_id',
        'retrieved_at', 'source_id', 'target_report_revision_id', 'trace_id',
      ]);
      assert.deepEqual(columns.rows.filter(({ can_insert }) => can_insert)
        .map(({ column_name }) => column_name), [
        'asserted_state', 'assertion_report_revision_id', 'dataset_kind', 'observation_id',
        'publisher_observed_at', 'replacement_report_revision_id', 'retrieved_at',
        'source_id', 'target_report_revision_id', 'trace_id',
      ]);
      assert.equal(columns.rows.some(({ can_update }) => can_update), false);

      const l1TablePrivileges = await migrationDatabase.executor.query<{
        can_select: boolean;
        can_insert: boolean;
        can_update: boolean;
        can_delete: boolean;
        can_truncate: boolean;
      }>(
        `SELECT has_table_privilege('waspada_l1_pipeline', 'waspada.report_revision_source_observations', 'SELECT') AS can_select,
                has_table_privilege('waspada_l1_pipeline', 'waspada.report_revision_source_observations', 'INSERT') AS can_insert,
                has_table_privilege('waspada_l1_pipeline', 'waspada.report_revision_source_observations', 'UPDATE') AS can_update,
                has_table_privilege('waspada_l1_pipeline', 'waspada.report_revision_source_observations', 'DELETE') AS can_delete,
                has_table_privilege('waspada_l1_pipeline', 'waspada.report_revision_source_observations', 'TRUNCATE') AS can_truncate`,
      );
      assert.deepEqual(l1TablePrivileges.rows[0], {
        can_select: false, can_insert: false, can_update: false, can_delete: false, can_truncate: false,
      });

      const otherRoleAccess = await migrationDatabase.executor.query<{ role_name: string }>(
        `SELECT DISTINCT role.rolname AS role_name
         FROM pg_roles AS role
         JOIN pg_class AS relation ON relation.oid = 'waspada.report_revision_source_observations'::regclass
         JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid
         WHERE left(role.rolname, 8) = 'waspada_' AND role.rolname <> 'waspada_l1_pipeline'
           AND attribute.attnum > 0 AND NOT attribute.attisdropped
           AND (
             has_table_privilege(role.rolname, relation.oid, 'SELECT')
             OR has_table_privilege(role.rolname, relation.oid, 'INSERT')
             OR has_table_privilege(role.rolname, relation.oid, 'UPDATE')
             OR has_table_privilege(role.rolname, relation.oid, 'DELETE')
             OR has_table_privilege(role.rolname, relation.oid, 'TRUNCATE')
             OR has_column_privilege(role.rolname, relation.oid, attribute.attnum, 'SELECT')
             OR has_column_privilege(role.rolname, relation.oid, attribute.attnum, 'INSERT')
             OR has_column_privilege(role.rolname, relation.oid, attribute.attnum, 'UPDATE')
           )
         ORDER BY role.rolname`,
      );
      assert.deepEqual(otherRoleAccess.rows, [], 'the new table is private to the existing L1 role');

      const publicAccess = await migrationDatabase.executor.query<{
        table_access: boolean;
        column_access: boolean;
      }>(
        `SELECT EXISTS (
                  SELECT 1 FROM pg_class AS relation
                  CROSS JOIN LATERAL aclexplode(COALESCE(relation.relacl, acldefault('r', relation.relowner))) AS acl
                  WHERE relation.oid = 'waspada.report_revision_source_observations'::regclass
                    AND acl.grantee = 0
                ) AS table_access,
                EXISTS (
                  SELECT 1 FROM pg_attribute AS attribute
                  CROSS JOIN LATERAL aclexplode(attribute.attacl) AS acl
                  WHERE attribute.attrelid = 'waspada.report_revision_source_observations'::regclass
                    AND attribute.attnum > 0 AND NOT attribute.attisdropped AND acl.grantee = 0
                ) AS column_access`,
      );
      assert.deepEqual(publicAccess.rows[0], { table_access: false, column_access: false });

      const publicFunctionExecute = await migrationDatabase.executor.query<{
        public_execute: boolean;
      }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_proc AS procedure
           CROSS JOIN LATERAL aclexplode(COALESCE(procedure.proacl,
             acldefault('f', procedure.proowner))) AS acl
           WHERE procedure.oid =
             'waspada.validate_report_revision_source_observation_replacement()'::regprocedure
             AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
         ) AS public_execute`,
      );
      assert.deepEqual(publicFunctionExecute.rows[0], { public_execute: false });

      const sourceText = await migrationDatabase.executor.query<{ can_select: boolean }>(
        `SELECT has_column_privilege('waspada_l1_pipeline', 'waspada.report_revisions', 'permitted_text', 'SELECT') AS can_select`,
      );
      assert.equal(sourceText.rows[0]?.can_select, true,
        'the migration preserves the pre-existing source-text grant without widening it');
    } finally {
      await migrationDatabase.close();
    }
  });

  it('grants the L2 grounding reader only exact source-observation columns', async () => {
    const gateMigration = migrations.find(({ version }) =>
      version === '030_l2_source_revision_grounding_gate');
    assert.ok(gateMigration, 'the source-revision grounding-gate migration is loaded');
    const migrationDatabase = await createTestDatabase();
    try {
      await applyMigrations(migrationDatabase.executor,
        migrations.filter(({ version }) => version !== gateMigration.version
          && version !== '031_source_revision_review_candidate_reader'));

      const snapshotUnchangedAccess = async () => {
        const [roles, schemas, memberships, otherObjects, otherObservationGrants] = await Promise.all([
          migrationDatabase.executor.query<{ state: string }>(
            `SELECT rolname || ':' || rolinherit || ':' || rolcanlogin || ':' || rolsuper
                      || ':' || rolcreatedb || ':' || rolcreaterole || ':' || rolreplication
                      || ':' || rolbypassrls AS state
             FROM pg_roles WHERE left(rolname, 8) = 'waspada_' ORDER BY state`,
          ),
          migrationDatabase.executor.query<{ state: string }>(
            `SELECT role.rolname || ':' || has_schema_privilege(role.rolname, 'waspada', 'USAGE')
                      || ':' || has_schema_privilege(role.rolname, 'waspada', 'CREATE') AS state
             FROM pg_roles AS role WHERE left(role.rolname, 8) = 'waspada_' ORDER BY state`,
          ),
          migrationDatabase.executor.query<{ state: string }>(
            `SELECT granted.rolname || '->' || member.rolname AS state
             FROM pg_auth_members AS membership
             JOIN pg_roles AS granted ON granted.oid = membership.roleid
             JOIN pg_roles AS member ON member.oid = membership.member
             WHERE left(granted.rolname, 8) = 'waspada_'
                OR left(member.rolname, 8) = 'waspada_'
             ORDER BY state`,
          ),
          migrationDatabase.executor.query<{ state: string }>(
            `SELECT role.rolname || ':' || relation.relname || ':' || attribute.attname
                      || ':' || has_table_privilege(role.rolname, relation.oid, 'SELECT')
                      || ':' || has_table_privilege(role.rolname, relation.oid, 'INSERT')
                      || ':' || has_table_privilege(role.rolname, relation.oid, 'UPDATE')
                      || ':' || has_table_privilege(role.rolname, relation.oid, 'DELETE')
                      || ':' || has_column_privilege(role.rolname, relation.oid, attribute.attnum, 'SELECT')
                      || ':' || has_column_privilege(role.rolname, relation.oid, attribute.attnum, 'INSERT')
                      || ':' || has_column_privilege(role.rolname, relation.oid, attribute.attnum, 'UPDATE') AS state
             FROM pg_roles AS role CROSS JOIN pg_class AS relation
             JOIN pg_namespace AS schema ON schema.oid = relation.relnamespace
             JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid
             WHERE left(role.rolname, 8) = 'waspada_' AND schema.nspname = 'waspada'
               AND relation.relkind IN ('r', 'p', 'v', 'm')
               AND relation.relname <> 'report_revision_source_observations'
               AND attribute.attnum > 0 AND NOT attribute.attisdropped
             ORDER BY state`,
          ),
          migrationDatabase.executor.query<{ state: string }>(
            `SELECT role.rolname || ':' || attribute.attname
                      || ':' || has_table_privilege(role.rolname, relation.oid, 'SELECT')
                      || ':' || has_table_privilege(role.rolname, relation.oid, 'INSERT')
                      || ':' || has_table_privilege(role.rolname, relation.oid, 'UPDATE')
                      || ':' || has_table_privilege(role.rolname, relation.oid, 'DELETE')
                      || ':' || has_column_privilege(role.rolname, relation.oid, attribute.attnum, 'SELECT')
                      || ':' || has_column_privilege(role.rolname, relation.oid, attribute.attnum, 'INSERT')
                      || ':' || has_column_privilege(role.rolname, relation.oid, attribute.attnum, 'UPDATE') AS state
             FROM pg_roles AS role
             JOIN pg_class AS relation ON relation.oid = 'waspada.report_revision_source_observations'::regclass
             JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid
             WHERE left(role.rolname, 8) = 'waspada_'
               AND role.rolname <> 'waspada_l2_grounding_reader'
               AND attribute.attnum > 0 AND NOT attribute.attisdropped
             ORDER BY state`,
          ),
        ]);
        return {
          roles: roles.rows.map(({ state }) => state),
          schemas: schemas.rows.map(({ state }) => state),
          memberships: memberships.rows.map(({ state }) => state),
          otherObjects: otherObjects.rows.map(({ state }) => state),
          otherObservationGrants: otherObservationGrants.rows.map(({ state }) => state),
        };
      };

      const before = await snapshotUnchangedAccess();
      const applied = await applyMigrations(migrationDatabase.executor,
        migrations.filter(({ version }) => version !== '031_source_revision_review_candidate_reader'));
      assert.deepEqual(applied.applied, ['030_l2_source_revision_grounding_gate']);
      assert.deepEqual(await snapshotUnchangedAccess(), before,
        'migration 030 changes no existing role, membership, schema, or non-L2 table grants');

      const observationColumns = await migrationDatabase.executor.query<{
        column_name: string;
        can_select: boolean;
        can_insert: boolean;
        can_update: boolean;
        can_references: boolean;
      }>(
        `SELECT attribute.attname AS column_name,
                has_column_privilege('waspada_l2_grounding_reader', relation.oid, attribute.attnum, 'SELECT') AS can_select,
                has_column_privilege('waspada_l2_grounding_reader', relation.oid, attribute.attnum, 'INSERT') AS can_insert,
                has_column_privilege('waspada_l2_grounding_reader', relation.oid, attribute.attnum, 'UPDATE') AS can_update,
                has_column_privilege('waspada_l2_grounding_reader', relation.oid, attribute.attnum, 'REFERENCES') AS can_references
         FROM pg_class AS relation
         JOIN pg_namespace AS schema ON schema.oid = relation.relnamespace
         JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid
         WHERE schema.nspname = 'waspada'
           AND relation.relname = 'report_revision_source_observations'
           AND attribute.attnum > 0 AND NOT attribute.attisdropped
         ORDER BY attribute.attname`,
      );
      assert.deepEqual(observationColumns.rows.filter(({ can_select }) => can_select)
        .map(({ column_name }) => column_name), [
        'asserted_state', 'dataset_kind', 'target_report_revision_id',
      ]);
      assert.equal(observationColumns.rows.some(({ can_insert, can_update, can_references }) =>
        can_insert || can_update || can_references), false);

      const l2TableAccess = await migrationDatabase.executor.query<{
        can_select: boolean;
        can_insert: boolean;
        can_update: boolean;
        can_delete: boolean;
        can_truncate: boolean;
        existing_source_text_read: boolean;
        schema_create: boolean;
      }>(
        `SELECT has_table_privilege('waspada_l2_grounding_reader', 'waspada.report_revision_source_observations', 'SELECT') AS can_select,
                has_table_privilege('waspada_l2_grounding_reader', 'waspada.report_revision_source_observations', 'INSERT') AS can_insert,
                has_table_privilege('waspada_l2_grounding_reader', 'waspada.report_revision_source_observations', 'UPDATE') AS can_update,
                has_table_privilege('waspada_l2_grounding_reader', 'waspada.report_revision_source_observations', 'DELETE') AS can_delete,
                has_table_privilege('waspada_l2_grounding_reader', 'waspada.report_revision_source_observations', 'TRUNCATE') AS can_truncate,
                has_column_privilege('waspada_l2_grounding_reader', 'waspada.report_revisions', 'permitted_text', 'SELECT') AS existing_source_text_read,
                has_schema_privilege('waspada_l2_grounding_reader', 'waspada', 'CREATE') AS schema_create`,
      );
      assert.deepEqual(l2TableAccess.rows[0], {
        can_select: false, can_insert: false, can_update: false, can_delete: false,
        can_truncate: false, existing_source_text_read: true, schema_create: false,
      });
    } finally {
      await migrationDatabase.close();
    }
  });

  it('extends only the existing L4 impact reader with source-observation metadata columns', async () => {
    const candidateMigration = migrations.find(({ version }) =>
      version === '031_source_revision_review_candidate_reader');
    assert.ok(candidateMigration, 'the source-revision review-candidate migration is loaded');
    const migrationDatabase = await createTestDatabase();
    try {
      await applyMigrations(migrationDatabase.executor,
        migrations.filter(({ version }) => version !== candidateMigration.version));

      const snapshotExistingSecurity = async () => {
        const [roles, schemas, memberships, otherObjects, otherObservationGrants] = await Promise.all([
          migrationDatabase.executor.query<{ state: string }>(
            `SELECT rolname || ':' || rolinherit || ':' || rolcanlogin || ':' || rolsuper
                      || ':' || rolcreatedb || ':' || rolcreaterole || ':' || rolreplication
                      || ':' || rolbypassrls AS state
             FROM pg_roles WHERE left(rolname, 8) = 'waspada_' ORDER BY state`,
          ),
          migrationDatabase.executor.query<{ state: string }>(
            `SELECT role.rolname || ':' || has_schema_privilege(role.rolname, 'waspada', 'USAGE')
                      || ':' || has_schema_privilege(role.rolname, 'waspada', 'CREATE') AS state
             FROM pg_roles AS role WHERE left(role.rolname, 8) = 'waspada_' ORDER BY state`,
          ),
          migrationDatabase.executor.query<{ state: string }>(
            `SELECT granted.rolname || '->' || member.rolname AS state
             FROM pg_auth_members AS membership
             JOIN pg_roles AS granted ON granted.oid = membership.roleid
             JOIN pg_roles AS member ON member.oid = membership.member
             WHERE left(granted.rolname, 8) = 'waspada_'
                OR left(member.rolname, 8) = 'waspada_'
             ORDER BY state`,
          ),
          migrationDatabase.executor.query<{ state: string }>(
            `SELECT role.rolname || ':' || relation.relname || ':' || attribute.attname
                      || ':' || has_table_privilege(role.rolname, relation.oid, 'SELECT')
                      || ':' || has_table_privilege(role.rolname, relation.oid, 'INSERT')
                      || ':' || has_table_privilege(role.rolname, relation.oid, 'UPDATE')
                      || ':' || has_table_privilege(role.rolname, relation.oid, 'DELETE')
                      || ':' || has_table_privilege(role.rolname, relation.oid, 'TRUNCATE')
                      || ':' || has_column_privilege(role.rolname, relation.oid, attribute.attnum, 'SELECT')
                      || ':' || has_column_privilege(role.rolname, relation.oid, attribute.attnum, 'INSERT')
                      || ':' || has_column_privilege(role.rolname, relation.oid, attribute.attnum, 'UPDATE')
                      || ':' || has_column_privilege(role.rolname, relation.oid, attribute.attnum, 'REFERENCES') AS state
             FROM pg_roles AS role CROSS JOIN pg_class AS relation
             JOIN pg_namespace AS schema ON schema.oid = relation.relnamespace
             JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid
             WHERE left(role.rolname, 8) = 'waspada_' AND schema.nspname = 'waspada'
               AND relation.relkind IN ('r', 'p', 'v', 'm')
               AND relation.relname <> 'report_revision_source_observations'
               AND attribute.attnum > 0 AND NOT attribute.attisdropped
             ORDER BY state`,
          ),
          migrationDatabase.executor.query<{ state: string }>(
            `SELECT role.rolname || ':' || attribute.attname
                      || ':' || has_table_privilege(role.rolname, relation.oid, 'SELECT')
                      || ':' || has_table_privilege(role.rolname, relation.oid, 'INSERT')
                      || ':' || has_table_privilege(role.rolname, relation.oid, 'UPDATE')
                      || ':' || has_table_privilege(role.rolname, relation.oid, 'DELETE')
                      || ':' || has_table_privilege(role.rolname, relation.oid, 'TRUNCATE')
                      || ':' || has_column_privilege(role.rolname, relation.oid, attribute.attnum, 'SELECT')
                      || ':' || has_column_privilege(role.rolname, relation.oid, attribute.attnum, 'INSERT')
                      || ':' || has_column_privilege(role.rolname, relation.oid, attribute.attnum, 'UPDATE')
                      || ':' || has_column_privilege(role.rolname, relation.oid, attribute.attnum, 'REFERENCES') AS state
             FROM pg_roles AS role
             JOIN pg_class AS relation ON relation.oid = 'waspada.report_revision_source_observations'::regclass
             JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid
             WHERE left(role.rolname, 8) = 'waspada_'
               AND role.rolname <> 'waspada_l4_report_revision_impact_reader'
               AND attribute.attnum > 0 AND NOT attribute.attisdropped
             ORDER BY state`,
          ),
        ]);
        return {
          roles: roles.rows.map(({ state }) => state),
          schemas: schemas.rows.map(({ state }) => state),
          memberships: memberships.rows.map(({ state }) => state),
          otherObjects: otherObjects.rows.map(({ state }) => state),
          otherObservationGrants: otherObservationGrants.rows.map(({ state }) => state),
        };
      };

      const before = await snapshotExistingSecurity();
      const applied = await applyMigrations(migrationDatabase.executor, migrations);
      assert.deepEqual(applied.applied, ['031_source_revision_review_candidate_reader']);
      assert.deepEqual(await snapshotExistingSecurity(), before,
        'migration 031 changes no role, membership, schema, unrelated object, or other-role grant');

      const role = await migrationDatabase.executor.query<{
        rolcanlogin: boolean;
        rolinherit: boolean;
        rolsuper: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolreplication: boolean;
        rolbypassrls: boolean;
      }>(
        `SELECT rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole,
                rolreplication, rolbypassrls
         FROM pg_roles WHERE rolname = 'waspada_l4_report_revision_impact_reader'`,
      );
      assert.deepEqual(role.rows[0], {
        rolcanlogin: false, rolinherit: false, rolsuper: false, rolcreatedb: false,
        rolcreaterole: false, rolreplication: false, rolbypassrls: false,
      });

      const memberships = await migrationDatabase.executor.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM pg_auth_members
         WHERE member = (SELECT oid FROM pg_roles WHERE rolname = 'waspada_l4_report_revision_impact_reader')
            OR roleid = (SELECT oid FROM pg_roles WHERE rolname = 'waspada_l4_report_revision_impact_reader')`,
      );
      assert.equal(memberships.rows[0]?.count, 0);

      const columns = await migrationDatabase.executor.query<{
        column_name: string;
        can_select: boolean;
        can_insert: boolean;
        can_update: boolean;
        can_references: boolean;
      }>(
        `SELECT attribute.attname AS column_name,
                has_column_privilege('waspada_l4_report_revision_impact_reader', relation.oid, attribute.attnum, 'SELECT') AS can_select,
                has_column_privilege('waspada_l4_report_revision_impact_reader', relation.oid, attribute.attnum, 'INSERT') AS can_insert,
                has_column_privilege('waspada_l4_report_revision_impact_reader', relation.oid, attribute.attnum, 'UPDATE') AS can_update,
                has_column_privilege('waspada_l4_report_revision_impact_reader', relation.oid, attribute.attnum, 'REFERENCES') AS can_references
         FROM pg_class AS relation
         JOIN pg_namespace AS schema ON schema.oid = relation.relnamespace
         JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid
         WHERE schema.nspname = 'waspada'
           AND relation.relname = 'report_revision_source_observations'
           AND attribute.attnum > 0 AND NOT attribute.attisdropped
         ORDER BY attribute.attname`,
      );
      assert.deepEqual(columns.rows.filter(({ can_select }) => can_select)
        .map(({ column_name }) => column_name), [
        'asserted_state', 'assertion_report_revision_id', 'dataset_kind', 'observation_id',
        'publisher_observed_at', 'recorded_at', 'replacement_report_revision_id',
        'retrieved_at', 'target_report_revision_id',
      ]);
      assert.equal(columns.rows.some(({ can_insert, can_update, can_references }) =>
        can_insert || can_update || can_references), false);

      const tablePrivileges = await migrationDatabase.executor.query<{
        can_select: boolean;
        can_insert: boolean;
        can_update: boolean;
        can_delete: boolean;
        can_truncate: boolean;
        source_text_read: boolean;
        source_url_read: boolean;
      }>(
        `SELECT has_table_privilege('waspada_l4_report_revision_impact_reader', 'waspada.report_revision_source_observations', 'SELECT') AS can_select,
                has_table_privilege('waspada_l4_report_revision_impact_reader', 'waspada.report_revision_source_observations', 'INSERT') AS can_insert,
                has_table_privilege('waspada_l4_report_revision_impact_reader', 'waspada.report_revision_source_observations', 'UPDATE') AS can_update,
                has_table_privilege('waspada_l4_report_revision_impact_reader', 'waspada.report_revision_source_observations', 'DELETE') AS can_delete,
                has_table_privilege('waspada_l4_report_revision_impact_reader', 'waspada.report_revision_source_observations', 'TRUNCATE') AS can_truncate,
                has_column_privilege('waspada_l4_report_revision_impact_reader', 'waspada.report_revisions', 'permitted_text', 'SELECT') AS source_text_read,
                has_column_privilege('waspada_l4_report_revision_impact_reader', 'waspada.report_revisions', 'canonical_url', 'SELECT') AS source_url_read`,
      );
      assert.deepEqual(tablePrivileges.rows[0], {
        can_select: false, can_insert: false, can_update: false, can_delete: false,
        can_truncate: false, source_text_read: false, source_url_read: false,
      });
    } finally {
      await migrationDatabase.close();
    }
  });

  it('grants the isolated freshness writer only append and replay access', async () => {
    const role = await testDatabase.executor.query<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolinherit: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit,
              rolreplication, rolbypassrls
       FROM pg_roles WHERE rolname = 'waspada_l4_freshness_writer'`,
    );
    assert.deepEqual(role.rows[0], {
      rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false,
      rolinherit: false, rolreplication: false, rolbypassrls: false,
    });

    const membership = await testDatabase.executor.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM pg_auth_members
       WHERE member = (SELECT oid FROM pg_roles WHERE rolname = 'waspada_l4_freshness_writer')
          OR roleid = (SELECT oid FROM pg_roles WHERE rolname = 'waspada_l4_freshness_writer')`,
    );
    assert.equal(membership.rows[0]?.count, 0);

    const grants = await testDatabase.executor.query<{
      can_read_transition: boolean;
      can_insert_transition: boolean;
      can_insert_identity: boolean;
      can_update_transition: boolean;
      can_delete_transition: boolean;
      can_read_links: boolean;
      can_insert_links: boolean;
      can_update_links: boolean;
      can_delete_links: boolean;
      can_rewrite_event: boolean;
      can_rewrite_impact: boolean;
      can_rewrite_publication: boolean;
      can_read_public_ledger: boolean;
      can_read_l1_ledger: boolean;
      can_read_l2_ledger: boolean;
    }>(
      `SELECT has_column_privilege('waspada_l4_freshness_writer', 'waspada.freshness_transitions', 'request_fingerprint', 'SELECT') AS can_read_transition,
              has_column_privilege('waspada_l4_freshness_writer', 'waspada.freshness_transitions', 'request_fingerprint', 'INSERT') AS can_insert_transition,
              has_column_privilege('waspada_l4_freshness_writer', 'waspada.freshness_transitions', 'transition_id', 'INSERT') AS can_insert_identity,
              has_table_privilege('waspada_l4_freshness_writer', 'waspada.freshness_transitions', 'UPDATE') AS can_update_transition,
              has_table_privilege('waspada_l4_freshness_writer', 'waspada.freshness_transitions', 'DELETE') AS can_delete_transition,
              has_column_privilege('waspada_l4_freshness_writer', 'waspada.freshness_transition_evidence', 'evidence_ref_id', 'SELECT') AS can_read_links,
              has_column_privilege('waspada_l4_freshness_writer', 'waspada.freshness_transition_evidence', 'evidence_ref_id', 'INSERT') AS can_insert_links,
              has_table_privilege('waspada_l4_freshness_writer', 'waspada.freshness_transition_evidence', 'UPDATE') AS can_update_links,
              has_table_privilege('waspada_l4_freshness_writer', 'waspada.freshness_transition_evidence', 'DELETE') AS can_delete_links,
              has_table_privilege('waspada_l4_freshness_writer', 'waspada.event_versions', 'INSERT')
                OR has_table_privilege('waspada_l4_freshness_writer', 'waspada.event_versions', 'UPDATE')
                OR has_table_privilege('waspada_l4_freshness_writer', 'waspada.event_versions', 'DELETE') AS can_rewrite_event,
              has_table_privilege('waspada_l4_freshness_writer', 'waspada.impact_versions', 'INSERT')
                OR has_table_privilege('waspada_l4_freshness_writer', 'waspada.impact_versions', 'UPDATE')
                OR has_table_privilege('waspada_l4_freshness_writer', 'waspada.impact_versions', 'DELETE') AS can_rewrite_impact,
              has_table_privilege('waspada_l4_freshness_writer', 'waspada.publication_decisions', 'INSERT')
                OR has_table_privilege('waspada_l4_freshness_writer', 'waspada.publication_decisions', 'UPDATE')
                OR has_table_privilege('waspada_l4_freshness_writer', 'waspada.publication_decisions', 'DELETE')
                OR has_table_privilege('waspada_l4_freshness_writer', 'waspada.publication_outbox', 'INSERT')
                OR has_table_privilege('waspada_l4_freshness_writer', 'waspada.publication_outbox', 'UPDATE')
                OR has_table_privilege('waspada_l4_freshness_writer', 'waspada.publication_outbox', 'DELETE') AS can_rewrite_publication,
              has_table_privilege('waspada_public_reader', 'waspada.freshness_transitions', 'SELECT') AS can_read_public_ledger,
              has_table_privilege('waspada_l1_pipeline', 'waspada.freshness_transitions', 'SELECT') AS can_read_l1_ledger,
              has_table_privilege('waspada_l2_grounding_reader', 'waspada.freshness_transitions', 'SELECT')
                OR has_table_privilege('waspada_l2_grounding_writer', 'waspada.freshness_transitions', 'SELECT')
                OR has_table_privilege('waspada_l2_proposal_writer', 'waspada.freshness_transitions', 'SELECT') AS can_read_l2_ledger`,
    );
    assert.deepEqual(grants.rows[0], {
      can_read_transition: true, can_insert_transition: true, can_insert_identity: false,
      can_update_transition: false, can_delete_transition: false,
      can_read_links: true, can_insert_links: true, can_update_links: false, can_delete_links: false,
      can_rewrite_event: false, can_rewrite_impact: false, can_rewrite_publication: false,
      can_read_public_ledger: false, can_read_l1_ledger: false, can_read_l2_ledger: false,
    });
  });


  it('keeps freshness ledger private while current-public safe views stay readable', async () => {
    const privileges = await testDatabase.executor.query<{
      can_read_current_view: boolean;
      can_read_impact_view: boolean;
      can_read_transition_ledger: boolean;
      can_read_evidence_ledger: boolean;
    }>(
      `SELECT has_table_privilege('waspada_public_reader', 'waspada.public_event_versions', 'SELECT') AS can_read_current_view,
              has_table_privilege('waspada_public_reader', 'waspada.public_event_impacts', 'SELECT') AS can_read_impact_view,
              has_table_privilege('waspada_public_reader', 'waspada.freshness_transitions', 'SELECT') AS can_read_transition_ledger,
              has_table_privilege('waspada_public_reader', 'waspada.freshness_transition_evidence', 'SELECT') AS can_read_evidence_ledger`,
    );
    assert.deepEqual(privileges.rows[0], {
      can_read_current_view: true,
      can_read_impact_view: true,
      can_read_transition_ledger: false,
      can_read_evidence_ledger: false,
    });

    await testDatabase.executor.execute('SET ROLE waspada_public_reader');
    try {
      await testDatabase.executor.query(
        'SELECT event_id, record_json FROM waspada.public_event_versions LIMIT 1',
      );
      await testDatabase.executor.query(
        'SELECT impact_id, record_json FROM waspada.public_event_impacts LIMIT 1',
      );
      await assert.rejects(
        testDatabase.executor.query('SELECT transition_id FROM waspada.freshness_transitions LIMIT 1'),
        /permission denied/iu,
      );
      await assert.rejects(
        testDatabase.executor.query('SELECT transition_id FROM waspada.freshness_transition_evidence LIMIT 1'),
        /permission denied/iu,
      );
    } finally {
      await testDatabase.executor.execute('RESET ROLE');
    }
  });

  it('creates the isolated publication capability with its exact operation grants', async () => {
    const role = await testDatabase.executor.query<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolinherit: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit,
              rolreplication, rolbypassrls
       FROM pg_roles WHERE rolname = 'waspada_l4_moderator_publication_writer'`,
    );
    assert.deepEqual(role.rows[0], {
      rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false,
      rolinherit: false, rolreplication: false, rolbypassrls: false,
    });

    const membership = await testDatabase.executor.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM pg_auth_members
       WHERE member = (SELECT oid FROM pg_roles WHERE rolname = 'waspada_l4_moderator_publication_writer')
          OR roleid = (SELECT oid FROM pg_roles WHERE rolname = 'waspada_l4_moderator_publication_writer')`,
    );
    assert.equal(membership.rows[0]?.count, 0, 'the capability has no role memberships in either direction');

    const schema = await testDatabase.executor.query<{ can_use: boolean; can_create: boolean }>(
      `SELECT has_schema_privilege('waspada_l4_moderator_publication_writer', 'waspada', 'USAGE') AS can_use,
              has_schema_privilege('waspada_l4_moderator_publication_writer', 'waspada', 'CREATE') AS can_create`,
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
              has_column_privilege('waspada_l4_moderator_publication_writer', table_class.oid, column_meta.attnum, 'SELECT') AS can_select,
              has_column_privilege('waspada_l4_moderator_publication_writer', table_class.oid, column_meta.attnum, 'INSERT') AS can_insert,
              has_column_privilege('waspada_l4_moderator_publication_writer', table_class.oid, column_meta.attnum, 'UPDATE') AS can_update
       FROM pg_class AS table_class
       JOIN pg_namespace AS table_schema ON table_schema.oid = table_class.relnamespace
       JOIN pg_attribute AS column_meta ON column_meta.attrelid = table_class.oid
       WHERE table_schema.nspname = 'waspada' AND table_class.relkind IN ('r', 'p')
         AND column_meta.attnum > 0 AND NOT column_meta.attisdropped
       ORDER BY table_class.relname, column_meta.attname`,
    );
    const expected = new Set<string>();
    const expect = (table: string, privilege: 'select' | 'insert', names: readonly string[]) => {
      for (const name of names) expected.add(`${table}.${name}.${privilege}`);
    };
    expect('dataset_namespace_config', 'select', ['dataset_kind']);
    expect('traces', 'select', ['trace_id', 'dataset_kind']);
    expect('event_proposals', 'select', [
      'dataset_kind', 'proposal_id', 'trace_id', 'candidate_id', 'context_id',
      'event_id', 'base_event_version', 'record_json',
    ]);
    expect('proposal_claims', 'select', [
      'dataset_kind', 'proposal_id', 'claim_id', 'support_assessment', 'evidence_label', 'claim_text', 'record_json',
    ]);
    expect('proposal_claim_evidence', 'select', [
      'dataset_kind', 'proposal_id', 'claim_id', 'evidence_kind', 'evidence_ref_id',
    ]);
    expect('proposal_claim_origins', 'select', ['dataset_kind', 'proposal_id', 'claim_id', 'origin_id']);
    expect('grounding_evidence', 'select', ['dataset_kind', 'context_id', 'evidence_ref_id']);
    expect('evidence_references', 'select', [
      'dataset_kind', 'evidence_ref_id', 'report_revision_id', 'permitted_text_hash',
      'span_start', 'span_end', 'offset_unit', 'relation',
    ]);
    expect('geometry_evidence', 'select', ['dataset_kind', 'geometry_id', 'evidence_ref_id']);
    expect('geometries', 'select', ['dataset_kind', 'geometry_id']);
    expect('event_versions', 'select', ['dataset_kind', 'event_id', 'version']);
    expect('impact_versions', 'select', ['dataset_kind', 'impact_id', 'version']);
    expect('publication_write_receipts', 'select', [
      'dataset_kind', 'idempotency_key', 'request_fingerprint', 'decision_id', 'event_id', 'event_version',
    ]);
    expect('publication_decisions', 'insert', [
      'dataset_kind', 'decision_id', 'trace_id', 'proposal_id', 'policy_version',
      'event_id', 'event_version', 'reviewer_id', 'decided_at', 'record_json',
    ]);
    expect('publication_claim_decisions', 'insert', [
      'dataset_kind', 'decision_id', 'proposal_id', 'claim_id', 'disposition', 'reason_codes',
    ]);
    expect('publication_decision_evidence', 'insert', ['dataset_kind', 'decision_id', 'claim_id', 'evidence_ref_id']);
    expect('event_versions', 'insert', [
      'dataset_kind', 'event_id', 'version', 'trace_id', 'supersedes_version', 'title', 'summary',
      'category', 'lifecycle', 'publication_status', 'withdrawal_reason', 'publication_decision_id',
      'published_at', 'withdrawn_at', 'record_json',
    ]);
    expect('event_claims', 'insert', [
      'dataset_kind', 'event_id', 'event_version', 'claim_id', 'publication_status',
      'claim_text', 'evidence_label', 'record_json',
    ]);
    expect('event_claim_evidence', 'insert', [
      'dataset_kind', 'event_id', 'event_version', 'claim_id', 'evidence_kind', 'evidence_ref_id',
    ]);
    expect('event_claim_origins', 'insert', ['dataset_kind', 'event_id', 'event_version', 'claim_id', 'origin_id']);
    expect('event_claim_geometries', 'insert', ['dataset_kind', 'event_id', 'event_version', 'claim_id', 'geometry_id']);
    expect('impact_versions', 'insert', [
      'dataset_kind', 'impact_id', 'version', 'trace_id', 'event_id', 'event_version',
      'impact_type', 'lifecycle', 'published_at', 'record_json',
    ]);
    expect('impact_claim_support', 'insert', [
      'dataset_kind', 'impact_id', 'impact_version', 'event_id', 'event_version', 'claim_id',
    ]);
    expect('event_impact_refs', 'insert', [
      'dataset_kind', 'event_id', 'event_version', 'impact_id', 'impact_version',
    ]);
    expect('audit_records', 'insert', [
      'dataset_kind', 'audit_id', 'trace_id', 'occurred_at', 'actor_id', 'action',
      'entity_type', 'entity_id', 'reason', 'details',
    ]);
    expect('publication_outbox', 'insert', [
      'outbox_id', 'dataset_kind', 'event_id', 'event_version', 'event_kind', 'trace_id', 'occurred_at',
    ]);
    expect('publication_write_receipts', 'insert', [
      'dataset_kind', 'idempotency_key', 'request_fingerprint', 'decision_id', 'event_id', 'event_version',
    ]);

    const granted = new Set<string>();
    for (const row of columns.rows) {
      if (row.can_select) granted.add(`${row.table_name}.${row.column_name}.select`);
      if (row.can_insert) granted.add(`${row.table_name}.${row.column_name}.insert`);
      if (row.can_update) granted.add(`${row.table_name}.${row.column_name}.update`);
    }
    assert.deepEqual([...granted].sort(), [...expected].sort(),
      'the role may read and insert only the writer SQL columns');

    const tablePrivileges = await testDatabase.executor.query<{
      can_select: boolean;
      can_insert: boolean;
      can_update: boolean;
      can_delete: boolean;
      can_truncate: boolean;
      can_references: boolean;
      can_trigger: boolean;
    }>(
      `SELECT has_table_privilege('waspada_l4_moderator_publication_writer', table_class.oid, 'SELECT') AS can_select,
              has_table_privilege('waspada_l4_moderator_publication_writer', table_class.oid, 'INSERT') AS can_insert,
              has_table_privilege('waspada_l4_moderator_publication_writer', table_class.oid, 'UPDATE') AS can_update,
              has_table_privilege('waspada_l4_moderator_publication_writer', table_class.oid, 'DELETE') AS can_delete,
              has_table_privilege('waspada_l4_moderator_publication_writer', table_class.oid, 'TRUNCATE') AS can_truncate,
              has_table_privilege('waspada_l4_moderator_publication_writer', table_class.oid, 'REFERENCES') AS can_references,
              has_table_privilege('waspada_l4_moderator_publication_writer', table_class.oid, 'TRIGGER') AS can_trigger
       FROM pg_class AS table_class JOIN pg_namespace AS table_schema ON table_schema.oid = table_class.relnamespace
       WHERE table_schema.nspname = 'waspada' AND table_class.relkind IN ('r', 'p')`,
    );
    assert.equal(tablePrivileges.rows.some((row) => Object.values(row).some(Boolean)), false,
      'no whole-table privileges are granted');

    const sequences = await testDatabase.executor.query<{ can_usage: boolean; can_select: boolean; can_update: boolean }>(
      `SELECT has_sequence_privilege('waspada_l4_moderator_publication_writer', sequence_class.oid, 'USAGE') AS can_usage,
              has_sequence_privilege('waspada_l4_moderator_publication_writer', sequence_class.oid, 'SELECT') AS can_select,
              has_sequence_privilege('waspada_l4_moderator_publication_writer', sequence_class.oid, 'UPDATE') AS can_update
       FROM pg_class AS sequence_class JOIN pg_namespace AS sequence_schema ON sequence_schema.oid = sequence_class.relnamespace
       WHERE sequence_schema.nspname = 'waspada' AND sequence_class.relkind = 'S'`,
    );
    assert.equal(sequences.rows.some((row) => row.can_usage || row.can_select || row.can_update), false,
      'the role has no sequence privileges');

    const sharedRole = await testDatabase.executor.query<{
      can_update_policy: boolean;
      can_write_trace: boolean;
      can_write_audit: boolean;
      can_read_queue_key: boolean;
      can_insert_queue_url: boolean;
      can_insert_event_version: boolean;
    }>(
      `SELECT has_column_privilege('waspada_l4_publication_writer', 'waspada.source_registry', 'auto_publication_policy', 'UPDATE') AS can_update_policy,
              has_table_privilege('waspada_l4_publication_writer', 'waspada.traces', 'INSERT') AS can_write_trace,
              has_table_privilege('waspada_l4_publication_writer', 'waspada.audit_records', 'INSERT') AS can_write_audit,
              has_column_privilege('waspada_l4_publication_writer', 'waspada.acquisition_jobs', 'request_fingerprint', 'SELECT') AS can_read_queue_key,
              has_column_privilege('waspada_l4_publication_writer', 'waspada.acquisition_jobs', 'submitted_url', 'INSERT') AS can_insert_queue_url,
              has_column_privilege('waspada_l4_publication_writer', 'waspada.event_versions', 'dataset_kind', 'INSERT') AS can_insert_event_version`,
    );
    assert.deepEqual(sharedRole.rows[0], {
      can_update_policy: true, can_write_trace: true, can_write_audit: true,
      can_read_queue_key: true, can_insert_queue_url: true, can_insert_event_version: true,
    }, 'the accepted shared L4 responsibilities remain available');
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
      'embedding_runs.trace_id',
      'embedding_runs.vector_index_version',
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
      'report_revision_source_observations.asserted_state',
      'report_revision_source_observations.dataset_kind',
      'report_revision_source_observations.target_report_revision_id',
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
           'investigation_requests', 'investigation_checkpoints', 'investigation_action_reservations',
           'investigation_progress_snapshots')
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
      'limit_model_tokens', 'fingerprint_key_id', 'consumed_tool_attempts', 'consumed_reasoning_turns', 'consumed_active_seconds',
      'consumed_model_tokens', 'reserved_tool_attempts', 'reserved_reasoning_turns', 'reserved_active_seconds',
      'reserved_model_tokens', 'requested_at', 'record_json',
    ]);
    expect('investigation_requests', 'insert', [
      'dataset_kind', 'investigation_id', 'trace_id', 'candidate_id', 'context_id', 'event_id', 'event_version',
      'questions', 'budget_policy_version', 'limit_tool_attempts', 'limit_reasoning_turns', 'limit_active_seconds',
      'limit_model_tokens', 'requested_at', 'fingerprint_key_id', 'record_json',
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
      'reconciled_checkpoint_version', 'action_fingerprint_key_id', 'action_fingerprint',
    ];
    expect('investigation_action_reservations', 'select', reservationColumns);
    expect('investigation_action_reservations', 'insert', [
      'dataset_kind', 'reservation_id', 'investigation_id', 'action_kind', 'action_name',
      'expected_checkpoint_version', 'reserved_tool_attempts', 'reserved_reasoning_turns',
      'reserved_active_seconds', 'reserved_model_tokens', 'reservation_status', 'created_at',
      'action_fingerprint_key_id', 'action_fingerprint',
    ]);
    expect('investigation_action_reservations', 'update', [
      'reservation_status', 'outcome', 'actual_active_seconds', 'actual_model_tokens',
      'started_at', 'finished_at', 'reconciled_checkpoint_version',
    ]);
    const progressSnapshotColumns = [
      'dataset_kind', 'investigation_id', 'checkpoint_version', 'candidate_id', 'context_id',
      'fingerprint_key_id', 'grounding_fingerprint', 'consecutive_no_progress', 'recorded_at',
    ];
    expect('investigation_progress_snapshots', 'select', progressSnapshotColumns);
    expect('investigation_progress_snapshots', 'insert', progressSnapshotColumns);

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
