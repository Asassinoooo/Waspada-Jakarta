import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { AccountUsernameTakenError, createAccountStore } from '../src/accounts.js';
import type { SqlExecutor, TransactionalSqlExecutor } from '../src/sql.js';

const accountsMigration = new URL('../migrations/036_accounts.sql', import.meta.url);
const passwordMigration = new URL('../migrations/045_password_accounts.sql', import.meta.url);
const baseTime = Date.parse('2026-01-01T00:00:00.000Z');
const passwordHash = `pbkdf2-sha256$100000$${'A'.repeat(22)}$${'B'.repeat(43)}`;

test('password accounts persist per dataset with unique usernames, scoped sessions, and audited operator roles', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'waspada-account-test-'));
  let database = await PGlite.create(dataDirectory);
  const executor = createExecutor(database);
  try {
    for (const role of [
      'waspada_public_reader',
      'waspada_l1_pipeline',
      'waspada_l2_grounding_reader',
      'waspada_l2_grounding_writer',
      'waspada_l2_proposal_writer',
      'waspada_l3_coordinator',
      'waspada_l4_freshness_writer',
      'waspada_l4_publication_outbox_delivery',
      'waspada_l4_publication_writer',
      'waspada_l4_report_revision_impact_reader',
      'waspada_l4_moderator_publication_writer',
    ]) {
      await executor.execute(`CREATE ROLE ${role}`);
    }
    await executor.execute(await readFile(accountsMigration, 'utf8'));
    await executor.execute(await readFile(passwordMigration, 'utf8'));

    const live = createAccountStore(executor, 'live');
    const demo = createAccountStore(executor, 'demo');

    const user = await live.createPasswordAccount({
      datasetMode: 'live', username: 'ayu.rani', passwordHash, displayName: 'Ayu Rani', role: 'user', now: iso(0),
    });
    assert.equal(user.role, 'user');
    assert.equal(user.email, null, 'password accounts have no email');
    assert.equal(user.onboarding_version, 0, 'self-registered users still complete onboarding');
    await assert.rejects(
      live.createPasswordAccount({ datasetMode: 'live', username: 'ayu.rani', passwordHash, displayName: 'Other', role: 'user', now: iso(1) }),
      AccountUsernameTakenError,
      'a duplicate username in one dataset is a typed conflict',
    );
    const demoUser = await demo.createPasswordAccount({
      datasetMode: 'demo', username: 'ayu.rani', passwordHash, displayName: 'Ayu Rani', role: 'user', now: iso(2),
    });
    assert.notEqual(demoUser.id, user.id, 'the same username is independent in another dataset');
    await assert.rejects(
      live.createPasswordAccount({ datasetMode: 'demo', username: 'wrong.dataset', passwordHash, displayName: 'X', role: 'user', now: iso(3) }),
      TypeError,
      'a store cannot create accounts for a different dataset',
    );
    await assert.rejects(
      live.createPasswordAccount({ datasetMode: 'live', username: 'needs.reason', passwordHash, displayName: 'Admin', role: 'admin', now: iso(3) }),
      TypeError,
      'operator-provisioned roles require an audit reason',
    );

    const admin = await live.createPasswordAccount({
      datasetMode: 'live', username: 'admin.seed', passwordHash, displayName: 'Admin Seed', role: 'admin',
      now: iso(4), reason: 'Initial operator provisioning for isolated test',
    });
    assert.equal(admin.onboarding_version, 1, 'operator-provisioned administrators are introduced at creation');
    const provisioningAudit = await executor.query<{ action: string; actor_kind: string; target_role_after: string }>(
      `SELECT action, actor_kind, target_role_after FROM waspada.account_admin_audit
       WHERE dataset_mode = 'live' AND target_account_id = $1::uuid`,
      [admin.id],
    );
    assert.deepEqual(provisioningAudit.rows, [{ action: 'account_provisioned', actor_kind: 'operator', target_role_after: 'admin' }]);

    const credential = await live.findPasswordCredentialByUsername('ayu.rani');
    assert.equal(credential?.account.id, user.id);
    assert.equal(credential?.passwordHash, passwordHash);
    assert.equal(await demo.findPasswordCredentialByUsername('ayu.rani').then((row) => row?.account.id), demoUser.id);
    assert.equal(await live.findPasswordCredentialByUsername('nobody.here'), null);

    const sessionToken = hash('session-token');
    const otherToken = hash('other-session');
    const csrfToken = 'c'.repeat(43);
    await live.createSession({
      accountId: user.id, tokenSha256: sessionToken, channel: 'web', csrfToken,
      createdAt: iso(5), idleExpiresAt: iso(5 + 30 * 60_000), absoluteExpiresAt: iso(5 + 8 * 60 * 60_000),
    });
    await live.createSession({
      accountId: user.id, tokenSha256: otherToken, channel: 'web', csrfToken,
      createdAt: iso(6), idleExpiresAt: iso(6 + 30 * 60_000), absoluteExpiresAt: iso(6 + 8 * 60 * 60_000),
    });
    assert.equal((await live.readSession(sessionToken, iso(7)))?.account.role, 'user');
    assert.equal(await demo.readSession(sessionToken, iso(7)), null, 'session lookup is dataset scoped');

    const nextHash = `pbkdf2-sha256$100000$${'C'.repeat(22)}$${'D'.repeat(43)}`;
    assert.equal(await live.setPasswordHash({ accountId: user.id, passwordHash: nextHash, now: iso(8), keepTokenSha256: sessionToken }), true);
    assert.equal(await live.readSession(otherToken, iso(9)), null, 'a password change revokes every other session');
    assert.notEqual(await live.readSession(sessionToken, iso(9)), null, 'the session that changed the password stays active');
    assert.equal((await live.findPasswordCredentialByAccountId(user.id))?.passwordHash, nextHash);

    const clientKey = hash('client-key');
    assert.equal(await live.consumeThrottle('login_client', clientKey, iso(30), 60_000, 2), true);
    assert.equal(await live.consumeThrottle('login_client', clientKey, iso(31), 60_000, 2), true);
    assert.equal(await live.consumeThrottle('login_client', clientKey, iso(32), 60_000, 2), false);
    assert.equal(await live.consumeThrottle('login_client', clientKey, iso(60_030), 60_000, 2), true,
      'the throttle starts a new window after expiry');
    assert.equal(await live.consumeThrottle('login_username', clientKey, iso(40), 60_000, 1), true,
      'username-keyed throttles are a separate scope from client-keyed throttles');

    const privileges = await executor.query<{ role_name: string; can_select: boolean; can_read_hash: boolean }>(
      `SELECT role_name,
              has_table_privilege(role_name, 'waspada.accounts', 'SELECT') AS can_select,
              has_column_privilege(role_name, 'waspada.accounts', 'password_hash', 'SELECT') AS can_read_hash
       FROM unnest(ARRAY[
         'waspada_auth_service', 'waspada_public_reader', 'waspada_l1_pipeline',
         'waspada_l2_grounding_reader', 'waspada_l2_grounding_writer',
         'waspada_l2_proposal_writer', 'waspada_l3_coordinator', 'waspada_l4_freshness_writer',
         'waspada_l4_publication_outbox_delivery', 'waspada_l4_publication_writer',
         'waspada_l4_report_revision_impact_reader',
         'waspada_l4_moderator_publication_writer'
       ]) AS role_name`);
    const byRole = Object.fromEntries(privileges.rows.map((row) => [row.role_name, row]));
    assert.equal(byRole.waspada_auth_service?.can_select, true);
    assert.equal(byRole.waspada_auth_service?.can_read_hash, true);
    for (const roleName of Object.keys(byRole)) {
      if (roleName === 'waspada_auth_service') continue;
      assert.equal(byRole[roleName]?.can_select, false, `${roleName} cannot read accounts`);
      assert.equal(byRole[roleName]?.can_read_hash, false, `${roleName} cannot read password hashes`);
    }
    const authPrivileges = await executor.query<{ can_delete_accounts: boolean; can_delete_audit: boolean }>(
      `SELECT has_table_privilege('waspada_auth_service', 'waspada.accounts', 'DELETE') AS can_delete_accounts,
              has_table_privilege('waspada_auth_service', 'waspada.account_admin_audit', 'DELETE') AS can_delete_audit`,
    );
    assert.deepEqual(authPrivileges.rows[0], { can_delete_accounts: false, can_delete_audit: false });

    await database.close();
    database = await PGlite.create(dataDirectory);
    const reopened = createAccountStore(createExecutor(database), 'live');
    const reopenedSession = await reopened.readSession(sessionToken, iso(60));
    assert.equal(reopenedSession?.account.id, user.id, 'account and session survive closing and reopening PGlite');
    assert.equal((await reopened.findPasswordCredentialByUsername('ayu.rani'))?.passwordHash, nextHash);
    const adminPage = await reopened.listAccounts(10, undefined, admin.id);
    assert.equal(adminPage.outcome, 'listed', 'a completed operator-provisioned admin can list accounts');
  } finally {
    await database.close();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

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

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function iso(offsetMilliseconds: number): string {
  return new Date(baseTime + offsetMilliseconds).toISOString();
}
