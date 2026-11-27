import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createAccountStore, type AccountStore } from '../src/accounts.js';
import type { SqlExecutor, TransactionalSqlExecutor } from '../src/sql.js';

/**
 * AUTH-RESET-01: administrator-issued one-time reset codes, on the real migrations 036, 045 and 063 in PGlite.
 * The tests read the rows back, so a stored clear code, a missing burn or a missing revocation shows up in the
 * table and not only in a return value. The worker route tests (accounts-api.test.ts) cover HTTP status and bodies.
 */

const migrationFiles = [
  new URL('../migrations/036_accounts.sql', import.meta.url),
  new URL('../migrations/045_password_accounts.sql', import.meta.url),
  new URL('../migrations/063_password_reset_codes.sql', import.meta.url),
];
const passwordHash = `pbkdf2-sha256$100000$${'A'.repeat(22)}$${'B'.repeat(43)}`;
const newPasswordHash = `pbkdf2-sha256$100000$${'D'.repeat(22)}$${'E'.repeat(43)}`;
const baseTime = Date.parse('2026-11-23T00:00:00.000Z');
const ttlMs = 30 * 60_000;
const dayMs = 24 * 60 * 60_000;
const resetReason = 'Administrator issued a one-time password reset code';

test('063 adds the code table, widens the audit and throttle vocabularies, and grants only the auth role', async () => {
  const database = await openDatabase();
  try {
    await database.exec('CREATE ROLE waspada_probe NOLOGIN');
    const privileges = await database.query<{ auth: boolean; probe: boolean }>(`
      SELECT has_table_privilege('waspada_auth_service', 'waspada.password_reset_codes', 'SELECT') AS auth,
             has_table_privilege('waspada_probe', 'waspada.password_reset_codes', 'SELECT') AS probe`);
    assert.deepEqual(privileges.rows, [{ auth: true, probe: false }], 'only the auth service reads the code table');

    const { store, admin, user } = await seedAccounts(database);
    await assert.rejects(
      database.exec(auditInsert({ action: 'unknown_action', actorKind: 'admin', actorId: admin.id, targetId: user.id, expectedVersion: 'NULL' })),
      /account_admin_audit_action_(vocabulary|shape)/u,
      'an unknown audit action is refused',
    );
    await assert.rejects(
      database.exec(auditInsert({ action: 'password_reset_code_issued', actorKind: 'admin', actorId: admin.id, targetId: user.id, expectedVersion: '1' })),
      /account_admin_audit_action_shape/u,
      'a reset audit row carries no expected version',
    );
    await database.exec(auditInsert({ action: 'password_reset_code_issued', actorKind: 'admin', actorId: admin.id, targetId: user.id, expectedVersion: 'NULL' }));

    assert.equal(await store.consumeThrottle('password_reset', hashOf('client-a'), iso(0), ttlMs, 2), true, 'the reset throttle scope is accepted');
    await assert.rejects(
      database.exec(`INSERT INTO waspada.account_login_throttles (dataset_mode, scope, client_key_sha256, window_started_at, request_count, expires_at)
        VALUES ('live', 'unknown_scope', '${hashOf('client-b')}', '${iso(0)}', 1, '${iso(ttlMs)}')`),
      /account_login_throttles_scope_check/u,
      'an unknown throttle scope is refused',
    );
  } finally {
    await database.close();
  }
});

test('an issued code is stored only as a hash, its reset is single-use, and it ends every session of the account', async () => {
  const database = await openDatabase();
  try {
    const { store, admin, user } = await seedAccounts(database);
    const sessionToken = hashOf('warga-session');
    await store.createSession({
      accountId: user.id, tokenSha256: sessionToken, channel: 'web', csrfToken: 'c'.repeat(43),
      createdAt: iso(2), idleExpiresAt: iso(2 + 30 * 60_000), absoluteExpiresAt: iso(2 + 8 * 60 * 60_000),
    });
    assert.notEqual(await store.readSession(sessionToken, iso(3)), null, 'the target has a live session before the reset');

    const issued = await store.issuePasswordResetCode({
      actorAccountId: admin.id, targetAccountId: user.id, codeHash: codeHashOf('ABCDEFGHJK'),
      reason: resetReason, now: iso(10), expiresAt: iso(10 + ttlMs),
    });
    assert.deepEqual(issued, { outcome: 'issued', username: 'warga.reset', expiresAt: iso(10 + ttlMs) });

    const stored = await database.query<{ code_hash: string; used_at: string | null; failed_attempts: number }>(
      'SELECT code_hash, used_at::text AS used_at, failed_attempts FROM waspada.password_reset_codes',
    );
    assert.deepEqual(stored.rows, [{ code_hash: codeHashOf('ABCDEFGHJK'), used_at: null, failed_attempts: 0 }]);
    assert.equal(JSON.stringify(stored.rows).includes('ABCDEFGHJK'), false, 'the clear code is never stored');

    const audit = await database.query<{ action: string; actor_kind: string; actor_account_id: string; reason: string; target_role_before: string; target_role_after: string; expected_version: number | null; target_version_after: number }>(`
      SELECT action, actor_kind, actor_account_id::text AS actor_account_id, reason, target_role_before,
             target_role_after, expected_version, target_version_after
      FROM waspada.account_admin_audit WHERE action = 'password_reset_code_issued'`);
    assert.deepEqual(audit.rows, [{
      action: 'password_reset_code_issued', actor_kind: 'admin', actor_account_id: admin.id, reason: resetReason,
      target_role_before: 'user', target_role_after: 'user', expected_version: null, target_version_after: user.version,
    }], 'one audit row names the administrator and the target, never the code');

    const hashes: string[] = [];
    const reset = await store.consumePasswordResetCode({
      username: 'warga.reset', now: iso(11), verifyCode: matchesCode('ABCDEFGHJK'),
      hashNewPassword: async () => { hashes.push('called'); return newPasswordHash; },
    });
    assert.deepEqual(reset, { outcome: 'reset', accountId: user.id });
    assert.equal(await store.readSession(sessionToken, iso(12)), null, 'the reset ends the session');
    assert.equal((await store.findPasswordCredentialByAccountId(user.id))?.passwordHash, newPasswordHash, 'the password hash is replaced');
    assert.equal((await store.findPasswordCredentialByAccountId(user.id))?.account.role, 'user', 'the reset never changes the role');

    const replay = await store.consumePasswordResetCode({
      username: 'warga.reset', now: iso(13), verifyCode: matchesCode('ABCDEFGHJK'),
      hashNewPassword: async () => { hashes.push('replay'); return newPasswordHash; },
    });
    assert.deepEqual(replay, { outcome: 'rejected' }, 'a used code is refused');
    assert.deepEqual(hashes, ['called'], 'a refused code never hashes the new password');

    // Retention runs on the admin issue path: the code used at +11 ms is purged by an issue two days later.
    const later = await store.issuePasswordResetCode({
      actorAccountId: admin.id, targetAccountId: user.id, codeHash: codeHashOf('LATER00001'),
      reason: resetReason, now: iso(2 * dayMs), expiresAt: iso(2 * dayMs + ttlMs),
    });
    assert.equal(later.outcome, 'issued');
    const remaining = await database.query<{ code_hash: string }>('SELECT code_hash FROM waspada.password_reset_codes');
    assert.deepEqual(remaining.rows, [{ code_hash: codeHashOf('LATER00001') }],
      'a code used more than a day ago loses its hash on the next issue');
  } finally {
    await database.close();
  }
});

test('five wrong attempts burn the code; the fifth correct attempt still lands; a new code replaces the old', async () => {
  const database = await openDatabase();
  try {
    const { store, admin, user } = await seedAccounts(database);
    const issue = (code: string, now: number) => store.issuePasswordResetCode({
      actorAccountId: admin.id, targetAccountId: user.id, codeHash: codeHashOf(code),
      reason: resetReason, now: iso(now), expiresAt: iso(now + ttlMs),
    });
    const attempt = (code: string, now: number) => store.consumePasswordResetCode({
      username: 'warga.reset', now: iso(now), verifyCode: matchesCode(code), hashNewPassword: async () => newPasswordHash,
    });

    assert.equal((await issue('CODEONE001', 10)).outcome, 'issued');
    for (let index = 0; index < 4; index += 1) {
      assert.deepEqual(await attempt('WRONGWRONG', 11 + index), { outcome: 'rejected' });
    }
    assert.deepEqual(await attempt('CODEONE001', 20), { outcome: 'reset', accountId: user.id }, 'four wrong attempts leave the code open');

    assert.equal((await issue('CODETWO002', 30)).outcome, 'issued');
    for (let index = 0; index < 5; index += 1) {
      assert.deepEqual(await attempt('WRONGWRONG', 31 + index), { outcome: 'rejected' });
    }
    assert.deepEqual(await attempt('CODETWO002', 40), { outcome: 'rejected' }, 'the fifth wrong attempt burns the code');
    const burned = await database.query<{ failed_attempts: number; burned: boolean }>(`
      SELECT failed_attempts, used_at IS NOT NULL AS burned FROM waspada.password_reset_codes
      ORDER BY created_at DESC LIMIT 1`);
    assert.deepEqual(burned.rows, [{ failed_attempts: 5, burned: true }]);

    assert.equal((await issue('CODETHREE3', 50)).outcome, 'issued');
    assert.equal((await issue('CODEFOUR04', 51)).outcome, 'issued');
    const unused = await database.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM waspada.password_reset_codes WHERE used_at IS NULL',
    );
    assert.equal(unused.rows[0]?.count, '1', 'a new code burns the older unused one, so one unused code remains');
    assert.deepEqual(await attempt('CODETHREE3', 52), { outcome: 'rejected' }, 'a replaced code no longer works');
    assert.deepEqual(await attempt('CODEFOUR04', 53), { outcome: 'reset', accountId: user.id });
  } finally {
    await database.close();
  }
});

test('an expired code is refused and burned; an unknown username never reaches a code', async () => {
  const database = await openDatabase();
  try {
    const { store, admin, user } = await seedAccounts(database);
    await store.issuePasswordResetCode({
      actorAccountId: admin.id, targetAccountId: user.id, codeHash: codeHashOf('EXPIRED001'),
      reason: resetReason, now: iso(10), expiresAt: iso(10 + ttlMs),
    });
    const expired = await store.consumePasswordResetCode({
      username: 'warga.reset', now: iso(10 + ttlMs), verifyCode: matchesCode('EXPIRED001'),
      hashNewPassword: async () => newPasswordHash,
    });
    assert.deepEqual(expired, { outcome: 'rejected' }, 'a correct code is refused at its expiry instant');
    const burned = await database.query<{ burned: boolean }>('SELECT used_at IS NOT NULL AS burned FROM waspada.password_reset_codes');
    assert.deepEqual(burned.rows, [{ burned: true }]);

    const seen: Array<string | null> = [];
    const unknown = await store.consumePasswordResetCode({
      username: 'tidak.ada', now: iso(20),
      verifyCode: async (stored) => { seen.push(stored); return false; },
      hashNewPassword: async () => { throw new Error('must not hash for an unknown username'); },
    });
    assert.deepEqual(unknown, { outcome: 'rejected' });
    assert.deepEqual(seen, [null], 'an unknown username is checked against no stored hash, at the same cost');

    const seenMalformed: Array<string | null> = [];
    const malformed = await store.consumePasswordResetCode({
      username: 'bukan nama', now: iso(21),
      verifyCode: async (stored) => { seenMalformed.push(stored); return false; },
      hashNewPassword: async () => { throw new Error('must not hash for a malformed username'); },
    });
    assert.deepEqual(malformed, { outcome: 'rejected' });
    assert.deepEqual(seenMalformed, [null], 'a malformed username pays the same check cost and matches no row');
  } finally {
    await database.close();
  }
});

test('an administrator cannot issue a code to themselves, a non-admin, an inactive account or a Google-only account', async () => {
  const database = await openDatabase();
  try {
    const { store, admin, user } = await seedAccounts(database);
    const issue = (actorId: string, targetId: string) => store.issuePasswordResetCode({
      actorAccountId: actorId, targetAccountId: targetId, codeHash: codeHashOf('REFUSED001'),
      reason: resetReason, now: iso(10), expiresAt: iso(10 + ttlMs),
    });
    assert.deepEqual(await issue(user.id, admin.id), { outcome: 'forbidden' }, 'a non-admin cannot issue');
    assert.deepEqual(await issue(admin.id, admin.id), { outcome: 'conflict' }, 'an administrator cannot issue to themselves');

    await database.exec(`UPDATE waspada.accounts SET active = false WHERE account_id = '${user.id}'`);
    assert.deepEqual(await issue(admin.id, user.id), { outcome: 'conflict' }, 'an inactive account gets no code');
    await database.exec(`UPDATE waspada.accounts SET active = true WHERE account_id = '${user.id}'`);

    await database.exec(`
      INSERT INTO waspada.accounts (dataset_mode, identity_issuer, identity_subject, display_name, email, role, active,
        onboarding_version, onboarding_completed_at, version, created_at, updated_at)
      VALUES ('live', 'https://accounts.google.com', 'legacy-subject', 'Legacy', 'legacy@example.test', 'user', true,
        0, NULL, 1, '${iso(0)}', '${iso(0)}')`);
    const legacy = await database.query<{ id: string }>("SELECT account_id::text AS id FROM waspada.accounts WHERE identity_subject = 'legacy-subject'");
    assert.deepEqual(await issue(admin.id, legacy.rows[0]?.id ?? ''), { outcome: 'not_found' }, 'a Google-only account has no password to reset');

    assert.equal((await database.query<{ count: string }>('SELECT count(*)::text AS count FROM waspada.password_reset_codes')).rows[0]?.count, '0',
      'no refused issue stores a code');
    assert.equal((await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM waspada.account_admin_audit WHERE action = 'password_reset_code_issued'")).rows[0]?.count, '0',
    'no refused issue is audited');
  } finally {
    await database.close();
  }
});

async function openDatabase(): Promise<PGlite> {
  const database = new PGlite();
  for (const file of migrationFiles) {
    await database.exec(await readFile(file, 'utf8'));
  }
  return database;
}

async function seedAccounts(database: PGlite): Promise<{
  store: AccountStore;
  admin: { id: string };
  user: { id: string; version: number };
}> {
  const store = createAccountStore(createExecutor(database), 'live');
  const admin = await store.createPasswordAccount({
    datasetMode: 'live', username: 'admin.reset', passwordHash, displayName: 'Admin Reset',
    role: 'admin', now: iso(0), reason: 'Penyediaan operator awal untuk uji reset',
  });
  const user = await store.createPasswordAccount({
    datasetMode: 'live', username: 'warga.reset', passwordHash, displayName: 'Warga Reset',
    role: 'user', now: iso(1),
  });
  return { store, admin, user };
}

function matchesCode(code: string): (storedHash: string | null) => Promise<boolean> {
  return async (storedHash) => storedHash !== null && storedHash === codeHashOf(code);
}

/** Any well-formed PBKDF2 string serves here: the store compares and stores hashes without computing them. */
function codeHashOf(code: string): string {
  return `pbkdf2-sha256$100000$${'C'.repeat(22)}$${hashOf(`code:${code}`).slice(0, 43)}`;
}

function auditInsert(options: {
  action: string;
  actorKind: 'admin' | 'operator';
  actorId: string;
  targetId: string;
  expectedVersion: string;
}): string {
  return `
    INSERT INTO waspada.account_admin_audit (
      dataset_mode, actor_kind, actor_account_id, target_account_id, action, reason,
      actor_role_at_action, target_role_before, target_role_after, target_active_before, target_active_after,
      expected_version, target_version_after, occurred_at
    ) VALUES ('live', '${options.actorKind}', '${options.actorId}', '${options.targetId}', '${options.action}',
      '${resetReason}', 'admin', 'user', 'user', true, true, ${options.expectedVersion}, 1, '${iso(40)}')`;
}

function createExecutor(database: PGlite): TransactionalSqlExecutor {
  return {
    async query<Row extends object>(statement: string, parameters?: readonly unknown[]) {
      const result = await database.query<Row>(statement, parameters ? [...parameters] : undefined);
      return { rows: result.rows };
    },
    async execute(statement: string) {
      await database.exec(statement);
    },
    async transaction<Result>(work: (transaction: SqlExecutor) => Promise<Result>) {
      return database.transaction(async (client) => work({
        async query<Row extends object>(statement: string, parameters?: readonly unknown[]) {
          const result = await client.query<Row>(statement, parameters ? [...parameters] : undefined);
          return { rows: result.rows };
        },
        async execute(statement: string) {
          await client.exec(statement);
        },
      }));
    },
  };
}

function hashOf(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function iso(offsetMilliseconds: number): string {
  return new Date(baseTime + offsetMilliseconds).toISOString();
}
