import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { postgis } from '@electric-sql/pglite-postgis';
import { vector } from '@electric-sql/pglite-pgvector';
import { createAccountStore } from '../../apps/db/src/accounts.js';
import { applyMigrations, readMigrations } from '../../apps/db/src/migrations.js';
import type { SqlExecutor, TransactionalSqlExecutor } from '../../apps/db/src/sql.js';
import { seedAdminAccount } from '../../apps/worker/src/accounts/seed-admin.js';

/**
 * Operator bootstrap for the first live administrator.
 *
 *   npm run accounts:seed-admin -- --username <name> [--db <dir>]
 *
 * The password comes only from WASPADA_ADMIN_PASSWORD or from stdin, never from a flag, and it
 * is never printed. Stop `serve:live` before running this against its database directory,
 * because PGlite is single-process.
 */

const defaultDatabase = '.data/live-db';

function parseArguments(argv: readonly string[]): { readonly username: string; readonly database: string } {
  let username: string | null = null;
  let database = defaultDatabase;
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (seen.has(flag)) throw new Error('invalid_arguments');
    seen.add(flag);
    if (flag === '--username' || flag === '--db') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--') || value.length === 0) throw new Error('invalid_arguments');
      index += 1;
      if (flag === '--username') username = value;
      else database = value;
    } else {
      throw new Error('invalid_arguments');
    }
  }
  if (username === null) throw new Error('invalid_arguments');
  return { username, database };
}

async function readPassword(): Promise<string> {
  const fromEnvironment = process.env.WASPADA_ADMIN_PASSWORD;
  if (fromEnvironment !== undefined && fromEnvironment.length > 0) return fromEnvironment;
  if (process.stdin.isTTY) throw new Error('password_required');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/u, '');
}

function transactionalExecutor(database: PGlite): TransactionalSqlExecutor {
  const base: SqlExecutor = {
    async query<Row extends object>(statement: string, parameters?: readonly unknown[]) {
      const result = await database.query<Row>(statement, parameters ? [...parameters] : undefined);
      return { rows: result.rows };
    },
    async execute(statement: string) {
      await database.exec(statement);
    },
  };
  return {
    ...base,
    async transaction<Result>(work: (transaction: SqlExecutor) => Promise<Result>) {
      return database.transaction(async (client) => work({
        async query<Row extends object>(statement: string, parameters?: readonly unknown[]) {
          const result = await client.query<Row>(statement, parameters ? [...parameters] : undefined);
          return { rows: result.rows };
        },
        async execute(statement: string) {
          await client.exec(statement);
        },
      }));
    },
  };
}

function safeReason(error: unknown): string {
  // Only short, known codes are reported. Anything else is generic, so paths and secrets stay out of output.
  if (error instanceof Error && /^[a-z_]{3,40}$/u.test(error.message)) return error.message;
  return 'seed_failed';
}

async function main() {
  const { username, database: databaseDirectory } = parseArguments(process.argv.slice(2));
  const password = await readPassword();
  const database = await PGlite.create({ dataDir: resolve(process.cwd(), databaseDirectory), extensions: { postgis, vector } });
  try {
    const executor = transactionalExecutor(database);
    await applyMigrations(executor, await readMigrations(new URL('../../apps/db/migrations/', import.meta.url)));
    const result = await seedAdminAccount(createAccountStore(executor, 'live'), {
      username,
      password,
      now: new Date().toISOString(),
    });
    console.log(JSON.stringify({ status: result.status, username: result.username, dataset: 'live', role: 'admin' }));
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ status: 'error', reason: safeReason(error) }));
  process.exitCode = 1;
});
