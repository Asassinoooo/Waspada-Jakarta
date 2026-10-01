# LIFE-01-FRESHNESS-AGGREGATE-CORE handoff

## Branch and commits

- Branch: `work/LIFE-01-FRESHNESS-AGGREGATE-CORE`
- Worktree: `C:\Users\perry\.codex\worktrees\l3-coordinator-core\RPL` (`/mnt/c/Users/perry/.codex/worktrees/l3-coordinator-core/RPL` in WSL)
- Assigned base: `aa9a5443671a87be2f88c8f2fa09cd2bf1d0b5f0`
- Implementation commit: `e8fceb59d5c24d191371a6eb17bad5976e986df1` — `feat(LIFE-01): aggregate event freshness across impacts`
- This handoff is committed separately after the implementation commit; its exact commit SHA is reported with the assignment return.

## Behavior implemented

Layer 4 now derives only `EventView.freshness.status` from the event's grouped claim-set status and the freshness statuses of its exact projected impact versions. Any `needs_update`, mixed `current`/`expired`, or invalid input fails closed to `needs_update`; an empty impact set preserves the claim-set status. The event's `evaluated_at`, `review_due_at`, and `basis` remain unchanged, as do each impact's freshness and all claim fields. `PublicClaim`, event lifecycle, publication state, and public DTO/OpenAPI shapes are unchanged.

The shared event projection applies the rule to event reads. The fixture-backed demo read model derives the same status before event filtering and detail return, without mutating its fixtures. Migration 020 appends an internal `freshness_status` column to `waspada.public_event_versions` and replaces the GeoJSON candidate view to expose that derived status separately from immutable event JSON. The status uses exact event-impact reference versions; invalid or absent impact status is conservative. The list and GeoJSON readers filter on the derived column before ordering and limits, including the GeoJSON 501-row overflow probe.

The migration changes views only. It adds no table writes, public API fields, grants, or configuration. Existing public-reader view access is retained; PGlite list and GeoJSON cases exercise the readers under `SET ROLE waspada_public_reader` and confirm no direct base-table access or event/publication-row mutation.

## Changed paths

- `apps/db/migrations/020_public_event_freshness_aggregate.sql`
- `apps/db/src/public-event-geojson-candidates.ts`
- `apps/db/src/public-event-list.ts`
- `apps/db/test/migrations.test.ts`
- `apps/db/test/public-event-geojson-candidates.test.ts`
- `apps/db/test/public-event-list.test.ts`
- `apps/db/test/public-event-updates.test.ts`
- `apps/worker/src/layers/l4-application-integration/freshness-aggregate-policy.ts`
- `apps/worker/src/layers/l4-application-integration/public-projection.ts`
- `apps/worker/src/layers/l4-application-integration/public-read-model.ts`
- `apps/worker/test/api.test.ts`
- `apps/worker/test/l4-public-projection.test.ts`
- `docs/assignments/LIFE-01-FRESHNESS-AGGREGATE-CORE-HANDOFF.md`

Root authorized two narrow path extensions: `apps/db/test/migrations.test.ts` for migration 020 inventory/order coverage, and `apps/db/test/public-event-updates.test.ts` to exclude migration 020 from the pre-016 setup and include it in the subsequent expected migration sequence. Root will update the assignment/backlog record during integration.

## Checks and environment

All project verification used the existing WSL `Ubuntu-26.04` runtime and dependencies. No dependencies were installed and no live source, provider, or external service was invoked.

- Focused Worker projection/demo tests: `tsx --test test/l4-public-projection.test.ts test/api.test.ts` — 40/40 passed.
- Final-SQL focused DB checks: migration, public list, GeoJSON candidates, and public updates tests — 28/28 passed, with no failures, cancellations, or skips.
- `npm run db:test` — 21/21 DB test files and 175 tests passed before the final defensive LEFT JOIN refinement. The final `npm test` below reran the complete DB suite after that refinement.
- Final `npm test` — 596/596 tests passed: web 60, Worker 349, DB 175 across 21 files, and casebook 12. No failures, cancellations, or skips.
- `npm run typecheck` — passed for web, Worker, DB, and evaluation TypeScript projects. The later edit changed only migration SQL.
- `npm run build` — passed; Vite production build and Wrangler dry-run completed.
- `git diff --check aa9a5443671a87be2f88c8f2fa09cd2bf1d0b5f0..HEAD` — passed after the implementation and handoff commits.

Runtime/tool versions observed: Node `v24.21.0`, npm `11.19.0`, tsx `4.23.15`, TypeScript `7.0.2`, PGlite `0.5.8`, Vite `8.3.0`, and Wrangler `4.137.0`.

An initial full DB run caught test maintenance issues after adding migration 020: hard-coded migration inventories, the update-feed test's migration ordering, a duplicate exact-version GeoJSON fixture, and two list expectation errors. Those were corrected and the focused suites plus final full test run passed. A redundant DB-wide run after the final LEFT JOIN change was stopped per root direction before reaching the changed migration tests; focused checks and the final `npm test` supplied the final-SQL verification.

## Limitations and remaining decisions

No remaining design decision is required for this local slice. Hosted Neon behavior has not been verified; the SQL migration and public-reader permissions were exercised with PGlite only. Live sources remain disabled. Root review and integration are recorded separately in the delivery log.
