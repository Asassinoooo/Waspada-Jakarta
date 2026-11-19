/**
 * FR-12 admin source approval, browser contract. Shared by the Worker route and the admin workspace.
 * Routes: GET /api/v1/admin/sources and POST /api/v1/admin/sources/:sourceId/approval.
 * Approval records registry status only. It does not start collection and does not grant public display.
 */

export type AdminSourceApprovalStatus = "approved" | "revoked";

export interface AdminSourceApprovalItem {
  readonly source_id: string;
  readonly display_name: string;
  readonly source_kind: string;
  readonly access_method: string;
  readonly registry_status: string;
  /** Registry approval_status: pending, approved, suspended or revoked. */
  readonly approval_status: string;
  readonly auto_acquisition_enabled: boolean;
  readonly auto_publication_policy: string;
  /** Result of the existing public-display permission model for this source (not a stored flag). */
  readonly public_display_granted: boolean;
  /** Reuse tokens from the registry (for example public_display, model_triage). The admin page labels them. */
  readonly reuse_basis: readonly string[];
  /** Free-text registry restriction notes. Empty when none are recorded. */
  readonly access_restrictions: readonly string[];
  /** Registry polling interval in seconds, or null when none is set. */
  readonly polling_interval_seconds: number | null;
  /** Hosted health from the ingest: unknown, healthy, degraded or unavailable. */
  readonly health_status: string;
  /** ISO instant of the last check (success or failure), or null when the source was never checked. */
  readonly last_checked_at: string | null;
  /** ISO instant of the last successful collection, or null when none is recorded. */
  readonly last_success_at: string | null;
  /**
   * ISO instant of the last failed check, or null. The hosted writer stores no separate failure time: a failed check
   * sets the status to degraded or unavailable and writes last_checked_at, and the next success sets healthy. So this
   * is last_checked_at only while the status is degraded or unavailable. No error code is stored for these sources.
   */
  readonly last_failure_at: string | null;
}

export interface AdminSourceListResponse {
  readonly sources: readonly AdminSourceApprovalItem[];
}

export interface AdminSourceApprovalRequest {
  readonly status: AdminSourceApprovalStatus;
  /** Trimmed to 10 to 500 characters by the server. */
  readonly note: string;
}

export interface AdminSourceApprovalResponse {
  readonly source: AdminSourceApprovalItem;
  readonly previous_approval_status: string;
  /** The audit row written in the same transaction as the registry change. */
  readonly audit_id: string;
}
