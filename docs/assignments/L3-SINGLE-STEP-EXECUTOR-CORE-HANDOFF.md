# L3-SINGLE-STEP-EXECUTOR-CORE implementation handoff

## Delivery

- **Branch:** `work/L3-SINGLE-STEP-EXECUTOR-CORE`
- **Worktree:** `D:\Projects\RPL\.codex-build\worktrees\l3-single-step-executor-core` (WSL: `/mnt/d/Projects/RPL/.codex-build/worktrees/l3-single-step-executor-core`)
- **Base:** `0e8b54ee244986b4370181a5f4edc1ebeb0b045d`
- **Implementation commit:** `4d52744e26a523dd8bef1e05c2b1a653f15d87e1` — `feat(L3-SINGLE-STEP-EXECUTOR-CORE): execute one registered action`
- **Handoff:** committed separately with `docs(L3-SINGLE-STEP-EXECUTOR-CORE): record implementation handoff`

## Behavior implemented

`createSingleStepExecutor` accepts one closed proposal with dataset, investigation ID, expected checkpoint version, caller-supplied reservation ID and timestamp, exact action name, and action-specific input. It checks action names and registry entries strictly, clones bounded JSON input before parsing, and returns closed denial or review results for malformed, unregistered, disabled, or action-invalid proposals before any ledger call.

The service reserves exactly one tool attempt, the registered maximum active seconds, and zero model tokens. A `reserveAction` replay returns its checkpoint without starting. A new reservation is identified by `replayed === false`; `startAction` is the only invocation gate, and the handler runs only when its result has `mayInvoke === true` and is not a replay. A replayed or uncertain start returns its checkpoint without invoking. Reconciliation uses the checkpoint version returned by the reservation and happens once for each handler invocation. Reservation, start, and reconciliation errors pass through unchanged.

The handler receives parsed input and an `AbortSignal`. Injected wall-clock, monotonic-clock, and timer ports control timestamps, usage measurement, and the active-time deadline. Timeout aborts the signal, charges the exact registered maximum, records `timed_out`, and discards any late handler result. Exceptions, malformed receipts, or unknown usage become a generic `failed` outcome charged at the full reservation. Valid outcomes are closed statuses; returned references are limited to at most eight unique ID-shaped values. Arbitrary result fields, raw errors, source content, and prompts are not returned or sent to ledger arguments. When telemetry is injected, the service decorates the repository through `createTelemetryInvestigationLedgerRepository` and emits no separate L3 events.

The tests use one synthetic action and a scripted ledger fake. They cover ordering and exact budget reservation, the reservation checkpoint version used for reconciliation, invalid/unknown/disabled proposals, reserve replay, non-invocable and replayed starts, reserve/start/reconcile error identity, caller input immutability, bounded references, malformed outputs and exceptions, normal and synchronous deadline behavior, late completion/failure, and telemetry delegation.

## Changed paths

- `apps/worker/src/layers/l3-investigation/single-step-executor.ts`
- `apps/worker/test/l3-single-step-executor.test.ts`
- `apps/worker/package.json` — Worker test discovery only
- `docs/assignments/L3-SINGLE-STEP-EXECUTOR-CORE-HANDOFF.md` — this handoff commit

No database code, migration, schema/OpenAPI contract, dependency, lockfile, credential, source/provider adapter, application runtime composition, route, UI, deployment, or ADR changed. There is no migration or configuration impact.

## Verification

Checks ran in WSL Ubuntu-26.04 with the existing native Node runtime on `PATH`: Node.js `v24.21.0`, npm `11.19.0`, tsx `4.23.15`, TypeScript `7.0.2`, Wrangler `4.137.0`, and Vite `8.3.0`.

- From `apps/worker`, `/mnt/d/Projects/RPL/node_modules/.bin/tsx --test test/l3-single-step-executor.test.ts` — passed 12/12.
- `npm test` — passed 208/208 total: web 5, Worker 113, DB 78 across 10 isolated test files, and evaluation casebook 12.
- `npm run typecheck` — passed for web, Worker, database, and evaluation.
- `npm run build` — passed; Vite production build and Wrangler `4.137.0` Worker dry-run succeeded.
- With explicit WSL `GIT_DIR` / `GIT_WORK_TREE` for this Windows-created worktree, `git diff --cached --check` and `git diff --check` — passed.

## Limitations and remaining decisions

The ledger fake proves service ordering and closed accounting behavior, not hosted PostgreSQL concurrency or Worker/database wiring. The executor adds no registered action to the application runtime. A handler that ignores its abort signal may continue after a timeout; its late result is discarded, and the executor never retries it.

This enables only one injected action per service call. It adds no model planner, live tool or source, L3 loop, background continuation, runtime wiring, route, or publication behavior. No contract gap or migration decision remains for root review; integration and task acceptance remain with the root reviewer.
