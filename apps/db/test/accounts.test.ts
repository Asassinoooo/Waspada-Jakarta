import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createAccountStore } from '../src/accounts.js';
import type { SqlExecutor, TransactionalSqlExecutor } from '../src/sql.js';

const migrationPath = new URL('../migrations/036_accounts.sql', import.meta.url);
const baseTime = Date.parse('2026-01-01T00:00:00.000Z');

test('account store persists dataset-scoped identities, sessions, attempts, throttles, and audited admin changes', async () => {
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
    await executor.execute(await readFile(migrationPath, 'utf8'));

    const live = createAccountStore(executor, 'live');
    const demo = createAccountStore(executor, 'demo');
    const identity = googleIdentity('subject-1');
    const provisionedAdmin = await live.provisionAccount({
      identity,
      role: 'admin',
      reason: 'Initial operator provisioning for isolated test',
      now: iso(0),
    });
    const user = await live.findOrCreateVerifiedAccount(identity, iso(1));
    assert.equal(user.id, provisionedAdmin.id);
    assert.equal(user.role, 'admin', 'normal sign-in must preserve an explicitly provisioned role');
    assert.equal(user.version, provisionedAdmin.version);

    const demoUser = await demo.findOrCreateVerifiedAccount(identity, iso(2));
    assert.notEqual(demoUser.id, user.id);
    assert.equal(demoUser.role, 'user', 'a live privilege must not carry into the demo dataset');

    const completedAdmin = await live.completeOnboarding(user.id, 1, iso(3));
    assert.equal(completedAdmin?.onboarding_version, 1);
    const alreadyCompleted = await live.completeOnboarding(user.id, 1, iso(4));
    assert.equal(alreadyCompleted?.version, completedAdmin?.version, 'onboarding completion is idempotent');
    const livePage = await live.listAccounts(10, undefined, user.id);
    assert.equal(livePage.outcome, 'listed', 'completed live admins can list only their server-bound dataset');
    assert.equal((await demo.listAccounts(10, undefined, demoUser.id)).outcome, 'forbidden',
      'demo users cannot list accounts even when they know an account id');

    const sessionToken = hash('session-token');
    const targetSessionToken = hash('target-session');
    const csrfToken = 'c'.repeat(43);
    await live.createSession({
      accountId: user.id,
      tokenSha256: sessionToken,
      channel: 'web',
      csrfToken,
      createdAt: iso(5),
      idleExpiresAt: iso(5 + 30 * 60_000),
      absoluteExpiresAt: iso(5 + 8 * 60 * 60_000),
    });
    const session = await live.readSession(sessionToken, iso(6));
    assert.equal(session?.channel, 'web');
    assert.equal(session?.csrfToken, csrfToken);
    assert.equal(session?.account.role, 'admin');
    assert.equal(await demo.readSession(sessionToken, iso(7)), null, 'session lookup is dataset scoped');

    const target = await live.findOrCreateVerifiedAccount(googleIdentity('subject-2'), iso(8));
    await live.createSession({
      accountId: target.id,
      tokenSha256: targetSessionToken,
      channel: 'web',
      csrfToken,
      createdAt: iso(9),
      idleExpiresAt: iso(9 + 30 * 60_000),
      absoluteExpiresAt: iso(9 + 8 * 60 * 60_000),
    });
    const updated = await live.updateAccountByAdmin({
      actorAccountId: user.id,
      targetAccountId: target.id,
      role: 'moderator',
      active: false,
      expectedVersion: target.version,
      reason: 'Disable account after verified report',
      occurredAt: iso(10),
    });
    assert.equal(updated.outcome, 'updated');
    if (updated.outcome !== 'updated') assert.fail('expected target update');
    assert.equal(updated.account.role, 'moderator');
    assert.equal(updated.account.active, false);
    assert.equal(await live.readSession(targetSessionToken, iso(11)), null, 'admin changes revoke target sessions');

    const stale = await live.updateAccountByAdmin({
      actorAccountId: user.id,
      targetAccountId: target.id,
      role: 'user',
      active: true,
      expectedVersion: target.version,
      reason: 'Stale update must conflict',
      occurredAt: iso(12),
    });
    assert.equal(stale.outcome, 'conflict');
    const selfUpdate = await live.updateAccountByAdmin({
      actorAccountId: user.id,
      targetAccountId: user.id,
      role: 'user',
      active: false,
      expectedVersion: user.version,
      reason: 'Self change denied',
      occurredAt: iso(13),
    });
    assert.equal(selfUpdate.outcome, 'conflict');

    const audit = await executor.query<{ action: string; reason: string; actor_kind: string }>(
      `SELECT action, reason, actor_kind FROM waspada.account_admin_audit
       WHERE dataset_mode = 'live' AND target_account_id = $1::uuid`,
      [target.id],
    );
    assert.deepEqual(audit.rows, [{
      action: 'account_updated',
      reason: 'Disable account after verified report',
      actor_kind: 'admin',
    }]);
    await assert.rejects(
      executor.execute('DELETE FROM waspada.account_admin_audit'),
      /append-only/u,
      'audit records cannot be deleted even by the table owner',
    );

    await live.createLoginAttempt({
      stateSha256: hash('oauth-state'),
      browserCookieSha256: hash('browser-cookie'),
      priorSessionTokenSha256: hash('prior-session-cookie'),
      codeVerifier: 'v'.repeat(43),
      nonce: 'n'.repeat(32),
      returnTo: '#mulai',
      createdAt: iso(20),
      expiresAt: iso(20 + 5 * 60_000),
    });
    assert.equal(await live.claimLoginAttempt(hash('oauth-state'), hash('wrong-cookie'), iso(21)), null);
    assert.deepEqual(
      await live.claimLoginAttempt(hash('oauth-state'), hash('browser-cookie'), iso(22)),
      {
        codeVerifier: 'v'.repeat(43),
        nonce: 'n'.repeat(32),
        returnTo: '#mulai',
        priorSessionTokenSha256: hash('prior-session-cookie'),
      },
    );
    assert.equal(await live.claimLoginAttempt(hash('oauth-state'), hash('browser-cookie'), iso(23)), null,
      'OAuth login attempts are single-use');

    const clientKey = hash('client-key');
    assert.equal(await live.consumeThrottle('web_start', clientKey, iso(30), 60_000, 2), true);
    assert.equal(await live.consumeThrottle('web_start', clientKey, iso(31), 60_000, 2), true);
    assert.equal(await live.consumeThrottle('web_start', clientKey, iso(32), 60_000, 2), false);
    assert.equal(await live.consumeThrottle('web_start', clientKey, iso(60_030), 60_000, 2), true,
      'the throttle starts a new window after expiry');

    const privileges = await executor.query<{ role_name: string; can_select: boolean }>(
      `SELECT role_name,
              has_table_privilege(role_name, 'waspada.accounts', 'SELECT') AS can_select
       FROM unnest(ARRAY[
         'waspada_auth_service', 'waspada_public_reader', 'waspada_l1_pipeline',
         'waspada_l2_grounding_reader', 'waspada_l2_grounding_writer',
         'waspada_l2_proposal_writer', 'waspada_l3_coordinator', 'waspada_l4_freshness_writer',
         'waspada_l4_publication_outbox_delivery', 'waspada_l4_publication_writer',
         'waspada_l4_report_revision_impact_reader',
         'waspada_l4_moderator_publication_writer'
       ]) AS role_name`);
    assert.deepEqual(
      Object.fromEntries(privileges.rows.map((row) => [row.role_name, row.can_select])),
      {
        waspada_auth_service: true,
        waspada_public_reader: false,
        waspada_l1_pipeline: false,
        waspada_l2_grounding_reader: false,
        waspada_l2_grounding_writer: false,
        waspada_l2_proposal_writer: false,
        waspada_l3_coordinator: false,
        waspada_l4_freshness_writer: false,
        waspada_l4_publication_outbox_delivery: false,
        waspada_l4_publication_writer: false,
        waspada_l4_report_revision_impact_reader: false,
        waspada_l4_moderator_publication_writer: false,
      },
    );
    const authPrivileges = await executor.query<{ can_delete_accounts: boolean; can_delete_audit: boolean }>(
      `SELECT has_table_privilege('waspada_auth_service', 'waspada.accounts', 'DELETE') AS can_delete_accounts,
              has_table_privilege('waspada_auth_service', 'waspada.account_admin_audit', 'DELETE') AS can_delete_audit`,
    );
    assert.deepEqual(authPrivileges.rows[0], { can_delete_accounts: false, can_delete_audit: false });

    await database.close();
    database = await PGlite.create(dataDirectory);
    const reopenedLive = createAccountStore(createExecutor(database), 'live');
    const reopenedSession = await reopenedLive.readSession(sessionToken, iso(60));
    assert.equal(reopenedSession?.account.id, user.id, 'account and session survive closing and reopening PGlite');
    assert.equal(reopenedSession?.account.role, 'admin');
    assert.equal(reopenedSession?.account.onboarding_version, 1);
    assert.equal((await reopenedLive.completeOnboarding(user.id, 1, iso(61)))?.version, completedAdmin?.version,
      'onboarding version remains durable and idempotent after reopen');
    const demotedAdmin = await reopenedLive.provisionAccount({
      identity,
      role: 'user',
      reason: 'Operator demotion revokes stale authority',
      now: iso(62),
    });
    assert.equal(demotedAdmin.role, 'user');
    assert.equal((await reopenedLive.listAccounts(10, undefined, user.id)).outcome, 'forbidden',
      'the store revalidates the current actor role inside the account-list transaction');
    assert.equal(await reopenedLive.readSession(sessionToken, iso(63)), null,
      'out-of-band role changes revoke existing sessions');
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

function googleIdentity(subject: string) {
  return {
    issuer: 'https://accounts.google.com',
    subject,
    displayName: `Test ${subject}`,
    email: `${subject}@example.test`,
    emailVerified: true,
  } as const;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function iso(offsetMilliseconds: number): string {
  return new Date(baseTime + offsetMilliseconds).toISOString();
}
