import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createAccountStore } from '../src/accounts.js';
import type { SqlExecutor, TransactionalSqlExecutor } from '../src/sql.js';

/**
 * NFR-07 (retention and session expiry, B and C2). A session is refused at its idle limit, at its absolute limit,
 * and after revocation. Expired session rows and expired login state are purged, in bounded batches, within one
 * dataset only. PGlite and synthetic fixtures; no network.
 */

const accountsMigration = new URL('../migrations/036_accounts.sql', import.meta.url);
const passwordMigration = new URL('../migrations/045_password_accounts.sql', import.meta.url);
const baseTime = Date.parse('2026-01-01T00:00:00.000Z');
const passwordHash = `pbkdf2-sha256$100000$${'A'.repeat(22)}$${'B'.repeat(43)}`;
const csrfToken = 'c'.repeat(43);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const roles = [
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
];

async function openDatabase() {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'waspada-nfr07-session-'));
  const database = await PGlite.create(dataDirectory);
  const executor = createExecutor(database);
  for (const role of roles) await executor.execute(`CREATE ROLE ${role}`);
  await executor.execute(await readFile(accountsMigration, 'utf8'));
  await executor.execute(await readFile(passwordMigration, 'utf8'));
  return { database, executor, dataDirectory };
}

test('NFR-07 C2: a session is refused at its idle limit, its absolute limit or after revocation, and an active one slides its idle window', async () => {
  const { database, dataDirectory, executor } = await openDatabase();
  try {
    const live = createAccountStore(executor, 'live');
    const user = await live.createPasswordAccount({
      datasetMode: 'live', username: 'sesi.uji', passwordHash, displayName: 'Sesi Uji', role: 'user', now: iso(0),
    });
    const sessionFor = (label: string, idleMs: number, absoluteMs: number) => {
      const token = hash(label);
      return live.createSession({
        accountId: user.id, tokenSha256: token, channel: 'web', csrfToken,
        createdAt: iso(0), idleExpiresAt: iso(idleMs), absoluteExpiresAt: iso(absoluteMs),
      }).then(() => token);
    };

    const idle = await sessionFor('idle', 30 * MINUTE, 8 * HOUR);
    assert.equal(await live.readSession(idle, iso(30 * MINUTE)), null, 'refused at the idle limit');

    // The database keeps idle expiry at or before the absolute limit, so the absolute cap is seen only when sliding would pass it.
    const capped = await sessionFor('absolute-cap', 30 * MINUTE, HOUR);
    assert.notEqual(await live.readSession(capped, iso(20 * MINUTE)), null, 'used inside its idle window');
    assert.notEqual(await live.readSession(capped, iso(45 * MINUTE)), null, 'the idle window slides to the absolute limit');
    assert.equal(await live.readSession(capped, iso(61 * MINUTE)), null,
      'sliding never extends past the absolute limit (without the cap, idle would reach 75 minutes)');

    const revoked = await sessionFor('revoked', 30 * MINUTE, 8 * HOUR);
    assert.equal(await live.revokeSession(revoked, iso(MINUTE)), true);
    assert.equal(await live.readSession(revoked, iso(2 * MINUTE)), null, 'refused after revocation');

    const active = await sessionFor('active', 30 * MINUTE, 8 * HOUR);
    assert.notEqual(await live.readSession(active, iso(20 * MINUTE)), null, 'an active session is accepted');
    assert.notEqual(await live.readSession(active, iso(45 * MINUTE)), null,
      'the idle window slid forward on the earlier use, so 45 minutes is still inside it');
    assert.equal(await live.readSession(active, iso(8 * HOUR)), null, 'the absolute limit still ends the session');
  } finally {
    await database.close();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test('NFR-07 B: cleanupExpired purges only expired or long-revoked sessions and expired login state, in bounded batches, within one dataset', async () => {
  const { database, dataDirectory, executor } = await openDatabase();
  try {
    const live = createAccountStore(executor, 'live');
    const demo = createAccountStore(executor, 'demo');
    const user = await live.createPasswordAccount({
      datasetMode: 'live', username: 'purge.uji', passwordHash, displayName: 'Purge Uji', role: 'user', now: iso(0),
    });
    const far = 200 * HOUR;
    const put = (label: string, idleMs: number, absoluteMs: number) => live.createSession({
      accountId: user.id, tokenSha256: hash(label), channel: 'web', csrfToken,
      createdAt: iso(0), idleExpiresAt: iso(idleMs), absoluteExpiresAt: iso(absoluteMs),
    });
    await put('expired-idle', 30 * MINUTE, 8 * HOUR);
    await put('expired-window', 30 * MINUTE, HOUR);
    await put('active', far, far);
    await put('revoked-recently', far, far);
    await put('revoked-long-ago', far, far);
    await live.revokeSession(hash('revoked-recently'), iso(20 * HOUR));
    await live.revokeSession(hash('revoked-long-ago'), iso(0));

    // Throttles and login state: the first expires one minute after its window opens, the second much later.
    assert.equal(await live.consumeThrottle('login_client', hash('client-old'), iso(0), MINUTE, 1), true);
    assert.equal(await live.consumeThrottle('login_client', hash('client-new'), iso(25 * HOUR), MINUTE, 1), true);
    await executor.query(
      `INSERT INTO waspada.account_login_attempts
         (dataset_mode, state_sha256, browser_cookie_sha256, code_verifier, nonce, return_to, created_at, expires_at)
       VALUES ('live', $1, $2, $3, $4, '#akun', $5::timestamptz, $6::timestamptz),
              ('live', $7, $2, $3, $4, '#akun', $8::timestamptz, $9::timestamptz)`,
      [
        hash('state-old'), hash('cookie'), 'v'.repeat(43), 'n'.repeat(16), iso(0), iso(10 * MINUTE),
        hash('state-new'), iso(25 * HOUR), iso(25 * HOUR + 10 * MINUTE),
      ],
    );

    assert.equal(await demo.cleanupExpired(iso(25 * HOUR), 50), 0, 'a demo purge never touches live rows');

    const now = iso(25 * HOUR);
    const removed = await live.cleanupExpired(now, 50);
    assert.equal(removed, 5, 'three sessions, one login attempt and one throttle are purged');
    const survivors = await executor.query<{ token_sha256: string }>(
      `SELECT token_sha256 FROM waspada.account_sessions WHERE dataset_mode = 'live' ORDER BY token_sha256`,
    );
    assert.deepEqual(
      survivors.rows.map((row) => row.token_sha256).sort(),
      [hash('active'), hash('revoked-recently')].sort(),
      'the active session and the session revoked less than a day ago remain',
    );
    const attempts = await executor.query<{ state_sha256: string }>(
      `SELECT state_sha256 FROM waspada.account_login_attempts WHERE dataset_mode = 'live'`,
    );
    assert.deepEqual(attempts.rows.map((row) => row.state_sha256), [hash('state-new')], 'only the unexpired login state remains');
    assert.notEqual(await live.readSession(hash('active'), now), null, 'an active session still reads after the purge');
  } finally {
    await database.close();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test('NFR-07 B: a purge batch is bounded, and an invalid bound is refused before any delete', async () => {
  const { database, dataDirectory, executor } = await openDatabase();
  try {
    const live = createAccountStore(executor, 'live');
    const user = await live.createPasswordAccount({
      datasetMode: 'live', username: 'batas.uji', passwordHash, displayName: 'Batas Uji', role: 'user', now: iso(0),
    });
    for (const label of ['old-1', 'old-2']) {
      await live.createSession({
        accountId: user.id, tokenSha256: hash(label), channel: 'web', csrfToken,
        createdAt: iso(0), idleExpiresAt: iso(MINUTE), absoluteExpiresAt: iso(HOUR),
      });
    }
    await assert.rejects(live.cleanupExpired(iso(2 * HOUR), 0), TypeError, 'a zero bound is invalid');
    await assert.rejects(live.cleanupExpired(iso(2 * HOUR), 1.5), TypeError, 'a fractional bound is invalid');
    const counts = await executor.query<{ rows: number }>(`SELECT COUNT(*)::int AS rows FROM waspada.account_sessions WHERE dataset_mode = 'live'`);
    assert.equal(counts.rows[0]?.rows, 2, 'an invalid bound deletes nothing');

    assert.equal(await live.cleanupExpired(iso(2 * HOUR), 1), 1, 'one batch removes at most the bound');
    assert.equal(await live.cleanupExpired(iso(2 * HOUR), 1), 1, 'the next batch removes the remainder');
    assert.equal(await live.cleanupExpired(iso(2 * HOUR), 1), 0, 'an empty table purges nothing');
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
