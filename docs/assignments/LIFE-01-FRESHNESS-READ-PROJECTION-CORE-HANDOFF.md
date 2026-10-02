# LIFE-01 current-public freshness projection handoff

## Assignment and implementation commit

- Backlog item: `LIFE-01-FRESHNESS-READ-PROJECTION-CORE`
- Base: `8034a822ee08001e415c6ef10523a91301f94779`
- Branch: `work/LIFE-01-FRESHNESS-READ-PROJECTION-CORE`
- Worktree: `/mnt/c/Users/perry/.codex/worktrees/life-01-freshness-read-projection-core/RPL`
- Implementation commit: `9437502cc2fca64485d7c9ee7616f2bd10201fac` — `feat(LIFE-01): project freshness overlays in current public views`

## Implemented behavior

Migration `025_freshness_current_public_overlay.sql` replaces the current-public event and impact views without changing their public column shapes or grants. Current event claim-set transitions are selected for the exact current published version. Impact transitions are selected for the exact event version and referenced impact ID/version. Targets without a transition keep the status in their immutable published record. Event status continues to follow ADR-032, including `needs_update` for invalid or missing impact statuses and mixed current/expired sets, and uses the claim-set status when there are no impacts. The event JSON status and internal `freshness_status` agree. Only `freshness.status` is overlaid; evaluation time, review deadline, basis, and each impact's metadata remain unchanged.

Latest withdrawals continue to hide the event and its history. Historical version status remains as published. The existing v1 list publication/history comparison now permits only the projected `freshness.status` difference; both freshness objects must have the closed, well-formed contract shape, and every other field remains deep-equal. No DTO, OpenAPI, application reader contract, or UI was changed.

Tests verify effective current status through safe views under `waspada_public_reader`, deny direct reads of both ledger tables, and compare stored event/impact versions, publication decisions, and outbox rows before and after projection reads. List and GeoJSON filtering follow the projected event status, while history retains the immutable published status. A current v2 snapshot with a transition only on v1 verifies that an older event transition does not affect the current read.

## Changed paths

- `apps/db/migrations/025_freshness_current_public_overlay.sql` — new current-public view overlay.
- `apps/db/src/public-event-list.ts` — preserve strict v1 publication/history validation across the status-only overlay.
- `apps/db/test/migrations.test.ts` — migration inventory/order and safe-view versus direct-ledger access.
- `apps/db/test/public-event-snapshot.test.ts` — status overlay, exact-version fallback, public role access, and immutable publication-state checks.
- `apps/db/test/public-event-list.test.ts` — effective v1 list status and unchanged historical status.
- `apps/db/test/public-event-geojson-candidates.test.ts` — projected status and filter alignment.
- `apps/db/test/public-event-history.test.ts` — current overlay versus immutable history status.
- `apps/db/test/public-event-updates.test.ts` — staged migration inventory only.
- `docs/assignments/LIFE-01-FRESHNESS-READ-PROJECTION-CORE-HANDOFF.md` — this handoff.

## Verification

All commands ran in WSL Ubuntu-26.04 using existing dependencies, with no installs or external services. Runtime versions were Node.js `v24.21.0`, npm `11.19.0`, `tsx` `4.23.15`, `@electric-sql/pglite` `0.5.8`, Vite `8.3.0`, and Wrangler `4.137.0`.

- Focused DB tests, run individually to avoid PGlite memory contention: snapshot `10/10`, list `6/6`, GeoJSON `9/9`, history `7/7`, migrations `12/12`, and staged updates inventory `4/4`. The final snapshot run includes the old-version transition fallback case.
- `npm run db:test`: passed all `26/26` DB test files.
- `npm test`: passed web `60/60`, worker `382/382`, all `26/26` DB test files, and evaluation casebook `12/12`.
- `npm run typecheck`: passed after the final test updates.
- `npm run build`: passed; Vite production bundle built, and Wrangler dry-run completed (`564.57 KiB`, `109.81 KiB` gzip).
- `git diff --check`: passed before commit; the required base-to-HEAD check is recorded after both commits in the task report.

The full DB and repository-wide test commands ran before the final addition to the snapshot test fixture; that fixture-only change was then covered by the final focused snapshot run. No production code changed after those full-suite runs.

## Migration impact, limits, and remaining decisions

Migration `025_freshness_current_public_overlay.sql` must be applied to a target database to enable the overlay. It introduces no table or column changes, role grants, environment variables, or application configuration. `CREATE OR REPLACE VIEW` retains the safe views' existing owner and grants; the tests confirm that the public reader can query the safe views while direct ledger reads remain denied.

Verification used PGlite only; no hosted Neon deployment or production data migration was performed. There are no unresolved design decisions in this slice. Root review and integration remain pending.
