import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { applyMigrations, readMigrations } from '../../db/src/migrations.js';
import type { SqlExecutor, TransactionalSqlExecutor } from '../../db/src/sql.js';
import { createAccountRuntime, resolveAccountRuntime } from '../src/runtime/account-runtime.js';

const https = 'https://waspada.example';
const hyperdrive = { connectionString: 'postgresql://auth:local@db.example/waspada?sslmode=require' };

test('accounts are enabled only with AUTH_ENABLED, a known dataset, an exact origin, and a database source', () => {
  assert.equal(resolveAccountRuntime({ DATASET_MODE: 'live', AUTH_APP_ORIGIN: https, AUTH_HYPERDRIVE: hyperdrive }), null,
    'AUTH_ENABLED must be the literal true');
  assert.equal(resolveAccountRuntime({ AUTH_ENABLED: 'true', DATASET_MODE: 'historical', AUTH_APP_ORIGIN: https, AUTH_HYPERDRIVE: hyperdrive }), null);
  assert.equal(resolveAccountRuntime({ AUTH_ENABLED: 'true', DATASET_MODE: 'live', AUTH_APP_ORIGIN: `${https}/`, AUTH_HYPERDRIVE: hyperdrive }), null,
    'the origin must be exact');
  assert.equal(resolveAccountRuntime({ AUTH_ENABLED: 'true', DATASET_MODE: 'live', AUTH_APP_ORIGIN: 'http://waspada.example', AUTH_HYPERDRIVE: hyperdrive }), null,
    'plain HTTP is accepted only on loopback');
  assert.equal(resolveAccountRuntime({ AUTH_ENABLED: 'true', DATASET_MODE: 'live', AUTH_APP_ORIGIN: https }), null,
    'a database source is required');

  const hosted = resolveAccountRuntime({ AUTH_ENABLED: 'true', DATASET_MODE: 'live', AUTH_APP_ORIGIN: https, AUTH_HYPERDRIVE: hyperdrive });
  assert.deepEqual(
    { mode: hosted?.datasetMode, kind: hosted?.datasetKind, cookie: hosted?.cookieMode, source: hosted?.source.kind },
    { mode: 'live', kind: 'live', cookie: 'host', source: 'connection' },
  );
  const local = resolveAccountRuntime({ AUTH_ENABLED: 'true', DATASET_MODE: 'live', AUTH_APP_ORIGIN: 'http://127.0.0.1:5173', SQL_EXECUTOR: fakeExecutor() });
  assert.deepEqual(
    { cookie: local?.cookieMode, source: local?.source.kind },
    { cookie: 'loopback', source: 'executor' },
    'local live serving uses loopback dev cookies over the in-process executor',
  );
  const synthetic = resolveAccountRuntime({ AUTH_ENABLED: 'true', DATASET_MODE: 'synthetic', AUTH_APP_ORIGIN: 'http://localhost:5173', SQL_EXECUTOR: fakeExecutor() });
  assert.deepEqual({ mode: synthetic?.datasetMode, kind: synthetic?.datasetKind }, { mode: 'demo', kind: 'synthetic' });
});

test('a disabled runtime keeps sessions anonymous and answers credential routes with 503', async () => {
  const handler = await createAccountRuntime({ DATASET_MODE: 'live', AUTH_ENABLED: 'false', AUTH_APP_ORIGIN: https, AUTH_HYPERDRIVE: hyperdrive });
  const session = await handler(new Request(`${https}/api/v1/auth/session`));
  assert.equal(((await session?.json()) as { status: string }).status, 'anonymous');
  const login = await handler(new Request(`${https}/api/v1/auth/login`, {
    method: 'POST', headers: { origin: https, 'x-waspada-request': '1' },
  }));
  assert.equal(login?.status, 503);
  assert.equal(await handler(new Request(`${https}/api/v1/events`)), undefined, 'public routes are not account routes');
});

test('a database failure fails closed without leaking the connection string or driver text', async () => {
  let attempts = 0;
  const handler = await createAccountRuntime({ DATASET_MODE: 'live', AUTH_ENABLED: 'true', AUTH_APP_ORIGIN: https, AUTH_HYPERDRIVE: hyperdrive }, {
    withTransactionalSqlExecutor: async () => {
      attempts += 1;
      throw new Error('connect ECONNREFUSED postgresql://auth:local@db.example');
    },
  });
  const response = await handler(new Request(`${https}/api/v1/auth/login`, {
    method: 'POST', headers: { origin: https, 'x-waspada-request': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'warga.jakarta', password: 'kata-sandi-2026' }),
  }));
  assert.equal(response?.status, 503);
  const text = await response!.text();
  assert.equal(text.includes('postgresql://'), false);
  assert.equal(text.includes('ECONNREFUSED'), false);
  assert.equal(attempts, 1);
});

test('register, login, and session work end to end on the local executor with a real account table', async () => {
  const database = await PGlite.create();
  const executor = createExecutor(database);
  try {
    // Only the account migrations are needed here, so the PostGIS and pgvector extensions stay unloaded.
    const migrations = await readMigrations(new URL('../../db/migrations/', import.meta.url));
    await applyMigrations(executor, migrations.filter(({ version }) => version === '036_accounts' || version === '045_password_accounts'));

    const handler = await createAccountRuntime({
      DATASET_MODE: 'live',
      AUTH_ENABLED: 'true',
      AUTH_APP_ORIGIN: 'http://127.0.0.1:5173',
      SQL_EXECUTOR: executor,
    }, { trustedClientKey: () => 'runtime-test-client' });
    const origin = 'http://127.0.0.1:5173';
    const post = (path: string, body: unknown, cookie?: string) => handler(new Request(`${origin}${path}`, {
      method: 'POST',
      headers: {
        origin, 'x-waspada-request': '1', 'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }));

    const registered = await post('/api/v1/auth/register', { username: 'runtime.user', password: 'kata-sandi-2026' });
    assert.equal(registered?.status, 200);
    const cookie = (registered?.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    assert.match(cookie, /^waspada_session_dev=/u, 'loopback origins use the development cookie name');
    assert.equal(((await registered?.json()) as { user: { role: string } }).user.role, 'user');

    assert.equal((await post('/api/v1/auth/register', { username: 'runtime.user', password: 'kata-sandi-2026' }))?.status, 409);
    const login = await post('/api/v1/auth/login', { username: 'runtime.user', password: 'kata-sandi-2026' });
    assert.equal(login?.status, 200);
    const session = await handler(new Request(`${origin}/api/v1/auth/session`, { headers: { cookie } }));
    assert.equal(((await session?.json()) as { status: string }).status, 'authenticated');
    const wrong = await post('/api/v1/auth/login', { username: 'runtime.user', password: 'kata-sandi-salah' });
    assert.equal(wrong?.status, 401);
  } finally {
    await database.close();
  }
});

function createExecutor(database: PGlite): TransactionalSqlExecutor {
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

function fakeExecutor(): TransactionalSqlExecutor {
  const fail = async () => {
    throw new Error('fake executor must not be reached');
  };
  return { query: fail, execute: fail, transaction: fail } as unknown as TransactionalSqlExecutor;
}
