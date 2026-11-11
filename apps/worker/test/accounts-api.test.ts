import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createAccountApi } from '../src/accounts/api.js';
import { hashPassword } from '../src/accounts/password.js';
import type {
  AccountAdminUpdateInput,
  AccountAdminUpdateResult,
  AccountChannel,
  AccountDatasetMode,
  AccountStore,
  AccountThrottleScope,
  CreatePasswordAccountInput,
  CreateAccountSessionInput,
  SetPasswordHashInput,
  StoredAccount,
  StoredAccountSession,
  StoredPasswordCredential,
} from '../../db/src/accounts.js';
import { AccountUsernameTakenError } from '../../db/src/accounts.js';

const appOrigin = 'https://waspada.example';
const sessionCookie = '__Host-waspada_session';
const startPassword = 'sandi-awal-2026';
const newPassword = 'sandi-baru-2026';
const baseTime = Date.parse('2026-10-01T00:00:00.000Z');

test('register creates a user session and ignores any role supplied in the body', async () => {
  const harness = createHarness();
  const response = await harness.post('/api/v1/auth/register', {
    username: 'Ayu.Rani',
    password: startPassword,
    display_name: 'Ayu Rani',
    role: 'admin',
  }, { origin: appOrigin, marker: true });
  assert.equal(response.status, 200);
  const body = await response.json() as SessionBody;
  assert.equal(body.status, 'authenticated');
  assert.equal(body.user?.role, 'user', 'the role never comes from the request');
  assert.equal(body.user?.email, null);
  assert.equal(body.password_login_available, true);
  assert.equal(body.registration_available, true);
  assert.ok(body.csrf_token && body.csrf_token.length >= 43);
  assert.match(response.headers.get('set-cookie') ?? '', /^__Host-waspada_session=[A-Za-z0-9_-]{43,}; Path=\/; Max-Age=28800; HttpOnly; SameSite=Strict; Secure$/u);
  const stored = harness.store.findByUsername('ayu.rani');
  assert.equal(stored?.account.role, 'user', 'the username is stored lowercase with role user');
  assert.notEqual(stored?.passwordHash, startPassword, 'the password is never stored in clear text');
});

test('duplicate usernames return 409 username_taken and weak passwords return 400 without creating accounts', async () => {
  const harness = createHarness();
  await harness.seed('warga.jakarta', startPassword, { role: 'user' });
  const duplicate = await harness.post('/api/v1/auth/register', {
    username: 'WARGA.jakarta', password: startPassword,
  }, { origin: appOrigin, marker: true });
  assert.equal(duplicate.status, 409);
  assert.equal(((await duplicate.json()) as { code: string }).code, 'username_taken');

  const short = await harness.post('/api/v1/auth/register', {
    username: 'short.pass', password: 'pendek',
  }, { origin: appOrigin, marker: true });
  assert.equal(short.status, 400);
  assert.equal(((await short.json()) as { code: string }).code, 'password_too_short');
  const invalidName = await harness.post('/api/v1/auth/register', {
    username: 'no spaces', password: startPassword,
  }, { origin: appOrigin, marker: true });
  assert.equal(invalidName.status, 400);
  assert.equal(harness.store.accountCount(), 1);
});

test('unknown users and wrong passwords get the same 401 body and no session', async () => {
  const harness = createHarness();
  await harness.seed('dewi.lestari', startPassword, { role: 'user' });
  const unknown = await harness.post('/api/v1/auth/login', { username: 'tidak.ada', password: startPassword }, { origin: appOrigin, marker: true });
  const wrong = await harness.post('/api/v1/auth/login', { username: 'dewi.lestari', password: 'sandi-salah-2026' }, { origin: appOrigin, marker: true });
  assert.equal(unknown.status, 401);
  assert.equal(wrong.status, 401);
  assert.equal(unknown.headers.get('set-cookie'), null);
  assert.equal(wrong.headers.get('set-cookie'), null);
  assert.deepEqual(withoutRequestId(await unknown.json()), withoutRequestId(await wrong.json()));
  assert.equal(((await harness.post('/api/v1/auth/login', { username: 'dewi.lestari', password: startPassword }, { origin: appOrigin, marker: true })).status), 200);
});

test('inactive accounts receive the same 401 as a wrong password', async () => {
  const harness = createHarness();
  await harness.seed('nonaktif.user', startPassword, { role: 'user', active: false });
  const response = await harness.post('/api/v1/auth/login', { username: 'nonaktif.user', password: startPassword }, { origin: appOrigin, marker: true });
  assert.equal(response.status, 401);
  assert.equal(((await response.json()) as { code: string }).code, 'invalid_credentials');
  assert.equal(response.headers.get('set-cookie'), null);
});

test('login throttles by client and by username and answers 429 once a window is exhausted', async () => {
  const harness = createHarness();
  await harness.seed('target.user', startPassword, { role: 'user' });
  // Distinct usernames from one client exhaust the client bucket after twelve attempts.
  for (let index = 0; index < 12; index += 1) {
    const attempt = await harness.post('/api/v1/auth/login', { username: `tebakan.${index}`, password: 'tebakan-salah-1' }, { origin: appOrigin, marker: true, client: 'client-a' });
    assert.equal(attempt.status, 401);
  }
  const limited = await harness.post('/api/v1/auth/login', { username: 'target.user', password: startPassword }, { origin: appOrigin, marker: true, client: 'client-a' });
  assert.equal(limited.status, 429);

  // The same username from rotating clients exhausts the username bucket.
  for (let index = 0; index < 12; index += 1) {
    await harness.post('/api/v1/auth/login', { username: 'target.user', password: 'tebakan-salah-1' }, { origin: appOrigin, marker: true, client: `rotate-${index}` });
  }
  const usernameLimited = await harness.post('/api/v1/auth/login', { username: 'target.user', password: startPassword }, { origin: appOrigin, marker: true, client: 'rotate-fresh' });
  assert.equal(usernameLimited.status, 429);
  harness.advance(10 * 60_000 + 1);
  const recovered = await harness.post('/api/v1/auth/login', { username: 'target.user', password: startPassword }, { origin: appOrigin, marker: true, client: 'client-a' });
  assert.equal(recovered.status, 200, 'the window reopens after ten minutes');
});

test('logout revokes the session on the server and clears the browser cookie', async () => {
  const harness = createHarness();
  await harness.seed('keluar.user', startPassword, { role: 'user' });
  const login = await harness.post('/api/v1/auth/login', { username: 'keluar.user', password: startPassword }, { origin: appOrigin, marker: true });
  const session = await login.json() as SessionBody;
  const cookie = cookieFrom(login);
  const logout = await harness.request('/api/v1/auth/logout', {
    method: 'POST',
    headers: { origin: appOrigin, 'x-csrf-token': session.csrf_token ?? '' },
    cookie,
  });
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get('set-cookie') ?? '', new RegExp(`^${sessionCookie}=; Path=/; Max-Age=0`, 'u'));
  const after = await harness.request('/api/v1/auth/session', { cookie });
  assert.equal(((await after.json()) as SessionBody).status, 'anonymous');
});

test('password change requires session CSRF and revokes every other session of the account', async () => {
  const harness = createHarness();
  await harness.seed('ganti.sandi', startPassword, { role: 'user' });
  const first = await harness.post('/api/v1/auth/login', { username: 'ganti.sandi', password: startPassword }, { origin: appOrigin, marker: true, client: 'device-a' });
  const firstSession = await first.json() as SessionBody;
  const firstCookie = cookieFrom(first);
  const second = await harness.post('/api/v1/auth/login', { username: 'ganti.sandi', password: startPassword }, { origin: appOrigin, marker: true, client: 'device-b' });
  const secondCookie = cookieFrom(second);

  const withoutCsrf = await harness.request('/api/v1/auth/password', {
    method: 'POST', cookie: firstCookie,
    headers: { origin: appOrigin, 'content-type': 'application/json' },
    body: { current_password: startPassword, new_password: newPassword },
  });
  assert.equal(withoutCsrf.status, 403);

  const wrongCurrent = await harness.request('/api/v1/auth/password', {
    method: 'POST', cookie: firstCookie,
    headers: { origin: appOrigin, 'x-csrf-token': firstSession.csrf_token ?? '', 'content-type': 'application/json' },
    body: { current_password: 'bukan-ini-2026', new_password: newPassword },
  });
  assert.equal(wrongCurrent.status, 403);
  assert.equal(((await wrongCurrent.json()) as { code: string }).code, 'invalid_current_password');

  const changed = await harness.request('/api/v1/auth/password', {
    method: 'POST', cookie: firstCookie,
    headers: { origin: appOrigin, 'x-csrf-token': firstSession.csrf_token ?? '', 'content-type': 'application/json' },
    body: { current_password: startPassword, new_password: newPassword },
  });
  assert.equal(changed.status, 200);
  assert.equal(((await (await harness.request('/api/v1/auth/session', { cookie: firstCookie })).json()) as SessionBody).status, 'authenticated');
  assert.equal(((await (await harness.request('/api/v1/auth/session', { cookie: secondCookie })).json()) as SessionBody).status, 'anonymous');

  assert.equal((await harness.post('/api/v1/auth/login', { username: 'ganti.sandi', password: startPassword }, { origin: appOrigin, marker: true, client: 'device-c' })).status, 401);
  assert.equal((await harness.post('/api/v1/auth/login', { username: 'ganti.sandi', password: newPassword }, { origin: appOrigin, marker: true, client: 'device-c' })).status, 200);
});

test('register and login reject a missing marker, a foreign Origin, or a missing Origin', async () => {
  const harness = createHarness();
  await harness.seed('pintu.masuk', startPassword, { role: 'user' });
  const cases: Array<{ origin?: string; marker: boolean }> = [
    { origin: appOrigin, marker: false },
    { origin: 'https://evil.example', marker: true },
    { marker: true },
  ];
  for (const options of cases) {
    const login = await harness.post('/api/v1/auth/login', { username: 'pintu.masuk', password: startPassword }, options);
    assert.equal(login.status, 403);
    const register = await harness.post('/api/v1/auth/register', { username: 'pintu.baru', password: startPassword }, options);
    assert.equal(register.status, 403);
  }
  assert.equal(harness.store.accountCount(), 1);
});

test('disabled accounts keep the session anonymous, close credential routes, and expose no Google routes', async () => {
  const api = createAccountApi({ enabled: false });
  const session = await api(new Request(`${appOrigin}/api/v1/auth/session`));
  assert.deepEqual(await session?.json(), {
    version: 'account-v1',
    status: 'anonymous',
    password_login_available: false,
    registration_available: false,
    csrf_token: null,
    user: null,
  });
  const login = await api(new Request(`${appOrigin}/api/v1/auth/login`, { method: 'POST', headers: { origin: appOrigin, 'x-waspada-request': '1' } }));
  assert.equal(login?.status, 503);
  for (const path of ['/api/v1/auth/google/start', '/api/v1/auth/google/callback', '/api/v1/auth/google/native', '/api/v1/auth/demo-login']) {
    const response = await api(new Request(`${appOrigin}${path}`, { method: 'POST' }));
    assert.equal(response?.status, 404, `${path} is not part of account-v1`);
  }
});

test('admin list and role changes require a completed admin session, CSRF, and an audited reason', async () => {
  const harness = createHarness();
  await harness.seed('admin.utama', startPassword, { role: 'admin', onboardingCompleted: true });
  await harness.seed('warga.biasa', startPassword, { role: 'user' });
  const admin = await harness.post('/api/v1/auth/login', { username: 'admin.utama', password: startPassword }, { origin: appOrigin, marker: true, client: 'admin' });
  const adminSession = await admin.json() as SessionBody;
  const adminCookie = cookieFrom(admin);
  const user = await harness.post('/api/v1/auth/login', { username: 'warga.biasa', password: startPassword }, { origin: appOrigin, marker: true, client: 'user' });
  const userSession = await user.json() as SessionBody;
  const userCookie = cookieFrom(user);

  assert.equal((await harness.request('/api/v1/account/users', { cookie: userCookie })).status, 403);
  const list = await harness.request('/api/v1/account/users', { cookie: adminCookie });
  assert.equal(list.status, 200);
  const page = await list.json() as { data: Array<{ id: string; version: number }> };
  const target = page.data.find((account) => account.id === userSession.user?.id);
  assert.ok(target);

  const update = (headers: Record<string, string>, body: unknown) => harness.request(`/api/v1/account/users/${target.id}`, {
    method: 'PATCH', cookie: adminCookie, headers: { origin: appOrigin, 'content-type': 'application/json', ...headers }, body,
  });
  assert.equal((await update({}, { role: 'moderator', active: true, expected_version: target.version, reason: 'Peran moderator' })).status, 403);
  const updated = await update({ 'x-csrf-token': adminSession.csrf_token ?? '' }, {
    role: 'moderator', active: true, expected_version: target.version, reason: 'Peran moderator',
  });
  assert.equal(updated.status, 200);
  assert.equal(((await updated.json()) as { role: string }).role, 'moderator');
  assert.equal(((await (await harness.request('/api/v1/auth/session', { cookie: userCookie })).json()) as SessionBody).status, 'anonymous',
    'admin role changes revoke the target sessions');
});

// ---------------------------------------------------------------------------

interface SessionBody {
  readonly version: 'account-v1';
  readonly status: 'anonymous' | 'authenticated';
  readonly password_login_available: boolean;
  readonly registration_available: boolean;
  readonly csrf_token: string | null;
  readonly user: { readonly id: string; readonly role: string; readonly email: string | null; readonly version: number } | null;
}

function withoutRequestId(body: unknown): unknown {
  const { request_id: _ignored, ...rest } = body as Record<string, unknown>;
  return rest;
}

function cookieFrom(response: Response): string {
  const header = response.headers.get('set-cookie') ?? '';
  const pair = header.split(';')[0] ?? '';
  return pair;
}

function createHarness() {
  const store = new FakeAccountStore('live');
  let clock = baseTime;
  const api = createAccountApi({
    enabled: true,
    store,
    appOrigin,
    datasetMode: 'live',
    cookieMode: 'host',
    now: () => clock,
    trustedClientKey: (request) => request.headers.get('x-test-client') ?? 'client-default',
  });

  interface PostOptions { readonly origin?: string; readonly marker?: boolean; readonly client?: string }

  async function request(path: string, options: {
    readonly method?: string;
    readonly headers?: Record<string, string>;
    readonly cookie?: string;
    readonly body?: unknown;
  } = {}): Promise<Response> {
    const headers = new Headers(options.headers ?? {});
    if (options.body !== undefined) headers.set('content-type', 'application/json');
    if (options.cookie) headers.set('cookie', options.cookie);
    const response = await api(new Request(`${appOrigin}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }));
    if (!response) throw new Error('account route did not answer');
    return response;
  }

  return {
    store,
    advance(milliseconds: number) { clock += milliseconds; },
    request,
    post(path: string, body: unknown, options: PostOptions = {}): Promise<Response> {
      const headers: Record<string, string> = { 'x-test-client': options.client ?? 'client-default' };
      if (options.origin) headers.origin = options.origin;
      if (options.marker) headers['x-waspada-request'] = '1';
      return request(path, { method: 'POST', headers, body });
    },
    async seed(username: string, password: string, options: { role: 'user' | 'moderator' | 'admin'; active?: boolean; onboardingCompleted?: boolean }) {
      await store.createPasswordAccount({
        datasetMode: 'live',
        username,
        passwordHash: await hashPassword(password),
        displayName: username,
        role: options.role,
        now: new Date(clock).toISOString(),
        ...(options.role === 'user' ? {} : { reason: 'Seeded for account API test' }),
      });
      const account = store.findByUsername(username);
      if (account) {
        account.account = {
          ...account.account,
          active: options.active ?? true,
          onboarding_version: options.role !== 'user' || options.onboardingCompleted ? 1 : 0,
          onboarding_completed_at: options.role !== 'user' || options.onboardingCompleted ? new Date(clock).toISOString() : null,
        };
      }
    },
  };
}

interface StoredRecord {
  account: StoredAccount;
  passwordHash: string;
  username: string;
}

interface SessionRecord {
  readonly accountId: string;
  readonly channel: AccountChannel;
  readonly csrfToken: string | null;
  readonly createdAt: string;
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
  revoked: boolean;
}

class FakeAccountStore implements AccountStore {
  readonly accounts = new Map<string, StoredRecord>();
  readonly sessions = new Map<string, SessionRecord>();
  readonly throttles = new Map<string, { count: number; expiresAt: number }>();

  constructor(readonly datasetMode: AccountDatasetMode) {}

  accountCount(): number {
    return this.accounts.size;
  }

  findByUsername(username: string): StoredRecord | undefined {
    for (const record of this.accounts.values()) {
      if (record.username === username) return record;
    }
    return undefined;
  }

  async createPasswordAccount(input: CreatePasswordAccountInput): Promise<StoredAccount> {
    const normalized = input.username;
    for (const record of this.accounts.values()) {
      if (record.username === normalized) throw new AccountUsernameTakenError();
    }
    const id = randomUUID();
    const operator = input.role !== 'user';
    const account: StoredAccount = {
      id,
      display_name: input.displayName,
      email: null,
      role: input.role,
      active: true,
      onboarding_version: operator ? 1 : 0,
      onboarding_completed_at: operator ? input.now : null,
      version: 1,
    };
    this.accounts.set(id, { account, passwordHash: input.passwordHash, username: normalized });
    return account;
  }

  async findPasswordCredentialByUsername(username: string): Promise<StoredPasswordCredential | null> {
    const record = this.findByUsername(username);
    return record ? { account: record.account, passwordHash: record.passwordHash } : null;
  }

  async findPasswordCredentialByAccountId(accountId: string): Promise<StoredPasswordCredential | null> {
    const record = this.accounts.get(accountId);
    return record ? { account: record.account, passwordHash: record.passwordHash } : null;
  }

  async setPasswordHash(input: SetPasswordHashInput): Promise<boolean> {
    const record = this.accounts.get(input.accountId);
    if (!record || !record.account.active) return false;
    record.passwordHash = input.passwordHash;
    for (const [token, session] of this.sessions) {
      if (session.accountId === input.accountId && token !== input.keepTokenSha256) session.revoked = true;
    }
    return true;
  }

  async createSession(input: CreateAccountSessionInput): Promise<StoredAccount> {
    const record = this.accounts.get(input.accountId);
    if (!record || !record.account.active) throw new Error('Account is unavailable.');
    if (input.revokeTokenSha256) {
      const prior = this.sessions.get(input.revokeTokenSha256);
      if (prior) prior.revoked = true;
    }
    this.sessions.set(input.tokenSha256, {
      accountId: input.accountId,
      channel: input.channel,
      csrfToken: input.csrfToken,
      createdAt: input.createdAt,
      idleExpiresAt: input.idleExpiresAt,
      absoluteExpiresAt: input.absoluteExpiresAt,
      revoked: false,
    });
    return record.account;
  }

  async readSession(tokenSha256: string, now: string): Promise<StoredAccountSession | null> {
    const session = this.sessions.get(tokenSha256);
    if (!session || session.revoked) return null;
    const at = Date.parse(now);
    if (Date.parse(session.idleExpiresAt) <= at || Date.parse(session.absoluteExpiresAt) <= at) return null;
    const record = this.accounts.get(session.accountId);
    if (!record || !record.account.active) return null;
    return { channel: session.channel, csrfToken: session.csrfToken, account: record.account };
  }

  async revokeSession(tokenSha256: string): Promise<boolean> {
    const session = this.sessions.get(tokenSha256);
    if (!session || session.revoked) return false;
    session.revoked = true;
    return true;
  }

  async completeOnboarding(accountId: string, _version: 1, now: string): Promise<StoredAccount | null> {
    const record = this.accounts.get(accountId);
    if (!record || !record.account.active) return null;
    record.account = { ...record.account, onboarding_version: 1, onboarding_completed_at: now, version: record.account.version + 1 };
    return record.account;
  }

  async listAccounts(limit: number, _after: string | undefined, actorAccountId: string) {
    const actor = this.accounts.get(actorAccountId)?.account;
    if (!actor || actor.role !== 'admin' || actor.onboarding_version !== 1) return { outcome: 'forbidden' as const };
    const data = [...this.accounts.values()].map((record) => record.account).slice(0, limit);
    return { outcome: 'listed' as const, page: { data, nextCursor: null } };
  }

  async updateAccountByAdmin(input: AccountAdminUpdateInput): Promise<AccountAdminUpdateResult> {
    const target = this.accounts.get(input.targetAccountId);
    if (!target) return { outcome: 'not_found' };
    if (target.account.version !== input.expectedVersion) return { outcome: 'conflict' };
    target.account = { ...target.account, role: input.role, active: input.active, version: target.account.version + 1 };
    for (const session of this.sessions.values()) {
      if (session.accountId === input.targetAccountId) session.revoked = true;
    }
    return { outcome: 'updated', account: target.account };
  }

  async consumeThrottle(scope: AccountThrottleScope, clientKeySha256: string, now: string, windowMilliseconds: number, maximumRequests: number): Promise<boolean> {
    const key = `${scope}:${clientKeySha256}`;
    const at = Date.parse(now);
    const current = this.throttles.get(key);
    if (!current || current.expiresAt <= at) {
      this.throttles.set(key, { count: 1, expiresAt: at + windowMilliseconds });
      return 1 <= maximumRequests;
    }
    current.count += 1;
    return current.count <= maximumRequests;
  }

  async cleanupExpired(): Promise<number> {
    return 0;
  }
}
