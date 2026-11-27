import { createAccountStore, type AccountDatasetMode, type AccountStore } from '../../../db/src/accounts.js';
import { withPostgresTransactionalSqlExecutor } from '../../../db/src/postgres-sql-executor.js';
import type { TransactionalSqlExecutor } from '../../../db/src/sql.js';
import { isValidHyperdriveConnectionString } from './public-event-list-runtime.js';
import {
  accountCookieMode,
  accountUnavailableResponse,
  createAccountApi,
} from '../accounts/api.js';
import type {
  AccountApiHandler,
  AccountCookieMode,
  AccountRuntimeDependencies,
  AccountWorkerEnvironment,
} from '../accounts/types.js';

const disabledHandler = createAccountApi({ enabled: false });
const runtimeCache = new WeakMap<object, Promise<AccountApiHandler>>();

/** Account dataset plus the moderation dataset kind it corresponds to. */
export interface AccountDatasetScope {
  readonly accountDatasetMode: AccountDatasetMode;
  /** Matches the L4 moderation and DB dataset vocabulary (`live` or `synthetic`). */
  readonly datasetKind: 'live' | 'synthetic';
}

export type AccountStoreSource =
  | { readonly kind: 'executor'; readonly executor: TransactionalSqlExecutor }
  | { readonly kind: 'connection'; readonly connectionString: string };

export interface AccountRuntimeConfig {
  readonly datasetMode: AccountDatasetMode;
  readonly datasetKind: 'live' | 'synthetic';
  readonly appOrigin: string;
  readonly cookieMode: AccountCookieMode;
  readonly source: AccountStoreSource;
}

export type AccountTransactionalSqlExecutorRunner = <Result>(
  connectionString: string,
  operation: (executor: TransactionalSqlExecutor) => Promise<Result>,
) => Promise<Result>;

/** `live` maps to the live dataset. `demo` and `synthetic` map to the isolated synthetic dataset. */
export function accountDatasetScope(datasetMode: string | undefined): AccountDatasetScope | null {
  if (datasetMode === 'live') return { accountDatasetMode: 'live', datasetKind: 'live' };
  if (datasetMode === 'demo' || datasetMode === 'synthetic') {
    return { accountDatasetMode: 'demo', datasetKind: 'synthetic' };
  }
  return null;
}

/**
 * Returns the account configuration only when every requirement holds: AUTH_ENABLED, a known
 * dataset, an exact trusted app origin, and a database source. Otherwise the caller fails closed.
 */
export function resolveAccountRuntime(
  environment: AccountWorkerEnvironment,
  cookieModeOverride?: AccountCookieMode,
): AccountRuntimeConfig | null {
  if (environment.AUTH_ENABLED !== 'true') return null;
  const scope = accountDatasetScope(environment.DATASET_MODE);
  const appOrigin = environment.AUTH_APP_ORIGIN;
  if (!scope || !isExactOrigin(appOrigin)) return null;
  const cookieMode = cookieModeOverride ?? accountCookieMode(appOrigin);
  if (cookieMode === null || cookieMode === undefined) return null;
  const source = accountStoreSource(environment);
  if (!source) return null;
  return {
    datasetMode: scope.accountDatasetMode,
    datasetKind: scope.datasetKind,
    appOrigin: appOrigin as string,
    cookieMode,
    source,
  };
}

/** Runs one operation with a dataset-scoped account store on the configured database source. */
export async function withAccountStore<Result>(
  config: AccountRuntimeConfig,
  dependencies: { readonly withTransactionalSqlExecutor?: AccountTransactionalSqlExecutorRunner } = {},
  operation: (store: AccountStore) => Promise<Result>,
): Promise<Result> {
  if (config.source.kind === 'executor') {
    return operation(createAccountStore(config.source.executor, config.datasetMode));
  }
  const runner = dependencies.withTransactionalSqlExecutor ?? withPostgresTransactionalSqlExecutor;
  return runner(config.source.connectionString, (executor) => operation(createAccountStore(executor, config.datasetMode)));
}

/**
 * One request's account store. The database connection opens on the first store call, through the same
 * transactional runner as withAccountStore, and every later call in the request shares it. close() releases
 * it once the response is built. A request that never reads the store, such as an anonymous session read
 * or a request refused by the pre-session marker, never opens a connection.
 */
interface RequestAccountStore {
  readonly store: AccountStore;
  close(): Promise<void>;
}

function openRequestAccountStore(
  config: AccountRuntimeConfig,
  dependencies: { readonly withTransactionalSqlExecutor?: AccountTransactionalSqlExecutorRunner } = {},
): RequestAccountStore {
  if (config.source.kind === 'executor') {
    return { store: createAccountStore(config.source.executor, config.datasetMode), close: async () => {} };
  }
  const runner = dependencies.withTransactionalSqlExecutor ?? withPostgresTransactionalSqlExecutor;
  const connectionString = config.source.connectionString;
  let releaseConnection: () => void = () => {};
  const holdConnection = new Promise<void>((resolve) => {
    releaseConnection = resolve;
  });
  let connection: Promise<void> | undefined;
  let connected: Promise<AccountStore> | undefined;
  const connect = (): Promise<AccountStore> => {
    connected ??= new Promise<AccountStore>((resolveStore, rejectStore) => {
      connection = runner(connectionString, async (executor) => {
        resolveStore(createAccountStore(executor, config.datasetMode));
        // The connection stays open until close(), so the request's store calls keep one client and its transactions.
        await holdConnection;
      });
      connection.catch(rejectStore);
    });
    return connected;
  };
  return {
    store: lazyAccountStore(config.datasetMode, connect),
    close: async () => {
      releaseConnection();
      await connection;
    },
  };
}

/** Delegates every store call to the store that `connect` opens on first use. */
function lazyAccountStore(datasetMode: AccountDatasetMode, connect: () => Promise<AccountStore>): AccountStore {
  return {
    datasetMode,
    createPasswordAccount: (input) => connect().then((store) => store.createPasswordAccount(input)),
    findPasswordCredentialByUsername: (username) => connect().then((store) => store.findPasswordCredentialByUsername(username)),
    findPasswordCredentialByAccountId: (accountId) => connect().then((store) => store.findPasswordCredentialByAccountId(accountId)),
    setPasswordHash: (input) => connect().then((store) => store.setPasswordHash(input)),
    issuePasswordResetCode: (input) => connect().then((store) => store.issuePasswordResetCode(input)),
    consumePasswordResetCode: (input) => connect().then((store) => store.consumePasswordResetCode(input)),
    createSession: (input) => connect().then((store) => store.createSession(input)),
    readSession: (tokenSha256, now) => connect().then((store) => store.readSession(tokenSha256, now)),
    revokeSession: (tokenSha256, now) => connect().then((store) => store.revokeSession(tokenSha256, now)),
    completeOnboarding: (accountId, version, now) => connect().then((store) => store.completeOnboarding(accountId, version, now)),
    listAccounts: (limit, after, actorAccountId) => connect().then((store) => store.listAccounts(limit, after, actorAccountId)),
    updateAccountByAdmin: (input) => connect().then((store) => store.updateAccountByAdmin(input)),
    consumeThrottle: (scope, clientKeySha256, now, windowMilliseconds, maximumRequests) => connect().then((store) => store.consumeThrottle(
      scope,
      clientKeySha256,
      now,
      windowMilliseconds,
      maximumRequests,
    )),
    cleanupExpired: (now, maxRows) => connect().then((store) => store.cleanupExpired(now, maxRows)),
  };
}

/** Returns a lazy, fail-closed request handler. The public Worker routes remain independent. */
export async function createAccountRuntime(
  configuration: AccountWorkerEnvironment,
  dependencies: AccountRuntimeDependencies = {},
): Promise<AccountApiHandler> {
  const config = resolveAccountRuntime(configuration, dependencies.cookieMode);
  if (!config) return disabledHandler;
  const apiOptions = {
    enabled: true,
    appOrigin: config.appOrigin,
    datasetMode: config.datasetMode,
    registrationAvailable: true,
    cookieMode: config.cookieMode,
    now: dependencies.now,
    trustedClientKey: dependencies.trustedClientKey ?? trustedCloudflareClientKey,
    ...(dependencies.randomToken ? { randomToken: dependencies.randomToken } : {}),
  };

  return async (request) => {
    if (!isAccountRequest(request)) return undefined;
    let scope: RequestAccountStore | undefined;
    try {
      scope = openRequestAccountStore(config, dependencies);
      const response = await createAccountApi({ ...apiOptions, store: scope.store })(request);
      await scope.close();
      return response;
    } catch {
      await scope?.close().catch(() => undefined);
      return accountUnavailableResponse();
    }
  };
}

/** Worker-friendly direct handler. It caches production setup by immutable env object. */
export async function handleAccountRequest(
  request: Request,
  environment: AccountWorkerEnvironment,
  dependencies?: AccountRuntimeDependencies,
): Promise<Response | undefined> {
  if (!isAccountRequest(request)) return undefined;
  if (dependencies) return (await createAccountRuntime(environment, dependencies))(request);
  let handler = runtimeCache.get(environment as object);
  if (!handler) {
    handler = createAccountRuntime(environment);
    runtimeCache.set(environment as object, handler);
  }
  return (await handler)(request);
}

function accountStoreSource(environment: AccountWorkerEnvironment): AccountStoreSource | null {
  const executor = environment.SQL_EXECUTOR;
  if (isTransactionalExecutor(executor)) return { kind: 'executor', executor };
  const connectionString = environment.AUTH_HYPERDRIVE?.connectionString;
  if (isValidHyperdriveConnectionString(connectionString)) return { kind: 'connection', connectionString };
  return null;
}

function isTransactionalExecutor(value: unknown): value is TransactionalSqlExecutor {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<TransactionalSqlExecutor>;
  return typeof candidate.query === 'function'
    && typeof candidate.execute === 'function'
    && typeof candidate.transaction === 'function';
}

function isExactOrigin(value: string | undefined): value is string {
  if (!value || value.length > 512) return false;
  try {
    const origin = new URL(value);
    return origin.origin === value && !origin.username && !origin.password
      && origin.pathname === '/' && !origin.search && !origin.hash;
  } catch {
    return false;
  }
}

function trustedCloudflareClientKey(request: Request): string {
  // Cloudflare supplies this edge-managed value. X-Forwarded-For is never consulted.
  return request.headers.get('cf-connecting-ip') ?? 'missing-cloudflare-client-ip';
}

function isAccountRequest(request: Request): boolean {
  const pathname = new URL(request.url).pathname;
  return pathname === '/api/v1/auth' || pathname.startsWith('/api/v1/auth/')
    || pathname === '/api/v1/account' || pathname.startsWith('/api/v1/account/');
}
