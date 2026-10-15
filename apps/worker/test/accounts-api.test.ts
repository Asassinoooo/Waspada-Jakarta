import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createAccountApi } from '../src/accounts/api.js';
import type {
  AccountAdminUpdateInput,
  AccountAdminUpdateResult,
  AccountChannel,
  AccountDatasetMode,
  AccountRole,
  AccountStore,
  ClaimedAccountLoginAttempt,
  CreateAccountLoginAttemptInput,
  CreateAccountSessionInput,
  ProvisionAccountInput,
  StoredAccount,
  StoredAccountSession,
  VerifiedGoogleIdentity,
} from '../../db/src/accounts.js';
import type { AccountGoogleProvider, GoogleWebAuthorization } from '../src/accounts/types.js';

const appOrigin = 'https://waspada.example';
const accountIdPattern = /^[0-9a-f-]{36}$/u;

test('web login binds Origin, state, browser cookie, PKCE inputs, one-time callback, and session hash', async () => {
  const store = new FakeAccountStore('live');
  const google = new FakeGoogleProvider();
  const api = createAccountApi({
    enabled: true,
    store,
    google,
    appOrigin,
    datasetMode: 'live',
    webLoginAvailable: true,
    nativeLoginAvailable: true,
    randomToken: tokenSequence(),
    now: () => Date.parse('2026-10-01T00:00:00.000Z'),
  });

  const wrongOrigin = await api(jsonRequest('/api/v1/auth/google/start', {
    headers: { origin: 'https://evil.example', 'x-waspada-request': '1' },
    body: { return_to: '#admin' },
  }));
  assert.equal(wrongOrigin?.status, 403);
  assert.equal(google.beginCount, 0);

  const started = await api(jsonRequest('/api/v1/auth/google/start', {
    headers: { origin: appOrigin, 'x-waspada-request': '1' },
    body: { return_to: '#admin' },
  }));
  assert.equal(started?.status, 200);
  const authorization = await started?.json() as { authorization_url: string };
  assert.equal(authorization.authorization_url, google.authorization.authorizationUrl);
  const attemptCookie = cookieValue(started?.headers.get('set-cookie') ?? '', '__Host-waspada_oauth_attempt');
  assert.ok(attemptCookie);
  assert.match(started?.headers.get('set-cookie') ?? '', /; HttpOnly; SameSite=Lax; Secure/u);

  const callback = await api(new Request(
    `${appOrigin}/api/v1/auth/google/callback?code=private-code&state=${encodeURIComponent(google.authorization.state)}`,
    { headers: { cookie: `__Host-waspada_oauth_attempt=${attemptCookie}` } },
  ));
  assert.equal(callback?.status, 303);
  assert.equal(callback?.headers.get('location'), `${appOrigin}/#mulai`,
    'new accounts start onboarding even when a different safe return hash was requested');
  assert.equal(google.completed.length, 1);
  assert.equal(google.completed[0]?.expectedState, google.authorization.state);
  assert.equal(google.completed[0]?.expectedNonce, google.authorization.nonce);
  assert.equal(google.completed[0]?.codeVerifier, google.authorization.codeVerifier);
  const sessionToken = cookieValue(callback?.headers.get('set-cookie') ?? '', '__Host-waspada_session');
  assert.ok(sessionToken);
  assert.match(callback?.headers.get('set-cookie') ?? '', /__Host-waspada_session=.*; HttpOnly; SameSite=Strict; Secure/u);
  assert.ok(!store.sessions.has(sessionToken), 'session table is keyed by a digest, never the cookie token');
  assert.ok(store.sessions.has(hash(sessionToken)));

  const replay = await api(new Request(
    `${appOrigin}/api/v1/auth/google/callback?code=private-code&state=${encodeURIComponent(google.authorization.state)}`,
    { headers: { cookie: `__Host-waspada_oauth_attempt=${attemptCookie}` } },
  ));
  assert.equal(replay?.status, 303);
  assert.equal(replay?.headers.get('location'), `${appOrigin}/#masuk?login=failed`);
  assert.equal(google.completed.length, 1, 'a callback replay never reaches the provider');
  assert.ok(!replay?.headers.get('location')?.includes('private-code'));

  const session = await api(new Request(`${appOrigin}/api/v1/auth/session`, {
    headers: { cookie: `__Host-waspada_session=${sessionToken}` },
  }));
  assert.equal(session?.status, 200);
  const envelope = await session?.json() as { status: string; csrf_token: string; user: StoredAccount };
  assert.equal(envelope.status, 'authenticated');
  assert.equal(envelope.user.role, 'user');
  assert.equal(envelope.user.onboarding_version, 0);
  assert.equal(envelope.csrf_token, `03${'R'.repeat(41)}`);
});

test('successful callback rotates the prior web session captured at same-origin start without needing its callback cookie', async () => {
  const store = new FakeAccountStore('live');
  const account = await store.findOrCreateVerifiedAccount(googleIdentity('web-user'), '2026-10-01T00:00:00.000Z');
  await store.completeOnboarding(account.id, 1, '2026-10-01T00:00:00.000Z');
  const oldToken = 'O'.repeat(43);
  await store.createSession({
    accountId: account.id,
    tokenSha256: hash(oldToken),
    channel: 'web',
    csrfToken: 'C'.repeat(43),
    createdAt: '2026-10-01T00:00:00.000Z',
    idleExpiresAt: '2026-10-01T00:30:00.000Z',
    absoluteExpiresAt: '2026-10-01T08:00:00.000Z',
  });
  const google = new FakeGoogleProvider();
  const api = createAccountApi({
    enabled: true,
    store,
    google,
    appOrigin,
    datasetMode: 'live',
    webLoginAvailable: true,
    nativeLoginAvailable: true,
    randomToken: tokenSequence(),
    now: () => Date.parse('2026-10-01T00:01:00.000Z'),
  });
  const start = await api(jsonRequest('/api/v1/auth/google/start', {
    headers: {
      origin: appOrigin,
      'x-waspada-request': '1',
      cookie: `__Host-waspada_session=${oldToken}`,
    },
    body: { return_to: '#akun' },
  }));
  const attemptCookie = cookieValue(start?.headers.get('set-cookie') ?? '', '__Host-waspada_oauth_attempt');
  assert.ok(attemptCookie);
  const attempt = store.attempts.get(hash(google.authorization.state));
  assert.equal(attempt?.priorSessionTokenSha256, hash(oldToken));

  const callback = await api(new Request(
    `${appOrigin}/api/v1/auth/google/callback?code=private-code&state=${encodeURIComponent(google.authorization.state)}`,
    { headers: { cookie: `__Host-waspada_oauth_attempt=${attemptCookie}` } },
  ));
  assert.equal(callback?.status, 303);
  assert.equal(callback?.headers.get('location'), `${appOrigin}/#akun`);
  assert.equal(store.sessions.get(hash(oldToken))?.revoked, true);
  const newToken = cookieValue(callback?.headers.get('set-cookie') ?? '', '__Host-waspada_session');
  assert.ok(newToken);
  const oldSession = await api(new Request(`${appOrigin}/api/v1/auth/session`, {
    headers: { cookie: `__Host-waspada_session=${oldToken}` },
  }));
  const newSession = await api(new Request(`${appOrigin}/api/v1/auth/session`, {
    headers: { cookie: `__Host-waspada_session=${newToken}` },
  }));
  assert.equal((await oldSession?.json() as { status: string }).status, 'anonymous');
  assert.equal((await newSession?.json() as { status: string }).status, 'authenticated');
});

test('failed Google callback consumes only its attempt and leaves the prior web session active', async () => {
  const store = new FakeAccountStore('live');
  const account = await store.findOrCreateVerifiedAccount(googleIdentity('web-user'), '2026-10-01T00:00:00.000Z');
  const oldToken = 'F'.repeat(43);
  await store.createSession({
    accountId: account.id,
    tokenSha256: hash(oldToken),
    channel: 'web',
    csrfToken: 'D'.repeat(43),
    createdAt: '2026-10-01T00:00:00.000Z',
    idleExpiresAt: '2026-10-01T00:30:00.000Z',
    absoluteExpiresAt: '2026-10-01T08:00:00.000Z',
  });
  const google = new FakeGoogleProvider();
  const api = createAccountApi({
    enabled: true,
    store,
    google,
    appOrigin,
    datasetMode: 'live',
    webLoginAvailable: true,
    randomToken: tokenSequence(),
    now: () => Date.parse('2026-10-01T00:01:00.000Z'),
  });
  const start = await api(jsonRequest('/api/v1/auth/google/start', {
    headers: {
      origin: appOrigin,
      'x-waspada-request': '1',
      cookie: `__Host-waspada_session=${oldToken}`,
    },
    body: { return_to: '#akun' },
  }));
  const attemptCookie = cookieValue(start?.headers.get('set-cookie') ?? '', '__Host-waspada_oauth_attempt');
  assert.ok(attemptCookie);
  const failed = await api(new Request(
    `${appOrigin}/api/v1/auth/google/callback?error=access_denied&state=${encodeURIComponent(google.authorization.state)}`,
    { headers: { cookie: `__Host-waspada_oauth_attempt=${attemptCookie}` } },
  ));
  assert.equal(failed?.status, 303);
  assert.equal(failed?.headers.get('location'), `${appOrigin}/#masuk?login=failed`);
  assert.equal(store.sessions.get(hash(oldToken))?.revoked, false);
  assert.equal(google.completed.length, 0);
  const oldSession = await api(new Request(`${appOrigin}/api/v1/auth/session`, {
    headers: { cookie: `__Host-waspada_session=${oldToken}` },
  }));
  assert.equal((await oldSession?.json() as { status: string }).status, 'authenticated');
});

test('browser mutations require exact Origin and session CSRF; unknown account routes stay closed', async () => {
  const store = new FakeAccountStore('live');
  const account = await store.provisionAccount({
    identity: googleIdentity('csrf-user'),
    role: 'user',
    reason: 'test setup',
    now: '2026-10-01T00:00:00.000Z',
  });
  const token = 'S'.repeat(43);
  const csrf = 'C'.repeat(43);
  await store.createSession({
    accountId: account.id,
    tokenSha256: hash(token),
    channel: 'web',
    csrfToken: csrf,
    createdAt: '2026-10-01T00:00:00.000Z',
    idleExpiresAt: '2026-10-01T00:30:00.000Z',
    absoluteExpiresAt: '2026-10-01T08:00:00.000Z',
  });
  const api = createAccountApi({
    enabled: true,
    store,
    google: new FakeGoogleProvider(),
    appOrigin,
    datasetMode: 'live',
    webLoginAvailable: true,
    now: () => Date.parse('2026-10-01T00:01:00.000Z'),
  });

  const wrongOrigin = await api(jsonRequest('/api/v1/account/onboarding', {
    headers: { cookie: `__Host-waspada_session=${token}`, origin: 'https://evil.example', 'x-waspada-csrf': csrf },
    body: { version: 1 },
  }));
  assert.equal(wrongOrigin?.status, 403);
  const missingCsrf = await api(jsonRequest('/api/v1/account/onboarding', {
    headers: { cookie: `__Host-waspada_session=${token}`, origin: appOrigin },
    body: { version: 1 },
  }));
  assert.equal(missingCsrf?.status, 403);
  const completed = await api(jsonRequest('/api/v1/account/onboarding', {
    headers: { cookie: `__Host-waspada_session=${token}`, origin: appOrigin, 'x-waspada-csrf': csrf },
    body: { version: 1 },
  }));
  assert.equal(completed?.status, 200);
  assert.equal((await completed?.json() as { user: StoredAccount }).user.onboarding_version, 1);
  const unknown = await api(new Request(`${appOrigin}/api/v1/auth/provider/debug`));
  assert.equal(unknown?.status, 404);
  const outside = await api(new Request(`${appOrigin}/api/v1/events`));
  assert.equal(outside, undefined, 'the auth handler leaves public routes alone');
});

test('native bearer sessions can onboard and log out but cannot enter web admin routes', async () => {
  const store = new FakeAccountStore('live');
  await store.provisionAccount({
    identity: googleIdentity('native-admin'),
    role: 'admin',
    reason: 'test setup',
    now: '2026-10-01T00:00:00.000Z',
  });
  const google = new FakeGoogleProvider();
  const api = createAccountApi({
    enabled: true,
    store,
    google,
    appOrigin,
    datasetMode: 'live',
    webLoginAvailable: true,
    nativeLoginAvailable: true,
    randomToken: tokenSequence(),
    now: () => Date.parse('2026-10-01T00:00:00.000Z'),
  });

  const cookieAttempt = await api(jsonRequest('/api/v1/auth/google/native', {
    headers: { cookie: '__Host-waspada_session=anything' },
    body: { id_token: 'synthetic-local-id-token' },
  }));
  assert.equal(cookieAttempt?.status, 403);
  const originAttempt = await api(jsonRequest('/api/v1/auth/google/native', {
    headers: { origin: appOrigin },
    body: { id_token: 'synthetic-local-id-token' },
  }));
  assert.equal(originAttempt?.status, 403);
  assert.equal(google.nativeVerifyCount, 0);

  const exchanged = await api(jsonRequest('/api/v1/auth/google/native', {
    body: { id_token: 'synthetic-local-id-token' },
  }));
  assert.equal(exchanged?.status, 200);
  const body = await exchanged?.json() as { session_token: string; session: { user: StoredAccount; csrf_token: null } };
  assert.equal(body.session.user.role, 'admin', 'provisioned roles remain server-owned');
  assert.equal(body.session.csrf_token, null);
  assert.ok(!store.sessions.has(body.session_token));
  assert.ok(store.sessions.has(hash(body.session_token)));

  const adminList = await api(new Request(`${appOrigin}/api/v1/account/users`, {
    headers: { authorization: `Bearer ${body.session_token}` },
  }));
  assert.equal(adminList?.status, 403, 'a privileged mobile session cannot use web admin routes');
  const onboarding = await api(jsonRequest('/api/v1/account/onboarding', {
    headers: { authorization: `Bearer ${body.session_token}` },
    body: { version: 1 },
  }));
  assert.equal(onboarding?.status, 200);
  const logout = await api(jsonRequest('/api/v1/auth/logout', {
    headers: { authorization: `Bearer ${body.session_token}` },
    body: {},
  }));
  assert.equal(logout?.status, 204);
  const afterLogout = await api(new Request(`${appOrigin}/api/v1/auth/session`, {
    headers: { authorization: `Bearer ${body.session_token}` },
  }));
  assert.equal((await afterLogout?.json() as { status: string }).status, 'anonymous');
});

test('admin updates require a completed web admin, CSRF, version, reason, and store-side actor revalidation', async () => {
  const store = new FakeAccountStore('live');
  const admin = await store.provisionAccount({
    identity: googleIdentity('admin'),
    role: 'admin',
    reason: 'test setup',
    now: '2026-10-01T00:00:00.000Z',
  });
  await store.completeOnboarding(admin.id, 1, '2026-10-01T00:00:00.000Z');
  const target = await store.findOrCreateVerifiedAccount(googleIdentity('target'), '2026-10-01T00:00:00.000Z');
  const token = 'A'.repeat(43);
  const csrf = 'B'.repeat(43);
  await store.createSession({
    accountId: admin.id,
    tokenSha256: hash(token),
    channel: 'web',
    csrfToken: csrf,
    createdAt: '2026-10-01T00:00:00.000Z',
    idleExpiresAt: '2026-10-01T00:30:00.000Z',
    absoluteExpiresAt: '2026-10-01T08:00:00.000Z',
  });
  const api = createAccountApi({
    enabled: true,
    store,
    google: new FakeGoogleProvider(),
    appOrigin,
    datasetMode: 'live',
    webLoginAvailable: true,
    now: () => Date.parse('2026-10-01T00:01:00.000Z'),
  });

  const targetUrl = `/api/v1/account/users/${target.id}`;
  const update = (headers: Record<string, string>, body = {
    role: 'moderator', active: false, expected_version: target.version, reason: 'verified account review',
  }) => api(jsonRequest(targetUrl, { method: 'PATCH', headers, body }));
  const baseHeaders = { cookie: `__Host-waspada_session=${token}`, origin: appOrigin };
  const listed = await api(new Request(`${appOrigin}/api/v1/account/users?limit=10`, {
    headers: { cookie: `__Host-waspada_session=${token}` },
  }));
  assert.equal(listed?.status, 200);
  const userPage = await listed?.json() as { data: readonly Record<string, unknown>[] };
  assert.ok(userPage.data.some((item) => item.id === target.id));
  assert.ok(userPage.data.every((item) => !('identity_subject' in item)));
  assert.equal((await update(baseHeaders))?.status, 403, 'missing CSRF must block privilege changes');
  const invalidReason = await update({ ...baseHeaders, 'x-waspada-csrf': csrf }, {
    role: 'admin', active: true, expected_version: target.version, reason: ' ' as unknown as string,
  });
  assert.equal(invalidReason?.status, 400);

  const changed = await update({ ...baseHeaders, 'x-waspada-csrf': csrf });
  assert.equal(changed?.status, 200);
  assert.equal((await changed?.json() as StoredAccount).role, 'moderator');
  const self = await api(jsonRequest(`/api/v1/account/users/${admin.id}`, {
    method: 'PATCH',
    headers: { ...baseHeaders, 'x-waspada-csrf': csrf },
    body: { role: 'user', active: false, expected_version: admin.version + 1, reason: 'self demotion denied' },
  }));
  assert.equal(self?.status, 409);

  store.revalidateAsNonAdminOnNextUpdate = true;
  const concurrentlyDemoted = await update({ ...baseHeaders, 'x-waspada-csrf': csrf }, {
    role: 'user', active: true, expected_version: target.version + 1, reason: 'race check',
  });
  assert.equal(concurrentlyDemoted?.status, 403, 'the durable store rechecks the actor in the update transaction');
});

test('API construction rejects a store from a different server-selected dataset', () => {
  assert.throws(() => createAccountApi({
    enabled: true,
    store: new FakeAccountStore('demo'),
    google: new FakeGoogleProvider(),
    appOrigin,
    datasetMode: 'live',
  }), /dataset scopes must match/u);
});

test('only an exact local consent URL with a matching state is allowed in demo loopback mode', async () => {
  const authorization: GoogleWebAuthorization = {
    authorizationUrl: 'http://localhost:5173/api/v1/auth/demo/consent?state=0123456789abcdef',
    state: '0123456789abcdef',
    nonce: 'n'.repeat(32),
    codeVerifier: 'v'.repeat(43),
  };
  const store = new FakeAccountStore('demo');
  const google = new FakeGoogleProvider(authorization);
  const api = createAccountApi({
    enabled: true,
    store,
    google,
    appOrigin: 'http://localhost:5173',
    datasetMode: 'demo',
    webLoginAvailable: true,
    cookieMode: 'loopback',
    loopbackAuthorizationOrigin: 'http://localhost:5173',
  });
  const accepted = await api(jsonRequest('/api/v1/auth/google/start', {
    headers: { origin: 'http://localhost:5173', 'x-waspada-request': '1' },
    body: { return_to: '#akun' },
  }));
  assert.equal(accepted?.status, 200);

  const poisoned = new FakeGoogleProvider({
    ...authorization,
    authorizationUrl: `${authorization.authorizationUrl}&next=https://evil.example`,
  });
  const poisonedApi = createAccountApi({
    enabled: true,
    store: new FakeAccountStore('demo'),
    google: poisoned,
    appOrigin: 'http://localhost:5173',
    datasetMode: 'demo',
    webLoginAvailable: true,
    cookieMode: 'loopback',
    loopbackAuthorizationOrigin: 'http://localhost:5173',
  });
  const rejected = await poisonedApi(jsonRequest('/api/v1/auth/google/start', {
    headers: { origin: 'http://localhost:5173', 'x-waspada-request': '1' },
    body: { return_to: '#akun' },
  }));
  assert.equal(rejected?.status, 503);
});

test('disabled session remains anonymous with login flags off while auth paths are closed', async () => {
  const api = createAccountApi({ enabled: false });
  const session = await api(new Request(`${appOrigin}/api/v1/auth/session`));
  assert.equal(session?.status, 200);
  assert.deepEqual(await session?.json(), {
    version: 'account-v1',
    status: 'anonymous',
    google_login_available: false,
    native_login_available: false,
    csrf_token: null,
    user: null,
  });
  assert.equal((await api(new Request(`${appOrigin}/api/v1/auth/google/native`, { method: 'POST' })))?.status, 503);
  assert.equal((await api(new Request(`${appOrigin}/api/v1/account/not-a-route`)))?.status, 404);
});

class FakeAccountStore implements AccountStore {
  readonly accounts = new Map<string, StoredAccount>();
  readonly sessions = new Map<string, FakeSession>();
  readonly attempts = new Map<string, FakeAttempt>();
  readonly throttle = new Map<string, { startedAt: number; expiresAt: number; count: number }>();
  readonly datasetMode: AccountDatasetMode;
  revalidateAsNonAdminOnNextUpdate = false;
  private nextId = 1;

  constructor(datasetMode: AccountDatasetMode) {
    this.datasetMode = datasetMode;
  }

  async createLoginAttempt(input: CreateAccountLoginAttemptInput): Promise<void> {
    this.attempts.set(input.stateSha256, { ...input, consumed: false });
  }

  async claimLoginAttempt(stateSha256: string, browserCookieSha256: string, now: string): Promise<ClaimedAccountLoginAttempt | null> {
    const attempt = this.attempts.get(stateSha256);
    if (!attempt || attempt.browserCookieSha256 !== browserCookieSha256
      || attempt.consumed || Date.parse(attempt.expiresAt) <= Date.parse(now)) return null;
    attempt.consumed = true;
    return {
      codeVerifier: attempt.codeVerifier,
      nonce: attempt.nonce,
      returnTo: attempt.returnTo,
      priorSessionTokenSha256: attempt.priorSessionTokenSha256,
    };
  }

  async findOrCreateVerifiedAccount(identity: VerifiedGoogleIdentity, now: string): Promise<StoredAccount> {
    const existing = [...this.accounts.values()].find((item) => item.email === identity.email);
    if (existing) return existing;
    const account = this.newAccount(identity, 'user', now);
    this.accounts.set(account.id, account);
    return account;
  }

  async createSession(input: CreateAccountSessionInput): Promise<StoredAccount> {
    const account = this.accounts.get(input.accountId);
    assert.ok(account?.active);
    if (input.revokeTokenSha256) {
      const previous = this.sessions.get(input.revokeTokenSha256);
      if (previous) previous.revoked = true;
    }
    this.sessions.set(input.tokenSha256, {
      accountId: input.accountId,
      channel: input.channel,
      csrfToken: input.csrfToken,
      idleExpiresAt: input.idleExpiresAt,
      absoluteExpiresAt: input.absoluteExpiresAt,
      revoked: false,
    });
    return account;
  }

  async readSession(tokenSha256: string, now: string): Promise<StoredAccountSession | null> {
    const session = this.sessions.get(tokenSha256);
    const account = session ? this.accounts.get(session.accountId) : undefined;
    if (!session || !account || session.revoked || !account.active
      || Date.parse(session.idleExpiresAt) <= Date.parse(now)
      || Date.parse(session.absoluteExpiresAt) <= Date.parse(now)) return null;
    session.idleExpiresAt = new Date(Math.min(
      Date.parse(now) + 30 * 60_000,
      Date.parse(session.absoluteExpiresAt),
    )).toISOString();
    return { channel: session.channel, csrfToken: session.csrfToken, account };
  }

  async revokeSession(tokenSha256: string): Promise<boolean> {
    const session = this.sessions.get(tokenSha256);
    if (!session || session.revoked) return false;
    session.revoked = true;
    return true;
  }

  async completeOnboarding(accountId: string, version: 1, _now: string): Promise<StoredAccount | null> {
    const account = this.accounts.get(accountId);
    if (!account?.active) return null;
    if (version === 1 && account.onboarding_version === 0) {
      const updated = { ...account, onboarding_version: 1 as const, onboarding_completed_at: '2026-10-01T00:00:00.000Z', version: account.version + 1 };
      this.accounts.set(accountId, updated);
      return updated;
    }
    return account;
  }

  async listAccounts(limit: number, after: string | undefined, actorAccountId: string) {
    const actor = this.accounts.get(actorAccountId);
    if (!actor || actor.role !== 'admin' || !actor.active || actor.onboarding_version !== 1) {
      return { outcome: 'forbidden' as const };
    }
    const all = [...this.accounts.values()].sort((left, right) => left.id.localeCompare(right.id))
      .filter((account) => after === undefined || account.id > after);
    const data = all.slice(0, limit);
    return {
      outcome: 'listed' as const,
      page: { data, nextCursor: all.length > limit ? data.at(-1)?.id ?? null : null },
    };
  }

  async updateAccountByAdmin(input: AccountAdminUpdateInput): Promise<AccountAdminUpdateResult> {
    const actor = this.accounts.get(input.actorAccountId);
    if (this.revalidateAsNonAdminOnNextUpdate && actor) {
      this.revalidateAsNonAdminOnNextUpdate = false;
      this.accounts.set(actor.id, { ...actor, role: 'user', version: actor.version + 1 });
      return { outcome: 'forbidden' };
    }
    if (!actor || actor.role !== 'admin' || !actor.active || actor.onboarding_version !== 1) {
      return { outcome: 'forbidden' };
    }
    if (input.actorAccountId === input.targetAccountId) return { outcome: 'conflict' };
    const target = this.accounts.get(input.targetAccountId);
    if (!target) return { outcome: 'not_found' };
    if (target.version !== input.expectedVersion) return { outcome: 'conflict' };
    const updated = {
      ...target,
      role: input.role,
      active: input.active,
      version: target.version + 1,
    };
    this.accounts.set(target.id, updated);
    for (const session of this.sessions.values()) {
      if (session.accountId === target.id) session.revoked = true;
    }
    return { outcome: 'updated', account: updated };
  }

  async consumeThrottle(
    scope: 'web_start' | 'web_callback' | 'native_exchange',
    clientKeySha256: string,
    now: string,
    windowMilliseconds: number,
    maximumRequests: number,
  ): Promise<boolean> {
    const key = `${scope}:${clientKeySha256}`;
    const time = Date.parse(now);
    const existing = this.throttle.get(key);
    if (!existing || existing.expiresAt <= time) {
      this.throttle.set(key, { startedAt: time, expiresAt: time + windowMilliseconds, count: 1 });
      return true;
    }
    existing.count += 1;
    return existing.count <= maximumRequests;
  }

  async cleanupExpired(): Promise<number> {
    return 0;
  }

  async provisionAccount(input: ProvisionAccountInput): Promise<StoredAccount> {
    const existing = [...this.accounts.values()].find((item) => item.email === input.identity.email);
    if (existing) {
      const updated = { ...existing, role: input.role, active: true, version: existing.version + 1 };
      this.accounts.set(existing.id, updated);
      return updated;
    }
    const account = this.newAccount(input.identity, input.role, input.now);
    this.accounts.set(account.id, account);
    return account;
  }

  private newAccount(identity: VerifiedGoogleIdentity, role: AccountRole, _now: string): StoredAccount {
    const id = `00000000-0000-4000-8000-${String(this.nextId++).padStart(12, '0')}`;
    assert.match(id, accountIdPattern);
    return {
      id,
      display_name: identity.displayName,
      email: identity.email,
      role,
      active: true,
      onboarding_version: 0,
      onboarding_completed_at: null,
      version: 1,
    };
  }
}

interface FakeAttempt extends CreateAccountLoginAttemptInput {
  consumed: boolean;
}

interface FakeSession {
  accountId: string;
  channel: AccountChannel;
  csrfToken: string | null;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  revoked: boolean;
}

class FakeGoogleProvider implements AccountGoogleProvider {
  readonly authorization: GoogleWebAuthorization;
  beginCount = 0;
  completed: Parameters<AccountGoogleProvider['completeWeb']>[0][] = [];
  nativeVerifyCount = 0;

  constructor(authorization?: GoogleWebAuthorization) {
    const state = 'state-0123456789abcdef';
    const nonce = 'nonce-0123456789abcdef';
    const codeVerifier = 'v'.repeat(43);
    const callbackUrl = new URL('/api/v1/auth/google/callback', appOrigin).href;
    const query = new URLSearchParams({
      response_type: 'code',
      state,
      nonce,
      redirect_uri: callbackUrl,
      code_challenge: 'challenge',
      code_challenge_method: 'S256',
      scope: 'openid email profile',
    });
    this.authorization = authorization ?? {
      authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?${query.toString()}`,
      state,
      nonce,
      codeVerifier,
    };
  }

  async beginWeb(): Promise<GoogleWebAuthorization> {
    this.beginCount += 1;
    return this.authorization;
  }

  async completeWeb(input: Parameters<AccountGoogleProvider['completeWeb']>[0]): Promise<VerifiedGoogleIdentity> {
    this.completed.push(input);
    return googleIdentity('web-user');
  }

  async verifyNativeIdToken(idToken: string): Promise<VerifiedGoogleIdentity> {
    this.nativeVerifyCount += 1;
    assert.equal(idToken, 'synthetic-local-id-token');
    return googleIdentity('native-admin');
  }
}

function googleIdentity(subject: string): VerifiedGoogleIdentity {
  return {
    issuer: 'https://accounts.google.com',
    subject,
    displayName: `Test ${subject}`,
    email: `${subject}@example.test`,
    emailVerified: true,
  };
}

function jsonRequest(
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  },
): Request {
  return new Request(`${appOrigin}${path}`, {
    method: options.method ?? 'POST',
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    body: JSON.stringify(options.body ?? {}),
  });
}

function cookieValue(header: string, name: string): string | null {
  const match = new RegExp(`(?:^|,\\s*)${name}=([^;,]+)`, 'u').exec(header);
  return match?.[1] ?? null;
}

function tokenSequence(): () => string {
  let next = 1;
  return () => `${String(next++).padStart(2, '0')}${'R'.repeat(41)}`;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
