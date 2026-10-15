import type {
  AccountAdminUpdateResult,
  AccountDatasetMode,
  AccountRole,
  AccountStore,
  StoredAccount,
  VerifiedGoogleIdentity,
} from '../../../db/src/accounts.js';
import type {
  AccountApiHandler,
  AccountApiOptions,
  AccountCookieMode,
  AccountGoogleProvider,
  GoogleWebAuthorization,
} from './types.js';

const accountPrefix = '/api/v1/account';
const authPrefix = '/api/v1/auth';
const knownReturnHashes = new Set(['#akun', '#mulai', '#admin', '#tinjau-bukti']);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const opaqueTokenPattern = /^[A-Za-z0-9_-]{43,128}$/u;
const safeIdentityIssuer = 'https://accounts.google.com';
const loginThrottleWindowMs = 10 * 60_000;
const maxWebLoginRequests = 12;
const maxNativeLoginRequests = 12;
const sessionIdleMs = 30 * 60_000;
const sessionAbsoluteMs = 8 * 60 * 60_000;
const oauthAttemptMs = 5 * 60_000;
const genericMessages: Record<string, string> = {
  INVALID_REQUEST: 'The account request is invalid.',
  UNAUTHORIZED: 'Sign in is required for this account action.',
  FORBIDDEN: 'This account cannot perform that action.',
  CONFLICT: 'The account changed before this request completed.',
  NOT_FOUND: 'The account was not found.',
  TOO_MANY_REQUESTS: 'Too many sign-in attempts. Try again later.',
  TEMPORARILY_UNAVAILABLE: 'Account sign-in is temporarily unavailable.',
  NOT_ALLOWED: 'This account route is not available.',
};

interface AuthenticatedRequest {
  readonly tokenSha256: string;
  readonly source: 'cookie' | 'bearer';
  readonly session: NonNullable<Awaited<ReturnType<AccountStore['readSession']>>>;
}

/** Creates the closed account-v1 HTTP surface. Unknown account/auth paths are closed with 404. */
export function createAccountApi(options: AccountApiOptions): AccountApiHandler {
  const datasetMode = options.datasetMode;
  const store = options.store;
  const google = options.google;
  const enabled = options.enabled === true;
  const webLoginAvailable = enabled && options.webLoginAvailable === true && google !== undefined;
  const nativeLoginAvailable = enabled && options.nativeLoginAvailable === true && google !== undefined;
  const now = options.now ?? Date.now;
  const randomToken = options.randomToken ?? secureRandomToken;
  const trustedClientKey = options.trustedClientKey ?? (() => 'unavailable-client-key');
  const cookieMode = options.cookieMode ?? 'host';
  const appOrigin = enabled ? requireTrustedOrigin(options.appOrigin, datasetMode, cookieMode) : undefined;
  const loopbackAuthorizationOrigin = options.loopbackAuthorizationOrigin === undefined
    ? undefined
    : requireLoopbackAuthorizationOrigin(options.loopbackAuthorizationOrigin, datasetMode, cookieMode);

  if (enabled && (!store || !google || !isDatasetMode(datasetMode))) {
    throw new TypeError('Enabled account API requires a configured store, provider, and dataset.');
  }
  if (enabled && store?.datasetMode !== datasetMode) {
    throw new TypeError('Account repository and API dataset scopes must match.');
  }

  return async (request) => {
    const url = new URL(request.url);
    const inAccountSurface = isAccountSurface(url.pathname);
    if (!inAccountSurface) return undefined;

    const route = routeFor(url.pathname, request.method);
    if (route.kind === 'unknown') return jsonResponse(apiError('NOT_FOUND'), 404);
    if (route.kind === 'method') return jsonResponse(apiError('NOT_ALLOWED'), 405);
    if (!enabled || !store || !google || !appOrigin || !isDatasetMode(datasetMode)) {
      if (route.kind === 'session') return jsonResponse(sessionEnvelope(null, null, false, false), 200);
      return jsonResponse(apiError('TEMPORARILY_UNAVAILABLE'), 503);
    }

    try {
      switch (route.kind) {
        case 'session':
          return await handleSession(request, store, {
            webLoginAvailable,
            nativeLoginAvailable,
            now,
            cookieNames: cookieNames(cookieMode),
          });
        case 'web_start':
          if (!webLoginAvailable) return jsonResponse(apiError('TEMPORARILY_UNAVAILABLE'), 503);
          return await handleWebStart(request, store, google, {
            appOrigin,
            cookieMode,
            cookieNames: cookieNames(cookieMode),
            loopbackAuthorizationOrigin,
            now,
            randomToken,
            trustedClientKey,
          });
        case 'web_callback':
          if (!webLoginAvailable) return callbackFailure(appOrigin, cookieMode, cookieNames(cookieMode));
          return await handleWebCallback(request, store, google, {
            appOrigin,
            cookieMode,
            cookieNames: cookieNames(cookieMode),
            datasetMode,
            now,
            randomToken,
            trustedClientKey,
          });
        case 'native_exchange':
          if (!nativeLoginAvailable) return jsonResponse(apiError('TEMPORARILY_UNAVAILABLE'), 503);
          return await handleNativeExchange(request, store, google, {
            datasetMode,
            now,
            randomToken,
            trustedClientKey,
            webLoginAvailable,
            nativeLoginAvailable,
          });
        case 'logout':
          return await handleLogout(request, store, {
            appOrigin,
            cookieMode,
            cookieNames: cookieNames(cookieMode),
            now,
          });
        case 'onboarding':
          return await handleOnboarding(request, store, {
            appOrigin,
            webLoginAvailable,
            nativeLoginAvailable,
            cookieMode,
            cookieNames: cookieNames(cookieMode),
            now,
          });
        case 'users_list':
          return await handleUsersList(request, store, {
            cookieMode,
            cookieNames: cookieNames(cookieMode),
            now,
          });
        case 'user_update':
          return await handleUserUpdate(request, store, {
            appOrigin,
            cookieMode,
            cookieNames: cookieNames(cookieMode),
            now,
          }, route.accountId);
      }
    } catch {
      // Provider/SQL exceptions may contain authorization codes, tokens, identity claims, or SQL.
      if (route.kind === 'web_callback') {
        return callbackFailure(appOrigin, cookieMode, cookieNames(cookieMode));
      }
      return jsonResponse(apiError('TEMPORARILY_UNAVAILABLE'), 503);
    }
  };
}

interface AccountApiContext {
  readonly appOrigin?: string;
  readonly datasetMode?: AccountDatasetMode;
  readonly cookieMode: AccountCookieMode;
  readonly cookieNames: { readonly session: string; readonly attempt: string };
  readonly now: () => number;
  readonly randomToken?: () => string;
  readonly trustedClientKey?: (request: Request) => string;
  readonly webLoginAvailable?: boolean;
  readonly nativeLoginAvailable?: boolean;
  readonly loopbackAuthorizationOrigin?: string;
}

function routeFor(
  pathname: string,
  method: string,
):
  | { readonly kind: 'session' }
  | { readonly kind: 'web_start' }
  | { readonly kind: 'web_callback' }
  | { readonly kind: 'native_exchange' }
  | { readonly kind: 'logout' }
  | { readonly kind: 'onboarding' }
  | { readonly kind: 'users_list' }
  | { readonly kind: 'user_update'; readonly accountId: string }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'method' } {
  const routes: Record<string, { path: string; method: string }> = {
    session: { path: `${authPrefix}/session`, method: 'GET' },
    web_start: { path: `${authPrefix}/google/start`, method: 'POST' },
    web_callback: { path: `${authPrefix}/google/callback`, method: 'GET' },
    native_exchange: { path: `${authPrefix}/google/native`, method: 'POST' },
    logout: { path: `${authPrefix}/logout`, method: 'POST' },
    onboarding: { path: `${accountPrefix}/onboarding`, method: 'POST' },
    users_list: { path: `${accountPrefix}/users`, method: 'GET' },
  };
  for (const [name, value] of Object.entries(routes)) {
    if (pathname === value.path) {
      return method === value.method
        ? { kind: name as 'session' | 'web_start' | 'web_callback' | 'native_exchange' | 'logout' | 'onboarding' | 'users_list' }
        : { kind: 'method' };
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

async function handleSession(
  request: Request,
  store: AccountStore,
  context: Pick<AccountApiContext, 'webLoginAvailable' | 'nativeLoginAvailable' | 'now' | 'cookieNames'>,
): Promise<Response> {
  const auth = await authenticate(request, store, context.now, context.cookieNames);
  const isAvailable = auth !== null;
  return jsonResponse(sessionEnvelope(
    auth?.session.account ?? null,
    isAvailable && auth.session.channel === 'web' ? auth.session.csrfToken : null,
    context.webLoginAvailable === true,
    context.nativeLoginAvailable === true,
  ), 200);
}

async function handleWebStart(
  request: Request,
  store: AccountStore,
  google: AccountGoogleProvider,
  context: Required<Pick<AccountApiContext,
    'appOrigin' | 'cookieMode' | 'cookieNames' | 'now' | 'randomToken' | 'trustedClientKey'>>
    & Pick<AccountApiContext, 'loopbackAuthorizationOrigin'>,
): Promise<Response> {
  if (!context.appOrigin) return jsonResponse(apiError('TEMPORARILY_UNAVAILABLE'), 503);
  if (!isExactOrigin(request, context.appOrigin) || request.headers.get('x-waspada-request') !== '1') {
    return jsonResponse(apiError('FORBIDDEN'), 403);
  }
  const body = await readJson(request, 4_096);
  if (!isPlainRecord(body) || !hasExactKeys(body, ['return_to'])
    || typeof body.return_to !== 'string' || !knownReturnHashes.has(body.return_to)) {
    return jsonResponse(apiError('INVALID_REQUEST'), 400);
  }
  const clock = readClock(context.now);
  if (!clock) return jsonResponse(apiError('TEMPORARILY_UNAVAILABLE'), 503);
  await store.cleanupExpired(new Date(clock).toISOString(), 50);
  if (!await consumeLoginThrottle(store, 'web_start', request, context.trustedClientKey, clock, maxWebLoginRequests)) {
    return jsonResponse(apiError('TOO_MANY_REQUESTS'), 429);
  }

  let priorSessionTokenSha256: string | null = null;
  const priorSessionToken = readCookie(request, context.cookieNames.session);
  if (priorSessionToken && isOpaqueToken(priorSessionToken)) {
    const priorHash = await sha256(priorSessionToken);
    const priorSession = await store.readSession(priorHash, new Date(clock).toISOString());
    if (priorSession?.channel === 'web') priorSessionTokenSha256 = priorHash;
  }

  const authorization = await google.beginWeb();
  if (!isSafeGoogleAuthorization(authorization, context.appOrigin, context.loopbackAuthorizationOrigin)) {
    return jsonResponse(apiError('TEMPORARILY_UNAVAILABLE'), 503);
  }
  const attemptCookie = context.randomToken();
  if (!isOpaqueToken(attemptCookie)) return jsonResponse(apiError('TEMPORARILY_UNAVAILABLE'), 503);
  await store.createLoginAttempt({
    stateSha256: await sha256(authorization.state),
    browserCookieSha256: await sha256(attemptCookie),
    priorSessionTokenSha256,
    codeVerifier: authorization.codeVerifier,
    nonce: authorization.nonce,
    returnTo: body.return_to as '#akun' | '#mulai' | '#admin' | '#tinjau-bukti',
    createdAt: new Date(clock).toISOString(),
    expiresAt: new Date(clock + oauthAttemptMs).toISOString(),
  });
  return new Response(JSON.stringify({ authorization_url: authorization.authorizationUrl }), {
    status: 200,
    headers: jsonHeaders({
      'set-cookie': cookie(context.cookieNames.attempt, attemptCookie, context.cookieMode, 'Lax', 300),
    }),
  });
}

async function handleWebCallback(
  request: Request,
  store: AccountStore,
  google: AccountGoogleProvider,
  context: Required<Pick<AccountApiContext,
    'appOrigin' | 'cookieMode' | 'cookieNames' | 'datasetMode' | 'now' | 'randomToken' | 'trustedClientKey'>>,
): Promise<Response> {
  if (!context.appOrigin || !context.datasetMode) return callbackFailure(context.appOrigin, context.cookieMode, context.cookieNames);
  const clock = readClock(context.now);
  if (!clock) return callbackFailure(context.appOrigin, context.cookieMode, context.cookieNames);
  if (!await consumeLoginThrottle(store, 'web_callback', request, context.trustedClientKey, clock, maxWebLoginRequests)) {
    return callbackFailure(context.appOrigin, context.cookieMode, context.cookieNames);
  }
  const url = new URL(request.url);
  const state = readSingleQuery(url, 'state');
  const attemptCookie = readCookie(request, context.cookieNames.attempt);
  if (!state || state.length < 16 || state.length > 512 || !attemptCookie || !isOpaqueToken(attemptCookie)) {
    return callbackFailure(context.appOrigin, context.cookieMode, context.cookieNames);
  }
  const attempt = await store.claimLoginAttempt(await sha256(state), await sha256(attemptCookie), new Date(clock).toISOString());
  if (!attempt) return callbackFailure(context.appOrigin, context.cookieMode, context.cookieNames);

  const code = readSingleQuery(url, 'code');
  const providerError = readSingleQuery(url, 'error');
  if (providerError !== null || !code || code.length > 4_096) {
    return callbackFailure(context.appOrigin, context.cookieMode, context.cookieNames);
  }
  const callbackUrl = new URL('/api/v1/auth/google/callback', context.appOrigin);
  callbackUrl.searchParams.set('code', code);
  callbackUrl.searchParams.set('state', state);
  const identity = await google.completeWeb({
    callbackUrl,
    codeVerifier: attempt.codeVerifier,
    expectedState: state,
    expectedNonce: attempt.nonce,
  });
  validateVerifiedIdentity(identity);
  const account = await store.findOrCreateVerifiedAccount(identity, new Date(clock).toISOString());
  if (!account.active) return callbackFailure(context.appOrigin, context.cookieMode, context.cookieNames);

  const rawSessionToken = context.randomToken();
  const csrfToken = context.randomToken();
  if (!isOpaqueToken(rawSessionToken) || !isOpaqueToken(csrfToken)) {
    return callbackFailure(context.appOrigin, context.cookieMode, context.cookieNames);
  }
  const sessionNow = new Date(clock).toISOString();
  await store.createSession({
    accountId: account.id,
    tokenSha256: await sha256(rawSessionToken),
    channel: 'web',
    csrfToken,
    createdAt: sessionNow,
    idleExpiresAt: new Date(clock + sessionIdleMs).toISOString(),
    absoluteExpiresAt: new Date(clock + sessionAbsoluteMs).toISOString(),
    ...(attempt.priorSessionTokenSha256
      ? { revokeTokenSha256: attempt.priorSessionTokenSha256 }
      : {}),
  });
  const returnHash = account.onboarding_version === 0 ? '#mulai' : attempt.returnTo;
  return redirectResponse(`${context.appOrigin}/${returnHash}`, 303, [
    cookie(context.cookieNames.session, rawSessionToken, context.cookieMode, 'Strict', 8 * 60 * 60),
    clearCookie(context.cookieNames.attempt, context.cookieMode, 'Lax'),
  ]);
}

async function handleNativeExchange(
  request: Request,
  store: AccountStore,
  google: AccountGoogleProvider,
  context: Required<Pick<AccountApiContext,
    'datasetMode' | 'now' | 'randomToken' | 'trustedClientKey' | 'webLoginAvailable' | 'nativeLoginAvailable'>>,
): Promise<Response> {
  if (request.headers.has('origin') || request.headers.has('cookie')) {
    return jsonResponse(apiError('FORBIDDEN'), 403);
  }
  const body = await readJson(request, 16 * 1024);
  if (!isPlainRecord(body) || !hasExactKeys(body, ['id_token'])
    || typeof body.id_token !== 'string' || body.id_token.length < 20 || body.id_token.length > 12_000) {
    return jsonResponse(apiError('INVALID_REQUEST'), 400);
  }
  const clock = readClock(context.now);
  if (!clock) return jsonResponse(apiError('TEMPORARILY_UNAVAILABLE'), 503);
  await store.cleanupExpired(new Date(clock).toISOString(), 50);
  if (!await consumeLoginThrottle(store, 'native_exchange', request, context.trustedClientKey, clock, maxNativeLoginRequests)) {
    return jsonResponse(apiError('TOO_MANY_REQUESTS'), 429);
  }
  const identity = await google.verifyNativeIdToken(body.id_token);
  validateVerifiedIdentity(identity);
  const account = await store.findOrCreateVerifiedAccount(identity, new Date(clock).toISOString());
  if (!account.active) return jsonResponse(apiError('FORBIDDEN'), 403);
  const rawSessionToken = context.randomToken();
  if (!isOpaqueToken(rawSessionToken)) return jsonResponse(apiError('TEMPORARILY_UNAVAILABLE'), 503);
  const oldBearer = parseBearer(request);
  await store.createSession({
    accountId: account.id,
    tokenSha256: await sha256(rawSessionToken),
    channel: 'mobile',
    csrfToken: null,
    createdAt: new Date(clock).toISOString(),
    idleExpiresAt: new Date(clock + sessionIdleMs).toISOString(),
    absoluteExpiresAt: new Date(clock + sessionAbsoluteMs).toISOString(),
    ...(oldBearer && isOpaqueToken(oldBearer) ? { revokeTokenSha256: await sha256(oldBearer) } : {}),
  });
  return jsonResponse({
    session_token: rawSessionToken,
    session: sessionEnvelope(account, null, context.webLoginAvailable, context.nativeLoginAvailable),
  }, 200);
}

async function handleLogout(
  request: Request,
  store: AccountStore,
  context: Required<Pick<AccountApiContext,
    'appOrigin' | 'cookieMode' | 'cookieNames' | 'now'>>,
): Promise<Response> {
  const auth = await authenticate(request, store, context.now, context.cookieNames);
  if (!auth) return jsonResponse(apiError('UNAUTHORIZED'), 401);
  if (auth.session.channel === 'web') {
    if (auth.source !== 'cookie') return jsonResponse(apiError('UNAUTHORIZED'), 401);
    if (!checkBrowserWrite(request, auth.session.csrfToken, context.appOrigin)) {
      return jsonResponse(apiError('FORBIDDEN'), 403);
    }
  } else if (auth.source !== 'bearer' || request.headers.has('origin') || request.headers.has('cookie')) {
    return jsonResponse(apiError('FORBIDDEN'), 403);
  }
  const clock = readClock(context.now);
  if (clock === null) return jsonResponse(apiError('TEMPORARILY_UNAVAILABLE'), 503);
  await store.revokeSession(auth.tokenSha256, new Date(clock).toISOString());
  const headers = new Headers({
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  if (auth.session.channel === 'web') {
    headers.set('set-cookie', clearCookie(context.cookieNames.session, context.cookieMode, 'Strict'));
  }
  return new Response(null, { status: 204, headers });
}

async function handleOnboarding(
  request: Request,
  store: AccountStore,
  context: Required<Pick<AccountApiContext,
    'appOrigin' | 'webLoginAvailable' | 'nativeLoginAvailable' | 'cookieMode' | 'cookieNames' | 'now'>>,
): Promise<Response> {
  const auth = await authenticate(request, store, context.now, context.cookieNames);
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
  const updated = await store.completeOnboarding(
    auth.session.account.id,
    1,
    new Date(clock).toISOString(),
  );
  if (!updated) return jsonResponse(apiError('FORBIDDEN'), 403);
  return jsonResponse(sessionEnvelope(
    updated,
    auth.session.channel === 'web' ? auth.session.csrfToken : null,
    context.webLoginAvailable,
    context.nativeLoginAvailable,
  ), 200);
}

async function handleUsersList(
  request: Request,
  store: AccountStore,
  context: Pick<AccountApiContext, 'cookieMode' | 'cookieNames' | 'now'>,
): Promise<Response> {
  const auth = await authenticate(request, store, context.now, context.cookieNames);
  if (!auth) return jsonResponse(apiError('UNAUTHORIZED'), 401);
  if (auth.session.channel !== 'web' || auth.source !== 'cookie'
    || !isCompletedAdmin(auth.session.account)) {
    return jsonResponse(apiError('FORBIDDEN'), 403);
  }
  const query = readAccountPageQuery(new URL(request.url).searchParams);
  if (!query) return jsonResponse(apiError('INVALID_REQUEST'), 400);
  const page = await store.listAccounts(query.limit, query.after, auth.session.account.id);
  if (page.outcome === 'forbidden') return jsonResponse(apiError('FORBIDDEN'), 403);
  return jsonResponse({
    data: page.page.data.map(toAccountUser),
    next_cursor: page.page.nextCursor,
  }, 200);
}

async function handleUserUpdate(
  request: Request,
  store: AccountStore,
  context: Required<Pick<AccountApiContext,
    'appOrigin' | 'cookieMode' | 'cookieNames' | 'now'>>,
  targetAccountId: string,
): Promise<Response> {
  const auth = await authenticate(request, store, context.now, context.cookieNames);
  if (!auth) return jsonResponse(apiError('UNAUTHORIZED'), 401);
  if (auth.session.channel !== 'web' || auth.source !== 'cookie'
    || !isCompletedAdmin(auth.session.account)) {
    return jsonResponse(apiError('FORBIDDEN'), 403);
  }
  if (!checkBrowserWrite(request, auth.session.csrfToken, context.appOrigin)) {
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
  const result = await store.updateAccountByAdmin({
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

async function authenticate(
  request: Request,
  store: AccountStore,
  now: () => number,
  names: { readonly session: string; readonly attempt: string },
): Promise<AuthenticatedRequest | null> {
  const bearer = parseBearer(request);
  let rawToken: string | null = null;
  let source: 'cookie' | 'bearer' = 'cookie';
  if (bearer !== null) {
    if (!isOpaqueToken(bearer)) return null;
    rawToken = bearer;
    source = 'bearer';
  } else {
    const cookieToken = readCookie(request, names.session);
    if (!cookieToken || !isOpaqueToken(cookieToken)) return null;
    rawToken = cookieToken;
  }
  const clock = readClock(now);
  if (clock === null) throw new Error('Clock is unavailable.');
  const tokenSha256 = await sha256(rawToken);
  const session = await store.readSession(tokenSha256, new Date(clock).toISOString());
  return session ? { tokenSha256, source, session } : null;
}

async function consumeLoginThrottle(
  store: AccountStore,
  scope: 'web_start' | 'web_callback' | 'native_exchange',
  request: Request,
  getTrustedClientKey: (request: Request) => string,
  now: number,
  maximum: number,
): Promise<boolean> {
  let trustedKey = 'unavailable-client-key';
  try {
    const candidate = getTrustedClientKey(request);
    if (typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 512) {
      trustedKey = candidate;
    }
  } catch {
    // All requests share the fallback bucket if the trusted adapter is unavailable.
  }
  return store.consumeThrottle(
    scope,
    await sha256(trustedKey),
    new Date(now).toISOString(),
    loginThrottleWindowMs,
    maximum,
  );
}

function authorizedWriteChannel(
  request: Request,
  auth: AuthenticatedRequest,
  appOrigin: string | undefined,
): boolean {
  if (auth.session.channel === 'web') {
    return auth.source === 'cookie' && checkBrowserWrite(request, auth.session.csrfToken, appOrigin);
  }
  return auth.source === 'bearer' && !request.headers.has('origin') && !request.headers.has('cookie');
}

function checkBrowserWrite(request: Request, csrfToken: string | null, appOrigin: string | undefined): boolean {
  return csrfToken !== null
    && appOrigin !== undefined
    && isExactOrigin(request, appOrigin)
    && request.headers.get('x-waspada-csrf') !== null
    && constantTimeTextEqual(request.headers.get('x-waspada-csrf') ?? '', csrfToken);
}

function isExactOrigin(request: Request, appOrigin: string): boolean {
  return request.headers.get('origin') === appOrigin;
}

function isSafeGoogleAuthorization(
  value: GoogleWebAuthorization,
  appOrigin: string,
  loopbackAuthorizationOrigin: string | undefined,
): boolean {
  if (typeof value.authorizationUrl !== 'string'
    || typeof value.state !== 'string'
    || typeof value.nonce !== 'string'
    || typeof value.codeVerifier !== 'string'
    || value.state.length < 16 || value.state.length > 512
    || value.nonce.length < 16 || value.nonce.length > 256
    || value.codeVerifier.length < 43 || value.codeVerifier.length > 128
    || !/^[A-Za-z0-9._~-]+$/u.test(value.codeVerifier)) return false;
  try {
    const url = new URL(value.authorizationUrl);
    const callback = new URL('/api/v1/auth/google/callback', appOrigin).href;
    const safeUrl = url.username === '' && url.password === '' && url.hash === '';
    const loopbackAuthorization = loopbackAuthorizationOrigin !== undefined
      && url.origin === loopbackAuthorizationOrigin
      && url.protocol === 'http:'
      && url.pathname === '/api/v1/auth/demo/consent'
      && [...url.searchParams.keys()].length === 1
      && readSingleQuery(url, 'state') === value.state;
    if (loopbackAuthorization) return safeUrl;
    const googleAuthorizationOrigin = url.protocol === 'https:' && url.hostname === 'accounts.google.com'
      && url.pathname === '/o/oauth2/v2/auth';
    return safeUrl && googleAuthorizationOrigin
      && readSingleQuery(url, 'response_type') === 'code'
      && readSingleQuery(url, 'state') === value.state
      && readSingleQuery(url, 'nonce') === value.nonce
      && readSingleQuery(url, 'redirect_uri') === callback
      && readSingleQuery(url, 'code_challenge_method') === 'S256'
      && Boolean(readSingleQuery(url, 'code_challenge'))
      && (readSingleQuery(url, 'scope') ?? '').split(' ').includes('openid');
  } catch {
    return false;
  }
}

function validateVerifiedIdentity(identity: VerifiedGoogleIdentity): void {
  if (identity.issuer !== safeIdentityIssuer
    || identity.emailVerified !== true
    || typeof identity.subject !== 'string'
    || identity.subject.length < 1 || identity.subject.length > 255
    || /[\u0000-\u001f\u007f]/u.test(identity.subject)
    || typeof identity.email !== 'string'
    || identity.email.length < 3 || identity.email.length > 320
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(identity.email)
    || typeof identity.displayName !== 'string'
    || identity.displayName.trim().length < 1 || identity.displayName.length > 200
    || /[\u0000-\u001f\u007f]/u.test(identity.displayName)) {
    throw new Error('Google identity claims are not acceptable.');
  }
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
  webLoginAvailable: boolean,
  nativeLoginAvailable: boolean,
) {
  return {
    version: 'account-v1' as const,
    status: account === null ? 'anonymous' as const : 'authenticated' as const,
    google_login_available: webLoginAvailable,
    native_login_available: nativeLoginAvailable,
    csrf_token: account === null ? null : csrfToken,
    user: account === null ? null : toAccountUser(account),
  };
}

function apiError(code: string) {
  return { code, message: genericMessages[code] ?? 'The account request could not be completed.', request_id: randomRequestId() };
}

function jsonResponse(body: unknown, status: number, extraHeaders?: HeadersInit): Response {
  const headers = jsonHeaders(extraHeaders);
  return new Response(JSON.stringify(body), { status, headers });
}

export function accountUnavailableResponse(): Response {
  return jsonResponse(apiError('TEMPORARILY_UNAVAILABLE'), 503);
}

function jsonHeaders(extraHeaders?: HeadersInit): Headers {
  const headers = new Headers(extraHeaders);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  headers.set('pragma', 'no-cache');
  headers.set('x-content-type-options', 'nosniff');
  return headers;
}

function redirectResponse(location: string, status: number, cookies: readonly string[]): Response {
  const headers = new Headers({
    location,
    'cache-control': 'no-store',
    pragma: 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  for (const value of cookies) headers.append('set-cookie', value);
  return new Response(null, { status, headers });
}

function callbackFailure(
  appOrigin: string | undefined,
  mode: AccountCookieMode,
  names: { readonly session: string; readonly attempt: string },
): Response {
  if (!appOrigin) return jsonResponse(apiError('TEMPORARILY_UNAVAILABLE'), 503);
  return redirectResponse(`${appOrigin}/#masuk?login=failed`, 303, [clearCookie(names.attempt, mode, 'Lax')]);
}

function cookieNames(mode: AccountCookieMode): { session: string; attempt: string } {
  return mode === 'host'
    ? { session: '__Host-waspada_session', attempt: '__Host-waspada_oauth_attempt' }
    : { session: 'waspada_session_dev', attempt: 'waspada_oauth_attempt_dev' };
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

function readSingleQuery(url: URL, key: string): string | null {
  const values = url.searchParams.getAll(key);
  return values.length === 1 ? values[0] ?? null : values.length === 0 ? null : '';
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
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
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

function requireTrustedOrigin(
  value: string | undefined,
  datasetMode: AccountDatasetMode | undefined,
  cookieMode: AccountCookieMode,
): string {
  if (!value || value.length > 512) throw new TypeError('Trusted account origin is missing.');
  const origin = new URL(value);
  if (origin.origin !== value || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new TypeError('Trusted account origin must be an exact origin.');
  }
  if (cookieMode === 'host' && origin.protocol !== 'https:') {
    throw new TypeError('Host-only account cookies require HTTPS.');
  }
  if (cookieMode === 'loopback'
    && (datasetMode !== 'demo' || !isLoopbackHostname(origin.hostname))) {
    throw new TypeError('Development account cookies are restricted to loopback demo mode.');
  }
  return origin.origin;
}

function requireLoopbackAuthorizationOrigin(
  value: string,
  datasetMode: AccountDatasetMode | undefined,
  cookieMode: AccountCookieMode,
): string {
  if (cookieMode !== 'loopback' || datasetMode !== 'demo' || value.length > 512) {
    throw new TypeError('Synthetic Google authorization is restricted to the loopback demo harness.');
  }
  const origin = new URL(value);
  if (origin.origin !== value || origin.username || origin.password
    || origin.pathname !== '/' || origin.search || origin.hash
    || origin.protocol !== 'http:'
    || origin.port !== '5173'
    || (origin.hostname !== 'localhost' && origin.hostname !== '127.0.0.1')) {
    throw new TypeError('Synthetic Google authorization origin must be loopback.');
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
