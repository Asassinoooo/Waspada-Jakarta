# L3-ADVANCE-REVIEW-PENDING-ACTION-RECONCILIATION-PGLITE-CORE — reconcile the exact started action, then stop

- **Status:** Assigned for a test-only local composition.
- **Backlog ID:** `L3-ADVANCE-REVIEW-PENDING-ACTION-RECONCILIATION-PGLITE-CORE`
- **Dependencies:** L3-ADVANCE-REVIEW-PENDING-CORE, L3-COORDINATOR-CORE, L3-SINGLE-STEP-EXECUTOR-CORE, L3-LEDGER-CORE, L3-ADVANCE-REVIEW-PENDING-COORDINATOR-PGLITE-CORE, DB-TEST-RUNNER-ISOLATION; ADR-014/017/031/051.
- **Requirements:** FR-07; NFR-01/02/05/07.
- **Contract baseline:** Existing private ledger/checkpoint and schema 2.0 grounding contracts. No schema, migration, role, API, or runtime change.
- **Branch/worktree:** Create `work/L3-ADVANCE-REVIEW-PENDING-ACTION-RECONCILIATION-PGLITE-CORE` in its own worktree under `.codex-build/worktrees/l3-advance-review-pending-action-reconciliation-pglite-core`, based on pushed `main` after this assignment commit. Do not edit through the root checkout.
- **Model:** GPT-6 Luna, max reasoning.

## Objective

Verify the accepted recovery boundary through the real local SQL ledger, single-step executor and coordinator: after `startAction` authorizes a handler, a review-pending marker may be recorded while that handler is running; the exact already-started reservation may reconcile its known result once, but the coordinator must observe the still-sticky marker and stop before refresh or progress.

This test proves deterministic local ordering only. It does not prove that a remote action stopped, authorize a retry, clear the marker, or establish hosted locking/fencing or Workflow recovery.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md`
- `docs/IMPLEMENTATION_BACKLOG.md`
- `docs/decisions/ADR-014-l3-investigation-ledger.md`
- `docs/decisions/ADR-017-l3-action-reservations.md`
- `docs/decisions/ADR-031-l3-bounded-coordinator-advance.md`
- `docs/decisions/ADR-051-l3-advance-replay-and-stage-timing.md`
- `docs/assignments/L3-ADVANCE-REVIEW-PENDING-CORE.md`
- `docs/assignments/L3-ADVANCE-REVIEW-PENDING-COORDINATOR-PGLITE-CORE.md`
- `docs/assignments/L3-SINGLE-STEP-EXECUTOR-CORE.md`
- `apps/db/test/investigation-ledger.test.ts`
- `apps/worker/src/layers/l3-investigation/coordinator.ts`
- `apps/worker/src/layers/l3-investigation/single-step-executor.ts`

## Required behavior

1. Extend only the existing PGlite-backed `apps/db/test/investigation-ledger.test.ts` composition. Use the real SQL investigation ledger, `createSingleStepExecutor`, and `createInvestigationCoordinator`, with authored synthetic contexts and scripted model/action ports.
2. Drive one bounded coordinator advance to a registered synthetic action. In the action handler, after the real executor has successfully started the exact reservation and before the handler returns, persist `action_result_uncertain` for that exact reservation through the existing marker repository method.
3. Return a fixed, valid synthetic action result. Verify `reconcileAction` accepts only that exact started reservation, records the known outcome once, updates the consumed reservation budget/checkpoint, and leaves the append-only review marker present.
4. Verify the coordinator returns the closed `review_required` / `advance_review_pending` outcome after reconciliation and does not invoke the refresh port or persist grounding progress. Count handler/planner/refresh calls and inspect the exact reservation, marker, checkpoint, and budget through the SQL repository.
5. Replay the same coordinator advance. It must stop on the persisted marker before planner/action/refresh calls; the handler must not run a second time and durable state must remain unchanged.
6. Keep `reconcileInterrupted`, new reservations, marker removal, retries, Workflow wiring, production changes, and source/provider behavior out of scope. If the accepted behavior cannot be composed without one of those changes, stop and report the exact gap instead of implementing production code.

## Allowed paths

- `apps/db/test/investigation-ledger.test.ts`
- `docs/assignments/L3-ADVANCE-REVIEW-PENDING-ACTION-RECONCILIATION-PGLITE-CORE.md` (handoff section only)

No production code, migration, grants, contract, telemetry, other test, API, Workflow/runtime, external service, dependency, source, or deployment change is authorized.

## Acceptance and verification

- One PGlite composition proves exact started-action result reconciliation can finish while the marker remains pending, after which the coordinator stops before refresh/progress; replay stays closed and never invokes the handler again.
- Run in WSL Ubuntu-26.04 with existing dependencies: focused `apps/db/test/investigation-ledger.test.ts`, `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD`. Record actual runtime versions and results.
- Commit the test and handoff on the task branch. Do not push or merge. Root independently reviews and integrates accepted work.

Stop if success requires a production contract, migration, privilege, coordinator behavior change, runtime, provider, hosted service, action retry, marker clearing, or termination claim. Escalate to GPT-6 Astra xhigh only after a Luna/max attempt leaves a substantive technical issue unresolved.

## Implementer handoff

Append exact branch/worktree, base, commit SHAs/messages, changed paths, behavior, checks actually run, limitations, configuration impact, and remaining decisions here after committing.

### Implementer handoff — 2026-10-09

- **Backlog item:** `L3-ADVANCE-REVIEW-PENDING-ACTION-RECONCILIATION-PGLITE-CORE` (test implementation complete; root review pending).
- **Branch:** `work/L3-ADVANCE-REVIEW-PENDING-ACTION-RECONCILIATION-PGLITE-CORE`.
- **Worktree:** `D:\Projects\RPL\.codex-build\worktrees\l3-advance-review-pending-action-reconciliation-pglite-core`.
- **Assigned base:** pushed `main` at `3e1370927c80f1673c3801e043230d1c8d7a737b`.
- **Implementation commit:** `07efe2d26d18772c1fb40ed65913255adc1ee36c`, `test(L3-ADVANCE-REVIEW-PENDING): cover exact action reconciliation`.
- **Handoff documentation commit:** this section is committed separately with message `docs(L3-ADVANCE-REVIEW-PENDING): record reconciliation handoff`; its exact SHA is included in the implementer-to-reviewer handoff accompanying this commit.
- **Changed paths:** `apps/db/test/investigation-ledger.test.ts`; this assignment's handoff section only.
- **Behavior verified:** a real PGlite ledger, single-step executor, and coordinator start the exact action before its handler writes the action-stage `action_result_uncertain` marker. The known result reconciles exactly once, accounts for the reservation budget and checkpoint, and preserves the marker. The coordinator then returns `review_required` / `advance_review_pending` without refresh or progress writes. Replaying returns the same hold without another planner, action, handler, or refresh call, with durable state unchanged.
- **Verification runtime/dependencies:** WSL Ubuntu-26.04; Node `v24.21.0`; npm `11.19.0`; Linux `x86_64` under WSL2. Existing locked dependencies were reused: PGlite `0.5.8`, tsx `4.23.15`, TypeScript `7.0.2`, Vite `8.3.0`, and Wrangler `4.137.0`. No dependencies were installed.
- **Checks actually run:**
  - `npm exec --no -- tsx --test apps/db/test/investigation-ledger.test.ts` — passed, 20/20 tests.
  - `npm run db:test` — passed, 44/44 DB test files (exit 0).
  - `npm test` — passed, 464/464 general tests, nested DB suite 44/44 files, and casebook suite 19/19 (exit 0).
  - `npm run typecheck` — passed (exit 0).
  - `npm run build` — passed; web Vite production build and Worker Wrangler dry run succeeded (exit 0).
  - `git diff --check 3e1370927c80f1673c3801e043230d1c8d7a737b..HEAD` — passed after both commits (exit 0; no whitespace errors).
- **Limitations:** this is deterministic local SQL/executor ordering coverage only. It does not establish remote cancellation, action retry, marker clearing, hosted locking/fencing, Workflow recovery, or source-dependent evaluation readiness.
- **Migration/configuration impact:** none; no production code, schema, migration, grants, runtime, dependency, or configuration changed.
- **Remaining decisions:** root review and acceptance. Source rights and EVAL-01 human-labeled casebook rights remain pending and are not addressed by this credential-free local test.
