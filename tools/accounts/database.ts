import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { SqlExecutor, TransactionalSqlExecutor } from '../../apps/db/src/sql.js';
import { applyMigrations } from '../../apps/db/src/migrations.js';

const PROFILE = 'local-account-synthetic-v1';
interface ProfileMarker { profile: typeof PROFILE; state: string; ready: boolean }
export interface LocalAccountDatabase {
  readonly executor: TransactionalSqlExecutor;
  readonly seedRequired: boolean;
  markSeeded(): Promise<void>;
  close(): Promise<void>;
}

/** Account-only storage. Never opens source/pipeline/publication databases. */
export async function openLocalAccountDatabase(state: string, baseDirectory = resolve('.codex-build/accounts')): Promise<LocalAccountDatabase> {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(state)) throw new Error('invalid_account_state');
  const directory = resolve(baseDirectory, state);
  if (!directory.startsWith(resolve(baseDirectory) + '/')) throw new Error('invalid_account_state');
  await mkdir(directory, { recursive: true });
  const lockPath = resolve(directory, 'owner.lock');
  const lock = await open(lockPath, 'wx').catch(() => { throw new Error('account_state_already_owned'); });
  let database: PGlite | undefined;
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= (async () => {
      try { await database?.close(); } finally {
        await lock.close();
        await rm(lockPath, { force: true });
      }
    })();
    return closing;
  };
  try {
    await lock.writeFile(String(process.pid));
    const markerPath = resolve(directory, 'profile.json');
    let marker: ProfileMarker;
    try {
      marker = JSON.parse(await readFile(markerPath, 'utf8')) as ProfileMarker;
      if (marker.profile !== PROFILE || marker.state !== state || typeof marker.ready !== 'boolean') throw new Error('invalid_account_profile');
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw new Error('invalid_account_profile');
      const existingDatabase = await stat(resolve(directory, 'pg')).then(() => true, () => false);
      if (existingDatabase) throw new Error('unowned_account_database');
      marker = { profile: PROFILE, state, ready: false };
      await writeFile(markerPath, JSON.stringify(marker), { flag: 'wx', mode: 0o600 });
    }
    database = await PGlite.create({ dataDir: resolve(directory, 'pg') });
    const executor = sqlExecutor(database);
    const sql = await readFile(new URL('../../apps/db/migrations/036_accounts.sql', import.meta.url), 'utf8');
    await applyMigrations(executor, [{ version: '036_accounts', sql }]);
    return {
      executor, seedRequired: !marker.ready,
      async markSeeded() {
        const temporary = resolve(directory, 'profile.next');
        await writeFile(temporary, JSON.stringify({ profile: PROFILE, state, ready: true }), { mode: 0o600 });
        await rename(temporary, markerPath);
      },
      close,
    };
  } catch {
    await close();
    throw new Error('local_account_database_unavailable');
  }
}

function sqlExecutor(database: PGlite): TransactionalSqlExecutor {
  return {
    async query<Row extends object>(statement: string, parameters?: readonly unknown[]) {
      const result = await database.query<Row>(statement, parameters ? [...parameters] : undefined);
      return { rows: result.rows };
    },
    async execute(statement: string) { await database.exec(statement); },
    transaction<Result>(work: (executor: SqlExecutor) => Promise<Result>) {
      return database.transaction(client => work({
        async query<Row extends object>(statement: string, parameters?: readonly unknown[]) {
          const result = await client.query<Row>(statement, parameters ? [...parameters] : undefined);
          return { rows: result.rows };
        },
        async execute(statement: string) { await client.exec(statement); },
      }));
    },
  };
}
