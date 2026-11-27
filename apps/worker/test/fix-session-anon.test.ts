import assert from 'node:assert/strict';
import test from 'node:test';
import type { SqlExecutor, TransactionalSqlExecutor } from '../../db/src/sql.js';
import type { AccountApiHandler, AccountRuntimeDependencies } from '../src/accounts/types.js';
import { createAccountRuntime } from '../src/runtime/account-runtime.js';

const origin = 'https://waspada.example';
const liveEnvironment = {
  DATASET_MODE: 'live',
  AUTH_ENABLED: 'true',
  AUTH_APP_ORIGIN: origin,
  AUTH_HYPERDRIVE: { connectionString: 'postgresql://auth:local@db.example/waspada?sslmode=require' },
};
const sessionCookie = `__Host-waspada_session=${'s'.repeat(43)}`;

type TransactionalRunner = NonNullable<AccountRuntimeDependencies['withTransactionalSqlExecutor']>;

interface RunnerSpy {
  readonly runner: TransactionalRunner;
  readonly opened: () => number;
  readonly released: () => number;
  readonly statements: string[];
}

/** Counts connections and records SQL. Every query answers with the rows `rowsFor` returns. */
function spyRunner(rowsFor: (statement: string) => readonly object[] = () => []): RunnerSpy {
  const statements: string[] = [];
  let opened = 0;
  let released = 0;
  const base: SqlExecutor = {
    async query<Row extends object>(statement: string) {
      statements.push(statement);
      return { rows: rowsFor(statement) as readonly Row[] };
    },
    async execute(statement: string) {
      statements.push(statement);
    },
  };
  const executor: TransactionalSqlExecutor = {
    ...base,
    async transaction<Result>(work: (transaction: SqlExecutor) => Promise<Result>) {
      return work(base);
    },
  };
  return {
    runner: async (_connectionString, operation) => {
      opened += 1;
      try {
        return await operation(executor);
      } finally {
        released += 1;
      }
    },
    opened: () => opened,
    released: () => released,
    statements,
  };
}

async function answer(handler: AccountApiHandler, request: Request): Promise<Response> {
  const response = await handler(request);
  assert.ok(response, 'the account route answers');
  return response;
}

async function liveHandler(spy: RunnerSpy): Promise<AccountApiHandler> {
  return createAccountRuntime(liveEnvironment, {
    withTransactionalSqlExecutor: spy.runner,
    trustedClientKey: () => 'fix-session-anon-client',
  });
}

test('an anonymous session read answers 200 with the account-v1 shape and never opens a connection', async () => {
  const spy = spyRunner();
  const handler = await liveHandler(spy);
  const response = await answer(handler, new Request(`${origin}/api/v1/auth/session`, { headers: { origin } }));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), [
    'version', 'status', 'password_login_available', 'registration_available', 'csrf_token', 'user',
  ]);
  assert.deepEqual(body, {
    version: 'account-v1',
    status: 'anonymous',
    password_login_available: true,
    registration_available: true,
    csrf_token: null,
    user: null,
  });
  assert.equal(spy.opened(), 0, 'the transactional runner is never called for an anonymous visitor');
  assert.deepEqual(spy.statements, []);
});

test('malformed bearer tokens and session cookies are anonymous without a connection', async () => {
  const spy = spyRunner();
  const handler = await liveHandler(spy);
  const bearer = await answer(handler, new Request(`${origin}/api/v1/auth/session`, {
    headers: { origin, authorization: 'Bearer short' },
  }));
  const cookie = await answer(handler, new Request(`${origin}/api/v1/auth/session`, {
    headers: { origin, cookie: '__Host-waspada_session=short' },
  }));

  assert.equal(((await bearer.json()) as { status: string }).status, 'anonymous');
  assert.equal(((await cookie.json()) as { status: string }).status, 'anonymous');
  assert.equal(spy.opened(), 0);
});

test('a session cookie opens one request-scoped connection and releases it before the response returns', async () => {
  const spy = spyRunner();
  const handler = await liveHandler(spy);
  const response = await answer(handler, new Request(`${origin}/api/v1/auth/session`, {
    headers: { origin, cookie: sessionCookie },
  }));

  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { status: string }).status, 'anonymous', 'an unknown session is not authenticated');
  assert.equal(spy.opened(), 1, 'the runner is used exactly once');
  assert.equal(spy.released(), 1, 'the connection is released before the response is returned');
  assert.ok(spy.statements.some((statement) => statement.includes('account_sessions')), 'the session lookup reached the store');
});

test('a connection failure on a session read answers 503 without the driver text', async () => {
  let attempts = 0;
  const handler = await createAccountRuntime(liveEnvironment, {
    withTransactionalSqlExecutor: async () => {
      attempts += 1;
      throw new Error('connect ECONNREFUSED postgresql://auth:local@db.example');
    },
    trustedClientKey: () => 'fix-session-anon-client',
  });
  const response = await answer(handler, new Request(`${origin}/api/v1/auth/session`, {
    headers: { origin, cookie: sessionCookie },
  }));

  assert.equal(response.status, 503);
  const text = await response.text();
  assert.equal(text.includes('postgresql://'), false);
  assert.equal(text.includes('ECONNREFUSED'), false);
  assert.equal(attempts, 1);
});

test('login still reaches the store through the runner, exactly once per request', async () => {
  const spy = spyRunner((statement) => (statement.includes('request_count') ? [{ request_count: 1 }] : []));
  const handler = await liveHandler(spy);
  const response = await answer(handler, new Request(`${origin}/api/v1/auth/login`, {
    method: 'POST',
    headers: { origin, 'x-waspada-request': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'warga.jakarta', password: 'kata-sandi-2026' }),
  }));

  assert.equal(response.status, 401);
  assert.equal(((await response.json()) as { code: string }).code, 'invalid_credentials');
  assert.equal(spy.opened(), 1);
  assert.equal(spy.released(), 1);
  assert.ok(spy.statements.some((statement) => statement.includes('account_login_throttles')), 'the throttle ran first');
});

test('a pre-session request without the marker is refused before any connection', async () => {
  const spy = spyRunner();
  const handler = await liveHandler(spy);
  const response = await answer(handler, new Request(`${origin}/api/v1/auth/login`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'warga.jakarta', password: 'kata-sandi-2026' }),
  }));

  assert.equal(response.status, 403);
  assert.equal(spy.opened(), 0);
});
