import { authorizeModeratorAction, type ModeratorAction } from '../layers/l4-application-integration/moderator-authorization.js';
import type { ModerationPrincipal } from '../layers/l4-application-integration/moderation-api.js';
import { readAccountAuthentication } from '../accounts/api.js';
import type { AccountWorkerEnvironment } from '../accounts/types.js';
import {
  resolveAccountRuntime,
  withAccountStore,
  type AccountRuntimeConfig,
  type AccountTransactionalSqlExecutorRunner,
} from './account-runtime.js';

export interface ModeratorSessionDependencies {
  readonly withTransactionalSqlExecutor?: AccountTransactionalSqlExecutorRunner;
}

/** Resolves the account configuration for moderation, or null when accounts are not enabled. */
export function moderationAccountConfig(
  environment: AccountWorkerEnvironment,
): AccountRuntimeConfig | null {
  return resolveAccountRuntime(environment);
}

/**
 * Reads the browser session for a moderation surface. Only a web cookie session counts, so
 * bearer tokens never authorize moderation writes. Throws on database failure, which callers
 * must map to 503 rather than to an anonymous response.
 */
export async function readModeratorPrincipal(
  request: Request,
  config: AccountRuntimeConfig,
  dependencies: ModeratorSessionDependencies = {},
): Promise<ModerationPrincipal | null> {
  const auth = await withAccountStore(config, dependencies, (store) =>
    readAccountAuthentication(request, store, Date.now, config.cookieMode));
  if (!auth || auth.source !== 'cookie' || auth.session.channel !== 'web') return null;
  return {
    actorId: auth.session.account.id,
    role: auth.session.account.role,
    active: auth.session.account.active,
    csrfToken: auth.session.csrfToken,
    channel: 'web',
    datasetScope: config.datasetKind,
  };
}

/**
 * Authorizes a whole moderation surface (SSE stream, embedding visualization) with the same
 * closed vocabulary the moderation handler uses. Returns null when the request may proceed.
 */
export async function moderatorSurfaceDenial(
  request: Request,
  config: AccountRuntimeConfig | null,
  action: ModeratorAction,
  dependencies: ModeratorSessionDependencies = {},
): Promise<Response | null> {
  if (!config) return jsonError('TEMPORARILY_UNAVAILABLE', 'Moderation sign-in is not available on this service.', 503);
  let principal: ModerationPrincipal | null;
  try {
    principal = await readModeratorPrincipal(request, config, dependencies);
  } catch {
    return jsonError('TEMPORARILY_UNAVAILABLE', 'Moderation sign-in is not available on this service.', 503);
  }
  if (!principal) return jsonError('UNAUTHORIZED', 'Authentication required to access moderation endpoints', 401);
  const decision = authorizeModeratorAction({
    principal: {
      actorId: principal.actorId,
      // authorizeModeratorAction rejects any role outside moderator/admin at runtime.
      role: principal.role as 'moderator' | 'admin',
      active: principal.active,
      datasetScope: config.datasetKind,
    },
    action,
    targetDataset: config.datasetKind,
    serverSelectedDataset: config.datasetKind,
  });
  if (decision.decision === 'allow') return null;
  return jsonError('FORBIDDEN', 'Forbidden: requires active user with moderator or admin role', 403);
}

function jsonError(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ code, message, request_id: crypto.randomUUID() }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
