# L3-ADVANCE-REVIEW-PENDING-PLANNER-RECONCILIATION-PGLITE-CORE — reconcile an already-started reasoning result under a review hold

- **Status:** Assigned for a test-only local composition.
- **Backlog ID:** `L3-ADVANCE-REVIEW-PENDING-PLANNER-RECONCILIATION-PGLITE-CORE`
- **Objective:** Prove that a known result from the exact already-started reasoning reservation is reconciled once when a sticky planning review marker is recorded during that call, after which the coordinator stops before taking further action.
- **Dependencies:** `L3-ADVANCE-REVIEW-PENDING-CORE`, `L3-COORDINATOR-CORE`, `L3-REASONING-STEP-CORE`, `L3-REASONING-STEP-PGLITE-CORE`, `L3-LEDGER-CORE`, `L3-INSUFFICIENT-CONTEXT-ENTRY-CORE`, `L2-INVESTIGATION-PLAN-CORE`, `L2-CONTEXT-PERSIST-CORE`, `DB-TEST-RUNNER-ISOLATION`, `L3-ADVANCE-REVIEW-PENDING-COORDINATOR-PGLITE-CORE`, `L3-ADVANCE-REVIEW-PENDING-ACTION-RECONCILIATION-PGLITE-CORE`; ADR-014/017/027/029/031/051.
- **Requirements:** FR-07/08; NFR-01/02/05/07.
- **Contract baseline:** Existing private schema-2.0 investigation checkpoint/grounding records, planner contract 1.0, and append-only migration-035 review marker. No public/API, schema, migration, grant, or runtime change.
- **Branch/worktree:** Use branch `work/L3-ADVANCE-REVIEW-PENDING-PLANNER-RECONCILIATION-PGLITE-CORE` in `.codex-build/worktrees/l3-advance-review-pending-planner-reconciliation-pglite-core`, based on the pushed assignment commit. The root dispatch records the exact base SHA. Do not edit through the root checkout.
- **Model:** GPT-6 Luna, max reasoning.

## Read before editing

Read `AGENTS.md`, `SOFTWARE_DEVELOPMENT_PLAN.md`, `docs/IMPLEMENTATION_BACKLOG.md`, this assignment, ADR-014/017/027/029/031/051, `apps/db/test/investigation-ledger.test.ts`, the accepted reasoning-step PGlite composition, the review-pending ledger/repository, the reasoning executor, and the coordinator. Confirm the marker's exact reservation identity and allowed `planning` / `planner_result_uncertain` representation before editing.

## Required behavior

1. Extend only `apps/db/test/investigation-ledger.test.ts` and this assignment's implementation handoff. Use the real PGlite ledger, reasoning-step executor, planner adapter and coordinator with authored synthetic context and a deterministic provider double.
2. Let the exact reasoning reservation start, then have the provider/test seam append a sticky marker for that same reservation with stage `planning` and reason `planner_result_uncertain` before returning a valid known proposal.
3. Assert the exact result reconciles once: the reasoning reservation completes, the bounded model usage/checkpoint is persisted, and the review marker remains. Assert the coordinator stops before the single-step action, refresh, or further progress.
4. Replay using the real coordinator/ledger. Assert the provider is not called again and all durable marker, reservation, checkpoint, budget, and progress state remains unchanged.
5. Preserve existing budget, proposal validation and fail-closed checks. The test demonstrates local ordering/reconciliation only; it does not establish hosted Workflow retry, cancellation, execution fencing, terminal proof, or permission to retry.
6. Use only the disposable PGlite test database and deterministic synthetic provider double. Do not invoke model APIs, source acquisition, hosted services, or live data.

## Allowed paths

- `apps/db/test/investigation-ledger.test.ts`
- `docs/assignments/L3-ADVANCE-REVIEW-PENDING-PLANNER-RECONCILIATION-PGLITE-CORE.md` (implementation handoff section only)

No production code, schema, migration, grant, public contract, dependency, configuration, source/provider, external service, or deployment change is authorized.

## Acceptance and verification

- One PGlite composition proves a planning-stage review marker created during an already-started reasoning call permits only that exact known result to reconcile, leaves the marker sticky, and blocks the remaining coordinator path. Replay does not call the provider or mutate durable state.
- Run checks in WSL Ubuntu-26.04 with installed dependencies: `npm exec --no -- tsx --test apps/db/test/investigation-ledger.test.ts`, `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD`. Record runtime versions and actual results.
- Commit the test and handoff on the task branch in coherent commits, leave its worktree clean, and do not merge or push. Root independently reviews and integrates accepted work.

Stop and report the exact gap if the existing ledger/executor cannot model this ordering without changing a contract, migration, production behavior, or grant. Escalate to GPT-6 Astra xhigh only after a GPT-6 Luna Max attempt fails on a substantive technical difficulty.

## Implementation handoff

Append the branch/worktree, exact base, commit SHAs and messages, changed paths, behavior, actual WSL checks, runtime versions, limitations, configuration impact, and remaining decisions here. Do not merge or push.
