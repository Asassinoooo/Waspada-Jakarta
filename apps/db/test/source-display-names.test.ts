import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { applyMigrations, readMigrations, type SqlMigration } from '../src/migrations.js';
import { createTestDatabase, type TestDatabase } from './harness.js';
import { BMKG_GEMPA_SOURCE_ID } from '../../worker/src/runtime/bmkg-poll-runtime.js';
import { PETABENCANA_SOURCE_ID } from '../../worker/src/layers/l1-data-knowledge/petabencana-ingest.js';
import { structuredSourceDisplayName } from '../../worker/src/runtime/structured-source-display.js';

/**
 * HOSTED-36 (owner decision, 18 Nov 2026): migration 058 gives the BMKG and PetaBencana registry rows their display names.
 * It changes a row only while display_name still equals the source id, so an owner-chosen name is never overwritten.
 * Every assertion reads the rows back from the database. The names come from the worker's map, which the migration must match.
 */

const MIGRATION = '058_source_display_names';
const TRACE_ID = 'trace-hosted36-display-names';

async function insertSource(db: TestDatabase, sourceId: string, displayName: string): Promise<void> {
  await db.executor.query(
    `INSERT INTO waspada.source_registry
       (source_id, trace_id, registry_version, display_name, source_kind, remit,
        access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
        approval_status, health_status, auto_acquisition_enabled, auto_publication_policy)
     VALUES ($1, $2, 1, $3, 'authority', ARRAY['all'], 'manual_fixture',
             ARRAY[]::text[], ARRAY[]::text[], ARRAY['public'], 'active', 'approved', 'healthy', false, 'never')`,
    [sourceId, TRACE_ID, displayName],
  );
}

async function readDisplayName(db: TestDatabase, sourceId: string): Promise<string | undefined> {
  const result = await db.executor.query<{ display_name: string }>(
    'SELECT display_name FROM waspada.source_registry WHERE source_id = $1',
    [sourceId],
  );
  return result.rows[0]?.display_name;
}

describe('HOSTED-36 source display names (migration 058)', () => {
  let db: TestDatabase;
  let migrations: SqlMigration[];

  before(async () => {
    db = await createTestDatabase();
    migrations = await readMigrations(new URL('../migrations/', import.meta.url));
  });

  after(async () => {
    await db.close();
  });

  it('renames only the BMKG and PetaBencana rows that still carry their source id', async () => {
    // Apply only the migrations before 058; later ones (059+) come after it, in order.
    const beforeMigration = migrations.filter(({ version }) => version < MIGRATION);
    const first = await applyMigrations(db.executor, beforeMigration);
    assert.equal(first.applied.at(-1), '057_pipeline_cycle_runs');

    await db.executor.query(
      `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
       VALUES ($1, 'live', '2026-11-18T00:00:00Z', 'succeeded', '{}'::jsonb)`,
      [TRACE_ID],
    );
    await insertSource(db, BMKG_GEMPA_SOURCE_ID, BMKG_GEMPA_SOURCE_ID);
    await insertSource(db, PETABENCANA_SOURCE_ID, PETABENCANA_SOURCE_ID);
    await insertSource(db, 'source-hosted36-owner-named', 'Nama Pilihan Pemilik');

    const applied = await applyMigrations(db.executor, migrations.filter(({ version }) => version <= MIGRATION));
    assert.deepEqual(applied.applied, [MIGRATION]);

    assert.equal(await readDisplayName(db, BMKG_GEMPA_SOURCE_ID), 'BMKG');
    assert.equal(await readDisplayName(db, PETABENCANA_SOURCE_ID), 'PetaBencana.id');
    assert.equal(await readDisplayName(db, 'source-hosted36-owner-named'), 'Nama Pilihan Pemilik',
      'a row whose display name is not the source id is left alone');
  });

  it('matches the names the worker writes for new rows', async () => {
    assert.equal(structuredSourceDisplayName(BMKG_GEMPA_SOURCE_ID), await readDisplayName(db, BMKG_GEMPA_SOURCE_ID));
    assert.equal(structuredSourceDisplayName(PETABENCANA_SOURCE_ID), await readDisplayName(db, PETABENCANA_SOURCE_ID));
  });

  it('is idempotent: running its statements again changes no row', async () => {
    const sql = migrations.find(({ version }) => version === MIGRATION)?.sql;
    assert.ok(sql, 'migration 058 is loaded');
    await db.executor.execute(sql);
    assert.equal(await readDisplayName(db, BMKG_GEMPA_SOURCE_ID), 'BMKG');
    assert.equal(await readDisplayName(db, PETABENCANA_SOURCE_ID), 'PetaBencana.id');
    assert.equal(await readDisplayName(db, 'source-hosted36-owner-named'), 'Nama Pilihan Pemilik');
  });

});
