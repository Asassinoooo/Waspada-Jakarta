# LIFE-01-SOURCE-REVISION-WITHDRAWN-FRESHNESS-CORE handoff

**Branch:** `work/LIFE-01-SOURCE-REVISION-WITHDRAWN-FRESHNESS-CORE`
**Worktree:** `/mnt/d/Projects/RPL/.codex-build/worktrees/life01-source-revision-withdrawn-freshness-core`
**Assigned base:** `c3dca9dc8ab4e6ef6ae6b23521d98f13211c5e91`

## Commits

- `62611d6016433fb1453c88e65ea9b3da3984565b` — `feat(LIFE-01): apply withdrawn source freshness`
- The handoff is committed separately after the implementation commit.

## Implemented behavior

Explicit live `withdrawn` source assertions now invalidate the exact current event claim set and only directly supported current impact versions. The coordinator uses `source_report_withdrawn` and the exact source-observation ID; a coexisting `current` assertion does not cancel withdrawal. Current-only candidates remain no-ops, duplicate target selection stays deterministic, and malformed candidate lineage fails before target reads or writes.

Issuer validity expiry still takes precedence at the inclusive `valid_until` boundary and records `issuer_validity_ended` without an observation ID. Existing `needs_update` and `expired` target states remain unchanged. A stale ledger conflict stops serial appends and returns the original input cursor. Public event and impact snapshots and their publication content remain unchanged; the source-observation ID stays private.

## Changed paths

- `apps/db/migrations/034_source_revision_withdrawn_freshness.sql`
- `apps/db/src/freshness-transition-ledger.ts`
- `apps/db/test/freshness-transition-ledger.test.ts`
- `apps/db/test/migrations.test.ts`
- `apps/db/test/public-event-updates.test.ts`
- `apps/db/test/source-revision-freshness-transition-composition.test.ts`
- `apps/worker/src/layers/l4-application-integration/source-revision-freshness-transition.ts`
- `apps/worker/test/source-revision-freshness-transition.test.ts`
- `docs/assignments/LIFE-01-SOURCE-REVISION-WITHDRAWN-FRESHNESS-CORE-HANDOFF.md`

## Verification

Checks ran in WSL Ubuntu-26.04 using Node `v24.21.0` and npm `11.19.0`. Relevant locked package versions were `@electric-sql/pglite` `0.5.8`, `tsx` `4.23.15`, TypeScript `7.0.2`, Vite `8.3.0`, and Wrangler `4.137.0`. No dependencies were installed. The worktree temporarily linked the repository's existing `node_modules` for checks; that worktree-local symlink was removed afterward.

- Focused DB command (`freshness-transition-ledger.test.ts`, `migrations.test.ts`, `public-event-updates.test.ts`, `source-revision-freshness-transition-composition.test.ts`): **35/35 passed**.
- Focused Worker coordinator test: **7/7 passed**.
- `npm run db:test`: **38/38 DB test files passed**.
- `npm test`: web **60/60**, Worker **431/431**, DB **38/38**, evaluation **12/12** passed.
- `npm run typecheck`: passed.
- `npm run build`: passed; Vite web build and Wrangler Worker `--dry-run` completed. No deployment occurred.
- `git diff --check c3dca9dc8ab4e6ef6ae6b23521d98f13211c5e91..HEAD`: passed after the implementation commit. Re-run after this handoff commit for the final branch check.

## Migration, privilege, and configuration impact

Migration 034 replaces only the existing private freshness reason/status check constraints to add `source_report_withdrawn`, limited to live `current` → `needs_update` transitions with a non-null observation ID. It reuses the existing observation foreign key, column, writer role, and grants. Migration tests verify roles, memberships, and transition grants are unchanged and the L4 freshness writer still cannot read source-observation rows directly. There is no configuration, dependency, public/API, runtime, scheduling, or deployment change.

## Limits and remaining decisions

The bounded coordinator still processes only the caller's one page; runtime and scheduling integration remain outside this assignment. No unresolved contract decision was identified. Root review and integration remain pending.
