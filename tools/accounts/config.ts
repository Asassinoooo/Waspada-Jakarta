export interface LocalAccountOptions {
  readonly enabled: boolean;
  readonly demo: boolean;
  readonly state: string | null;
  readonly origin: string;
}

/** The local executable supports synthetic identities only, never a production bypass. */
export function parseLocalAccountOptions(args: readonly string[]): LocalAccountOptions {
  let enabled = false;
  let demo = false;
  let state: string | null = null;
  let origin = 'http://127.0.0.1:5173';
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (seen.has(flag)) throw new Error('invalid_local_account_options');
    seen.add(flag);
    if (flag === '--enable') enabled = true;
    else if (flag === '--demo') demo = true;
    else if (flag === '--state' || flag === '--origin') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('invalid_local_account_options');
      if (flag === '--state') state = value;
      else origin = value;
    } else throw new Error('invalid_local_account_options');
  }
  if (state !== null && !/^[a-z][a-z0-9-]{0,47}$/.test(state)) throw new Error('invalid_local_account_options');
  if (origin !== 'http://127.0.0.1:5173' && origin !== 'http://localhost:5173') throw new Error('invalid_local_account_options');
  if (enabled && (!demo || state === null)) throw new Error('explicit_synthetic_profile_required');
  return { enabled, demo, state, origin };
}
