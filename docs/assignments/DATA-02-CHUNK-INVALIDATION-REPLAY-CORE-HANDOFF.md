# DATA-02-CHUNK-INVALIDATION-REPLAY-CORE handoff

**Status:** Implementation committed; root review and acceptance pending.

## Assignment

- **Branch:** `work/DATA-02-CHUNK-INVALIDATION-REPLAY-CORE`
- **Worktree:** `C:\Users\perry\.codex\worktrees\l3-coordinator-core\RPL` (`/mnt/c/Users/perry/.codex/worktrees/l3-coordinator-core/RPL`)
- **Base:** `6901cc0da4fdfc9bcf550b35d5263c6991ea0008`
- **Implementation commit:** `ac8f4947f152c23161300c68eacbb3cab9cd56f9` — `fix(DATA-02): reject replay of invalidated chunk generations`
- **Implementation files:** `apps/db/src/evidence-chunks.ts`, `apps/db/test/evidence-chunks.test.ts`, `apps/db/test/embedding-runs.test.ts`

## Behavior

The atomic chunk write now requires the exact report revision to remain `unreviewed` or `eligible`. It rejects an incoming chunk ID already stored as invalidated and rejects any chunker version with an invalidated row for the same dataset and revision, including retries using new IDs. The conflict update itself only changes rows still marked active. Existing active identical replay and unseen-version replacement remain supported; all failed guards leave chunks, embedding-run statuses, and vectors unchanged.

Tests cover active replay, generation replacement and retained vectors, exact stale-ID replay, a new ID reusing a tombstoned version, mixed stale/new inputs, revision eligibility, dataset and lineage boundaries, and embedding plus L2 retrieval after stale replay rejection. The composition test confirms retrieval selects the current chunk/run while invalidated chunk/run/vector history remains stored.

## Verification

Implementation verification ran in WSL Ubuntu-26.04 with Node.js `v24.21.0` and npm `11.19.0`, using existing dependencies through a temporary link to the root `node_modules` directory. Relevant package versions are PGlite `0.5.8`, PGlite pgvector `0.0.9`, PGlite PostGIS `0.2.8`, and Wrangler `4.137.0`. The link was removed before commit.

- `tsx --test apps/db/test/evidence-chunks.test.ts` — pass, 7/7.
- `tsx --test apps/db/test/embedding-runs.test.ts` — pass, 11/11.
- Root independently reran both focused files against the reviewed blobs — pass, 18/18.
- `npm run db:test` — pass, 23/23 files.
- `npm test` — exit 0: web 60/60, Worker 357/357, DB 23/23 files, evaluation casebook 12/12.
- Root independently ran `npm run typecheck && npm run build` in WSL against the same reviewed source/test blobs — exit 0. Vite build and Wrangler dry-run passed; the Wrangler configuration used `DATASET_MODE=demo`.
- `git diff --cached --check 6901cc0da4fdfc9bcf550b35d5263c6991ea0008` — passed for the staged implementation and handoff changes against the assigned base. The final committed-range check is reported in the agent handoff message.

Initial focused failures and fixes:

- An extra local test tried to change `report_revisions.revision_status` between preflight and write. The append-only trigger rejected the update (`waspada.report_revisions is append-only`), so that unsupported test setup was removed. The atomic SQL status predicate and direct allowed/disallowed revision tests remain.
- The first embedding-suite run passed 10/11 tests because its existing denied-revision test built quarantined/superseded/retracted fixtures through the chunk repository, which this correction now rejects. That test now owner-seeds clearly labelled legacy-invalid active chunk rows to exercise the separate embedding writer’s eligibility guard. The focused embedding suite then passed 11/11 and the full DB suites passed.

## Limits and remaining decisions

No migration, grant, repository contract, schema, API, or configuration change was made. Existing L1 permissions remain unchanged. PGlite verifies the local statement behavior but does not establish independent-session ordering or hosted Neon concurrency behavior. Version strings remain opaque; restoring a tombstoned generation would require a separately reviewed design. Root review and acceptance remain pending. The documentation commit for this handoff and the final assigned-base diff-check result are returned in the agent handoff message.
