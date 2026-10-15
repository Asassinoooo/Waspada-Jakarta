import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAccountRuntime } from '../src/runtime/account-runtime.js';
import type { SqlExecutor, TransactionalSqlExecutor } from '../../db/src/sql.js';
import type { AccountGoogleProvider } from '../src/accounts/types.js';

test('configured HTTPS Google account runtime is independent of live publication mode', async () => {
  for (const datasetMode of ['live', 'demo'] as const) {
    let executorCalls = 0;
    const handler = await createAccountRuntime({
      DATASET_MODE: datasetMode,
      AUTH_ENABLED: 'true',
      AUTH_APP_ORIGIN: 'https://waspada.example',
      AUTH_GOOGLE_CLIENT_ID: '1234567890-web.apps.googleusercontent.com',
      AUTH_GOOGLE_CLIENT_SECRET: 'local-not-used-by-this-session-request',
      AUTH_HYPERDRIVE: { connectionString: 'postgresql://auth:local@db.example/waspada?sslmode=require' },
    }, {
      withTransactionalSqlExecutor: async (_connectionString, operation) => {
        executorCalls += 1;
        return operation(fakeExecutor());
      },
      now: () => Date.parse('2026-10-01T00:00:00.000Z'),
    });

    const response = await handler(new Request('https://waspada.example/api/v1/auth/session'));
    assert.equal(response?.status, 200, `${datasetMode} configured account runtime should be enabled`);
    assert.deepEqual(await response?.json(), {
      version: 'account-v1',
      status: 'anonymous',
      google_login_available: true,
      native_login_available: true,
      csrf_token: null,
      user: null,
    });
    assert.equal(executorCalls, 1);
  }
});

test('lazy Google discovery is shared concurrently and retried after a transient failure', async () => {
  let discoveryCalls = 0;
  let rejectFirstDiscovery!: (reason: Error) => void;
  let markFirstDiscoveryStarted!: () => void;
  const firstDiscoveryStarted = new Promise<void>((resolve) => {
    markFirstDiscoveryStarted = resolve;
  });
  const firstDiscovery = new Promise<AccountGoogleProvider>((_resolve, reject) => {
    rejectFirstDiscovery = reject;
  });
  let throttleRequests = 0;
  let releaseThrottleBatch!: () => void;
  let markBothThrottleRequests!: () => void;
  const throttleBatch = new Promise<void>((resolve) => {
    releaseThrottleBatch = resolve;
  });
  const bothThrottleRequests = new Promise<void>((resolve) => {
    markBothThrottleRequests = resolve;
  });

  const handler = await createAccountRuntime({
    DATASET_MODE: 'demo',
    AUTH_ENABLED: 'true',
    AUTH_APP_ORIGIN: 'https://waspada.example',
    AUTH_GOOGLE_CLIENT_ID: '1234567890-web.apps.googleusercontent.com',
    AUTH_GOOGLE_CLIENT_SECRET: 'local-not-used-by-this-session-request',
    AUTH_HYPERDRIVE: { connectionString: 'postgresql://auth:local@db.example/waspada?sslmode=require' },
  }, {
    googleProviderFactory: async () => {
      discoveryCalls += 1;
      if (discoveryCalls === 1) {
        markFirstDiscoveryStarted();
        return firstDiscovery;
      }
      return fakeGoogleProvider();
    },
    withTransactionalSqlExecutor: async (_connectionString, operation) => operation(fakeThrottleExecutor(async () => {
      throttleRequests += 1;
      if (throttleRequests === 2) markBothThrottleRequests();
      await throttleBatch;
    })),
    now: () => Date.parse('2026-10-01T00:00:00.000Z'),
  });

  const concurrent = Promise.all([startRequest(handler), startRequest(handler)]);
  await bothThrottleRequests;
  releaseThrottleBatch();
  await firstDiscoveryStarted;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(discoveryCalls, 1, 'concurrent requests share one discovery attempt');
  rejectFirstDiscovery(new Error('temporary discovery failure'));
  const failedResponses = await concurrent;
  assert.deepEqual(failedResponses.map((response) => response?.status), [503, 503]);

  const retried = await startRequest(handler);
  assert.equal(retried?.status, 200);
  assert.equal(discoveryCalls, 2, 'a later request initializes the provider again');
});

function startRequest(handler: (request: Request) => Promise<Response | undefined>) {
  return handler(new Request('https://waspada.example/api/v1/auth/google/start', {
    method: 'POST',
    headers: {
      origin: 'https://waspada.example',
      'x-waspada-request': '1',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ return_to: '#akun' }),
  }));
}

function fakeGoogleProvider(): AccountGoogleProvider {
  const state = 'fixed-state-for-runtime-retry-test';
  const nonce = 'fixed-nonce-for-runtime-retry-test';
  const authorization = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authorization.searchParams.set('response_type', 'code');
  authorization.searchParams.set('state', state);
  authorization.searchParams.set('nonce', nonce);
  authorization.searchParams.set('redirect_uri', 'https://waspada.example/api/v1/auth/google/callback');
  authorization.searchParams.set('code_challenge_method', 'S256');
  authorization.searchParams.set('code_challenge', 'fixed-challenge');
  authorization.searchParams.set('scope', 'openid email profile');
  return {
    async beginWeb() {
      return {
        authorizationUrl: authorization.href,
        state,
        nonce,
        codeVerifier: 'v'.repeat(48),
      };
    },
    async completeWeb() {
      throw new Error('unused by this test');
    },
    async verifyNativeIdToken() {
      throw new Error('unused by this test');
    },
  };
}

function fakeThrottleExecutor(beforeThrottleResult: () => Promise<void> | void = () => {}): TransactionalSqlExecutor {
  const transaction: SqlExecutor = {
    async query<Row extends object>(statement: string) {
      if (statement.includes('INSERT INTO waspada.account_login_throttles')) {
        await beforeThrottleResult();
        return { rows: [{ request_count: 1 }] as unknown as Row[] };
      }
      return { rows: [] as Row[] };
    },
    async execute() {},
  };
  return {
    ...transaction,
    async transaction<Result>(work: (executor: SqlExecutor) => Promise<Result>) {
      return work(transaction);
    },
  };
}

function fakeExecutor(): TransactionalSqlExecutor {
  const transaction: SqlExecutor = {
    async query<Row extends object>() {
      return { rows: [] as Row[] };
    },
    async execute() {},
  };
  return {
    ...transaction,
    async transaction<Result>(work: (executor: SqlExecutor) => Promise<Result>) {
      return work(transaction);
    },
  };
}
