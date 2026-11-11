import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import { createTestDatabase } from './harness.js';

const validHash = `pbkdf2-sha256$100000$${'A'.repeat(22)}$${'B'.repeat(43)}`;

test('migration 045 keeps legacy Google rows valid and enforces password-account invariants', async () => {
  const { executor, close } = await createTestDatabase();
  try {
    const migrations = await readMigrations(new URL('../migrations/', import.meta.url));
    const through036 = migrations.filter(({ version }) => version <= '036_accounts');
    const before = await applyMigrations(executor, through036);
    assert.equal(before.applied.length, through036.length);

    // A legacy Google row created before 045 must survive the migration unchanged.
    await executor.execute(`
      INSERT INTO waspada.accounts (
        dataset_mode, identity_issuer, identity_subject, display_name, email, role, active,
        onboarding_version, onboarding_completed_at, version, created_at, updated_at
      ) VALUES ('live', 'https://accounts.google.com', 'legacy-subject', 'Legacy', 'legacy@example.test',
        'user', true, 0, NULL, 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
    `);
    const applied = await applyMigrations(executor, migrations);
    assert.ok(applied.applied.includes('045_password_accounts'));
    const legacy = await executor.query<{ username: string | null; email: string }>(
      "SELECT username, email FROM waspada.accounts WHERE identity_subject = 'legacy-subject'",
    );
    assert.deepEqual(legacy.rows, [{ username: null, email: 'legacy@example.test' }]);

    await assert.rejects(
      executor.execute(insertAccount({ username: 'UpperCase', hash: validHash })),
      /accounts_username_format/u,
      'usernames are stored lowercase and within the format',
    );
    await assert.rejects(
      executor.execute(insertAccount({ username: 'ab', hash: validHash })),
      /accounts_username_format/u,
      'usernames need at least three characters',
    );
    await assert.rejects(
      executor.execute(insertAccount({ username: 'bad.hash', hash: 'plaintext-password' })),
      /accounts_password_hash_format/u,
      'only the PBKDF2 encoding is accepted',
    );
    await assert.rejects(
      executor.execute(insertAccount({ username: 'no.hash', hash: null })),
      /accounts_password_credentials_paired/u,
      'a username without a hash is rejected',
    );
    await assert.rejects(
      executor.execute(insertAccount({ username: null, hash: validHash })),
      /accounts_password_credentials_paired|accounts_has_login_method/u,
      'a hash without a username is rejected',
    );
    await assert.rejects(
      executor.execute(`
        INSERT INTO waspada.accounts (dataset_mode, display_name, role, created_at, updated_at)
        VALUES ('live', 'No Login', 'user', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
      `),
      /accounts_has_login_method/u,
      'an account needs either a password credential or a complete external identity',
    );
    await assert.rejects(
      executor.execute(`
        INSERT INTO waspada.accounts (dataset_mode, identity_issuer, identity_subject, display_name, role, created_at, updated_at)
        VALUES ('live', 'https://accounts.google.com', 'no-email', 'No Email', 'user', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
      `),
      /accounts_identity_has_email/u,
      'Google identities still require an email',
    );
    await assert.rejects(
      executor.execute(`
        INSERT INTO waspada.accounts (dataset_mode, identity_issuer, identity_subject, display_name, email, role, created_at, updated_at)
        VALUES ('live', 'https://example.invalid', 'other', 'Other', 'o@example.test', 'user', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
      `),
      /accounts_identity_issuer_check|check constraint/u,
      'non-Google issuers stay outside the accepted identities',
    );

    await executor.execute(insertAccount({ username: 'ayu.rani', hash: validHash }));
    await assert.rejects(
      executor.execute(insertAccount({ username: 'ayu.rani', hash: validHash })),
      /accounts_dataset_username_unique/u,
      'usernames are unique within one dataset',
    );
    await executor.execute(insertAccount({ username: 'ayu.rani', hash: validHash, dataset: 'demo' }));
    const counts = await executor.query<{ dataset_mode: string; total: string }>(
      "SELECT dataset_mode, count(*)::text AS total FROM waspada.accounts WHERE username = 'ayu.rani' GROUP BY dataset_mode ORDER BY dataset_mode",
    );
    assert.deepEqual(
      counts.rows,
      [{ dataset_mode: 'demo', total: '1' }, { dataset_mode: 'live', total: '1' }],
      'the same username can exist once in each dataset',
    );

    const scopes = await executor.query<{ allowed: boolean }>(`
      SELECT (pg_get_constraintdef(oid) LIKE '%login_username%') AS allowed
      FROM pg_constraint WHERE conname = 'account_login_throttles_scope_check'`);
    assert.deepEqual(scopes.rows, [{ allowed: true }], 'the throttle scope check admits username-keyed throttles');
  } finally {
    await close();
  }
});

function insertAccount(options: { username: string | null; hash: string | null; dataset?: string }): string {
  const dataset = options.dataset ?? 'live';
  const username = options.username === null ? 'NULL' : `'${options.username}'`;
  const hash = options.hash === null ? 'NULL' : `'${options.hash}'`;
  return `
    INSERT INTO waspada.accounts (
      dataset_mode, username, password_hash, display_name, role, active,
      onboarding_version, onboarding_completed_at, version, created_at, updated_at
    ) VALUES ('${dataset}', ${username}, ${hash}, 'Test', 'user', true, 0, NULL, 1,
      '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
  `;
}
