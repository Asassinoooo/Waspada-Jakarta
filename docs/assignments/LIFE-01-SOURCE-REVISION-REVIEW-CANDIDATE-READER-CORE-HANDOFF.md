# LIFE-01 source-revision review-candidate reader handoff

Implementation is complete for independent root review. It has not been accepted.

## Branch and commits

- Branch: `work/LIFE-01-SOURCE-REVISION-REVIEW-CANDIDATE-READER-CORE`
- Worktree: `/mnt/d/Projects/RPL/.codex-build/worktrees/life01-source-revision-review-candidate-reader-core`
- Exact base: `48e038c65e8690ab096579894d211df8131d5e9e`
- Implementation commit: `e6b7e933a9dc762dc0f68c259d4f931af77bab49` — `feat(LIFE-01): add source-revision review-candidate reader`
- This handoff is recorded in a separate commit with message `docs(LIFE-01): record review-candidate reader handoff`.

## Implementation

The internal reader returns a bounded, dataset-scoped projection for each explicit `superseded`, `retracted`, or `withdrawn` source-revision observation. It retains conflicting observations as separate candidates and produces none for `current` assertions. A candidate requires direct claim evidence whose evidence kind is `support`, whose relation is `supports`, and whose report revision exactly matches the observation's target revision. It targets only the latest published event version; a latest withdrawn or unpublished version hides the event. Impact targets require the exact event impact reference, impact version, and linked claim-support row.

Requests use a deterministic keyset cursor and a limit from 1 through 100 with one extra row as the continuation probe. The projection contains only the assigned observation metadata and exact event/impact identities. It does not return source or claim text, URLs, excerpts, hashes, or full rows. The query and role remain read-only; tests verify no changes to source observations, publication, history, lifecycle, freshness, geometry, audit, or outbox data.

Migration 031 extends only the existing `waspada_l4_report_revision_impact_reader` with SELECT on the exact source-observation metadata columns used by the query. It creates no role or function. No public API, OpenAPI, DTO, model, publication, lifecycle, history, geometry, freshness, worker configuration, dependency, binding, or deployment behavior changed.

## Changed paths

- `apps/db/migrations/031_source_revision_review_candidate_reader.sql`
- `apps/db/src/source-revision-review-candidate-reader.ts`
- `apps/db/test/source-revision-review-candidate-reader.test.ts`
- `apps/db/test/migrations.test.ts`
- `apps/db/test/public-event-updates.test.ts`
- `docs/assignments/LIFE-01-SOURCE-REVISION-REVIEW-CANDIDATE-READER-CORE-HANDOFF.md`

## Verification

Checks ran in WSL Ubuntu-26.04 with the existing installed dependencies and Node.js `v24.21.0`, npm `11.19.0`, TypeScript `7.0.2`, tsx `4.23.15`, `@electric-sql/pglite` `0.5.8`, Vite `8.3.0`, and Wrangler `4.137.0`. No packages were installed and no external service was contacted.

- `node --import tsx --test apps/db/test/source-revision-review-candidate-reader.test.ts apps/db/test/migrations.test.ts apps/db/test/public-event-updates.test.ts` — PASS, 25/25 tests. This focused command was rerun after the final test type corrections.
- `npm run db:test` — PASS, 35/35 DB test files. This full run preceded only the final type-safe assertion/predicate edits in the new test; the focused reader, migration, and update-feed tests passed again afterward.
- `npm test` — PASS. Workspace tests passed, all 35 DB test files passed, and all 12 evaluation casebook tests passed. This full run preceded only those same test-only type corrections; the focused affected tests passed afterward.
- `npm run typecheck` — PASS after correcting the new test's type errors.
- `npm run build` — PASS; includes typecheck, Vite production build, and Wrangler deploy dry-run.
- `git diff --check 48e038c65e8690ab096579894d211df8131d5e9e..HEAD` — PASS at the implementation commit. The same check is rerun after the handoff commit and its final result is included in the task reply.

## Limitations and remaining decisions

Coverage uses synthetic PGlite fixtures only; hosted Neon behavior and live data were not exercised. The reader deliberately makes no freshness or status writes and adds no review/authentication/write path. Root's separately recorded ADR-046 freshness decision remains outside this assignment; the treatment of `withdrawn` freshness remains open. Root review and acceptance are pending.
