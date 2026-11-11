import {
  AccountUsernameTakenError,
  type AccountAdminUpdateResult,
  type AccountDatasetMode,
  type AccountRole,
  type AccountStore,
  type StoredAccount,
  type StoredAccountSession,
} from '../../../db/src/accounts.js';
import { hashPassword, normaliseUsername, validatePasswordPolicy, verifyPassword } from './password.js';
import type { AccountApiHandler, AccountApiOptions, AccountCookieMode } from './types.js';

const accountPrefix = '/api/v1/account';
const authPrefix = '/api/v1/auth';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const opaqueTokenPattern = /^[A-Za-z0-9_-]{43,128}$/u;
const registrationHeader = 'x-waspada-request';
const throttleWindowMs = 10 * 60_000;
const maxRegisterRequests = 6;
const maxLoginRequestsPerClient = 12;
const maxLoginRequestsPerUsername = 12;
const maxPasswordChangeRequests = 6;
const sessionIdleMs = 30 * 60_000;
const sessionAbsoluteMs = 8 * 60 * 60_000;
const genericMessages: Record<string, string> = {
  INVALID_REQUEST: 'The account request is invalid.',
  UNAUTHORIZED: 'Sign in is required for this account action.',
  FORBIDDEN: 'This account cannot perform that action.',
  CONFLICT: 'The account changed before this request completed.',
  NOT_FOUND: 'The account was not found.',
  TOO_MANY_REQUESTS: 'Too many attempts. Try again later.',
  TEMPORARILY_UNAVAILABLE: 'Account sign-in is temporarily unavailable.',
  NOT_ALLOWED: 'This account route is not available.',
  invalid_credentials: 'The username or password is not correct.',
  username_taken: 'That username is already registered.',
  invalid_username: 'Use 3 to 32 lowercase letters, digits, dots or underscores for the username.',
  password_too_short: 'The password must be at least 10 characters.',
  password_too_long: 'The password must be at most 256 characters.',
  invalid_current_password: 'The current password is not correct.',
};

/** Session credential resolved from the browser cookie (web) or an existing bearer (mobile). */
export interface AccountAuthentication {
  readonly tokenSha256: string;
  readonly source: 'cookie' | 'bearer';
  readonly session: StoredAccountSession;
}

interface AccountApiContext {
  readonly appOrigin: string;
  readonly cookieMode: AccountCookieMode;
  readonly store: AccountStore;
  readonly datasetMode: AccountDatasetMode;
  readonly now: () => number;
  readonly randomToken: () => string;
  readonly trustedClientKey: (request: Request) => string;
  readonly registrationAvailable: boolean;
}

type Route =
  | { readonly kind: 'session' }
  | { readonly kind: 'register' }
  | { readonly kind: 'login' }
  | { readonly kind: 'password' }
  | { readonly kind: 'logout' }
  | { readonly kind: 'onboarding' }
  | { readonly kind: 'users_list' }
  | { readonly kind: 'user_update'; readonly accountId: string }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'method' };

/** Creates the closed account-v1 HTTP surface. Unknown account/auth paths are closed with 404. */
export function createAccountApi(options: AccountApiOptions): AccountApiHandler {
  const datasetMode = options.datasetMode;
  const store = options.store;
  const enabled = options.enabled === true;
  const cookieMode = options.cookieMode ?? 'host';
  const registrationAvailable = enabled && options.registrationAvailable !== false;
  const now = options.now ?? Date.now;
  const randomToken = options.randomToken ?? secureRandomToken;
  const trustedClientKey = options.trustedClientKey ?? (() => 'unavailable-client-key');
  const appOrigin = enabled ? requireTrustedOrigin(options.appOrigin, cookieMode) : undefined;

  if (enabled && (!store || !isDatasetMode(datasetMode))) {
    throw new TypeError('Enabled account API requires a configured store and dataset.');
  }
  if (enabled && store?.datasetMode !== datasetMode) {
    throw new TypeError('Account repository and API dataset scopes must match.');
  }

  return async (request) => {
    const url = new URL(request.url);
    if (!isAccountSurface(url.pathname)) return undefined;

    const route = routeFor(url.pathname, request.method);
    if (route.kind === 'unknown') return jsonResponse(apiError('NOT_FOUND'), 404);
    if (route.kind === 'method') return jsonResponse(apiError('NOT_ALLOWED'), 405);
    if (!enabled || !store || !appOrigin || !isDatasetMode(datasetMode)) {
      if (route.kind === 'session') return jsonResponse(sessionEnvelope(null, null, false, false), 200);
      return jsonResponse(apiError('TEMPORARILY_UNAVAILABLE'), 503);
    }

    const context: AccountApiContext = {
      appOrigin,
      cookieMode,
      store,
      datasetMode,
      now,
      randomToken,
      trustedClientKey,
      registrationAvailable,
    };
    try {
      switch (route.kind) {
        case 'session':
          return await handleSession(request, context);
        case 'register':
          return await handleRegister(request, context);
        case 'login':
          return await handleLogin(request, context);
        case 'password':
          return await handlePasswordChange(request, context);
        case 'logout':
          return await handleLogout(request, context);
        case 'onboarding':
          return await handleOnboarding(request, context);
        case 'users_list':
          return await handleUsersList(request, context);
        case 'user_update':
          return await handleUserUpdate(request, context, route.accountId);
      }
    } catch {
      // SQL and hashing errors can contain credentials or table details, so the body stays generic.
      return jsonResponse(apiError('TEMPORARILY_UNAVAILABLE'), 503);
    }
  };
}

/** Cookie mode follows the trusted app origin: HTTPS origins get host-only Secure cookies, loopback HTTP gets dev cookies. */
export function accountCookieMode(appOrigin: string | undefined): AccountCookieMode | null {
  if (!appOrigin) return null;
  try {
    const origin = new URL(appOrigin);
    if (origin.protocol === 'https:') return 'host';
    if (origin.protocol === 'http:' && isLoopbackHostname(origin.hostname)) return 'loopback';
  } catch {
    return null;
  }
  return null;
}

/** The single source of session cookie names. Moderation and account routes both use it. */
export function accountCookieNames(mode: AccountCookieMode): { readonly session: string } {
  return mode === 'host'
    ? { session: '__Host-waspada_session' }
    : { session: 'waspada_session_dev' };
}

/**
 * Resolves the current session from the browser cookie, or from an existing bearer for
 * sessions minted before native login was removed. Returns null for anything not active.
 */
export async function readAccountAuthentication(
  request: Request,
  store: AccountStore,
  now: () => number,
  cookieMode: AccountCookieMode,
): Promise<AccountAuthentication | null> {
  const bearer = parseBearer(request);
  let rawToken: string | null;
  let source: 'cookie' | 'bearer';
  if (bearer !== null) {
    if (!isOpaqueToken(bearer)) return null;
    rawToken = bearer;
    source = 'bearer';
  } else {
    const cookieToken = readCookie(request, accountCookieNames(cookieMode).session);
    if (!cookieToken || !isOpaqueToken(cookieToken)) return null;
    rawToken = cookieToken;
    source = 'cookie';
  }
  const clock = readClock(now);
  if (clock === null) throw new Error('Clock is unavailable.');
  const tokenSha256 = await sha256(rawToken);
  const session = await store.readSession(tokenSha256, new Date(clock).toISOString());
  return session ? { tokenSha256, source, session } : null;
}

/** Exact Origin plus the session CSRF token. Shared with other browser write surfaces. */
export function isAuthorizedBrowserWrite(
  request: Request,
  csrfToken: string | null,
  appOrigin: string | undefined,
): boolean {
  return csrfToken !== null
    && appOrigin !== undefined
    && isExactOrigin(request, appOrigin)
    && request.headers.get('x-csrf-token') !== null
    && constantTimeTextEqual(request.headers.get('x-csrf-token') ?? '', csrfToken);
}

export function accountUnavailableResponse(): Response {
  return jsonResponse(apiError('TEMPORARILY_UNAVAILABLE'), 503);
}

function routeFor(pathname: string, method: string): Route {
  const routes: Record<string, { path: string; method: string; kind: Route['kind'] }> = {
    session: { path: `${authPrefix}/session`, method: 'GET', kind: 'session' },
    register: { path: `${authPrefix}/register`, method: 'POST', kind: 'register' },
    login: { path: `${authPrefix}/login`, method: 'POST', kind: 'login' },
    password: { path: `${authPrefix}/password`, method: 'POST', kind: 'password' },
    logout: { path: `${authPrefix}/logout`, method: 'POST', kind: 'logout' },
    onboarding: { path: `${accountPrefix}/onboarding`, method: 'POST', kind: 'onboarding' },
    users_list: { path: `${accountPrefix}/users`, method: 'GET', kind: 'users_list' },
  };
  for (const value of Object.values(routes)) {
    if (pathname === value.path) {
      return method === value.method ? { kind: value.kind } as Route : { kind: 'method' };
    }
  }
  const match = new RegExp(`^${accountPrefix}/users/([^/]+)$`, 'u').exec(pathname);
  if (match) {
    if (method !== 'PATCH') return { kind: 'method' };
    let accountId: string;
    try {
      accountId = decodeURIComponent(match[1] ?? '');
    } catch {
      return { kind: 'unknown' };
    }
    return uuidPattern.test(accountId) ? { kind: 'user_update', accountId } : { kind: 'unknown' };
  }
  return { kind: 'unknown' };
}

function isAccountSurface(pathname: string): boolean {
  return pathname === authPrefix || pathname.startsWith(`${authPrefix}/`)
    || pathname === accountPrefix || pathname.startsWith(`${accountPrefix}/`);
}

async function handleSession(request: Request, context: AccountApiContext): Promise<Response> {
  const auth = await authenticate(request, context);
  return jsonResponse(sessionEnvelope(
    auth?.session.account ?? null,
    auth !== null && auth.session.channel === 'web' ? auth.session.csrfToken : null,
    true,
    context.registrationAvailable,
  ), 200);
}

async function handleRegister(request: Request, context: AccountApiContext): Promise<Response> {
  if (!hasPreSessionMarker(request, context.appOrigin)) return jsonResponse(apiError('FORBIDDEN'), 403);
  const clock = readClock(context.now);
  if (clock === null) return jsonResponse(apiError('TEMPORARILY_UNAVAILABLE'), 503);
  await context.store.cleanupExpired(new Date(clock).toISOString(), 50);
  if (!context.registrationAvailable) return jsonResponse(apiError('NOT_FOUND'), 404);
  if (!await consumeThrottle(context, 'register', 'self', request, clock, maxRegisterRequests)) {
    return jsonResponse(apiError('TOO_MANY_REQUESTS'), 429);
  }
  // Allow-list reading: only these fields are read. Any other field, including `role`, is ignored.
  const body = await readJson(request, 4_096);
  if (!isPlainRecord(body) || !hasRequiredKeys(body, ['username', 'password'])) {
    return jsonResponse(apiError('INVALID_REQUEST'), 400);
  }
  const username = normaliseUsername(body.username);
  if (!username) return jsonResponse(apiError('invalid_username'), 400);
  const policy = validatePasswordPolicy(body.password);
  if (!policy.ok) return jsonResponse(apiError(policyErrorCode(policy.code)), 400);
  const displayName = readDisplayName(body.display_name, username);
  if (displayName === null) return jsonResponse(apiError('INVALID_REQUEST'), 400);

  const passwordHash = await hashPassword(body.password as string);
  let account: StoredAccount;
  try {
    // Self-registration never takes a role from the request body.
    account = await context.store.createPasswordAccount({
      datasetMode: context.datasetMode,
      username,
      passwordHash,
      displayName,
      role: 'user',
      now: new Date(clock).toISOString(),
    });
  } catch (error) {
    if (error instanceof AccountUsernameTakenError) return jsonResponse(apiError('username_taken'), 409);
    throw error;
  }
  return startWebSession(request, account, context, clock);
}

async function handleLogin(request: Request, context: AccountApiContext): Promise<Response> {
  if (!hasPreSessionMarker(request, context.appOrigin)) return jsonResponse(apiError('FORBIDDEN'), 403);
  const body = await readJson(request, 4_096);
  if (!isPlainRecord(body) || !hasRequiredKeys(body, ['username', 'password'])
    || typeof body.username !== 'string' || body.username.length < 1 || body.username.length > 256
    || typeof body.password !== 'string' || body.password.length < 1 || body.password.length > 1_024) {
    return jsonResponse(apiError('INVALID_REQUEST'), 400);
  }
  const clock = readClock(context.now);
  if (clock === null) return jsonResponse(apiError('TEMPORARILY_UNAVAILABLE'), 503);
  await context.store.cleanupExpired(new Date(clock).toISOString(), 50);

  const normalized = normaliseUsername(body.username);
  // Both throttles are consumed on every attempt, so neither a rotating client nor a rotating
  // username can bypass the other.
  const clientAllowed = await consumeThrottle(context, 'login_client', 'client', request, clock, maxLoginRequestsPerClient);
  const usernameAllowed = await consumeThrottle(
    context,
    'login_username',
    `username:${normalized ?? body.username.trim().toLowerCase().slice(0, 64)}`,
    request,
    clock,
    maxLoginRequestsPerUsername,
  );
  if (!clientAllowed || !usernameAllowed) return jsonResponse(apiError('TOO_MANY_REQUESTS'), 429);

  const credential = normalized ? await context.store.findPasswordCredentialByUsername(normalized) : null;
  // Unknown users verify against a dummy hash so their response time matches a real miss.
  const passwordMatches = await verifyPassword(body.password, credential?.passwordHash ?? await dummyPasswordHash(context));
  if (!credential || !passwordMatches || !credential.account.active) {
    return jsonResponse(apiError('invalid_credentials'), 401);
  }
  return startWebSession(request, credential.account, context, clock);
}

async function handlePasswordChange(request: Request, context: AccountApiContext): Promise<Response> {
  const auth = await authenticate(request, context);
  if (!auth) return jsonResponse(apiError('UNAUTHORIZED'), 401);
  if (auth.session.channel !== 'web' || auth.source !== 'cookie'
    || !isAuthorizedBrowserWrite(request, auth.session.csrfToken, context.appOrigin)) {
    return jsonResponse(apiError('FORBIDDEN'), 403);
  }
  const body = await readJson(request, 4_096);
  if (!isPlainRecord(body) || !hasRequiredKeys(body, ['current_password', 'new_password'])
    || typeof body.current_password !== 'string' || body.current_password.length < 1
    || body.current_password.length > 1_024) {
    return jsonResponse(apiError('INVALID_REQUEST'), 400);
  }
  const policy = validatePasswordPolicy(body.new_password);
  if (!policy.ok) return jsonResponse(apiError(policyErrorCode(policy.code)), 400);
  const clock = readClock(context.now);
  if (clock === null) return jsonResponse(apiError('TEMPORARILY_UNAVAILABLE'), 503);
  const accountId = auth.session.account.id;
  if (!await consumeThrottle(context, 'login_username', `account:${accountId}`, request, clock, maxPasswordChangeRequests)) {
    return jsonResponse(apiError('TOO_MANY_REQUESTS'), 429);
  }
  const credential = await context.store.findPasswordCredentialByAccountId(accountId);
  if (!credential) return jsonResponse(apiError('FORBIDDEN'), 403);
  if (!await verifyPassword(body.current_password, credential.passwordHash)) {
    return jsonResponse(apiError('invalid_current_password'), 403);
  }
  const changed = await context.store.setPasswordHash({
    accountId,
    passwordHash: await hashPassword(body.new_password as string),
    now: new Date(clock).toISOString(),
    keepTokenSha256: auth.tokenSha256,
  });
  if (!changed) return jsonResponse(apiError('CONFLICT'), 409);
  return jsonResponse(sessionEnvelope(auth.session.account, auth.session.csrfToken, true, context.registrationAvailable), 200);
}

async function startWebSession(
  request: Request,
  account: StoredAccount,
  context: AccountApiContext,
  clock: number,
): Promise<Response> {
  if (!account.active) return jsonResponse(apiError('invalid_credentials'), 401);
  const rawSessionToken = context.randomToken();
  const csrfToken = context.randomToken();
  if (!isOpaqueToken(rawSessionToken) || !isOpaqueToken(csrfToken)) {
    return jsonResponse(apiError('TEMPORARILY_UNAVAILABLE'), 503);
  }
  // A session cookie presented at login is rotated out, so a stale or fixated session cannot survive.
  const priorToken = readCookie(request, accountCookieNames(context.cookieMode).session);
  await context.store.createSession({
    accountId: account.id,
    tokenSha256: await sha256(rawSessionToken),
    channel: 'web',
    csrfToken,
    createdAt: new Date(clock).toISOString(),
    idleExpiresAt: new Date(clock + sessionIdleMs).toISOString(),
    absoluteExpiresAt: new Date(clock + sessionAbsoluteMs).toISOString(),
    ...(priorToken && isOpaqueToken(priorToken) ? { revokeTokenSha256: await sha256(priorToken) } : {}),
  });
  return jsonResponse(sessionEnvelope(account, csrfToken, true, context.registrationAvailable), 200, {
    'set-cookie': cookie(accountCookieNames(context.cookieMode).session, rawSessionToken, context.cookieMode, 'Strict', 8 * 60 * 60),
  });
}

async function handleLogout(request: Request, context: AccountApiContext): Promise<Response> {
  const auth = await authenticate(request, context);
  if (!auth) return jsonResponse(apiError('UNAUTHORIZED'), 401);
  if (auth.session.channel === 'web') {
    if (auth.source !== 'cookie') return jsonResponse(apiError('UNAUTHORIZED'), 401);
    if (!isAuthorizedBrowserWrite(request, auth.session.csrfToken, context.appOrigin)) {
      return jsonResponse(apiError('FORBIDDEN'), 403);
    }
  } else if (auth.source !== 'bearer' || request.headers.has('origin') || request.headers.has('cookie')) {
    return jsonResponse(apiError('FORBIDDEN'), 403);
  }
  const clock = readClock(context.now);
  if (clock === null) return jsonResponse(apiError('TEMPORARILY_UNAVAILABLE'), 503);
  await context.store.revokeSession(auth.tokenSha256, new Date(clock).toISOString());
  const headers = new Headers({
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  if (auth.session.channel === 'web') {
    headers.set('set-cookie', clearCookie(accountCookieNames(context.cookieMode).session, context.cookieMode, 'Strict'));
  }
  return new Response(null, { status: 204, headers });
}

async function handleOnboarding(request: Request, context: AccountApiContext): Promise<Response> {
  const auth = await authenticate(request, context);
  if (!auth) return jsonResponse(apiError('UNAUTHORIZED'), 401);
  if (!authorizedWriteChannel(request, auth, context.appOrigin)) {
    return jsonResponse(apiError('FORBIDDEN'), 403);
  }
  const body = await readJson(request, 1_024);
  if (!isPlainRecord(body) || !hasExactKeys(body, ['version']) || body.version !== 1) {
    return jsonResponse(apiError('INVALID_REQUEST'), 400);
  }
  const clock = readClock(context.now);
  if (clock === null) return jsonResponse(apiError('TEMPORARILY_UNAVAILABLE'), 503);
  const updated = await context.store.completeOnboarding(auth.session.account.id, 1, new Date(clock).toISOString());
  if (!updated) return jsonResponse(apiError('FORBIDDEN'), 403);
  return jsonResponse(sessionEnvelope(
    updated,
    auth.session.channel === 'web' ? auth.session.csrfToken : null,
    true,
    context.registrationAvailable,
  ), 200);
}

async function handleUsersList(request: Request, context: AccountApiContext): Promise<Response> {
  const auth = await authenticate(request, context);
  if (!auth) return jsonResponse(apiError('UNAUTHORIZED'), 401);
  if (auth.session.channel !== 'web' || auth.source !== 'cookie'
    || !isCompletedAdmin(auth.session.account)) {
    return jsonResponse(apiError('FORBIDDEN'), 403);
  }
  const query = readAccountPageQuery(new URL(request.url).searchParams);
  if (!query) return jsonResponse(apiError('INVALID_REQUEST'), 400);
  const page = await context.store.listAccounts(query.limit, query.after, auth.session.account.id);
  if (page.outcome === 'forbidden') return jsonResponse(apiError('FORBIDDEN'), 403);
  return jsonResponse({
    data: page.page.data.map(toAccountUser),
    next_cursor: page.page.nextCursor,
  }, 200);
}

async function handleUserUpdate(request: Request, context: AccountApiContext, targetAccountId: string): Promise<Response> {
  const auth = await authenticate(request, context);
  if (!auth) return jsonResponse(apiError('UNAUTHORIZED'), 401);
  if (auth.session.channel !== 'web' || auth.source !== 'cookie'
    || !isCompletedAdmin(auth.session.account)) {
    return jsonResponse(apiError('FORBIDDEN'), 403);
  }
  if (!isAuthorizedBrowserWrite(request, auth.session.csrfToken, context.appOrigin)) {
    return jsonResponse(apiError('FORBIDDEN'), 403);
  }
  const body = await readJson(request, 4_096);
  if (!isPlainRecord(body) || !hasExactKeys(body, ['role', 'active', 'expected_version', 'reason'])
    || !isAccountRole(body.role)
    || typeof body.active !== 'boolean'
    || !Number.isSafeInteger(body.expected_version)
    || (body.expected_version as number) < 1
    || typeof body.reason !== 'string'
    || body.reason.trim().length < 1
    || body.reason.trim().length > 500
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(body.reason)) {
    return jsonResponse(apiError('INVALID_REQUEST'), 400);
  }
  const clock = readClock(context.now);
  if (clock === null) return jsonResponse(apiError('TEMPORARILY_UNAVAILABLE'), 503);
  const result = await context.store.updateAccountByAdmin({
    actorAccountId: auth.session.account.id,
    targetAccountId,
    role: body.role,
    active: body.active,
    expectedVersion: body.expected_version as number,
    reason: body.reason,
    occurredAt: new Date(clock).toISOString(),
  });
  return adminUpdateResponse(result);
}

async function authenticate(request: Request, context: AccountApiContext): Promise<AccountAuthentication | null> {
  return readAccountAuthentication(request, context.store, context.now, context.cookieMode);
}

async function consumeThrottle(
  context: AccountApiContext,
  scope: 'register' | 'login_client' | 'login_username',
  keyKind: string,
  request: Request,
  now: number,
  maximum: number,
): Promise<boolean> {
  let trustedKey = 'unavailable-client-key';
  try {
    const candidate = context.trustedClientKey(request);
    if (typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 512) {
      trustedKey = candidate;
    }
  } catch {
    // All requests share the fallback bucket if the trusted adapter is unavailable.
  }
  // The key kind keeps client and username buckets separate even when their text could match.
  const keySource = scope === 'login_username' ? keyKind : `${keyKind}:${trustedKey}`;
  return context.store.consumeThrottle(
    scope,
    await sha256(keySource),
    new Date(now).toISOString(),
    throttleWindowMs,
    maximum,
  );
}

let dummyHashPromise: Promise<string> | undefined;

/** A real PBKDF2 hash of a random value, computed once per isolate. It is never a valid credential. */
function dummyPasswordHash(context: AccountApiContext): Promise<string> {
  dummyHashPromise ??= hashPassword(context.randomToken());
  return dummyHashPromise;
}

function hasPreSessionMarker(request: Request, appOrigin: string): boolean {
  return isExactOrigin(request, appOrigin) && request.headers.get(registrationHeader) === '1';
}

function policyErrorCode(code: 'password_too_short' | 'password_too_long' | 'password_invalid'): string {
  return code === 'password_invalid' ? 'INVALID_REQUEST' : code;
}

function readDisplayName(value: unknown, fallback: string): string | null {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (name.length < 1 || name.length > 200 || /[\u0000-\u001f\u007f]/u.test(name)) return null;
  return name;
}

function authorizedWriteChannel(request: Request, auth: AccountAuthentication, appOrigin: string): boolean {
  if (auth.session.channel === 'web') {
    return auth.source === 'cookie' && isAuthorizedBrowserWrite(request, auth.session.csrfToken, appOrigin);
  }
  return auth.source === 'bearer' && !request.headers.has('origin') && !request.headers.has('cookie');
}

function isExactOrigin(request: Request, appOrigin: string): boolean {
  return request.headers.get('origin') === appOrigin;
}

function adminUpdateResponse(result: AccountAdminUpdateResult): Response {
  switch (result.outcome) {
    case 'updated': return jsonResponse(toAccountUser(result.account), 200);
    case 'forbidden': return jsonResponse(apiError('FORBIDDEN'), 403);
    case 'not_found': return jsonResponse(apiError('NOT_FOUND'), 404);
    case 'conflict': return jsonResponse(apiError('CONFLICT'), 409);
  }
}

function isCompletedAdmin(account: StoredAccount): boolean {
  return account.active && account.role === 'admin' && account.onboarding_version === 1;
}

function readAccountPageQuery(searchParams: URLSearchParams): { limit: number; after: string | undefined } | null {
  let rawLimit: string | undefined;
  let after: string | undefined;
  const seen = new Set<string>();
  for (const [key, value] of searchParams) {
    if ((key !== 'limit' && key !== 'after') || seen.has(key)) return null;
    seen.add(key);
    if (key === 'limit') rawLimit = value;
    else after = value;
  }
  let limit = 20;
  if (rawLimit !== undefined) {
    if (!/^(?:[1-9]|[1-4][0-9]|50)$/u.test(rawLimit)) return null;
    limit = Number(rawLimit);
  }
  if (after !== undefined && !uuidPattern.test(after)) return null;
  return { limit, after };
}

function toAccountUser(account: StoredAccount) {
  return {
    id: account.id,
    display_name: account.display_name,
    email: account.email,
    role: account.role,
    active: account.active,
    onboarding_version: account.onboarding_version,
    onboarding_completed_at: account.onboarding_completed_at,
    version: account.version,
  };
}

function sessionEnvelope(
  account: StoredAccount | null,
  csrfToken: string | null,
  passwordLoginAvailable: boolean,
  registrationAvailable: boolean,
) {
  return {
    version: 'account-v1' as const,
    status: account === null ? 'anonymous' as const : 'authenticated' as const,
    password_login_available: passwordLoginAvailable,
    registration_available: registrationAvailable,
    csrf_token: account === null ? null : csrfToken,
    user: account === null ? null : toAccountUser(account),
  };
}

function apiError(code: string) {
  return { code, message: genericMessages[code] ?? 'The account request could not be completed.', request_id: randomRequestId() };
}

function jsonResponse(body: unknown, status: number, extraHeaders?: HeadersInit): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders(extraHeaders) });
}

function jsonHeaders(extraHeaders?: HeadersInit): Headers {
  const headers = new Headers(extraHeaders);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  headers.set('pragma', 'no-cache');
  headers.set('x-content-type-options', 'nosniff');
  return headers;
}

function cookie(
  name: string,
  value: string,
  mode: AccountCookieMode,
  sameSite: 'Strict' | 'Lax',
  maxAgeSeconds: number,
): string {
  const secure = mode === 'host' ? '; Secure' : '';
  return `${name}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=${sameSite}${secure}`;
}

function clearCookie(name: string, mode: AccountCookieMode, sameSite: 'Strict' | 'Lax'): string {
  const secure = mode === 'host' ? '; Secure' : '';
  return `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=${sameSite}${secure}`;
}

function readCookie(request: Request, name: string): string | null {
  const raw = request.headers.get('cookie');
  if (!raw || raw.length > 8_192) return null;
  const matches: string[] = [];
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    if (part.slice(0, separator).trim() === name) matches.push(part.slice(separator + 1).trim());
  }
  return matches.length === 1 ? matches[0] ?? null : null;
}

function parseBearer(request: Request): string | null {
  const value = request.headers.get('authorization');
  if (value === null) return null;
  const match = /^Bearer ([A-Za-z0-9_-]{43,128})$/u.exec(value);
  return match?.[1] ?? '';
}

async function readJson(request: Request, maximumBytes: number): Promise<unknown | null> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') return null;
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maximumBytes)) {
    return null;
  }
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  try {
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function hasRequiredKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  return required.every((key) => Object.hasOwn(value, key));
}

function isAccountRole(value: unknown): value is AccountRole {
  return value === 'user' || value === 'moderator' || value === 'admin';
}

function isDatasetMode(value: unknown): value is AccountDatasetMode {
  return value === 'live' || value === 'demo';
}

function isOpaqueToken(value: string): boolean {
  return opaqueTokenPattern.test(value);
}

function requireTrustedOrigin(value: string | undefined, cookieMode: AccountCookieMode): string {
  if (!value || value.length > 512) throw new TypeError('Trusted account origin is missing.');
  const origin = new URL(value);
  if (origin.origin !== value || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new TypeError('Trusted account origin must be an exact origin.');
  }
  if (cookieMode === 'host' && origin.protocol !== 'https:') {
    throw new TypeError('Host-only account cookies require HTTPS.');
  }
  if (cookieMode === 'loopback' && (origin.protocol !== 'http:' && origin.protocol !== 'https:' || !isLoopbackHostname(origin.hostname))) {
    throw new TypeError('Development account cookies are restricted to loopback origins.');
  }
  return origin.origin;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function readClock(clock: () => number): number | null {
  try {
    const value = clock();
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function constantTimeTextEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function secureRandomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '');
}

function randomRequestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return 'unavailable';
  }
}
