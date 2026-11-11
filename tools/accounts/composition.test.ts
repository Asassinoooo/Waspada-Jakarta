import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountStore } from '../../apps/db/src/accounts.js';
import { createAccountApi } from '../../apps/worker/src/accounts/index.js';
import type { SessionEnvelope } from '../../apps/worker/src/contracts/accounts.js';
import { openLocalAccountDatabase } from './database.js';
import { seedSyntheticAccounts, SYNTHETIC_DEMO_PASSWORD } from './demo-accounts.js';
import { startLocalAccountServer } from './http-server.js';

test('owned synthetic HTTP composition seeds password users, keeps roles across restart, and revokes target sessions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'waspada-account-composition-'));
  let database: Awaited<ReturnType<typeof openLocalAccountDatabase>> | undefined;
  let server: Awaited<ReturnType<typeof startLocalAccountServer>> | undefined;
  const appOrigin = 'http://127.0.0.1:5173';
  try {
    database = await openLocalAccountDatabase('composition', directory);
    assert.equal(database.seedRequired, true);
    await assert.rejects(openLocalAccountDatabase('composition', directory), /account_state_already_owned/);
    await seedSyntheticAccounts(createAccountStore(database.executor, 'demo'), new Date().toISOString());
    await database.markSeeded();

    const compose = () => {
      const api = createAccountApi({
        enabled: true,
        store: createAccountStore(database!.executor, 'demo'),
        appOrigin,
        datasetMode: 'demo',
        cookieMode: 'loopback',
        trustedClientKey: () => 'composition-client',
      });
      return startLocalAccountServer(api, { appOrigin, port: 0 });
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
          const [pair] = cookie.split(';');
          const separator = pair!.indexOf('=');
          const key = pair!.slice(0, separator);
          const value = pair!.slice(separator + 1);
          if (!value) cookies.delete(key);
          else cookies.set(key, value);
        }
        assert.equal(response.headers.get('cache-control'), 'no-store');
        return response;
      };
    };

    const login = async (client: ReturnType<typeof browser>, username: string) => {
      const response = await client('/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password: SYNTHETIC_DEMO_PASSWORD }),
      });
      assert.equal(response.status, 200);
      const session = await response.json() as SessionEnvelope;
      assert.equal(session.status, 'authenticated');
      assert.equal(session.registration_available, true);
      return session;
    };

    const user = browser();
    const admin = browser();
    let userSession = await login(user, 'demo.warga');
    let adminSession = await login(admin, 'demo.admin');
    const onboarding = await user('/api/v1/account/onboarding', {
      method: 'POST',
      headers: { 'X-CSRF-Token': userSession.csrf_token! },
      body: JSON.stringify({ version: 1 }),
    });
    assert.equal(onboarding.status, 200);
    assert.equal((await onboarding.json() as SessionEnvelope).user?.onboarding_version, 1);

    userSession = await (await user('/api/v1/auth/session')).json() as SessionEnvelope;
    adminSession = await (await admin('/api/v1/auth/session')).json() as SessionEnvelope;
    assert.equal((await user('/api/v1/account/users')).status, 403);
    assert.equal((await admin('/api/v1/account/users')).status, 200);
    const update = await admin(`/api/v1/account/users/${userSession.user!.id}`, {
      method: 'PATCH',
      headers: { 'X-CSRF-Token': adminSession.csrf_token! },
      body: JSON.stringify({ role: 'moderator', active: true, expected_version: userSession.user!.version, reason: 'Synthetic role review for composition test' }),
    });
    assert.equal(update.status, 200);
    assert.equal((await (await user('/api/v1/auth/session')).json() as SessionEnvelope).status, 'anonymous');

    await server.close();
    server = undefined;
    await database.close();
    database = await openLocalAccountDatabase('composition', directory);
    assert.equal(database.seedRequired, false, 'restart must not reseed the demo profiles');
    server = await compose();

    const restored = await (await admin('/api/v1/auth/session')).json() as SessionEnvelope;
    assert.equal(restored.status, 'authenticated');
    assert.equal(restored.user?.onboarding_version, 1);
    const page = await (await admin('/api/v1/account/users')).json() as { data: { id: string; role: string }[] };
    assert.equal(page.data.find((account) => account.id === userSession.user!.id)?.role, 'moderator');
    assert.equal((await (await user('/api/v1/auth/session')).json() as SessionEnvelope).status, 'anonymous');

    const logout = await admin('/api/v1/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': restored.csrf_token! } });
    assert.equal(logout.status, 204);
    assert.equal((await (await admin('/api/v1/auth/session')).json() as SessionEnvelope).status, 'anonymous');

    const live = createAccountStore(database.executor, 'live');
    assert.equal(await live.findPasswordCredentialByUsername('demo.admin'), null, 'synthetic demo accounts never exist in the live dataset');
  } finally {
    await server?.close();
    await database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
