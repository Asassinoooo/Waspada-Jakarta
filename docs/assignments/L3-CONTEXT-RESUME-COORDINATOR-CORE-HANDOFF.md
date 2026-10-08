# L3-CONTEXT-RESUME-COORDINATOR-CORE implementation handoff

**Backlog ID:** `L3-CONTEXT-RESUME-COORDINATOR-CORE`

**Branch:** `work/L3-CONTEXT-RESUME-COORDINATOR-CORE`

**Worktree:** `D:\Projects\RPL\.codex-build\worktrees\l3-context-resume-coordinator-core`

**Assigned base:** `eaeed50100ef95c452e2ebbb826e080def1ac29c`

## Changes

Added one synthetic-only PGlite composition test in `apps/db/test/investigation-ledger.test.ts`. It persists a schema 2.0 refs-only grounding context and version 1 L3 checkpoint, reloads the checkpoint, then uses the real L2 `GroundingContextResumer`, SQL exact-reference/span readers, and L3 coordinator to perform one bounded resume through a planner, registered action, and refresh.

The test proves that a missing exact context returns `null`; a saved revision-state mismatch, paused source, and explicit withdrawn-source assertion fail closed with `revision_state_mismatch`, `source_ineligible`, and `source_invalidated`; these cases do not call coordinator ports. On success, it checks exact context/case identity, current source lineage and exact span, and confirms one call each to planner/action/refresh. Reusing the old checkpoint returns `review_required: stale_checkpoint`; all request, checkpoint, and reservation rows remain unchanged and no port runs again. It also verifies refs-only durable context/checkpoint/ledger data and zero publication, decision, public event, outbox, or public-history-review writes.

Missing context is modeled as an exact read miss at the L2 repository boundary because grounding-context rows are append-only. The context/checkpoint schemas, checkpoint version, production code, migrations, grants, dependencies, and runtime configuration are unchanged. No age-based expiry rule was added. The test uses unique synthetic fixture IDs and makes no model, source, or external-service calls.

## Commits

- `9efe9baa12a553ff0e043f86cf920c1ddc60706d` — `test(L3-CONTEXT-RESUME): compose refs-only checkpoint restart`
- The handoff document is committed separately after the implementation commit; its full SHA and exact message are included in the delivery message accompanying this file.

## Verification

All commands ran from the assigned worktree through WSL `Ubuntu-26.04`, using Node `v24.21.0` and npm `11.19.0`; no packages were installed.

| Command | Result |
| --- | --- |
| `npm exec tsx -- --test apps/db/test/investigation-ledger.test.ts` | Pass, 13/13 tests, rerun after the final missing-context and replay-row assertions. |
| `npm run db:test` | Pass, 41/41 DB test files. This ran before the final test-only assertion refinement; the changed test file was rerun afterward as above. |
| `npm test` | Pass, exit 0; web, worker, all 41 DB files, and remaining test suites passed. This ran before the final test-only assertion refinement; the changed test file was rerun afterward as above. |
| `npm run typecheck` | Pass, rerun after the final test edits. |
| `npm run build` | Pass, including web build and Wrangler Worker dry-run. This ran before the final test-only assertion refinement; no production/build input changed. |
| `git diff --check` | Pass on the implementation diff before commit. The assigned-base-to-HEAD check is recorded in the delivery message after the handoff commit. |

## Limits and remaining decisions

PGlite proves the local SQL/worker-port composition and synthetic replay/fail-closed behavior only. It does not establish hosted Neon behavior, live-source behavior, provider behavior, Cloudflare Workflow behavior, or production runtime wiring. No configuration or migration impact and no remaining contract or schema decisions were identified; root review and integration remain outstanding.
