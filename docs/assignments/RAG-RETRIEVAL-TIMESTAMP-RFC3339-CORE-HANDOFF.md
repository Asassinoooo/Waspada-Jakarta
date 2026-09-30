# RAG-RETRIEVAL-TIMESTAMP-RFC3339-CORE handoff

**Status:** Implementation complete; awaiting independent root review and integration.
**Branch:** `work/RAG-RETRIEVAL-TIMESTAMP-RFC3339-CORE`
**Worktree:** `C:\Users\perry\.codex\worktrees\l1-fixture-runner-core\RPL` (`/mnt/c/Users/perry/.codex/worktrees/l1-fixture-runner-core/RPL` in WSL Ubuntu-26.04)
**Base:** `c02ea6ad094fe594a8ef48e27b7be7748abd7746`
**Implementation commit:** `6fddc8900ed80aa1651ee6015f36963f9b91325a` — `fix(db): format retrieved evidence timestamps as RFC3339`

## Changes

The retrieval SQL now formats `published_at`, `observed_at`, `retrieved_at`, `valid_from`, and `valid_until` after explicitly converting each `timestamptz` to UTC. The fixed format includes the RFC3339 `T` separator, a `Z` timezone, and all six PostgreSQL fractional-second digits. `to_char` preserves SQL nulls. Retrieval filters, ordering, event-time JSON, lineage, and truncation logic are unchanged.

The PGlite regression uses UTC and non-UTC input offsets, checks exact canonical instants and microseconds under `Asia/Jakarta`, confirms nullable fields and unchanged event-time JSON, and sends the database result through the existing `assembleGroundingReasoningRequest` strict validation boundary.

Changed paths:

- `apps/db/src/evidence-retrieval.ts`
- `apps/db/test/evidence-retrieval.test.ts`
- `docs/assignments/RAG-RETRIEVAL-TIMESTAMP-RFC3339-CORE-HANDOFF.md`

## Verification

All commands ran in WSL Ubuntu-26.04 from the assigned worktree, using the existing `node_modules` and Node.js `v24.21.0` from `/home/perry/.nvm/versions/node/v24.21.0/bin` (npm `11.19.0`; PGlite `0.5.8`). No dependencies were installed.

| Command | Result |
| --- | --- |
| `./node_modules/.bin/tsx --test apps/db/test/evidence-retrieval.test.ts` | Passed, 15/15 tests. |
| `npm run db:test` | Passed, 21/21 DB test files. |
| `npm test` | Passed, exit 0: web and Worker workspace tests, 21/21 DB files, and 12/12 evaluation casebook tests. |
| `npm run typecheck` | Passed for web, Worker, DB, and evaluation TypeScript projects. |
| `npm run build` | Passed: typecheck, Vite production build, and Wrangler Worker dry-run. |
| `git diff --check c02ea6ad094fe594a8ef48e27b7be7748abd7746..HEAD` | Passed after the implementation commit. |

## Impact and limitations

No migration, contract/API, dependency, runtime configuration, or provider/source change. Hosted Neon behavior was not exercised; verification used local PGlite. The handoff record is committed as a documentation follow-up; its commit SHA and exact message are provided in the agent report.

There are no remaining design decisions for this slice. Root review and integration remain outstanding.
