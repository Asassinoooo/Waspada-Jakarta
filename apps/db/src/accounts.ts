import type { SqlExecutor, TransactionalSqlExecutor } from './sql.js';

export type AccountDatasetMode = 'live' | 'demo';
export type AccountRole = 'user' | 'moderator' | 'admin';
export type AccountChannel = 'web' | 'mobile';

export interface VerifiedGoogleIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly displayName: string;
  readonly email: string;
  readonly emailVerified: boolean;
}

export interface StoredAccount {
  readonly id: string;
  readonly display_name: string;
  readonly email: string;
  readonly role: AccountRole;
  readonly active: boolean;
  readonly onboarding_version: 0 | 1;
  readonly onboarding_completed_at: string | null;
  readonly version: number;
}

export interface CreateAccountLoginAttemptInput {
  readonly stateSha256: string;
  readonly browserCookieSha256: string;
  readonly priorSessionTokenSha256: string | null;
  readonly codeVerifier: string;
  readonly nonce: string;
  readonly returnTo: '#akun' | '#mulai' | '#admin' | '#tinjau-bukti';
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface ClaimedAccountLoginAttempt {
  readonly codeVerifier: string;
  readonly nonce: string;
  readonly returnTo: '#akun' | '#mulai' | '#admin' | '#tinjau-bukti';
  readonly priorSessionTokenSha256: string | null;
}

export interface CreateAccountSessionInput {
  readonly accountId: string;
  readonly tokenSha256: string;
  readonly channel: AccountChannel;
  readonly csrfToken: string | null;
  readonly createdAt: string;
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
  readonly revokeTokenSha256?: string;
}

export interface StoredAccountSession {
  readonly channel: AccountChannel;
  readonly csrfToken: string | null;
  readonly account: StoredAccount;
}

export interface AccountUserPageRecord {
  readonly data: readonly StoredAccount[];
  readonly nextCursor: string | null;
}

export type AccountUserPageResult =
  | { readonly outcome: 'listed'; readonly page: AccountUserPageRecord }
  | { readonly outcome: 'forbidden' };

export interface AccountAdminUpdateInput {
  readonly actorAccountId: string;
  readonly targetAccountId: string;
  readonly role: AccountRole;
  readonly active: boolean;
  readonly expectedVersion: number;
  readonly reason: string;
  readonly occurredAt: string;
}

export type AccountAdminUpdateResult =
  | { readonly outcome: 'updated'; readonly account: StoredAccount }
  | { readonly outcome: 'forbidden' }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'conflict' };

export interface ProvisionAccountInput {
  readonly identity: VerifiedGoogleIdentity;
  readonly role: AccountRole;
  readonly reason: string;
  readonly now: string;
}

export interface AccountStore {
  readonly datasetMode: AccountDatasetMode;
  createLoginAttempt(input: CreateAccountLoginAttemptInput): Promise<void>;
  claimLoginAttempt(
    stateSha256: string,
    browserCookieSha256: string,
    now: string,
  ): Promise<ClaimedAccountLoginAttempt | null>;
  findOrCreateVerifiedAccount(identity: VerifiedGoogleIdentity, now: string): Promise<StoredAccount>;
  createSession(input: CreateAccountSessionInput): Promise<StoredAccount>;
  readSession(tokenSha256: string, now: string): Promise<StoredAccountSession | null>;
  revokeSession(tokenSha256: string, now: string): Promise<boolean>;
  completeOnboarding(accountId: string, version: 1, now: string): Promise<StoredAccount | null>;
  listAccounts(limit: number, after: string | undefined, actorAccountId: string): Promise<AccountUserPageResult>;
  updateAccountByAdmin(input: AccountAdminUpdateInput): Promise<AccountAdminUpdateResult>;
  consumeThrottle(
    scope: 'web_start' | 'web_callback' | 'native_exchange',
    clientKeySha256: string,
    now: string,
    windowMilliseconds: number,
    maximumRequests: number,
  ): Promise<boolean>;
  cleanupExpired(now: string, maxRows: number): Promise<number>;
  /** Trusted operator-only setup primitive. It is never reachable through account-v1 HTTP. */
  provisionAccount(input: ProvisionAccountInput): Promise<StoredAccount>;
}

interface AccountRow {
  account_id: string;
  display_name: string;
  email: string;
  role: AccountRole;
  active: boolean;
  onboarding_version: number;
  onboarding_completed_at: string | Date | null;
  version: number;
}

interface LoginAttemptRow {
  code_verifier: string;
  nonce: string;
  return_to: ClaimedAccountLoginAttempt['returnTo'];
  prior_session_token_sha256: string | null;
}

interface SessionRow extends AccountRow {
  channel: AccountChannel;
  csrf_token: string | null;
  session_revoked_at: string | Date | null;
  idle_expires_at: string | Date;
  absolute_expires_at: string | Date;
}

const googleIssuer = 'https://accounts.google.com';
const roleValues = new Set<AccountRole>(['user', 'moderator', 'admin']);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const hashPattern = /^[0-9a-f]{64}$/u;
const maxCleanupRows = 100;

/**
 * Creates an account repository permanently scoped to one server-selected dataset.
 * Every transaction runs under the dedicated, no-login auth capability.
 */
export function createAccountStore(
  executor: TransactionalSqlExecutor,
  datasetMode: AccountDatasetMode,
): AccountStore {
  if (datasetMode !== 'live' && datasetMode !== 'demo') {
    throw new TypeError('Account dataset mode must be configured by the server.');
  }

  async function inTransaction<Result>(work: (transaction: SqlExecutor) => Promise<Result>): Promise<Result> {
    return executor.transaction(async (transaction) => {
      await transaction.query('SET LOCAL ROLE waspada_auth_service');
      return work(transaction);
    });
  }

  async function getAccount(
    transaction: SqlExecutor,
    accountId: string,
    forUpdate = false,
  ): Promise<StoredAccount | null> {
    const rows = await transaction.query<AccountRow>(
      `SELECT account_id::text, display_name, email, role, active,
              onboarding_version, onboarding_completed_at, version
       FROM waspada.accounts
       WHERE dataset_mode = $1 AND account_id = $2::uuid${forUpdate ? ' FOR UPDATE' : ''}`,
      [datasetMode, accountId],
    );
    return rows.rows[0] ? toStoredAccount(rows.rows[0]) : null;
  }

  return {
    datasetMode,

    async createLoginAttempt(input) {
      requireHash(input.stateSha256, 'state');
      requireHash(input.browserCookieSha256, 'browser cookie');
      if (input.priorSessionTokenSha256 !== null) {
        requireHash(input.priorSessionTokenSha256, 'prior session');
      }
      await inTransaction(async (transaction) => {
        await transaction.query(
          `INSERT INTO waspada.account_login_attempts (
             dataset_mode, state_sha256, browser_cookie_sha256, prior_session_token_sha256,
             code_verifier, nonce, return_to, created_at, expires_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [datasetMode, input.stateSha256, input.browserCookieSha256, input.priorSessionTokenSha256,
            input.codeVerifier, input.nonce, input.returnTo, input.createdAt, input.expiresAt],
        );
      });
    },

    async claimLoginAttempt(stateSha256, browserCookieSha256, now) {
      requireHash(stateSha256, 'state');
      requireHash(browserCookieSha256, 'browser cookie');
      return inTransaction(async (transaction) => {
        const result = await transaction.query<LoginAttemptRow>(
          `UPDATE waspada.account_login_attempts
           SET consumed_at = $4
           WHERE dataset_mode = $1 AND state_sha256 = $2 AND browser_cookie_sha256 = $3
             AND consumed_at IS NULL AND expires_at > $4
           RETURNING code_verifier, nonce, return_to, prior_session_token_sha256`,
          [datasetMode, stateSha256, browserCookieSha256, now],
        );
        const row = result.rows[0];
        return row
          ? {
            codeVerifier: row.code_verifier,
            nonce: row.nonce,
            returnTo: row.return_to,
            priorSessionTokenSha256: row.prior_session_token_sha256,
          }
          : null;
      });
    },

    async findOrCreateVerifiedAccount(identity, now) {
      validateIdentity(identity);
      return inTransaction(async (transaction) => {
        const upserted = await transaction.query<AccountRow>(
          `INSERT INTO waspada.accounts (
             dataset_mode, identity_issuer, identity_subject, display_name, email,
             role, active, onboarding_version, onboarding_completed_at,
             version, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, 'user', true, 0, NULL, 1, $6, $6)
           ON CONFLICT (dataset_mode, identity_issuer, identity_subject) DO UPDATE
           SET display_name = EXCLUDED.display_name,
               email = EXCLUDED.email,
               updated_at = EXCLUDED.updated_at,
               version = waspada.accounts.version + 1
           WHERE waspada.accounts.display_name IS DISTINCT FROM EXCLUDED.display_name
              OR waspada.accounts.email IS DISTINCT FROM EXCLUDED.email
           RETURNING account_id::text, display_name, email, role, active,
                     onboarding_version, onboarding_completed_at, version`,
          [datasetMode, identity.issuer, identity.subject, identity.displayName, identity.email, now],
        );
        if (upserted.rows[0]) return toStoredAccount(upserted.rows[0]);

        const existing = await transaction.query<AccountRow>(
          `SELECT account_id::text, display_name, email, role, active,
                  onboarding_version, onboarding_completed_at, version
           FROM waspada.accounts
           WHERE dataset_mode = $1 AND identity_issuer = $2 AND identity_subject = $3
           FOR UPDATE`,
          [datasetMode, identity.issuer, identity.subject],
        );
        if (!existing.rows[0]) throw new Error('Account upsert could not be read back.');
        return toStoredAccount(existing.rows[0]);
      });
    },

    async createSession(input) {
      requireUuid(input.accountId, 'account');
      requireHash(input.tokenSha256, 'session');
      if (input.revokeTokenSha256 !== undefined) requireHash(input.revokeTokenSha256, 'previous session');
      if ((input.channel === 'web') !== (input.csrfToken !== null)) {
        throw new TypeError('Web sessions require CSRF state and mobile sessions do not.');
      }
      return inTransaction(async (transaction) => {
        const account = await getAccount(transaction, input.accountId, true);
        if (!account || !account.active) throw new Error('Account is unavailable.');
        if (input.revokeTokenSha256) {
          await transaction.query(
            `UPDATE waspada.account_sessions SET revoked_at = $3
             WHERE dataset_mode = $1 AND token_sha256 = $2 AND revoked_at IS NULL`,
            [datasetMode, input.revokeTokenSha256, input.createdAt],
          );
        }
        await transaction.query(
          `INSERT INTO waspada.account_sessions (
             account_id, token_sha256, channel, dataset_mode, csrf_token,
             created_at, last_seen_at, idle_expires_at, absolute_expires_at
           ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $6, $7, $8)`,
          [input.accountId, input.tokenSha256, input.channel, datasetMode, input.csrfToken,
            input.createdAt, input.idleExpiresAt, input.absoluteExpiresAt],
        );
        return account;
      });
    },

    async readSession(tokenSha256, now) {
      requireHash(tokenSha256, 'session');
      return inTransaction(async (transaction) => {
        const rows = await transaction.query<SessionRow>(
          `SELECT a.account_id::text, a.display_name, a.email, a.role, a.active,
                  a.onboarding_version, a.onboarding_completed_at, a.version,
                  s.channel, s.csrf_token, s.revoked_at AS session_revoked_at,
                  s.idle_expires_at, s.absolute_expires_at
           FROM waspada.account_sessions AS s
           JOIN waspada.accounts AS a
             ON a.account_id = s.account_id AND a.dataset_mode = s.dataset_mode
           WHERE s.dataset_mode = $1 AND s.token_sha256 = $2
           FOR UPDATE OF s, a`,
          [datasetMode, tokenSha256],
        );
        const row = rows.rows[0];
        if (!row || row.session_revoked_at !== null || !row.active
          || timestamp(row.idle_expires_at) <= timestamp(now)
          || timestamp(row.absolute_expires_at) <= timestamp(now)) {
          return null;
        }
        const absoluteExpiry = timestamp(row.absolute_expires_at);
        const idleExpiry = Math.min(timestamp(now) + 30 * 60_000, absoluteExpiry);
        await transaction.query(
          `UPDATE waspada.account_sessions
           SET last_seen_at = $3, idle_expires_at = $4
           WHERE dataset_mode = $1 AND token_sha256 = $2`,
          [datasetMode, tokenSha256, now, new Date(idleExpiry).toISOString()],
        );
        return {
          channel: row.channel,
          csrfToken: row.csrf_token,
          account: toStoredAccount(row),
        };
      });
    },

    async revokeSession(tokenSha256, now) {
      requireHash(tokenSha256, 'session');
      return inTransaction(async (transaction) => {
        const result = await transaction.query<{ session_id: string }>(
          `UPDATE waspada.account_sessions SET revoked_at = $3
           WHERE dataset_mode = $1 AND token_sha256 = $2 AND revoked_at IS NULL
           RETURNING session_id::text`,
          [datasetMode, tokenSha256, now],
        );
        return result.rows.length > 0;
      });
    },

    async completeOnboarding(accountId, version, now) {
      requireUuid(accountId, 'account');
      if (version !== 1) throw new TypeError('Only onboarding version 1 is supported.');
      return inTransaction(async (transaction) => {
        const existing = await getAccount(transaction, accountId, true);
        if (!existing || !existing.active) return null;
        if (existing.onboarding_version === 1) return existing;
        const result = await transaction.query<AccountRow>(
          `UPDATE waspada.accounts
           SET onboarding_version = 1, onboarding_completed_at = $3,
               version = version + 1, updated_at = $3
           WHERE dataset_mode = $1 AND account_id = $2::uuid AND onboarding_version = 0
           RETURNING account_id::text, display_name, email, role, active,
                     onboarding_version, onboarding_completed_at, version`,
          [datasetMode, accountId, now],
        );
        return result.rows[0] ? toStoredAccount(result.rows[0]) : null;
      });
    },

    async listAccounts(limit, after, actorAccountId) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
        throw new TypeError('Account page limit is invalid.');
      }
      if (after !== undefined) requireUuid(after, 'cursor');
      requireUuid(actorAccountId, 'actor');
      return inTransaction(async (transaction) => {
        const actor = await transaction.query<{ account_id: string }>(
          `SELECT account_id::text
           FROM waspada.accounts
           WHERE dataset_mode = $1 AND account_id = $2::uuid
             AND role = 'admin' AND active AND onboarding_version = 1
           FOR SHARE`,
          [datasetMode, actorAccountId],
        );
        if (!actor.rows[0]) return { outcome: 'forbidden' };
        const rows = await transaction.query<AccountRow>(
          `SELECT account_id::text, display_name, email, role, active,
                  onboarding_version, onboarding_completed_at, version
           FROM waspada.accounts
           WHERE dataset_mode = $1 AND ($2::uuid IS NULL OR account_id > $2::uuid)
           ORDER BY account_id ASC
           LIMIT $3`,
          [datasetMode, after ?? null, limit + 1],
        );
        const hasMore = rows.rows.length > limit;
        const pageRows = hasMore ? rows.rows.slice(0, limit) : rows.rows;
        return {
          outcome: 'listed',
          page: {
            data: pageRows.map(toStoredAccount),
            nextCursor: hasMore ? pageRows.at(-1)?.account_id ?? null : null,
          },
        };
      });
    },

    async updateAccountByAdmin(input) {
      requireUuid(input.actorAccountId, 'actor');
      requireUuid(input.targetAccountId, 'target');
      if (!roleValues.has(input.role)) throw new TypeError('Account role is invalid.');
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
        throw new TypeError('Account version is invalid.');
      }
      const reason = normalizeReason(input.reason);
      if (input.actorAccountId === input.targetAccountId) return { outcome: 'conflict' };

      return inTransaction(async (transaction) => {
        const locked = await transaction.query<AccountRow>(
          `SELECT account_id::text, display_name, email, role, active,
                  onboarding_version, onboarding_completed_at, version
           FROM waspada.accounts
           WHERE dataset_mode = $1 AND account_id IN ($2::uuid, $3::uuid)
           ORDER BY account_id ASC
           FOR UPDATE`,
          [datasetMode, input.actorAccountId, input.targetAccountId],
        );
        const actor = locked.rows.find((row) => row.account_id === input.actorAccountId);
        const target = locked.rows.find((row) => row.account_id === input.targetAccountId);
        if (!actor || actor.role !== 'admin' || !actor.active || actor.onboarding_version !== 1) {
          return { outcome: 'forbidden' };
        }
        if (!target) return { outcome: 'not_found' };
        if (target.version !== input.expectedVersion) return { outcome: 'conflict' };

        const updatedRows = await transaction.query<AccountRow>(
          `UPDATE waspada.accounts
           SET role = $4, active = $5, version = version + 1, updated_at = $6
           WHERE dataset_mode = $1 AND account_id = $2::uuid AND version = $3
           RETURNING account_id::text, display_name, email, role, active,
                     onboarding_version, onboarding_completed_at, version`,
          [datasetMode, input.targetAccountId, input.expectedVersion,
            input.role, input.active, input.occurredAt],
        );
        const updated = updatedRows.rows[0];
        if (!updated) return { outcome: 'conflict' };

        await transaction.query(
          `UPDATE waspada.account_sessions SET revoked_at = $3
           WHERE dataset_mode = $1 AND account_id = $2::uuid AND revoked_at IS NULL`,
          [datasetMode, input.targetAccountId, input.occurredAt],
        );
        await transaction.query(
          `INSERT INTO waspada.account_admin_audit (
             dataset_mode, actor_kind, actor_account_id, target_account_id,
             action, reason, actor_role_at_action, target_role_before,
             target_role_after, target_active_before, target_active_after,
             expected_version, target_version_after, occurred_at
           ) VALUES ($1, 'admin', $2::uuid, $3::uuid, 'account_updated', $4,
                    'admin', $5, $6, $7, $8, $9, $10, $11)`,
          [datasetMode, input.actorAccountId, input.targetAccountId, reason,
            target.role, updated.role, target.active, updated.active,
            input.expectedVersion, updated.version, input.occurredAt],
        );
        return { outcome: 'updated', account: toStoredAccount(updated) };
      });
    },

    async consumeThrottle(scope, clientKeySha256, now, windowMilliseconds, maximumRequests) {
      requireHash(clientKeySha256, 'client key');
      if (!Number.isSafeInteger(windowMilliseconds) || windowMilliseconds < 1
        || !Number.isSafeInteger(maximumRequests) || maximumRequests < 1) {
        throw new TypeError('Throttle bounds are invalid.');
      }
      const nowMilliseconds = timestamp(now);
      const expiresAt = new Date(nowMilliseconds + windowMilliseconds).toISOString();
      return inTransaction(async (transaction) => {
        const result = await transaction.query<{ request_count: number }>(
          `INSERT INTO waspada.account_login_throttles (
             dataset_mode, scope, client_key_sha256, window_started_at, request_count, expires_at
           ) VALUES ($1, $2, $3, $4, 1, $5)
           ON CONFLICT (dataset_mode, scope, client_key_sha256) DO UPDATE
           SET window_started_at = CASE
                 WHEN waspada.account_login_throttles.expires_at <= EXCLUDED.window_started_at
                   THEN EXCLUDED.window_started_at
                 ELSE waspada.account_login_throttles.window_started_at
               END,
               request_count = CASE
                 WHEN waspada.account_login_throttles.expires_at <= EXCLUDED.window_started_at
                   THEN 1
                 ELSE waspada.account_login_throttles.request_count + 1
               END,
               expires_at = CASE
                 WHEN waspada.account_login_throttles.expires_at <= EXCLUDED.window_started_at
                   THEN EXCLUDED.expires_at
                 ELSE waspada.account_login_throttles.expires_at
               END
           RETURNING request_count`,
          [datasetMode, scope, clientKeySha256, now, expiresAt],
        );
        return (result.rows[0]?.request_count ?? maximumRequests + 1) <= maximumRequests;
      });
    },

    async cleanupExpired(now, maxRows) {
      if (!Number.isSafeInteger(maxRows) || maxRows < 1) {
        throw new TypeError('Cleanup bound is invalid.');
      }
      const boundedRows = Math.min(maxCleanupRows, maxRows);
      return inTransaction(async (transaction) => {
        const sessions = await transaction.query<{ session_id: string }>(
          `WITH expired AS (
             SELECT session_id FROM waspada.account_sessions
             WHERE dataset_mode = $1 AND
               (idle_expires_at <= $2 OR absolute_expires_at <= $2 OR revoked_at <= $2 - interval '1 day')
             ORDER BY COALESCE(revoked_at, LEAST(idle_expires_at, absolute_expires_at))
             LIMIT $3
           )
           DELETE FROM waspada.account_sessions AS s
           USING expired WHERE s.session_id = expired.session_id
           RETURNING s.session_id::text`,
          [datasetMode, now, boundedRows],
        );
        const attempts = await transaction.query<{ attempt_id: string }>(
          `WITH expired AS (
             SELECT attempt_id FROM waspada.account_login_attempts
             WHERE dataset_mode = $1 AND (expires_at <= $2 OR consumed_at <= $2 - interval '1 day')
             ORDER BY expires_at
             LIMIT $3
           )
           DELETE FROM waspada.account_login_attempts AS a
           USING expired WHERE a.attempt_id = expired.attempt_id
           RETURNING a.attempt_id::text`,
          [datasetMode, now, boundedRows],
        );
        const throttles = await transaction.query<{ scope: string }>(
          `WITH expired AS (
             SELECT scope, client_key_sha256 FROM waspada.account_login_throttles
             WHERE dataset_mode = $1 AND expires_at <= $2
             ORDER BY expires_at
             LIMIT $3
           )
           DELETE FROM waspada.account_login_throttles AS t
           USING expired
           WHERE t.dataset_mode = $1 AND t.scope = expired.scope
             AND t.client_key_sha256 = expired.client_key_sha256
           RETURNING t.scope`,
          [datasetMode, now, boundedRows],
        );
        return sessions.rows.length + attempts.rows.length + throttles.rows.length;
      });
    },

    async provisionAccount(input) {
      validateIdentity(input.identity);
      if (!roleValues.has(input.role)) throw new TypeError('Account role is invalid.');
      const reason = normalizeReason(input.reason);
      return inTransaction(async (transaction) => {
        const inserted = await transaction.query<AccountRow>(
          `INSERT INTO waspada.accounts (
             dataset_mode, identity_issuer, identity_subject, display_name, email,
             role, active, onboarding_version, onboarding_completed_at,
             version, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, true, 0, NULL, 1, $7, $7)
           ON CONFLICT (dataset_mode, identity_issuer, identity_subject) DO NOTHING
           RETURNING account_id::text, display_name, email, role, active,
                     onboarding_version, onboarding_completed_at, version`,
          [datasetMode, input.identity.issuer, input.identity.subject,
            input.identity.displayName, input.identity.email, input.role, input.now],
        );
        let before: StoredAccount | null = null;
        let provisioned: StoredAccount;
        if (inserted.rows[0]) {
          provisioned = toStoredAccount(inserted.rows[0]);
        } else {
          const existingRows = await transaction.query<AccountRow>(
            `SELECT account_id::text, display_name, email, role, active,
                    onboarding_version, onboarding_completed_at, version
             FROM waspada.accounts
             WHERE dataset_mode = $1 AND identity_issuer = $2 AND identity_subject = $3
             FOR UPDATE`,
            [datasetMode, input.identity.issuer, input.identity.subject],
          );
          if (!existingRows.rows[0]) throw new Error('Provisioned account could not be loaded.');
          before = toStoredAccount(existingRows.rows[0]);
          const updatedRows = await transaction.query<AccountRow>(
            `UPDATE waspada.accounts
             SET display_name = $3, email = $4, role = $5, active = true,
                 version = version + 1, updated_at = $6
             WHERE dataset_mode = $1 AND account_id = $2::uuid
             RETURNING account_id::text, display_name, email, role, active,
                       onboarding_version, onboarding_completed_at, version`,
            [datasetMode, before.id, input.identity.displayName,
              input.identity.email, input.role, input.now],
          );
          if (!updatedRows.rows[0]) throw new Error('Provisioned account could not be updated.');
          provisioned = toStoredAccount(updatedRows.rows[0]);
          await transaction.query(
            `UPDATE waspada.account_sessions SET revoked_at = $3
             WHERE dataset_mode = $1 AND account_id = $2::uuid AND revoked_at IS NULL`,
            [datasetMode, before.id, input.now],
          );
        }
        await transaction.query(
          `INSERT INTO waspada.account_admin_audit (
             dataset_mode, actor_kind, actor_account_id, target_account_id,
             action, reason, actor_role_at_action, target_role_before,
             target_role_after, target_active_before, target_active_after,
             expected_version, target_version_after, occurred_at
           ) VALUES ($1, 'operator', NULL, $2::uuid, 'account_provisioned', $3,
                    NULL, $4, $5, $6, $7, NULL, $8, $9)`,
          [datasetMode, provisioned.id, reason, before?.role ?? null,
            provisioned.role, before?.active ?? null, provisioned.active,
            provisioned.version, input.now],
        );
        return provisioned;
      });
    },
  };
}

function toStoredAccount(row: AccountRow): StoredAccount {
  if (row.onboarding_version !== 0 && row.onboarding_version !== 1) {
    throw new Error('Stored account onboarding state is invalid.');
  }
  if (!roleValues.has(row.role) || !Number.isSafeInteger(row.version)) {
    throw new Error('Stored account state is invalid.');
  }
  return Object.freeze({
    id: row.account_id,
    display_name: row.display_name,
    email: row.email,
    role: row.role,
    active: row.active,
    onboarding_version: row.onboarding_version,
    onboarding_completed_at: formatTimestamp(row.onboarding_completed_at),
    version: row.version,
  });
}

function validateIdentity(identity: VerifiedGoogleIdentity): void {
  if (identity.issuer !== googleIssuer
    || identity.emailVerified !== true
    || typeof identity.subject !== 'string'
    || identity.subject.length < 1
    || identity.subject.length > 255
    || /[\u0000-\u001f\u007f]/u.test(identity.subject)
    || typeof identity.email !== 'string'
    || identity.email.length < 3
    || identity.email.length > 320
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(identity.email)
    || typeof identity.displayName !== 'string'
    || identity.displayName.trim().length < 1
    || identity.displayName.length > 200
    || /[\u0000-\u001f\u007f]/u.test(identity.displayName)) {
    throw new TypeError('Verified Google identity is invalid.');
  }
}

function requireUuid(value: string, label: string): void {
  if (!uuidPattern.test(value)) throw new TypeError(`${label} identifier is invalid.`);
}

function requireHash(value: string, label: string): void {
  if (!hashPattern.test(value)) throw new TypeError(`${label} hash is invalid.`);
}

function normalizeReason(value: string): string {
  const reason = value.trim();
  if (reason.length < 1 || reason.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(reason)) {
    throw new TypeError('Administrative reason is invalid.');
  }
  return reason;
}

function timestamp(value: string | Date): number {
  const result = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(result)) throw new TypeError('Timestamp is invalid.');
  return result;
}

function formatTimestamp(value: string | Date | null): string | null {
  if (value === null) return null;
  return new Date(timestamp(value)).toISOString();
}
