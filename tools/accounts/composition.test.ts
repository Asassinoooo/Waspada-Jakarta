import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountStore } from '../../apps/db/src/accounts.js';
import { createAccountApi } from '../../apps/worker/src/accounts/index.js';
import type { SessionEnvelope } from '../../apps/worker/src/contracts/accounts.js';
import { openLocalAccountDatabase } from './database.js';
import { createSyntheticAccountProvider, DEMO_IDENTITIES } from './demo-provider.js';
import { startLocalAccountServer } from './http-server.js';

test('owned synthetic HTTP composition retains onboarding and role changes on restart and revokes target sessions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'waspada-account-composition-'));
  let database: Awaited<ReturnType<typeof openLocalAccountDatabase>> | undefined;
  let server: Awaited<ReturnType<typeof startLocalAccountServer>> | undefined;
  const appOrigin = 'http://127.0.0.1:5173';
  try {
    database = await openLocalAccountDatabase('composition', directory);
    assert.equal(database.seedRequired, true);
    await assert.rejects(openLocalAccountDatabase('composition', directory), /account_state_already_owned/);
    const store = createAccountStore(database.executor, 'demo');
    for (const profile of DEMO_IDENTITIES) await store.provisionAccount({ ...profile, reason: 'Synthetic composition fixture', now: new Date().toISOString() });
    await database.markSeeded();
    const compose = () => {
      const demo = createSyntheticAccountProvider(appOrigin);
      const api = createAccountApi({ enabled: true, store: createAccountStore(database!.executor, 'demo'), google: demo.provider, appOrigin, datasetMode: 'demo', webLoginAvailable: true, nativeLoginAvailable: false, cookieMode: 'loopback', loopbackAuthorizationOrigin: appOrigin });
      return startLocalAccountServer(async request => await demo.consent(request) ?? await api(request), { appOrigin, port: 0 });
    };
    server = await compose();
    const browser = () => {
      const cookies = new Map<string, string>();
      return async (path: string, init: RequestInit = {}) => {
        const url = new URL(path, appOrigin);
        const headers = new Headers(init.headers);
        if (cookies.size) headers.set('Cookie', [...cookies].map(([key, value]) => `${key}=${value}`).join('; '));
        if (init.method && init.method !== 'GET') {
          headers.set('Origin', appOrigin);
          headers.set('Content-Type', 'application/json');
          headers.set('X-Waspada-Request', '1');
        }
        const response = await fetch(`http://127.0.0.1:${server!.port}${url.pathname}${url.search}`, { ...init, headers, redirect: 'manual' });
        for (const cookie of response.headers.getSetCookie()) {
          const [pair] = cookie.split(';'); const separator = pair!.indexOf('=');
          const key = pair!.slice(0, separator); const value = pair!.slice(separator + 1);
          if (!value) cookies.delete(key); else cookies.set(key, value);
        }
        assert.equal(response.headers.get('cache-control'), 'no-store');
        return response;
      };
    };
    const user = browser(); const admin = browser();
    const login = async (client: ReturnType<typeof browser>, identity: string) => {
      const start = await client('/api/v1/auth/google/start', { method: 'POST', body: JSON.stringify({ return_to: '#akun' }) });
      assert.equal(start.status, 200);
      const authorization = new URL((await start.json() as { authorization_url: string }).authorization_url);
      authorization.searchParams.set('identity', identity);
      const consent = await client(authorization.href);
      assert.equal(consent.status, 303);
      const callback = await client(consent.headers.get('location')!);
      assert.equal(callback.status, 303);
      const result = await client('/api/v1/auth/session');
      const session = await result.json() as SessionEnvelope;
      assert.equal(session.status, 'authenticated');
      assert.equal(session.native_login_available, false);
      return session;
    };
    let userSession = await login(user, DEMO_IDENTITIES[0]!.identity.subject);
    let adminSession = await login(admin, DEMO_IDENTITIES[2]!.identity.subject);
    for (const [client, session] of [[user, userSession], [admin, adminSession]] as const) {
      const response = await client('/api/v1/account/onboarding', { method: 'POST', headers: { 'X-CSRF-Token': session.csrf_token! }, body: JSON.stringify({ version: 1 }) });
      assert.equal(response.status, 200);
      assert.equal((await response.json() as SessionEnvelope).user?.onboarding_version, 1);
    }
    userSession = await (await user('/api/v1/auth/session')).json() as SessionEnvelope;
    adminSession = await (await admin('/api/v1/auth/session')).json() as SessionEnvelope;
    assert.equal((await user('/api/v1/account/users')).status, 403);
    assert.equal((await admin('/api/v1/account/users')).status, 200);
    const update = await admin(`/api/v1/account/users/${userSession.user!.id}`, { method: 'PATCH', headers: { 'X-CSRF-Token': adminSession.csrf_token! }, body: JSON.stringify({ role: 'moderator', active: true, expected_version: userSession.user!.version, reason: 'Synthetic role review for composition test' }) });
    assert.equal(update.status, 200);
    assert.equal((await (await user('/api/v1/auth/session')).json() as SessionEnvelope).status, 'anonymous');
    await server.close(); server = undefined;
    await database.close(); database = await openLocalAccountDatabase('composition', directory);
    assert.equal(database.seedRequired, false, 'restart must not reprovision roles');
    server = await compose();
    const restored = await (await admin('/api/v1/auth/session')).json() as SessionEnvelope;
    assert.equal(restored.status, 'authenticated');
    assert.equal(restored.user?.onboarding_version, 1);
    const page = await (await admin('/api/v1/account/users')).json() as { data: { id: string; role: string }[] };
    assert.equal(page.data.find(account => account.id === userSession.user!.id)?.role, 'moderator');
    assert.equal((await (await user('/api/v1/auth/session')).json() as SessionEnvelope).status, 'anonymous');
    const logout = await admin('/api/v1/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': restored.csrf_token! } });
    assert.equal(logout.status, 204);
    assert.equal((await (await admin('/api/v1/auth/session')).json() as SessionEnvelope).status, 'anonymous');
    const live = createAccountStore(database.executor, 'live');
    const separate = await live.findOrCreateVerifiedAccount(DEMO_IDENTITIES[2]!.identity, new Date().toISOString());
    assert.equal(separate.role, 'user', 'synthetic demo admin cannot grant a live role');
  } finally {
    await server?.close(); await database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
