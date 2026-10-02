# LIFE-01 freshness due-composition implementation handoff

- **Backlog ID:** `LIFE-01-FRESHNESS-DUE-COMPOSITION-PGLITE-CORE`
- **Branch:** `work/LIFE-01-FRESHNESS-DUE-COMPOSITION-PGLITE-CORE`
- **Worktree:** `/mnt/c/Users/perry/.codex/worktrees/life-01-freshness-due-composition-pglite-core/RPL`
- **Assigned base:** `8ff0811f343560f8c14a4ef5d9697d8ab4c389bb`
- **Implementation commit:** `e0ec2cf4ce8557234e80154cf306a050507bb597` — `test(LIFE-01): compose freshness due evaluation in PGlite`

## Implemented behavior

Added one deterministic PGlite composition test at `apps/db/test/freshness-due-evaluator-composition.test.ts`. It seeds a clearly authored synthetic fixture with complete trace, source, report revision, extraction, grounding context, proposal, publication decision, event, impact, and exact impact-reference lineage. It then composes the existing due-target reader, bounded evaluator, transition recorder, SQL ledger, and current-public views over the same migrated database.

At explicit time `2026-10-02T10:00:00.000000Z`, the test reads the exact current impact version whose issuer validity ends at that instant. The evaluator records one transition from `current` to `expired` with reason `issuer_validity_ended`, sequence 1, the supplied evaluation trace, deterministic run-scoped idempotency key, and request fingerprint. It asserts that expiry does not claim evidence recovery and creates no evidence links.

The current-public overlay projects the impact as `expired` and the event as `needs_update` through the existing conservative aggregate. A subsequent read at the same explicit time contains no already-transitioned impact target. Before/after snapshots prove the event version, impact version, and publication-decision rows are unchanged. The live-only publication outbox contains no row for this synthetic event; the snapshot is absent both before and after evaluation.

The composition does not demonstrate a stale-to-current recovery transition or recovery evidence behavior.

## Changed paths

- `apps/db/test/freshness-due-evaluator-composition.test.ts` (new)
- `docs/assignments/LIFE-01-FRESHNESS-DUE-COMPOSITION-PGLITE-CORE-HANDOFF.md` (new)

No production code, schema, migration, database grants, dependencies, package scripts, or runtime configuration changed. No external service, source, provider, schedule, model, live data, or wall clock was used.

## Verification

All commands ran in WSL Ubuntu 26.04 using the existing dependency installation. No dependencies were installed. The worktree temporarily linked its `node_modules` to the pre-existing repository installation for checks; that untracked symlink was removed afterward.

| Command | Result |
| --- | --- |
| From `apps/db`: `node --import tsx --test test/freshness-due-evaluator-composition.test.ts` | Passed, 1/1 test |
| `npm run db:test` | Passed, all 28/28 DB test files, including the new composition |
| `npm run typecheck` | Passed across workspaces and evaluation tooling |
| `npm test` | Passed, including 387 tests in the workspace test stage, all 28/28 DB test files, and 12 casebook tests |
| `npm run build` | Passed: typecheck, Vite production build, and Wrangler dry-run |
| `git diff --check 8ff0811f343560f8c14a4ef5d9697d8ab4c389bb..HEAD` | Passed after both commits |

Toolchain and relevant locked package versions: Ubuntu 26.04 LTS, Node `v24.21.0`, npm `11.19.0`, Git `2.53.0`, `@electric-sql/pglite` `0.5.8`, `@electric-sql/pglite-postgis` `0.2.8`, `@electric-sql/pglite-pgvector` `0.0.9`, `tsx` `4.23.15`, TypeScript `7.0.2`, Vite `8.3.0`, and Wrangler `4.137.0`.

## Limitations and review

Validation is against the checked-in migrations and PGlite harness; no hosted Neon instance was exercised. The synthetic fixture cannot create a publication-outbox row under the existing live-only constraints, so the test verifies that the event-scoped outbox snapshot is absent before and after evaluation. Root review remains required before integration or acceptance.
