import assert from 'node:assert/strict';
import test from 'node:test';
import { request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import type { TransactionalSqlExecutor, SqlExecutor } from '../../apps/db/src/sql.js';
import { parseLocalServerOptions } from './run-local-server.js';
import { startLocalPipelinePreviewServer } from './server.js';

interface ResponseValue {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

function rejectingExecutor(state: { transactions: number; statements: string[] }): TransactionalSqlExecutor {
  const executor: SqlExecutor = {
    async query() {
      throw new Error('PRIVATE_DATABASE_ERROR_SENTINEL');
    },
    async execute(statement) {
      state.statements.push(statement);
    },
  };
  return {
    ...executor,
    async transaction(work) {
      state.transactions++;
      return work(executor);
    },
  };
}

function request(
  port: number,
  path = '/__local/pipeline',
  method = 'GET',
  headers: OutgoingHttpHeaders = {},
): Promise<ResponseValue> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path, method, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.once('error', reject);
    request.end();
  });
}

test('server CLI is disabled by default and bounds mock scheduling and real inspection', () => {
  assert.deepEqual(parseLocalServerOptions([]), {
    enabled: false, realAi: false, omitExtractionOutputLimits: false,
    watch: false, state: null, intervalMs: 5_000, maxPolls: 60,
  });
  const mock = parseLocalServerOptions(['--enable', '--state', 'mock-demo', '--watch', '--interval-ms', '1000', '--max-polls', '3']);
  assert.equal(mock.enabled, true);
  assert.equal(mock.watch, true);
  assert.equal(mock.maxPolls, 3);
  const realState = 'real-123e4567-e89b-42d3-a456-426614174000';
  const real = parseLocalServerOptions(['--enable', '--state', realState, '--real-ai', '--omit-extraction-output-limits']);
  assert.equal(real.realAi, true);
  assert.equal(real.omitExtractionOutputLimits, true);
  for (const args of [
    ['--state', 'mock-demo'],
    ['--enable', '--state', 'mock-demo', '--omit-extraction-output-limits'],
    ['--enable', '--state', 'mock-demo', '--watch', '--interval-ms', '999'],
    ['--enable', '--state', realState, '--real-ai', '--watch'],
    ['--enable', '--state', 'real-12345678-1234-1234-1234-123456789012', '--real-ai'],
    ['--enable', '--state', 'mock-demo', '--watch', '--max-polls', '10001'],
  ]) assert.throws(() => parseLocalServerOptions(args), /invalid_local_server_options/);
});

test('loopback endpoint rejects hostile host origin and fetch-site without database access', async () => {
  const state = { transactions: 0, statements: [] as string[] };
  const server = await startLocalPipelinePreviewServer({
    executor: rejectingExecutor(state), models: 'mock', port: 0,
  });
  try {
    const hostileHost = await request(server.port, '/__local/pipeline', 'GET', { host: 'example.invalid' });
    assert.equal(hostileHost.status, 403);
    const hostileOrigin = await request(server.port, '/__local/pipeline', 'GET', {
      origin: 'https://example.invalid', 'sec-fetch-site': 'cross-site',
    });
    assert.equal(hostileOrigin.status, 403);
    const hostileFetchSite = await request(server.port, '/__local/pipeline', 'GET', {
      origin: 'http://127.0.0.1:5173', 'sec-fetch-site': 'cross-site',
    });
    assert.equal(hostileFetchSite.status, 403);
    assert.equal(state.transactions, 0);
    assert.equal(hostileOrigin.headers['access-control-allow-origin'], undefined);
    assert.equal(hostileOrigin.headers['cache-control'], 'no-store');
    assert.deepEqual(JSON.parse(hostileOrigin.body), { error: 'forbidden' });
  } finally {
    await server.close();
  }
});

test('allowlisted Vite origin reaches one read-only projection and database errors stay closed', async () => {
  const state = { transactions: 0, statements: [] as string[] };
  const server = await startLocalPipelinePreviewServer({
    executor: rejectingExecutor(state), models: 'mock', port: 0,
  });
  try {
    const response = await request(server.port, '/__local/pipeline', 'GET', {
      origin: 'http://localhost:5173', 'sec-fetch-site': 'same-site',
    });
    assert.equal(response.status, 503);
    assert.deepEqual(JSON.parse(response.body), { error: 'preview_unavailable' });
    assert.equal(response.body.includes('PRIVATE_DATABASE_ERROR_SENTINEL'), false);
    assert.equal(state.transactions, 1);
    assert.deepEqual(state.statements, ['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY']);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
  } finally {
    await server.close();
  }
});

test('endpoint denies mutations and query variants before querying state', async () => {
  const state = { transactions: 0, statements: [] as string[] };
  const server = await startLocalPipelinePreviewServer({
    executor: rejectingExecutor(state), models: 'mock', port: 0,
  });
  try {
    const mutation = await request(server.port, '/__local/pipeline', 'POST');
    const query = await request(server.port, '/__local/pipeline?debug=true');
    const path = await request(server.port, '/__local/other');
    assert.equal(mutation.status, 405);
    assert.equal(mutation.headers.allow, 'GET');
    assert.equal(query.status, 404);
    assert.equal(path.status, 404);
    assert.equal(state.transactions, 0);
    for (const response of [mutation, query, path]) {
      assert.equal(response.headers['access-control-allow-origin'], undefined);
      assert.equal(response.headers['cache-control'], 'no-store');
    }
  } finally {
    await server.close();
  }
});

test('scheduler failures become a closed unavailable response', async () => {
  const state = { transactions: 0, statements: [] as string[] };
  const server = await startLocalPipelinePreviewServer({
    executor: rejectingExecutor(state),
    models: 'mock',
    scheduler: () => { throw new Error('PRIVATE_SCHEDULER_SENTINEL'); },
    port: 0,
  });
  try {
    const response = await request(server.port);
    assert.equal(response.status, 503);
    assert.deepEqual(JSON.parse(response.body), { error: 'preview_unavailable' });
    assert.equal(response.body.includes('PRIVATE_SCHEDULER_SENTINEL'), false);
    assert.equal(state.transactions, 0);
  } finally {
    await server.close();
  }
});
