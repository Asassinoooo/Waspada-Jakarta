// PERF-09: the admin/review access rule, in a tiny module the eager shell (App, AppShell, provider fetch rules) imports.
// The gate screen that uses it lives in account-gate.tsx and loads only on protected routes.
import type { SessionEnvelope } from "@waspada/worker/account-contracts";

export type ProtectedShell = "admin" | "review";

export function hasProtectedShellAccess(shell: ProtectedShell, session: SessionEnvelope): boolean {
  const user = session.user;
  if (session.status !== "authenticated" || user === null || !user.active) return false;
  if (shell === "admin") return user.role === "admin";
  return user.role === "moderator" || user.role === "admin";
}
