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
    assert.deepEqual(result.applied, ['001_foundation']);
    assert.deepEqual(result.skipped, []);
  });

  after(async () => {
    await testDatabase.close();
  });

  it('applies from empty state and is repeatable with checksum protection', async () => {
    const repeated = await applyMigrations(testDatabase.executor, migrations);
    assert.deepEqual(repeated.applied, []);
    assert.deepEqual(repeated.skipped, ['001_foundation']);

    const count = await testDatabase.executor.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM waspada.schema_migrations',
    );
    assert.equal(count.rows[0]?.count, '1');

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
      /Cannot apply migration 000_late_backfill before already applied migration 001_foundation/,
    );

    const ledger = await testDatabase.executor.query<{ version: string }>(
      'SELECT version FROM waspada.schema_migrations ORDER BY version',
    );
    assert.deepEqual(ledger.rows, [{ version: '001_foundation' }]);
  });

  it('loads only ordered, named SQL migrations', async () => {
    assert.deepEqual(migrations.map(({ version }) => version), ['001_foundation']);
    const version = await testDatabase.executor.query<{ version: string; server_version: string }>(
      "SELECT extversion AS version, current_setting('server_version') AS server_version FROM pg_extension WHERE extname = 'postgis'",
    );
    assert.match(version.rows[0]?.version ?? '', /^\d+\.\d+/);
    assert.match(version.rows[0]?.server_version ?? '', /^\d+/);
  });
});
