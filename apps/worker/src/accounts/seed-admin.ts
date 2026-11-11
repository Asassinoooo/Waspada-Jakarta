import { AccountUsernameTakenError, type AccountStore } from '../../../db/src/accounts.js';
import { hashPassword, normaliseUsername, validatePasswordPolicy } from './password.js';

export type SeedAdminResult =
  | { readonly status: 'created'; readonly username: string }
  | { readonly status: 'exists'; readonly username: string };

/**
 * Operator-only bootstrap for the first administrator. It never changes an existing account,
 * so re-running it cannot escalate or reset anyone. Errors carry only a short code.
 */
export async function seedAdminAccount(
  store: AccountStore,
  input: { readonly username: string; readonly password: string; readonly now: string },
): Promise<SeedAdminResult> {
  const username = normaliseUsername(input.username);
  if (username === null) throw new Error('admin_username_invalid');
  const policy = validatePasswordPolicy(input.password);
  if (!policy.ok) throw new Error(policy.code);
  if (await store.findPasswordCredentialByUsername(username)) return { status: 'exists', username };
  try {
    await store.createPasswordAccount({
      datasetMode: store.datasetMode,
      username,
      passwordHash: await hashPassword(input.password),
      displayName: username,
      role: 'admin',
      now: input.now,
      reason: 'Operator-seeded administrator account',
    });
  } catch (error) {
    if (error instanceof AccountUsernameTakenError) return { status: 'exists', username };
    throw error;
  }
  return { status: 'created', username };
}
