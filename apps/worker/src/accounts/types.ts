import type { AccountChannel, AccountDatasetMode, AccountStore, VerifiedGoogleIdentity } from '../../../db/src/accounts.js';
import type { GoogleAccountProviderConfiguration } from './google-provider.js';

export type { AccountChannel, AccountDatasetMode, AccountRole, AccountStore, StoredAccount, VerifiedGoogleIdentity } from '../../../db/src/accounts.js';

export interface GoogleWebAuthorization {
  readonly authorizationUrl: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
}

export interface CompleteGoogleWebAuthorizationInput {
  readonly callbackUrl: URL;
  readonly codeVerifier: string;
  readonly expectedState: string;
  readonly expectedNonce: string;
}

/** Implementations must return identity claims only after signature and claim verification. */
export interface AccountGoogleProvider {
  beginWeb(): Promise<GoogleWebAuthorization>;
  completeWeb(input: CompleteGoogleWebAuthorizationInput): Promise<VerifiedGoogleIdentity>;
  verifyNativeIdToken(idToken: string): Promise<VerifiedGoogleIdentity>;
}

export type AccountCookieMode = 'host' | 'loopback';

export type AccountApiHandler = (request: Request) => Promise<Response | undefined>;

export interface AccountApiOptions {
  readonly enabled: boolean;
  readonly store?: AccountStore;
  readonly google?: AccountGoogleProvider;
  readonly appOrigin?: string;
  readonly datasetMode?: AccountDatasetMode;
  readonly webLoginAvailable?: boolean;
  readonly nativeLoginAvailable?: boolean;
  readonly cookieMode?: AccountCookieMode;
  /** Explicit local loopback consent surface used only by the isolated demo harness. */
  readonly loopbackAuthorizationOrigin?: string;
  readonly now?: () => number;
  /** Must be supplied by a trusted edge/socket adapter; forwarded client headers are not consulted. */
  readonly trustedClientKey?: (request: Request) => string;
  /** Test seam for session and browser-attempt secrets. Production uses cryptographic randomness. */
  readonly randomToken?: () => string;
}

export interface AccountWorkerEnvironment {
  readonly DATASET_MODE?: string;
  readonly AUTH_ENABLED?: string;
  readonly AUTH_APP_ORIGIN?: string;
  readonly AUTH_GOOGLE_CLIENT_ID?: string;
  readonly AUTH_GOOGLE_NATIVE_CLIENT_ID?: string;
  readonly AUTH_GOOGLE_ANDROID_CLIENT_ID?: string;
  readonly AUTH_GOOGLE_CLIENT_SECRET?: string;
  readonly AUTH_HYPERDRIVE?: { readonly connectionString?: string };
}

export interface AccountRuntimeDependencies {
  readonly google?: AccountGoogleProvider;
  /** Test seam for retrying provider discovery without contacting Google. */
  readonly googleProviderFactory?: (
    configuration: GoogleAccountProviderConfiguration,
  ) => Promise<AccountGoogleProvider>;
  readonly withTransactionalSqlExecutor?: <Result>(
    connectionString: string,
    operation: (executor: import('../../../db/src/sql.js').TransactionalSqlExecutor) => Promise<Result>,
  ) => Promise<Result>;
  readonly now?: () => number;
  readonly trustedClientKey?: (request: Request) => string;
  readonly randomToken?: () => string;
  readonly cookieMode?: AccountCookieMode;
  readonly loopbackAuthorizationOrigin?: string;
}

export interface AccountSessionIdentity {
  readonly channel: AccountChannel;
  readonly csrfToken: string | null;
}
