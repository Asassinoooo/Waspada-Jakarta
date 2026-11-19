import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createAccountStore } from '../src/accounts.js';
import type { SqlExecutor, TransactionalSqlExecutor } from '../src/sql.js';

/**
 * ST-F-09 (FR-12, FR-15): an administrator changes another user's role with a reason. The real account store
 * and the real migrations run on an in-memory PGlite. The tests read the audit rows back from the table, rather
 * than trusting the returned outcome. The worker route (accounts-api.test.ts) covers the 403, CSRF and 400
 * refusals with a fake store; this file covers what the database keeps.
 */

const accountsMigration = new URL('../migrations/036_accounts.sql', import.meta.url);
const passwordMigration = new URL('../migrations/045_password_accounts.sql', import.meta.url);
const passwordHash = `pbkdf2-sha256$100000$${'A'.repeat(22)}$${'B'.repeat(43)}`;
const baseTime = Date.parse('2026-11-01T00:00:00.000Z');

test('an administrator role change is refused without a reason or a current version, and audited with its reason when it lands', async () => {
  const database = new PGlite();
  try {
    for (const role of [
      'waspada_public_reader', 'waspada_l1_pipeline', 'waspada_l2_grounding_reader', 'waspada_l2_grounding_writer',
      'waspada_l2_proposal_writer', 'waspada_l3_coordinator', 'waspada_l4_freshness_writer',
      'waspada_l4_publication_outbox_delivery', 'waspada_l4_publication_writer',
      'waspada_l4_report_revision_impact_reader', 'waspada_l4_moderator_publication_writer',
    ]) {
      await database.exec(`CREATE ROLE ${role}`);
    }
    await database.exec(await readFile(accountsMigration, 'utf8'));
    await database.exec(await readFile(passwordMigration, 'utf8'));
    const executor = createExecutor(database);
    const store = createAccountStore(executor, 'live');

    const admin = await store.createPasswordAccount({
      datasetMode: 'live', username: 'admin.role', passwordHash, displayName: 'Admin Peran', role: 'admin',
      now: iso(0), reason: 'Penyediaan operator awal untuk uji peran',
    });
    const user = await store.createPasswordAccount({
      datasetMode: 'live', username: 'warga.peran', passwordHash, displayName: 'Warga Peran', role: 'user', now: iso(1),
    });
    const sessionToken = hash('warga-session');
    await store.createSession({
      accountId: user.id, tokenSha256: sessionToken, channel: 'web', csrfToken: 'c'.repeat(43),
      createdAt: iso(2), idleExpiresAt: iso(2 + 30 * 60_000), absoluteExpiresAt: iso(2 + 8 * 60 * 60_000),
    });
    assert.notEqual(await store.readSession(sessionToken, iso(3)), null, 'the target has a live session before the change');

    const auditFor = async (targetId: string) => (await executor.query<{
      action: string;
      actor_kind: string;
      actor_account_id: string | null;
      reason: string;
      target_role_before: string | null;
      target_role_after: string | null;
      expected_version: number | null;
      target_version_after: number | null;
    }>(
      `SELECT action, actor_kind, actor_account_id::text AS actor_account_id, reason, target_role_before,
              target_role_after, expected_version, target_version_after
       FROM waspada.account_admin_audit
       WHERE dataset_mode = 'live' AND target_account_id = $1::uuid
       ORDER BY occurred_at ASC, action ASC`,
      [targetId],
    )).rows;
    const roleOf = async (accountId: string) => (await store.findPasswordCredentialByAccountId(accountId))?.account.role;

    assert.deepEqual(await auditFor(user.id), [], 'a plain user provisioned without a reason has no audit row');

    // Refusals: each one leaves the role, the version and the audit trail unchanged.
    await assert.rejects(
      store.updateAccountByAdmin({
        actorAccountId: admin.id, targetAccountId: user.id, role: 'moderator', active: true,
        expectedVersion: user.version, reason: '   ', occurredAt: iso(10),
      }),
      TypeError,
      'a blank reason is refused before any write',
    );
    assert.equal(await roleOf(user.id), 'user');
    assert.deepEqual(await auditFor(user.id), []);

    const stale = await store.updateAccountByAdmin({
      actorAccountId: admin.id, targetAccountId: user.id, role: 'moderator', active: true,
      expectedVersion: user.version + 5, reason: 'Versi lama dari layar admin', occurredAt: iso(11),
    });
    assert.deepEqual(stale, { outcome: 'conflict' }, 'a stale expected version is a conflict');
    assert.equal(await roleOf(user.id), 'user');
    assert.deepEqual(await auditFor(user.id), [], 'a conflict writes no audit row');
    assert.notEqual(await store.readSession(sessionToken, iso(12)), null, 'a conflict revokes no session');

    const self = await store.updateAccountByAdmin({
      actorAccountId: admin.id, targetAccountId: admin.id, role: 'user', active: true,
      expectedVersion: admin.version, reason: 'Mengubah peran diri sendiri', occurredAt: iso(13),
    });
    assert.deepEqual(self, { outcome: 'conflict' }, 'an administrator cannot change their own role');
    assert.equal(await roleOf(admin.id), 'admin');

    const byUser = await store.updateAccountByAdmin({
      actorAccountId: user.id, targetAccountId: admin.id, role: 'user', active: true,
      expectedVersion: admin.version, reason: 'Diubah oleh pengguna biasa', occurredAt: iso(14),
    });
    assert.deepEqual(byUser, { outcome: 'forbidden' }, 'only a completed administrator can change roles');
    assert.equal(await roleOf(admin.id), 'admin');

    // The landing change: a reason, the current version, and a moderator role.
    const updated = await store.updateAccountByAdmin({
      actorAccountId: admin.id, targetAccountId: user.id, role: 'moderator', active: true,
      expectedVersion: user.version, reason: '  Peran moderator untuk tinjauan usulan  ', occurredAt: iso(20),
    });
    assert.equal(updated.outcome, 'updated');
    if (updated.outcome !== 'updated') return;
    assert.equal(updated.account.role, 'moderator');
    assert.equal(updated.account.version, user.version + 1);

    assert.deepEqual(await auditFor(user.id), [{
      action: 'account_updated',
      actor_kind: 'admin',
      actor_account_id: admin.id,
      reason: 'Peran moderator untuk tinjauan usulan',
      target_role_before: 'user',
      target_role_after: 'moderator',
      expected_version: user.version,
      target_version_after: user.version + 1,
    }], 'one audit row names the administrator, the reason (trimmed), both roles and both versions');

    assert.equal(await store.readSession(sessionToken, iso(21)), null, 'the role change revokes the target session');

    // Replaying the same request with the now-stale version changes nothing and adds no row.
    const replay = await store.updateAccountByAdmin({
      actorAccountId: admin.id, targetAccountId: user.id, role: 'user', active: true,
      expectedVersion: user.version, reason: 'Pengulangan permintaan lama', occurredAt: iso(22),
    });
    assert.deepEqual(replay, { outcome: 'conflict' });
    assert.equal(await roleOf(user.id), 'moderator');
    assert.equal((await auditFor(user.id)).length, 1, 'the replay adds no second audit row');
  } finally {
    await database.close();
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
