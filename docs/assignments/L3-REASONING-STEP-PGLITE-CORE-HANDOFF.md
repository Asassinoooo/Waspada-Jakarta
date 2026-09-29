# L3-REASONING-STEP-PGLITE-CORE — implementation handoff

## Branch and commits

- Branch: `work/L3-REASONING-STEP-PGLITE-CORE`
- Worktree: `C:\Users\perry\.codex\worktrees\obs-01-l1-fixture-telemetry\RPL` (`/mnt/c/Users/perry/.codex/worktrees/obs-01-l1-fixture-telemetry/RPL` in WSL)
- Base: `4e24882198de89ff1efd36adb4b477b2fc78a650` — `docs(L3-REASONING-STEP-PGLITE-CORE): pin task base commit`
- Test commit: `a855445457dc16158ec738cedb289ac7fa3661d8` — `test(L3-REASONING-STEP-PGLITE-CORE): verify planner ledger accounting`
- Handoff commit: `docs(L3-REASONING-STEP-PGLITE-CORE): record PGlite integration handoff`; its full SHA is included in the task report after commit.

## Changed paths and behavior

- `apps/db/test/investigation-ledger.test.ts` adds two PGlite integration cases. Both create a persisted insufficient synthetic case with the real SQL ledger repository and inject a typed planner double. The preflight validates the schema 2.0 grounding context, while the plan input uses the fixture's persisted dataset, trace, context and candidate identity.
- The proposal case observes the SQL reservation and checkpoint from inside the planner callback and verifies the reservation is already started with the full time/token reservation. It then checks one planner invocation, three measured active seconds, 25 actual tokens, exact trusted model/prompt metadata in the persisted `ModelRun`, closed successful reservation state, and zero remaining reserved counters. Retrying the original checkpoint version and reservation ID returns `stale_checkpoint`, makes no second planner call, and leaves the saved checkpoint and reservation unchanged.
- The provider-error case also confirms the reservation is started before the planner call. It checks one call, a reconciled failed reservation, the full configured seven seconds and 83 tokens consumed, no `ModelRun`, closed timestamps, and zero reserved counters. Ledger JSON is checked to exclude the planner request, synthetic excerpt, proposed action input, and provider exception text.
- The test exercises real PGlite migrations, the existing grounding fixture, and `createSqlInvestigationLedgerRepository`; only the planner is a double.

## Verification

Checks ran in WSL Ubuntu-26.04 using Node.js `v24.21.0` and npm `11.19.0`. Existing locked test/build dependencies were unchanged: PGlite `0.5.8`, PGlite PostGIS `0.2.8`, PGlite pgvector `0.0.9`, tsx `4.23.15`, TypeScript `7.0.2`, Vite `8.3.0`, and Wrangler `4.137.0`.

- `node_modules/.bin/tsx --test apps/db/test/investigation-ledger.test.ts` — 8/8 passed.
- `npm run db:test` — 21/21 DB test files passed.
- `npm test` — exited 0; web 60, Worker 327, DB 21/21 files, evaluation 12.
- `npm run typecheck` — passed.
- `npm run build` — passed; Vite production build and Wrangler `4.137.0` dry run completed, with the Worker still exposing only `DATASET_MODE="demo"`.
- `git diff --check` and staged `git diff --cached --check` — passed.

## Limitations and impact

All records are synthetic and the planner is an injected double. This verifies local PGlite repository behavior and wrapper accounting only; hosted Neon sessions, provider behavior/cancellation, live sources, and Worker runtime composition were not tested. No production source, migration/schema, dependency, package script, or runtime configuration changed. There are no unresolved implementation decisions within this test-only assignment; root review and acceptance remain pending.
