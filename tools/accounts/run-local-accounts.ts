import { createAccountStore } from '../../apps/db/src/accounts.js';
import { createAccountApi } from '../../apps/worker/src/accounts/index.js';
import { parseLocalAccountOptions } from './config.js';
import { openLocalAccountDatabase } from './database.js';
import { DEMO_ACCOUNTS, seedSyntheticAccounts } from './demo-accounts.js';
import { startLocalAccountServer } from './http-server.js';

async function main() {
  const options = parseLocalAccountOptions(process.argv.slice(2));
  if (!options.enabled || !options.demo || options.state === null) {
    console.log(JSON.stringify({ status: 'disabled', reason: 'explicit_synthetic_profile_required' }));
    return;
  }
  const database = await openLocalAccountDatabase(options.state);
  let server: Awaited<ReturnType<typeof startLocalAccountServer>> | undefined;
  try {
    const store = createAccountStore(database.executor, 'demo');
    if (database.seedRequired) {
      await seedSyntheticAccounts(store, new Date().toISOString());
      await database.markSeeded();
    }
    const api = createAccountApi({
      enabled: true,
      store,
      appOrigin: options.origin,
      datasetMode: 'demo',
      cookieMode: 'loopback',
      trustedClientKey: () => 'owned-loopback-synthetic-client',
    });
    server = await startLocalAccountServer(api, { appOrigin: options.origin });
    // Only usernames are printed. The synthetic password is documented in demo-accounts.ts.
    console.log(JSON.stringify({
      status: 'ready',
      mode: 'synthetic-demo',
      port: server.port,
      state: options.state,
      usernames: DEMO_ACCOUNTS.map((profile) => profile.username),
    }));
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
  } finally {
    await server?.close();
    await database.close();
  }
}

main().catch(() => {
  console.error(JSON.stringify({ status: 'unavailable', reason: 'local_account_startup_failed_check_profile_and_port' }));
  process.exitCode = 1;
});
