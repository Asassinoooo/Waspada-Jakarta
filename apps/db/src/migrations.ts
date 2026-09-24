import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SqlExecutor } from './sql.js';

export interface SqlMigration {
  readonly version: string;
  readonly sql: string;
}

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

interface AppliedMigration {
  readonly version: string;
  readonly checksum_sha256: string;
}

export async function readMigrations(directory: URL): Promise<SqlMigration[]> {
  const path = fileURLToPath(directory);
  const files = (await readdir(path)).filter((file) => file.endsWith('.sql')).sort();
  const migrations = await Promise.all(
    files.map(async (file) => ({
      version: basename(file, '.sql'),
      sql: await readFile(join(path, file), 'utf8'),
    })),
  );

  const seen = new Set<string>();
  for (const migration of migrations) {
    if (!/^\d{3}_[a-z0-9_]+$/.test(migration.version)) {
      throw new Error(`Invalid migration filename: ${migration.version}.sql`);
    }
    if (seen.has(migration.version)) {
      throw new Error(`Duplicate migration version: ${migration.version}`);
    }
    seen.add(migration.version);
  }
  return migrations;
}

export async function applyMigrations(
  executor: SqlExecutor,
  input: readonly SqlMigration[],
): Promise<MigrationResult> {
  const migrations = [...input].sort((left, right) => left.version.localeCompare(right.version));
  if (new Set(migrations.map(({ version }) => version)).size !== migrations.length) {
    throw new Error('Migration versions must be unique');
  }

  await executor.execute('CREATE SCHEMA IF NOT EXISTS waspada;');
  await executor.execute(`
    CREATE TABLE IF NOT EXISTS waspada.schema_migrations (
      version text PRIMARY KEY,
      checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const appliedRows = await executor.query<AppliedMigration>(
    'SELECT version, checksum_sha256 FROM waspada.schema_migrations ORDER BY version',
  );
  const appliedByVersion = new Map(appliedRows.rows.map((row) => [row.version, row.checksum_sha256]));
  const knownVersions = new Set(migrations.map(({ version }) => version));
  for (const appliedVersion of appliedByVersion.keys()) {
    if (!knownVersions.has(appliedVersion)) {
      throw new Error(`Applied migration is missing from this checkout: ${appliedVersion}`);
    }
  }

  const applied: string[] = [];
  const skipped: string[] = [];
  for (const migration of migrations) {
    const checksum = createHash('sha256').update(migration.sql, 'utf8').digest('hex');
    const previousChecksum = appliedByVersion.get(migration.version);
    if (previousChecksum !== undefined) {
      if (previousChecksum !== checksum) {
        throw new Error(`Checksum mismatch for applied migration ${migration.version}`);
      }
      skipped.push(migration.version);
      continue;
    }

    await executor.execute('BEGIN;');
    try {
      await executor.execute(migration.sql);
      await executor.query(
        'INSERT INTO waspada.schema_migrations (version, checksum_sha256) VALUES ($1, $2)',
        [migration.version, checksum],
      );
      await executor.execute('COMMIT;');
      applied.push(migration.version);
    } catch (error) {
      await executor.execute('ROLLBACK;');
      throw error;
    }
  }

  return { applied, skipped };
}
