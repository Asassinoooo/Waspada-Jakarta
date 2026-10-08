# L3-ACTION-RESERVATION-TIMING-CORE — create action time after planning

- **Status:** Accepted locally on `main`
- **Backlog ID:** `L3-ACTION-RESERVATION-TIMING-CORE`
- **Parent:** FR-07; NFR-01/02/05/07
- **Implementation model:** GPT-6 Luna, max reasoning
- **Branch:** `work/L3-ACTION-RESERVATION-TIMING-CORE`
- **Worktree:** `.codex-build/worktrees/l3-action-reservation-timing-core`
- **Base:** `6478e7427e00d3325528fa1f42773e05ce2cf78c`
- **Contract baseline:** Internal L3 coordinator port only. Keep schema 2.0, database schema, API/OpenAPI, Layer 2 model contracts, and reservation-ledger behavior unchanged.
- **Dependencies:** L3-COORDINATOR-CORE, L3-REASONING-STEP-CORE, L3-SINGLE-STEP-EXECUTOR-CORE, ADR-014/017/029/031/051.

## Objective

Remove the caller-supplied action timestamp from one bounded coordinator advance. Generate and validate it only after the planner has returned a valid proposal and reconciled checkpoint, so the action reservation cannot regress the checkpoint timestamp. Keep stable reservation IDs and all other coordinator behavior unchanged.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md`
- `docs/IMPLEMENTATION_BACKLOG.md`
- `ARCHITECTURE.md`
- [ADR-014](../decisions/ADR-014-l3-investigation-ledger.md)
- [ADR-017](../decisions/ADR-017-l3-single-step-execution.md)
- [ADR-029](../decisions/ADR-029-l3-budgeted-planner-call.md)
- [ADR-031](../decisions/ADR-031-l3-bounded-coordinator-advance.md)
- [ADR-051](../decisions/ADR-051-l3-advance-replay-and-stage-timing.md)
- `apps/worker/src/layers/l3-investigation/contracts.ts`
- `apps/worker/src/layers/l3-investigation/coordinator.ts`
- `apps/worker/test/l3-investigation-coordinator.test.ts`

## Allowed paths

- `apps/worker/src/layers/l3-investigation/contracts.ts`
- `apps/worker/src/layers/l3-investigation/coordinator.ts`
- `apps/worker/test/l3-investigation-coordinator.test.ts`
- This assignment's **Implementation handoff** section only

Do not change DB code, migrations, roles/grants, API/OpenAPI, Layer 2 contracts, providers, sources, runtime bindings, Wrangler configuration, dependencies/lockfiles, or other planning files. Do not implement reservation recovery or automatic replay. If the solution needs one of these paths or changes an external contract, stop and report the exact gap.

## Required behavior

1. Keep `reasoningReservationId`, `reasoningReservedAt`, and `actionReservationId` as stable advance inputs; remove `actionReservedAt` from the advance input contract and its validator.
2. Call the trusted `wallNow` only after a valid planner proposal and checkpoint have been accepted. Pass that timestamp to the action executor as `reservedAt`.
3. Require the new timestamp to be valid RFC3339 and not earlier than `planning.checkpoint.updated_at`. If clock access fails, returns malformed time, or moves backward, return a closed review result and do not call the action executor. Preserve the planner's durable checkpoint and do not pretend it was rolled back.
4. Do not sample action time when planning abstains, is replayed, fails, or returns a malformed proposal/checkpoint.
5. Update open/resume test builders and assertions to use the new input contract. Add meaningful tests for timestamp ordering, invalid/throwing clock, and proving no action invocation on those failures.
6. Preserve exact one-planner/one-action bounds, stable action reservation ID, result/error behavior, and existing L1/L2 refresh and progress semantics.

## Acceptance criteria

- A coordinator test proves the action reservation time is read after planner reconciliation and is at least the returned planner checkpoint time.
- Invalid, throwing, and out-of-order time cases fail closed before any action call.
- Planner rejection/replay paths do not request action time or call the action executor.
- Existing coordinator behavior remains covered; no test weakens stale-checkpoint or no-double-invocation assertions.
- Only the allowed paths change; no migration, dependency, API, provider/source, runtime, or deployment change occurs.
- In WSL Ubuntu-26.04 with existing dependencies, run the focused coordinator test, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD`. Record actual Node/npm versions and all results; do not install dependencies.

## Stop and handoff

Stop if correct replay requires a DB/schema change, recovery from an uncertain started handler, persistence of proposal/output content, a new provider, or a runtime/deployment change. Commit implementation and handoff separately on this task branch. Do not merge or push. Handoff with branch/worktree, exact base, commit SHAs and exact messages, changed paths, behavior, actual WSL commands/results and versions, limitations, migration/configuration impact, and remaining decisions. Root independently reviews and integrates.

## Implementation handoff

Implemented on branch `work/L3-ACTION-RESERVATION-TIMING-CORE` in worktree `D:\Projects\RPL\.codex-build\worktrees\l3-action-reservation-timing-core` (`/mnt/d/Projects/RPL/.codex-build/worktrees/l3-action-reservation-timing-core`), starting from exact base `6478e7427e00d3325528fa1f42773e05ce2cf78c`.

- **Implementation commit:** `6eb3675c98d3a023182cf80a83957e24ee309c6c` — `fix(L3): reserve action time after planning`
- **Changed implementation paths:** `apps/worker/src/layers/l3-investigation/contracts.ts`, `apps/worker/src/layers/l3-investigation/coordinator.ts`, and `apps/worker/test/l3-investigation-coordinator.test.ts`.
- **Behavior:** removed caller-supplied `actionReservedAt`; the coordinator now validates the planner proposal and checkpoint timestamp before sampling trusted wall time. It compares RFC3339 instants with their full fractional precision after applying offsets, normalizes lowercase `t`/`z` before invoking the existing executor, and returns the existing `ledger_uncertain` review result with the planner's durable checkpoint if time is malformed, throwing, or earlier. These cases make no action or refresh call. The action reservation ID and one-planner/one-action/refresh flow remain unchanged.
- **Timestamp profile:** the parser deliberately matches the bounded L2 app profile: at most 40 code units and 1–9 fractional digits. It rejects impossible Gregorian dates and leap seconds; the latter and longer fractional forms are outside this app profile even though RFC3339 permits them.
- **Runtime:** checks ran in WSL Ubuntu-26.04 with Linux Node `v24.21.0` and npm `11.19.0`, using existing dependencies.
- **Checks:** focused coordinator test (`tsx --test apps/worker/test/l3-investigation-coordinator.test.ts`) passed, 35/35; `npm run typecheck` passed; `npm run build` passed, including Vite production build and Wrangler dry run; `git diff --check 6478e7427e00d3325528fa1f42773e05ce2cf78c..HEAD` passed after the implementation commit.
- **Initial full suite:** `npm test` reported 40/41 database files passing because `investigation-ledger.test.ts` still replayed the old `10:03` timestamp while the coordinator now sampled `10:04` after planning. Root corrected that test-only fixture in `e516b3f` (`test(L3): align PGlite replay with coordinator-owned time`); the direct replay now uses the canonical planned action timestamp and verifies the persisted instant.
- **Migration/configuration impact:** none. No DB, schema, API, dependency, runtime-binding, or deployment changes.
- **Root review:** independent review found and fixed a trailing-newline acceptance bug in the strict timestamp parser and restored the prior `reasoningReservedAt` validation profile. Root preserved the reviewed follow-up commits as `54cbf54` (`fix(L3): preserve reasoning timestamp validation`) and `7b7d566` (`docs(L3): record timestamp validation follow-up`).

### Root integration and acceptance

Root accepted the branch on local `main`, preserving the agent's four commits above in root commits `765ae52` (`fix(L3): reserve action time after planning`), `d3da8ae` (`docs(L3): record action reservation timing handoff`), `54cbf54` (`fix(L3): preserve reasoning timestamp validation`), and `7b7d566` (`docs(L3): record timestamp validation follow-up`). Root added the PGlite fixture correction separately as `e516b3f` (`test(L3): align PGlite replay with coordinator-owned time`).

In WSL Ubuntu-26.04 with Linux Node `v24.21.0` and npm `11.19.0`, root independently passed the focused coordinator suite (37/37), the PGlite investigation-ledger file (13/13), the integrated `npm test` (web 60/60, Worker 448/448, DB 41/41 files, evaluation 19/19; command exit 0), `npm run typecheck`, `npm run build` (Vite production build and Wrangler dry run), and `git diff --check 6478e7427e00d3325528fa1f42773e05ce2cf78c..HEAD`. The operation changes no migration, grant, API/public schema, dependency, runtime binding, or deployment configuration. Hosted Neon, Cloudflare Workflow execution/recovery, live sources, and model/provider behavior remain unverified. This slice does not implement reservation recovery or Workflow runtime behavior.

### Follow-up review fixes

Applied on the same branch/worktree, based on `43f5b107afc514c943843298d10017ff3c8c5774`.

- **Implementation commit:** `56abca1702174e709113653a2b497260344c298d` — `fix(L3): preserve reasoning timestamp validation`
- **Changed paths:** `apps/worker/src/layers/l3-investigation/coordinator.ts` and `apps/worker/test/l3-investigation-coordinator.test.ts`.
- **Behavior and regressions:** strict planner/action timestamp parsing now also requires the regex match to equal the complete string, so a trailing newline fails before action invocation. Existing caller-supplied `reasoningReservedAt` validation is restored to its prior `TIMESTAMP_PATTERN` plus `Date.parse` behavior; a 30-digit fractional timestamp remains accepted and reaches the planner unchanged.
- **Runtime and checks:** WSL Ubuntu-26.04, Linux Node `v24.21.0`, npm `11.19.0`; focused coordinator test passed, 37/37; `npm run typecheck` passed; `npm run build` passed (Vite production build and Wrangler dry run); `git diff --check 43f5b107afc514c943843298d10017ff3c8c5774..HEAD` passed after the implementation commit.
- **Full suite:** not rerun for this follow-up. The previously recorded `npm test` failure remains the single out-of-scope stale replay fixture in `investigation-ledger.test.ts`; the DB test was not changed.
