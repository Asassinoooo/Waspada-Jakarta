# L3-ADVANCE-REVIEW-PENDING-COORDINATOR-PGLITE-CORE — persisted marker blocks restarted coordination

- **Status:** Assigned for a test-only local composition.
- **Backlog ID:** `L3-ADVANCE-REVIEW-PENDING-COORDINATOR-PGLITE-CORE`
- **Dependencies:** L3-ADVANCE-REVIEW-PENDING-CORE, L3-COORDINATOR-CORE, L3-CONTEXT-RESUME-COORDINATOR-CORE, L3-LEDGER-CORE, DB-TEST-RUNNER-ISOLATION; ADR-014/031/049/051.
- **Requirements:** FR-07; NFR-01/02/05/07.
- **Contract baseline:** Existing private ledger/checkpoint and schema 2.0 grounding contracts. No schema, migration, role, API, or runtime change.
- **Branch/worktree:** Create `work/L3-ADVANCE-REVIEW-PENDING-COORDINATOR-PGLITE-CORE` in its own worktree under `.codex-build/worktrees/l3-advance-review-pending-coordinator-pglite-core`, based on pushed `main` after this assignment commit. Do not edit through the root checkout.
- **Model:** GPT-6 Luna, max reasoning.

## Objective

Close the local repository-to-coordinator test seam. Persist a review-pending marker through the real SQL investigation-ledger repository, then create a fresh coordinator instance against that repository and prove the marker blocks progress before planner, action, or refresh ports are invoked.

The marker remains a sticky hold. This test does not prove cancellation, terminal state, execution fencing, or permission to retry/reconcile an uncertain action.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md`
- `docs/IMPLEMENTATION_BACKLOG.md`
- `docs/decisions/ADR-014-l3-investigation-ledger.md`
- `docs/decisions/ADR-031-l3-bounded-coordinator-advance.md`
- `docs/decisions/ADR-049-l3-context-resume.md`
- `docs/decisions/ADR-051-l3-advance-replay-and-stage-timing.md`
- `docs/assignments/L3-ADVANCE-REVIEW-PENDING-CORE.md`
- `docs/assignments/L3-COORDINATOR-CORE.md`
- `docs/assignments/L3-CONTEXT-RESUME-COORDINATOR-CORE.md`
- `apps/db/test/investigation-ledger.test.ts`
- `apps/worker/src/layers/l3-investigation/coordinator.ts`

## Required behavior

1. Extend only the existing PGlite-backed `apps/db/test/investigation-ledger.test.ts` composition. Reuse the real L3 repository, persisted investigation/checkpoint/reservation, and marker path. Use only authored synthetic records and scripted port doubles.
2. Persist the exact marker after a started reservation under the existing accepted policy, then construct a fresh coordinator over the same SQL repository and advance the matching checkpoint.
3. Assert the coordinator returns the closed `advance_review_pending` outcome before planner, action executor, or refresh ports are invoked. Assert the checkpoint, marker, reservation, and budget snapshots remain unchanged.
4. Replay the same advance and verify it remains blocked without extra calls or writes. Cover sufficient-context early-return ordering too, so context sufficiency cannot bypass a persisted marker.
5. Reuse existing contract semantics; do not add marker-clearing, retry, `reconcileInterrupted`, cancellation, fencing, or terminal-proof behavior.
6. If an accepted helper cannot express this composition, report the exact gap instead of adding production code or changing any contract.

## Allowed paths

- `apps/db/test/investigation-ledger.test.ts`
- `docs/assignments/L3-ADVANCE-REVIEW-PENDING-COORDINATOR-PGLITE-CORE.md` (handoff section only)

No production code, migration, grants, contract, telemetry, other test, API, Workflow/runtime, external service, dependency, source, or deployment change is authorized.

## Acceptance and verification

- One test composition proves persisted-marker behavior through a restarted coordinator for ordinary and sufficient-context paths, with zero forbidden port calls and stable replay.
- Run in WSL Ubuntu-26.04 with existing dependencies: focused `apps/db/test/investigation-ledger.test.ts`, `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD`. Record actual versions and results.
- Commit the test and handoff on the task branch. Do not push or merge. Root independently reviews and integrates accepted work.

Stop if success requires a production contract, migration, privilege, coordinator behavior, runtime, source, provider, or hosted-service change. Escalate to GPT-6 Astra xhigh only after a Luna/max attempt leaves a substantive technical issue unresolved.

## Implementer handoff

Append exact branch/worktree, base, commit SHAs/messages, changed paths, behavior, actual checks, versions, limitations and remaining decisions here after committing.
