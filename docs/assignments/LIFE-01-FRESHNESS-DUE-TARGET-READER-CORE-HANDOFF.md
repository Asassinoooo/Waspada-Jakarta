# LIFE-01 freshness due-target reader handoff

## Assignment and branch

- Backlog item: `LIFE-01-FRESHNESS-DUE-TARGET-READER-CORE`
- Branch: `work/LIFE-01-FRESHNESS-DUE-TARGET-READER-CORE`
- Worktree: `/mnt/c/Users/perry/.codex/worktrees/life-01-freshness-due-target-reader-core/RPL`
- Assigned base: `e4430e5e2f94f9d9b5dc250ddcbc24d25a809d4d`
- Implementation commit: `2cba16e4baa32eda578efd3e44093a958109064a` — `feat(LIFE-01): add bounded freshness due-target reader`

## Behavior implemented

Added a private, read-only due-target reader. It takes an explicit dataset kind, a validated RFC3339 `now`, a page size from 1 through 100, and an optional validated keyset cursor. It selects only the latest published event versions, hides histories whose latest version is withdrawn, and determines event claim-set status from the immutable event JSON plus that exact target's latest ledger transition. Impact status comes from exact current event-impact references, their exact impact versions, and each exact target's latest transition. It does not use aggregate freshness from `public_event_versions`.

The query applies the due predicate before stable keyset ordering and the `limit + 1` probe. It returns explicit due targets when `valid_until <= now` for `current` or `needs_update`, or when `review_due_at <= now` for `current`. Both times are retained so downstream policy can apply expiry precedence. Results contain only dataset and target identity, effective status, transition sequence, and the two freshness times. Raw record JSON, source text, and other fields are not returned.

The reader uses only existing L4 select grants. Tests establish that the existing L4 capability can run the path and the public, L1, and L2 roles cannot read its private data or ledger. Errors are stable and redacted. The reader performs no writes, recovery, source access, scheduling, or ambient-clock reads.

## Changed paths and impact

- `apps/db/src/freshness-due-target-reader.ts`
- `apps/db/test/freshness-due-target-reader.test.ts`
- `docs/assignments/LIFE-01-FRESHNESS-DUE-TARGET-READER-CORE-HANDOFF.md`

No migrations, grants, configuration, dependencies, public routes, API/runtime wiring, scheduler, or provider changes were made. Existing L4 column grants cover the query; no permission-boundary decision remains. Hosted Neon behavior was not exercised; database behavior was verified with the repository's PGlite fixtures.

## Verification

All project commands were run in WSL Ubuntu-26.04 with the existing dependency tree; no packages were installed. Runtime/tool versions observed: Node `v24.21.0`, npm `11.19.0`, Git `2.53.0`, PGlite `0.5.8`, tsx `4.23.15`, Vite `8.3.0`, Wrangler `4.137.0`.

- Focused reader test, `tsx --test test/freshness-due-target-reader.test.ts` from `apps/db`: passed, 8/8.
- `npm run db:test`: passed, 27/27 DB test files.
- `npm run typecheck`: passed for the web, worker, database, and evaluation TypeScript projects.
- `npm test`: passed, web 60/60, worker 382/382, DB 27/27 files, evaluation 12/12; exit code 0.
- `npm run build`: passed, including typecheck, Vite production build, and Wrangler dry-run build.
- Staged patch `git diff --cached --check`: passed before the implementation commit.
- Assigned-base `git diff --check e4430e5e2f94f9d9b5dc250ddcbc24d25a809d4d HEAD`: passed after both commits.

The temporary `node_modules` symlink to `/mnt/d/Projects/RPL/node_modules` was removed from the assigned worktree after verification. No hosted database, scheduler, source, or provider was invoked.

## Remaining review

No implementation decision or migration/configuration change remains. Reviewer acceptance and integration are pending the primary orchestrator.
