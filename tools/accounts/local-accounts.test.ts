import assert from 'node:assert/strict';
import { request as nodeRequest } from 'node:http';
import test from 'node:test';
import { parseLocalAccountOptions } from './config.js';
import { startLocalAccountServer } from './http-server.js';

test('local auth requires explicit synthetic profile and confines origins and state paths', () => {
  assert.equal(parseLocalAccountOptions([]).enabled, false);
  assert.deepEqual(parseLocalAccountOptions(['--enable', '--demo', '--state', 'qa']), {
    enabled: true, demo: true, state: 'qa', origin: 'http://127.0.0.1:5173',
  });
  for (const args of [
    ['--enable'], ['--enable', '--state', 'qa'], ['--state', '../pipeline'],
    ['--origin', 'http://attacker.invalid:5173'], ['--enable', '--enable'], ['--real'],
  ]) assert.throws(() => parseLocalAccountOptions(args));
});

test('loopback adapter preserves cookies/origin, refuses bad hosts and bounds bodies without leaking failures', async () => {
  const seen: Request[] = [];
  const server = await startLocalAccountServer(async request => {
    seen.push(request);
    if (new URL(request.url).pathname.endsWith('/fail')) throw new Error('RAW_PROVIDER_SECRET_NEVER_RENDER');
    return new Response(JSON.stringify({ origin: new URL(request.url).origin }), {
      headers: [['Content-Type', 'application/json'], ['Set-Cookie', 'one=1; HttpOnly'], ['Set-Cookie', 'two=2; HttpOnly']],
    });
  }, { appOrigin: 'http://127.0.0.1:5173', port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const response = await fetch(base + '/api/v1/auth/session');
    assert.deepEqual(await response.json(), { origin: 'http://127.0.0.1:5173' });
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.getSetCookie().length, 2);
    const unknown = await fetch(base + '/api/v1/events');
    assert.equal(unknown.status, 404);
    const large = await fetch(base + '/api/v1/auth/google/native', { method: 'POST', body: 'x'.repeat(16 * 1024 + 1) });
    assert.equal(large.status, 413);
    const failure = await fetch(base + '/api/v1/auth/fail');
    assert.equal(failure.status, 503);
    assert.doesNotMatch(await failure.text(), /RAW_PROVIDER|SECRET/);
    const badHost = await new Promise<number>(resolve => {
      const req = nodeRequest(base + '/api/v1/auth/session', { headers: { Host: 'attacker.invalid' } }, result => {
        result.resume(); resolve(result.statusCode ?? 0);
      }); req.end();
    });
    assert.equal(badHost, 403);
    assert.equal(seen.length, 2);
  } finally { await server.close(); }
});
