import { createAccountStore, type AccountDatasetMode } from '../../../db/src/accounts.js';
import {
  withPostgresTransactionalSqlExecutor,
} from '../../../db/src/postgres-sql-executor.js';
import type { TransactionalSqlExecutor } from '../../../db/src/sql.js';
import { isValidHyperdriveConnectionString } from './public-event-list-runtime.js';
import { accountUnavailableResponse, createAccountApi } from '../accounts/api.js';
import { createGoogleAccountProvider } from '../accounts/google-provider.js';
import type {
  AccountApiHandler,
  AccountGoogleProvider,
  AccountRuntimeDependencies,
  AccountWorkerEnvironment,
} from '../accounts/types.js';

const disabledHandler = createAccountApi({ enabled: false });
const runtimeCache = new WeakMap<object, Promise<AccountApiHandler>>();

export type AccountTransactionalSqlExecutorRunner = <Result>(
  connectionString: string,
  operation: (executor: TransactionalSqlExecutor) => Promise<Result>,
) => Promise<Result>;

/** Returns a lazy, fail-closed request handler. The public Worker routes remain independent. */
export async function createAccountRuntime(
  configuration: AccountWorkerEnvironment,
  dependencies: AccountRuntimeDependencies = {},
): Promise<AccountApiHandler> {
  const datasetMode = parseDatasetMode(configuration.DATASET_MODE);
  const cookieMode = dependencies.cookieMode ?? 'host';
  const explicitlyInjectedLoopbackDemo = datasetMode === 'demo'
    && cookieMode === 'loopback'
    && dependencies.google !== undefined;
  const enabled = configuration.AUTH_ENABLED === 'true'
    && datasetMode !== undefined
    && isValidHyperdriveConnectionString(configuration.AUTH_HYPERDRIVE?.connectionString)
    && isTrustedOrigin(configuration.AUTH_APP_ORIGIN, cookieMode, datasetMode)
    && hasGoogleConfiguration(configuration, dependencies.google, explicitlyInjectedLoopbackDemo);

  if (!enabled || !datasetMode || !configuration.AUTH_HYPERDRIVE?.connectionString
    || !configuration.AUTH_APP_ORIGIN) {
    return disabledHandler;
  }

  const appOrigin = configuration.AUTH_APP_ORIGIN;
  const connectionString = configuration.AUTH_HYPERDRIVE.connectionString;
  const google = dependencies.google ?? createLazyGoogleProvider(
    configuration,
    appOrigin,
    dependencies.googleProviderFactory ?? createGoogleAccountProvider,
  );
  const withExecutor: AccountTransactionalSqlExecutorRunner = dependencies.withTransactionalSqlExecutor
    ?? withPostgresTransactionalSqlExecutor;
  const apiOptions = {
    enabled: true,
    google,
    appOrigin,
    datasetMode,
    webLoginAvailable: true,
    nativeLoginAvailable: true,
    cookieMode,
    now: dependencies.now,
    trustedClientKey: dependencies.trustedClientKey ?? trustedCloudflareClientKey,
    ...(dependencies.randomToken ? { randomToken: dependencies.randomToken } : {}),
    ...(dependencies.loopbackAuthorizationOrigin
      ? { loopbackAuthorizationOrigin: dependencies.loopbackAuthorizationOrigin }
      : {}),
  };

  return async (request) => {
    if (!isAccountRequest(request)) return undefined;
    try {
      return await withExecutor(connectionString, async (executor) => {
        const store = createAccountStore(executor, datasetMode);
        return createAccountApi({ ...apiOptions, store })(request);
      });
    } catch {
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

function createLazyGoogleProvider(
  configuration: AccountWorkerEnvironment,
  appOrigin: string,
  providerFactory: typeof createGoogleAccountProvider,
): AccountGoogleProvider {
  let provider: Promise<AccountGoogleProvider> | undefined;
  const getProvider = (): Promise<AccountGoogleProvider> => {
    if (!provider) {
      const webClientId = configuration.AUTH_GOOGLE_CLIENT_ID;
      const webClientSecret = configuration.AUTH_GOOGLE_CLIENT_SECRET;
      const nativeAudience = configuration.AUTH_GOOGLE_NATIVE_CLIENT_ID || webClientId;
      if (!webClientId || !webClientSecret || !nativeAudience) {
        throw new Error('Google account provider configuration is incomplete.');
      }
      const initialization = providerFactory({
        webClientId,
        webClientSecret,
        nativeAudience,
        callbackUrl: new URL('/api/v1/auth/google/callback', appOrigin).href,
        ...(configuration.AUTH_GOOGLE_ANDROID_CLIENT_ID
          ? { nativeAuthorizedParties: [configuration.AUTH_GOOGLE_ANDROID_CLIENT_ID] }
          : {}),
      });
      provider = initialization;
      void initialization.catch(() => {
        if (provider === initialization) provider = undefined;
      });
    }
    return provider;
  };
  return {
    async beginWeb() {
      return (await getProvider()).beginWeb();
    },
    async completeWeb(input) {
      return (await getProvider()).completeWeb(input);
    },
    async verifyNativeIdToken(idToken) {
      return (await getProvider()).verifyNativeIdToken(idToken);
    },
  };
}

function parseDatasetMode(value: string | undefined): AccountDatasetMode | undefined {
  return value === 'live' || value === 'demo' ? value : undefined;
}

function isTrustedOrigin(
  value: string | undefined,
  cookieMode: 'host' | 'loopback',
  datasetMode: AccountDatasetMode | undefined,
): boolean {
  if (!value || value.length > 512) return false;
  try {
    const origin = new URL(value);
    const exactOrigin = origin.origin === value
      && !origin.username && !origin.password
      && origin.pathname === '/' && !origin.search && !origin.hash;
    if (!exactOrigin) return false;
    if (cookieMode === 'host') return origin.protocol === 'https:';
    return datasetMode === 'demo'
      && (origin.protocol === 'http:' || origin.protocol === 'https:')
      && isLoopback(origin.hostname);
  } catch {
    return false;
  }
}

function hasGoogleConfiguration(
  environment: AccountWorkerEnvironment,
  injectedProvider: AccountGoogleProvider | undefined,
  injectedLoopbackDemo: boolean,
): boolean {
  if (injectedLoopbackDemo) return true;
  if (injectedProvider !== undefined) return true;
  return isGoogleClientId(environment.AUTH_GOOGLE_CLIENT_ID)
    && isGoogleClientId(environment.AUTH_GOOGLE_NATIVE_CLIENT_ID || environment.AUTH_GOOGLE_CLIENT_ID)
    && (environment.AUTH_GOOGLE_ANDROID_CLIENT_ID === undefined
      || isGoogleClientId(environment.AUTH_GOOGLE_ANDROID_CLIENT_ID))
    && typeof environment.AUTH_GOOGLE_CLIENT_SECRET === 'string'
    && environment.AUTH_GOOGLE_CLIENT_SECRET.length > 0
    && environment.AUTH_GOOGLE_CLIENT_SECRET.length <= 4_096;
}

function isGoogleClientId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 8
    && value.length <= 512
    && /^[A-Za-z0-9._:-]+$/u.test(value);
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
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
