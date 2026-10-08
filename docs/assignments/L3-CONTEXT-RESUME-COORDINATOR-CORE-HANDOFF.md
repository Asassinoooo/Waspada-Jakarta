# L3-CONTEXT-RESUME-COORDINATOR-CORE implementation handoff

**Backlog ID:** `L3-CONTEXT-RESUME-COORDINATOR-CORE`

**Branch:** `work/L3-CONTEXT-RESUME-COORDINATOR-CORE`

**Worktree:** `D:\Projects\RPL\.codex-build\worktrees\l3-context-resume-coordinator-core`

**Assigned base:** `eaeed50100ef95c452e2ebbb826e080def1ac29c`

## Changes

Added one synthetic-only PGlite composition test in `apps/db/test/investigation-ledger.test.ts`. It persists a schema 2.0 refs-only grounding context and version 1 L3 checkpoint, reloads the checkpoint, then uses the real L2 `GroundingContextResumer`, SQL exact-reference/span readers, and L3 coordinator to perform one bounded resume through a planner, registered action, and refresh. The `advanceFromCheckpoint` test wrapper handles a missing context as `context_missing` with the real resumer result `null`, then exits without calling the coordinator. For a found context, it compares checkpoint identity, sufficiency, current source/revision/origin lineage, persisted reference, and exact span before calling `coordinator.advance`.

The test also proves that a saved revision-state mismatch, paused source, and explicit withdrawn-source assertion fail closed with `revision_state_mismatch`, `source_ineligible`, and `source_invalidated`; these cases do not call coordinator ports. The successful advance calls planner/action/refresh once each. Reusing the old checkpoint returns `review_required: stale_checkpoint` before reservation-key replay. Case-scoped request, checkpoint, reservation, and progress-snapshot rows are captured before and after this stale rejection and remain unchanged; coordinator port counts also remain unchanged. This does not claim to exercise reservation-key replay because the old checkpoint is rejected first. The test compares publication, decision, outbox, and public-history-review counts before and after the whole test rather than assuming global counts are initially zero. It also verifies refs-only durable context/checkpoint/ledger data.

Missing context is modeled as an exact read miss at the L2 repository boundary because grounding-context rows are append-only. The context/checkpoint schemas, checkpoint version, production code, migrations, grants, dependencies, and runtime configuration are unchanged. No age-based expiry rule was added. The test uses unique synthetic fixture IDs and makes no model, source, or external-service calls.

## Commits

- `9efe9baa12a553ff0e043f86cf920c1ddc60706d` — `test(L3-CONTEXT-RESUME): compose refs-only checkpoint restart`
- `9d34250dfef3aeafbd214432cc9f3edcfba3a096` — `docs(L3-CONTEXT-RESUME): record coordinator resume handoff`
- `392473dfeebd8fb10b49ce257d60d85ea2242ebc` — `docs(L3-CONTEXT-RESUME): fix handoff whitespace`
- The follow-up commit message is `test(L3-CONTEXT-RESUME): strengthen replay and side-effect assertions`; its full SHA is included in the delivery message accompanying this file.

Changed paths are `apps/db/test/investigation-ledger.test.ts` and `docs/assignments/L3-CONTEXT-RESUME-COORDINATOR-CORE-HANDOFF.md` only.

## Verification

All commands ran from the assigned worktree through WSL `Ubuntu-26.04`, using Node `v24.21.0` and npm `11.19.0`; no packages were installed.

| Command | Result |
| --- | --- |
| `npm exec tsx -- --test apps/db/test/investigation-ledger.test.ts` | Pass, 13/13 tests, rerun after the follow-up including the pre-coordinator sufficiency comparison. |
| `npm run typecheck` | Pass in the original implementation and follow-up; the follow-up run is recorded after the final test edit. |
| `git diff --check eaeed50100ef95c452e2ebbb826e080def1ac29c..HEAD` | Pass in WSL after the follow-up commit. |
| `npm run db:test` | Previous broad run passed, 41/41 DB test files. It predates the final test-only refinements; the changed PGlite test was rerun afterward as above. |
| `npm test` | Previous combined run passed with exit 0; web, worker, all 41 DB files, and remaining suites passed. It predates the final test-only refinements; the changed PGlite test was rerun afterward as above. |
| `npm run build` | Previous run passed, including web build and Wrangler Worker dry-run. It predates the final test-only refinements; no production/build input changed. |

## Limits and remaining decisions

PGlite proves the local SQL/worker-port composition and synthetic replay/fail-closed behavior only. It does not establish hosted Neon behavior, live-source behavior, provider behavior, Cloudflare Workflow behavior, or production runtime wiring. No configuration or migration impact and no remaining contract or schema decisions were identified; root review and integration remain outstanding.
