import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  hashPassword,
  normaliseUsername,
  validatePasswordPolicy,
  verifyPassword,
} from '../src/accounts/password.js';
import { seedAdminAccount } from '../src/accounts/seed-admin.js';
import { AccountUsernameTakenError, type AccountStore, type CreatePasswordAccountInput } from '../../db/src/accounts.js';

test('password hash round-trips, uses the documented encoding, and never stores the plaintext', async () => {
  const password = 'kata-sandi-rahasia-1';
  const stored = await hashPassword(password);
  assert.match(stored, /^pbkdf2-sha256\$100000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/u);
  assert.equal(stored.includes(password), false);
  assert.equal(await verifyPassword(password, stored), true);
  assert.equal(await verifyPassword('kata-sandi-salah-1', stored), false, 'a wrong password fails');
  assert.notEqual(await hashPassword(password), stored, 'every hash uses a fresh salt');
});

test('malformed or tampered stored hashes fail closed instead of throwing', async () => {
  const stored = await hashPassword('kata-sandi-rahasia-1');
  const [scheme, iterations, salt, key] = stored.split('$');
  const malformed = [
    '',
    'plaintext-password',
    `${scheme}$100000$${salt}`,
    `${scheme}$1000$${salt}$${key}`,
    `${scheme}$100000$${salt}$${key.slice(0, 42)}`,
    `md5$100000$${salt}$${key}`,
    `${scheme}$${iterations}$${salt!.slice(0, 20)}$${key}`,
    `${scheme}$99999999$${salt}$${key}`,
  ];
  for (const value of malformed) {
    assert.equal(await verifyPassword('kata-sandi-rahasia-1', value), false, `malformed hash rejected: ${value.slice(0, 12)}`);
  }
});

test('password policy enforces 10 to 256 characters', () => {
  assert.deepEqual(validatePasswordPolicy('a'.repeat(10)), { ok: true });
  assert.deepEqual(validatePasswordPolicy('a'.repeat(256)), { ok: true });
  assert.deepEqual(validatePasswordPolicy('a'.repeat(9)), { ok: false, code: 'password_too_short' });
  assert.deepEqual(validatePasswordPolicy('a'.repeat(257)), { ok: false, code: 'password_too_long' });
  assert.deepEqual(validatePasswordPolicy(undefined), { ok: false, code: 'password_invalid' });
});

test('usernames are trimmed, lowercased, and must match the stored format', () => {
  assert.equal(normaliseUsername('  Ayu.Rani_01 '), 'ayu.rani_01');
  assert.equal(normaliseUsername('ab'), null, 'too short');
  assert.equal(normaliseUsername('a'.repeat(33)), null, 'too long');
  assert.equal(normaliseUsername('no spaces'), null);
  assert.equal(normaliseUsername('emoji🙂'), null);
  assert.equal(normaliseUsername(42), null);
});

test('admin seeding creates the administrator once and never changes an existing account', async () => {
  const created: CreatePasswordAccountInput[] = [];
  const existing = new Set<string>();
  const store = {
    datasetMode: 'live',
    async findPasswordCredentialByUsername(username: string) {
      return existing.has(username) ? { account: {} as never, passwordHash: 'x' } : null;
    },
    async createPasswordAccount(input: CreatePasswordAccountInput) {
      if (existing.has(input.username)) throw new AccountUsernameTakenError();
      created.push(input);
      existing.add(input.username);
      return {} as never;
    },
  } as unknown as AccountStore;

  const first = await seedAdminAccount(store, { username: 'Admin.Utama', password: 'sandi-admin-2026', now: '2026-11-08T00:00:00.000Z' });
  assert.deepEqual(first, { status: 'created', username: 'admin.utama' });
  assert.equal(created[0]?.role, 'admin');
  assert.equal(created[0]?.reason, 'Operator-seeded administrator account');
  assert.notEqual(created[0]?.passwordHash, 'sandi-admin-2026');
  const second = await seedAdminAccount(store, { username: 'admin.utama', password: 'sandi-lain-2026', now: '2026-11-08T00:00:00.000Z' });
  assert.deepEqual(second, { status: 'exists', username: 'admin.utama' });
  assert.equal(created.length, 1, 'a second run does not create or reset anything');

  await assert.rejects(
    seedAdminAccount(store, { username: 'admin.kedua', password: 'pendek', now: '2026-11-08T00:00:00.000Z' }),
    /password_too_short/u,
    'the error carries only the policy code, never the password',
  );
  await assert.rejects(
    seedAdminAccount(store, { username: 'bad name', password: 'sandi-admin-2026', now: '2026-11-08T00:00:00.000Z' }),
    /admin_username_invalid/u,
  );
});
