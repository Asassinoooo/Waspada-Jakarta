# LIFE-01-SOURCE-REVISION-FRESHNESS-TRANSITION-CORE handoff

**Status:** Implementation committed; awaiting root review and integration.

## Branch and commits

- Branch: `work/LIFE-01-SOURCE-REVISION-FRESHNESS-TRANSITION-CORE`
- Worktree: `/mnt/d/Projects/RPL/.codex-build/worktrees/life01-source-revision-freshness-transition-core`
- Assigned base: `bb4915cbe48e2376053d02b2573e93929dbcf35b`
- Implementation commit: `018d1c4251433d3f9f171ee57727c99c34fc4314` — `feat(LIFE-01): apply source revision freshness transitions`
- Handoff commit: this commit; its SHA is reported by the task after creation.

## Changed paths

- `apps/db/migrations/032_source_revision_freshness_transitions.sql`
- `apps/db/src/freshness-transition-ledger.ts`
- `apps/db/test/migrations.test.ts`
- `apps/db/test/source-revision-freshness-transition-composition.test.ts`
- `apps/worker/src/layers/l4-application-integration/source-revision-freshness-transition.ts`
- `apps/worker/test/source-revision-freshness-transition.test.ts`
- `apps/worker/package.json` — registers only the focused coordinator test.
- `apps/db/test/public-event-updates.test.ts` — root-authorized test-fixture exception: excludes 032 from its pre-ledger setup and expects 032 in the later full application.
- `apps/db/test/report-revision-source-observations.test.ts` — root-authorized test-fixture exception: accepts PostgreSQL/PGlite's FK rejection for TRUNCATE; its existing row-count assertion still verifies the observation remains.

## Behavior

The Layer 4 coordinator validates a live-only request, explicit RFC3339 time, caller limit (1–100), trace ID, cursor and exactly one candidate page before processing. It skips current and withdrawn observations, preserves each invalidating assertion, selects the lexically smallest observation ID for duplicate exact targets, reads each selected event claim-set or directly linked impact target once, and appends transitions serially.

Issuer validity ending at or before `now` takes precedence and expires current or needs-update targets without a source-observation ID. Otherwise, only a current target becomes needs-update for an explicit retracted or superseded assertion. Existing needs-update and expired states remain unchanged. The deterministic bounded idempotency identity includes the exact target, selected observation ID and reason. Conflicts and read/write failures retain the caller's input cursor and do not continue the page.

Migration 032 adds the nullable observation identity to the private append-only transition ledger, references the immutable observation using the existing dataset-scoped key, and enforces reason/status/ID combinations in SQL. It grants the existing freshness writer only column-level SELECT and INSERT on the new ledger column. It adds no role or membership, and the L4 writer still cannot directly read observation rows. Public DTOs/views, publication content, lifecycle and event history remain unchanged. The composition test confirms the conservative public event badge becomes needs-update while the event claim-set target expires at validity equality and only the directly supported impact becomes needs-update.

## Verification

All commands below ran in WSL Ubuntu-26.04 with the existing workspace dependencies; none were installed.

Runtime and relevant package versions: Node.js `v24.21.0`, npm `11.19.0`, `@electric-sql/pglite` `0.5.8`, `@electric-sql/pglite-postgis` `0.2.8`, `@electric-sql/pglite-pgvector` `0.0.9`, TypeScript `7.0.2`, `tsx` `4.23.15`, Wrangler `4.137.0`.

- In `apps/db`, `node --import tsx --test test/freshness-transition-ledger.test.ts`: passed, 10/10.
- In `apps/db`, `node --import tsx --test test/migrations.test.ts`: passed, 17/17.
- In `apps/db`, `node --import tsx --test test/source-revision-freshness-transition-composition.test.ts`: passed, 1/1.
- In `apps/db`, `node --import tsx --test test/public-event-updates.test.ts`: passed, 4/4.
- In `apps/db`, `node --import tsx --test test/report-revision-source-observations.test.ts`: passed, 7/7.
- In `apps/worker`, `node --import tsx --test test/source-revision-freshness-transition.test.ts`: passed, 5/5.
- `npm run db:test`: passed, 37/37 DB test files.
- `npm test`: passed (web, Worker, all DB tests, and 12/12 evaluation casebook tests).
- `npm run typecheck`: passed for web, Worker, DB and evaluation TypeScript.
- `npm run build`: passed; Vite production build and Wrangler deploy dry-run completed.
- `git diff --check bb4915cbe48e2376053d02b2573e93929dbcf35b..HEAD`: passed after the implementation commit. It is rerun after the handoff commit.

A temporary worktree-local `node_modules` symlink pointed to `/mnt/d/Projects/RPL/node_modules` for verification and was removed before commit. The worktree was clean after the implementation commit.

## Limits and remaining decisions

No API, public projection, scheduler, runtime, source/provider, model, configuration, dependency, or publication wiring was added. No live sources or external services were contacted. No contract version changed. No unresolved implementation decision is identified; root review and integration remain pending.
