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
