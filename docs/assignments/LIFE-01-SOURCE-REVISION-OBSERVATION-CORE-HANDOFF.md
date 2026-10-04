# LIFE-01-SOURCE-REVISION-OBSERVATION-CORE handoff

**Status:** Implemented on the assigned branch; awaiting root review.
**Branch:** `work/LIFE-01-SOURCE-REVISION-OBSERVATION-CORE`
**Worktree:** `/mnt/d/Projects/RPL/.codex-build/worktrees/life01-source-revision-observation-core`
**Assigned base:** `12d2fd0d46f40f9c39fe957fb4ee9c2ba0bd334a`

## Commits

- `48fd6d69d201d9cac284f40e4b2e7fe8e5780d1d` — `feat(LIFE-01): store source revision observations`
- A separate documentation commit adds this handoff after the implementation commit.

## Changed paths

- `apps/db/migrations/029_source_revision_observations.sql`
- `apps/db/src/report-revision-source-observations.ts`
- `apps/db/src/ports.ts`
- `apps/db/test/report-revision-source-observations.test.ts`
- `apps/db/test/migrations.test.ts`
- `apps/db/test/public-event-updates.test.ts`
- `docs/assignments/LIFE-01-SOURCE-REVISION-OBSERVATION-CORE-HANDOFF.md`

## Behavior

Migration 029 adds an append-only, metadata-only Layer 1 ledger for explicit `current`, `superseded`, `retracted`, and `withdrawn` publisher assertions. It keys stable observation IDs by dataset, preserves publisher-observed, retrieved, and database-recorded timestamps separately, and enforces exact dataset/source lineage in SQL. A `superseded` assertion must name a same-source replacement whose immutable `supersedes_id` identifies the target; the other states cannot carry a replacement ID.

The typed transactional repository validates closed inputs, reads exact revision lineage, creates rows idempotently, and returns a fixed redacted conflict when any assertion or provenance field differs on stable-ID reuse. Conflicting assertions remain separate rows. SQL constraints and triggers reject invalid lineage/replacement data and block update, delete, and truncate. The existing L1 role receives only column-scoped metadata SELECT/INSERT; PUBLIC execution is revoked from the trigger-only validation function. No source text or arbitrary JSON is copied into the ledger.

The tests verify the four states, exact replay and conflicting reuse, separate timestamps, lineage and replacement rules, append-only protection, exact L1 capability without broadening existing grants, and no changes to revision eligibility, retrieval, public projection, freshness, publication, audit, outbox, or delivery data.

## Verification

Ran in WSL Ubuntu 26.04 LTS with the already installed Node.js `v24.21.0` and npm `11.19.0`. The web build used Vite `8.3.0`; the Worker dry-run used Wrangler `4.137.0`. No packages were installed and no dependency, runtime, secret, provider, or deployment configuration was changed.

- Focused observation tests: 7/7 passed.
- Focused migration capability test: 1/1 passed.
- `npm run db:test`: all 34/34 DB test files passed.
- `npm test`: 423 workspace/web tests, 34/34 DB test files, and 12 evaluation casebook tests passed; exit code 0.
- `npm run typecheck`: passed; exit code 0.
- `npm run build`: passed; Vite production build and Wrangler deployment dry-run succeeded; exit code 0.
- `git diff --check 12d2fd0d46f40f9c39fe957fb4ee9c2ba0bd334a..HEAD`: passed for the implementation commit; exit code 0. The final handoff commit is also checked before completion.

## Limitations and remaining decisions

Source rights remain pending. Tests use only authored synthetic PGlite fixtures; no source, provider, fetch, or runtime was accessed. This slice does not resolve a winning/current source state, mutate `report_revisions.revision_status`, change L2 retrieval, or create freshness, moderator, publication, audit, or outbox state. Public APIs and DTOs remain unchanged. No unresolved contract or scope decision was encountered.
