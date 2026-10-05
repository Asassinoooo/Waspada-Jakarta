# LIFE-01 source-revision freshness run-state handoff

**Status:** Implemented and committed for root review; reviewer acceptance is pending.
**Branch:** `work/LIFE-01-SOURCE-REVISION-FRESHNESS-RUN-STATE-CORE`
**Worktree:** `/mnt/d/Projects/RPL/.codex-build/worktrees/life01-source-revision-freshness-run-state-core`
**Assigned base:** `b73111739ff79f12b4c6343b790c456ee26afe01`

## Commits

- `c3b7266b871d0248a5c054b7a934310b485fe044` — `feat(LIFE-01): persist source-revision freshness run state`
- `5abbfde9371e1c429d6918fe6b1b1e602ea8396b` — `docs(LIFE-01): record freshness run-state handoff`

## Implementation

Migration 033 adds private singleton keyset checkpoint state, immutable per-run input cursor snapshots, and one append-only output cursor record per run. Fixed-purpose `SECURITY DEFINER` functions use a pinned search path and are executable only by `waspada_l4_freshness_writer`. Application roles cannot directly read or mutate the state tables. Existing source-observation grants remain unchanged.

`begin` creates or exactly replays a live trace and binds its stable trace ID to the current checkpoint cursor. `advance` accepts one completed page through compare-and-set, permits exact output replay, reports stale conflicts, and rejects non-monotonic cursor progress. A null output cursor records a completed sweep/reset distinctly from a run that has not advanced. `finalize` accepts only the closed succeeded/failed outcomes and exact bounded count summary, then writes count-only metadata with the fixed `source_revision_freshness_transition` trigger. The TypeScript repository validates IDs, closed cursor/count shapes and strict finite RFC3339 instants before calling those functions.

The SQL timestamp validators now explicitly reject year `0000` to match the TypeScript validator. PGlite 0.5.8 was also checked directly: casting `0000-01-01T00:00:00Z` to `timestamptz` raises `date/time field value out of range`; it does not normalize to 1 BC. The direct-function test verifies the fixed SQL validation error for that input.

## Changed paths

- `apps/db/migrations/033_source_revision_freshness_run_state.sql` — private run/checkpoint schema, guards, and fixed-purpose functions.
- `apps/db/src/source-revision-freshness-run-state.ts` — typed repository and input/result validation.
- `apps/db/test/source-revision-freshness-run-state.test.ts` — PGlite behavior, replay, CAS, failure, and least-privilege coverage.
- `apps/db/test/migrations.test.ts` — migration ordering, repeatability, and access-boundary checks.
- `apps/db/test/public-event-updates.test.ts` — authorized fixture-order correction only; no reader behavior changed.
- `docs/assignments/LIFE-01-SOURCE-REVISION-FRESHNESS-RUN-STATE-CORE-HANDOFF.md` — this handoff.

## Verification

All commands ran in WSL Ubuntu-26.04 using the existing runtime and dependencies. Runtime/package versions recorded at implementation and final verification were Node `v24.21.0`, npm `11.19.0`, `@electric-sql/pglite` `0.5.8`, `@electric-sql/pglite-postgis` `0.2.8`, `@electric-sql/pglite-pgvector` `0.0.9`, TypeScript `7.0.2`, tsx `4.23.15`, Vite `8.3.0`, and Wrangler `4.137.0`.

- Focused final-source tests: `node --import tsx --test apps/db/test/source-revision-freshness-run-state.test.ts apps/db/test/migrations.test.ts apps/db/test/public-event-updates.test.ts` — passed, 31 tests across 3 files.
- `npm run typecheck` — passed.
- `npm run build` — passed; Vite production build and Wrangler `--dry-run` completed. No deployment occurred.
- `npm test` — passed: web 60/60, worker 429/429, database 38/38 files, evaluation 12/12. The database workspace test runs the same `tsx test/run-db-tests.ts` aggregate as `npm run db:test`, and this run included the final year-zero guard and direct-function test.
- `npm run db:test` — passed before the final explicit year-zero guard/test addition: 38/38 database files. The post-correction database aggregate passed as part of `npm test`.
- `git diff --check` — passed before commit. The assigned-base-to-HEAD check is run after the handoff commit and reported with that commit.

## Scope, impact, and remaining decisions

The migration is additive and does not widen source-observation access. No dependencies, runtime configuration, schedule, worker handler, public DTO, or external resource was added or changed. No hosted database or live source was accessed; migration and role behavior were verified with authored PGlite fixtures. Scheduled one-page runtime wiring remains a later task. No unresolved design or contract decision remains; root review and integration are pending.
