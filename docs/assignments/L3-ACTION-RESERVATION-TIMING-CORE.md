# L3-ACTION-RESERVATION-TIMING-CORE — create action time after planning

- **Status:** Assigned for implementation
- **Backlog ID:** `L3-ACTION-RESERVATION-TIMING-CORE`
- **Parent:** FR-07; NFR-01/02/05/07
- **Implementation model:** GPT-6 Luna, max reasoning
- **Branch:** `work/L3-ACTION-RESERVATION-TIMING-CORE`
- **Worktree:** `.codex-build/worktrees/l3-action-reservation-timing-core`
- **Base:** To be pinned by root immediately before dispatch; implementation must start from the exact commit named in the dispatch.
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

Not started.
