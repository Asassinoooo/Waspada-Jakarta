# LIFE-01 source-revision freshness target reader handoff

## Delivery

- Branch: `work/LIFE-01-SOURCE-REVISION-FRESHNESS-TARGET-READER-CORE`
- Worktree: `/mnt/d/Projects/RPL/.codex-build/worktrees/life01-source-revision-freshness-target-reader-core`
- Assigned base: `d8e28fb208ed6596e845033b3181efdbe5a49222`
- Implementation commit: `4b376e716d9a313377bffe58065d0c0fa5c9b501` — `feat(LIFE-01): add freshness target reader`
- Exact-reference correction: `a073ac91d4ab0c985bddcf5500ae85721cd69a4d` — `fix(LIFE-01): bind impacts to exact event reference`

## Behavior

Added `createSourceRevisionFreshnessTargetReader`, a bounded read-only database reader for requested exact current live event-claim-set and impact targets. Requests are live-only, accept 1–100 exact target identities, reject malformed and unsupported scopes before SQL, and deduplicate exact identities before one parameterized query.

For an event claim-set target, the reader derives effective freshness from the exact immutable event version and its exact freshness-transition ledger rows; it never reads the public aggregate. For impacts, it requires the exact reference tuple in that event version and checks the referenced impact row's immutable JSON event ID and event version against that tuple using fields already granted to the reader. A regression fixture proves a v1 impact payload referenced from the current v2 event is omitted. It returns effective status, exact transition sequence (zero when no transition exists), and the issuer validity end. Results are bounded, deterministic, shape-validated, and errors are content-free.

The reader uses only existing `waspada_l4_freshness_writer` read grants. No writes, migrations, grants, API/public changes, source-observation or provider access, or dependency changes were introduced. Existing current-version and withdrawal handling is consumed as currently specified; the open withdrawn policy remains undecided and unchanged.

## Changed paths

- `apps/db/src/source-revision-freshness-target-reader.ts`
- `apps/db/test/source-revision-freshness-target-reader.test.ts`
- `docs/assignments/LIFE-01-SOURCE-REVISION-FRESHNESS-TARGET-READER-CORE-HANDOFF.md`

The PGlite tests cover exact target selection and projection, transition and immutable fallback behavior, current event-version boundaries, exact impact references, request/result bounds and validation, query count and ordering, role capability boundaries, and no mutation of stored or public rows.

## Verification

Ran in WSL Ubuntu 26.04 LTS with installed dependencies only; no dependencies were installed.

- Focused reader test: `tsx --test test/source-revision-freshness-target-reader.test.ts` from `apps/db` — passed, 5/5 tests both before and after the exact-reference correction; after correction, the L4 role-scoped regression path passed.
- `npm run db:test` — passed, 36/36 DB test files before the exact-reference correction.
- `npm test` — passed (exit 0) before the exact-reference correction; includes workspace tests, 36/36 DB test files, and 12 evaluation casebook tests.
- `npm run typecheck` — passed (exit 0) both before and after the exact-reference correction across web, worker, database, and evaluation packages.
- `npm run build` — passed (exit 0) before the exact-reference correction; Vite production build and Wrangler worker dry run completed.
- `git diff --check d8e28fb208ed6596e845033b3181efdbe5a49222` — passed against the final implementation and handoff content; rerun after the handoff commit.

Toolchain versions observed: Node `v24.21.0`, npm `11.19.0`, TypeScript `7.0.2`, tsx `4.23.15`, PGlite `0.5.8`, Vite `8.3.0`, and Wrangler `4.137.0`.

## Limitations and remaining decisions

This is a database reader module only; it does not wire a runtime caller or alter a public/API contract. Tests use isolated PGlite fixtures and do not verify a hosted Neon deployment or production live data. The existing grants and schema contracts supported the projection, so no escalation or contract change was needed. No migration or configuration impact. The open withdrawn policy remains for its separately assigned decision.
