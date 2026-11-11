import type { AccountChannel, AccountDatasetMode, AccountStore } from '../../../db/src/accounts.js';

export type {
  AccountChannel,
  AccountDatasetMode,
  AccountRole,
  AccountStore,
  AccountThrottleScope,
  CreatePasswordAccountInput,
  StoredAccount,
  StoredPasswordCredential,
} from '../../../db/src/accounts.js';

export type AccountCookieMode = 'host' | 'loopback';

export type AccountApiHandler = (request: Request) => Promise<Response | undefined>;

export interface AccountApiOptions {
  readonly enabled: boolean;
  readonly store?: AccountStore;
  readonly appOrigin?: string;
  readonly datasetMode?: AccountDatasetMode;
  readonly registrationAvailable?: boolean;
  readonly cookieMode?: AccountCookieMode;
  readonly now?: () => number;
  /** Must be supplied by a trusted edge/socket adapter; forwarded client headers are not consulted. */
  readonly trustedClientKey?: (request: Request) => string;
  /** Test seam for session and CSRF secrets. Production uses cryptographic randomness. */
  readonly randomToken?: () => string;
}

export interface AccountWorkerEnvironment {
  readonly DATASET_MODE?: string;
  readonly AUTH_ENABLED?: string;
  readonly AUTH_APP_ORIGIN?: string;
  readonly AUTH_HYPERDRIVE?: { readonly connectionString?: string };
  /** Local composition only: a transaction-capable executor replaces the Hyperdrive connection. */
  readonly SQL_EXECUTOR?: unknown;
}

export interface AccountRuntimeDependencies {
  readonly withTransactionalSqlExecutor?: <Result>(
    connectionString: string,
    operation: (executor: import('../../../db/src/sql.js').TransactionalSqlExecutor) => Promise<Result>,
  ) => Promise<Result>;
  readonly now?: () => number;
  readonly trustedClientKey?: (request: Request) => string;
  readonly randomToken?: () => string;
  readonly cookieMode?: AccountCookieMode;
}

export interface AccountSessionIdentity {
  readonly channel: AccountChannel;
  readonly csrfToken: string | null;
}
