# L3-SYNTHETIC-L1L2-ROUNDTRIP-CORE — implementation handoff

**Status:** Blocked by an existing L2 retrieval to reasoning-validation timestamp-format mismatch. No implementation is ready for acceptance.

## Assignment and branch

- **Branch:** `work/L3-SYNTHETIC-L1L2-ROUNDTRIP-CORE`
- **Worktree:** `C:\Users\perry\.codex\worktrees\l3-coordinator-core\RPL` (`/mnt/c/Users/perry/.codex/worktrees/l3-coordinator-core/RPL` in WSL)
- **Assigned base:** `ae81f65a434c71ae9bdb8703ac9e4744f1743575`
- **Commit:** This blocker report is committed as `docs(L3-SYNTHETIC-L1L2-ROUNDTRIP-CORE): record L2 timestamp boundary blocker`; its SHA is included in the implementation handoff to root.
- **Changed paths:** this handoff only. The exploratory edit to `apps/db/test/investigation-ledger.test.ts` was reverted after it exposed the blocker; no production, contract, migration, dependency, API, or configuration file was changed.

## Concrete blocker

The test-only PGlite composition reached real L1 persistence, L2 retrieval, and exact-span rehydration, but could not assemble a valid reasoning request. `createSqlEvidenceRetrievalRepository.search()` returns PostgreSQL `timestamptz::text` values in SQL display format, such as `2026-09-23 08:02:03+07`. The existing `validateReasoningRequest()` datetime pattern requires RFC3339 with a `T` separator and explicit `Z` or `+hh:mm`, so `assembleGroundingReasoningRequest()` rejects the real retrieval result with `request.data.groundingContext.evidence[0].publishedAt:invalid_datetime`. The retrieval instants were preserved (`2026-09-23T01:02:03Z` was returned as `2026-09-23 08:02:03+07`); the issue is that the SQL representation is not accepted by the next layer.

Fixing this requires normalizing the database reader's timestamp projection or changing the reasoning validator's accepted datetime format. Both are production-path changes outside this assignment's allowed paths. The test must not normalize or mock the real retrieval result because doing so would hide the failing boundary. Root should resolve that interface contract in a separately scoped change before retrying this round-trip task.

The attempted action used an exact synthetic report reference and completed the existing L1 fixture pipeline through the real SQL repositories. The Layer 1 persisted-result replay reused the same dataset/candidate/report revision and did not call the deterministic extractor again. Exact-span rehydration completed before request validation failed. Consequently, context persistence, coordinator refresh return, and the required final identity/no-publication/replay assertions were not reached. There is no claim here of fresh-source acquisition or production dispatch.

## Checks and runtime

- **Runtime:** WSL Ubuntu-26.04, Node.js `v24.21.0`, npm `11.19.0`.
- `node_modules/.bin/tsx --test apps/db/test/investigation-ledger.test.ts` — **failed 11/12** because the new composition attempt returned `review_required: refresh_failed` at the timestamp validation described above; the other 11 existing tests passed.
- `node_modules/.bin/tsx --test --test-name-pattern='composes one coordinator advance' apps/db/test/investigation-ledger.test.ts` — **failed 0/1** for the same concrete boundary mismatch and captured the SQL display-form timestamps.
- `npm run db:test`, `npm test`, `npm run typecheck`, and `npm run build` were **not run** because the integration could not proceed within the test-only scope. Do not treat these as passing.
- `git diff --check ae81f65a434c71ae9bdb8703ac9e4744f1743575..HEAD` — **passed** on the initial handoff commit; it will be rerun after this documentation update.

## Limits and remaining decisions

- No migration, configuration, dependency, or provider impact.
- The local PGlite query demonstrates the local output-format mismatch; hosted Neon behavior was not tested.
- Root must decide and assign the timestamp normalization/contract correction. After that boundary is fixed and reviewed, retry the original composition objective without weakening the exact identity, provenance, or refs-only assertions.
