/** Account-v1 is separate from published incident DTOs. Never expose identity proofs. */
export const ACCOUNT_CONTRACT_VERSION = "account-v1" as const;
export type AccountRole = "user" | "moderator" | "admin";
export type AccountChannel = "web" | "mobile";

export interface AccountUser {
  readonly id: string;
  readonly display_name: string;
  readonly email: string;
  readonly role: AccountRole;
  readonly active: boolean;
  readonly onboarding_version: 0 | 1;
  readonly onboarding_completed_at: string | null;
  readonly version: number;
}

export interface SessionEnvelope {
  readonly version: typeof ACCOUNT_CONTRACT_VERSION;
  readonly status: "anonymous" | "authenticated";
  readonly google_login_available: boolean;
  readonly native_login_available: boolean;
  readonly csrf_token: string | null;
  readonly user: AccountUser | null;
}

export interface AccountUserPage {
  readonly data: readonly AccountUser[];
  readonly next_cursor: string | null;
}

export interface AccountUserUpdate {
  readonly role: AccountRole;
  readonly active: boolean;
  readonly expected_version: number;
  readonly reason: string;
}

export interface NativeSessionExchange {
  readonly session_token: string;
  readonly session: SessionEnvelope;
}
