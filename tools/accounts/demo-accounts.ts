import type { AccountRole, AccountStore } from '../../apps/db/src/accounts.js';
import { hashPassword } from '../../apps/worker/src/accounts/password.js';

/**
 * Synthetic local fixtures for the isolated demo dataset only. The password below is a
 * documented test value for throwaway local accounts, not a credential, and it is never
 * printed by the runner. These accounts are never created in the live dataset.
 */
export const SYNTHETIC_DEMO_PASSWORD = 'contoh-sandi-lokal-2026';

export interface SyntheticDemoProfile {
  readonly username: string;
  readonly displayName: string;
  readonly role: AccountRole;
}

export const DEMO_ACCOUNTS: readonly SyntheticDemoProfile[] = Object.freeze([
  { username: 'demo.warga', displayName: 'Warga Demo', role: 'user' },
  { username: 'demo.moderator', displayName: 'Moderator Demo', role: 'moderator' },
  { username: 'demo.admin', displayName: 'Administrator Demo', role: 'admin' },
]);

/** Seeds the synthetic profiles into the demo dataset. Operator roles are audited as provisioned. */
export async function seedSyntheticAccounts(store: AccountStore, now: string): Promise<void> {
  if (store.datasetMode !== 'demo') throw new TypeError('Synthetic accounts belong only to the demo dataset.');
  const passwordHash = await hashPassword(SYNTHETIC_DEMO_PASSWORD);
  for (const profile of DEMO_ACCOUNTS) {
    await store.createPasswordAccount({
      datasetMode: 'demo',
      username: profile.username,
      passwordHash,
      displayName: profile.displayName,
      role: profile.role,
      now,
      ...(profile.role === 'user' ? {} : { reason: 'Explicit isolated local synthetic account fixture' }),
    });
  }
}
