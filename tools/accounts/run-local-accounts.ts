import { createAccountStore } from '../../apps/db/src/accounts.js';
import { createAccountApi } from '../../apps/worker/src/accounts/index.js';
import { parseLocalAccountOptions } from './config.js';
import { openLocalAccountDatabase } from './database.js';
import { createSyntheticAccountProvider, DEMO_IDENTITIES } from './demo-provider.js';
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
      for (const profile of DEMO_IDENTITIES) await store.provisionAccount({ ...profile, reason: 'Explicit isolated local synthetic account fixture', now: new Date().toISOString() });
      await database.markSeeded();
    }
    const demo = createSyntheticAccountProvider(options.origin);
    const api = createAccountApi({
      enabled: true, store, google: demo.provider, appOrigin: options.origin, datasetMode: 'demo',
      webLoginAvailable: true, nativeLoginAvailable: false, cookieMode: 'loopback',
      loopbackAuthorizationOrigin: options.origin,
      trustedClientKey: () => 'owned-loopback-synthetic-client',
    });
    server = await startLocalAccountServer(async request => await demo.consent(request) ?? await api(request), { appOrigin: options.origin });
    console.log(JSON.stringify({ status: 'ready', mode: 'synthetic-demo', port: server.port, state: options.state, googleCalls: 0 }));
    await new Promise<void>(resolve => {
      process.once('SIGINT', resolve); process.once('SIGTERM', resolve);
    });
  } finally { await server?.close(); await database.close(); }
}

main().catch(() => {
  console.error(JSON.stringify({ status: 'unavailable', reason: 'local_account_startup_failed_check_profile_and_port' }));
  process.exitCode = 1;
});
