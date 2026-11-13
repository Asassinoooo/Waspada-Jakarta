import type { SessionEnvelope } from "@waspada/worker/account-contracts";
import { hasProtectedShellAccess } from "./AccountPages.js";
import { ContextSourcesHttpError } from "./context-sources-client.js";
import { SourcePreviewHttpError } from "./source-preview-client.js";

/** Shown in place of a provider fetch control to anyone without moderator or admin access. */
export const PROVIDER_FETCH_ROLE_NOTE = "Ambil data penyedia hanya untuk moderator atau admin yang sudah masuk.";

/**
 * Provider fetch (`?mode=fetch`) is a moderator or admin action, the same `review_evidence` rule the
 * server enforces. Only an active moderator or admin session may see the control.
 */
export function providerFetchAllowed(session: SessionEnvelope | null): boolean {
  return session !== null && hasProtectedShellAccess("review", session);
}

/** Returns the mode to send, or null when a provider fetch is not allowed. Local and snapshot modes always pass. */
export function requestModeAllowed<Mode extends string>(mode: Mode, canRequestProviderFetch: boolean): Mode | null {
  return mode === "fetch" && !canRequestProviderFetch ? null : mode;
}

/** The notice for a refused provider fetch (401 anonymous or deactivated, 403 signed-in user), otherwise null. */
export function providerFetchRefusalNotice(error: unknown): string | null {
  const status = error instanceof ContextSourcesHttpError || error instanceof SourcePreviewHttpError
    ? error.status
    : null;
  return status === 401 || status === 403 ? PROVIDER_FETCH_ROLE_NOTE : null;
}
