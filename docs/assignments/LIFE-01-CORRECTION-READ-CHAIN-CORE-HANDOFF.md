# LIFE-01-CORRECTION-READ-CHAIN-CORE handoff

- **Status:** Implementation ready for independent root review; not yet accepted.
- **Branch:** `work/LIFE-01-CORRECTION-READ-CHAIN-CORE`
- **Worktree:** `C:\Users\perry\.codex\worktrees\life-01-correction-read-chain\RPL` (`/mnt/c/Users/perry/.codex/worktrees/life-01-correction-read-chain/RPL`)
- **Assigned base:** `3ee1408ce338876d0fc26dfcd50d784633dab5a0`
- **Implementation commit:** `c7f5cd3bba739ad4ff92ad5d5d90265358a79030` — `test(db): trace synthetic correction through update projection`

## Changed paths

- `apps/db/test/publication-writer.test.ts`
- `docs/assignments/LIFE-01-CORRECTION-READ-CHAIN-CORE-HANDOFF.md`

## Behavior

The publication-writer test now creates a unique authored fictional event through the real SQL writer, publishes version 1, verifies an idempotent replay, and writes version 2 with `supersedes_version: 1`. It seeds explicit synthetic disclosure fixtures for the exact `(live, event ID, version)` pairs, then reads the committed watermark and candidates through `createPublicEventUpdatesReader` and the existing Layer 4 update service inside a repeatable-read, read-only PGlite transaction.

The test uses a non-exportable in-memory HMAC key, a fixed clock, and a signed cursor beginning at sequence zero. It verifies both public entries, their exact version-bound summaries and stored publication timestamps, and the closed `UpdatePage` and `HistoryEntry` key sets. It checks that reviewer identity, sequence metadata, SQL, proposal IDs, source IDs, and evidence references do not appear in the projection. The existing writer checks for evidence links, audit rollback, outbox writes, append-only behavior, and idempotency remain intact.

The disclosure rows are authored contract fixtures identified with `synthetic-fixture-not-a-person`; they are not human decisions or moderator actions. No demo write capability, login, route, source, contract, schema, migration, dependency, or runtime configuration was added. The test reads the public update projection only; it makes no outbox delivery, factuality, freshness, source-rights, or source-independence claim. ADR-028 remains in force and the course demo stays read-only.

## Checks

Runtime: WSL Ubuntu-26.04 with Node.js `v24.21.0`, npm `11.19.0`, Git `2.53.0`, PGlite `0.5.8`, tsx `4.23.15`, TypeScript `7.0.2`, and Wrangler `4.137.0`. The worktree reused the existing Linux dependency tree through a temporary symlink to `/mnt/d/Projects/RPL/node_modules`; no dependencies were installed or copied, and the symlink was removed before handoff.

- `npm exec --workspace=@waspada/db -- tsx --test test/publication-writer.test.ts` — passed, 12/12.
- `npm run db:test` — passed, all 21/21 DB test files.
- `npm test` — passed: web 60/60, Worker 328/328, DB 21/21 files, evaluation 12/12.
- `npm run typecheck` — passed. The first attempt exposed that the DB tsconfig does not include the WebCrypto type used by the imported Worker modules; a file-local `/// <reference lib="webworker" />` in the assigned test file resolved the type boundary without changing project configuration or production code.
- `npm run build` — passed. Vite production build and Wrangler `4.137.0` dry-run completed; the Worker still exposes only `DATASET_MODE="demo"`.
- `git diff --check 3ee1408ce338876d0fc26dfcd50d784633dab5a0..HEAD` — passed after the implementation commit and repeated after the final handoff commit.

## Limitations and impact

No migration, schema, API, dependency, configuration, or provider impact. This is local synthetic PGlite coverage only. Hosted Neon behavior, Cloudflare deployment, real review decisions, freshness transitions, invalidation, source-revision state, and outbox delivery remain unverified or open. Latest-withdrawn suppression remains covered by the existing update-reader tests; this test does not synthesize a withdrawal.

No unresolved decision blocks this bounded test-only package. Root review and integration are still required before the backlog item can be accepted.
