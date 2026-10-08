# L3-ADVANCE-REVIEW-PENDING-CORE — durable hold for uncertain partial advances

- **Status:** Assigned for implementation
- **Backlog ID:** `L3-ADVANCE-REVIEW-PENDING-CORE`
- **Parent:** FR-07; NFR-01/02/05/07
- **Implementation model:** GPT-6 Luna, max reasoning
- **Branch:** `work/L3-ADVANCE-REVIEW-PENDING-CORE`
- **Worktree:** `.codex-build/worktrees/l3-advance-review-pending-core`
- **Base:** `1a5382e9b1b047409cb081348b6a8635fd98e47d`
- **Contract baseline:** Internal DB/L3 contract only. A dedicated database migration and exact L3 coordinator-role grants are permitted. Keep schema 2.0 checkpoints, public API/OpenAPI, source/evidence contracts, publication authority, and runtime/deployment configuration unchanged.
- **Dependencies:** L3-COORDINATOR-CORE, L3-CONTEXT-RESUME-COORDINATOR-CORE, L3-ACTION-RESERVATION-TIMING-CORE, ADR-014/017/031/051.

## Objective

Record bounded review intent durably when one coordinator advance has explicit evidence of uncertain partial work. Keep the marker separate from append-only checkpoints so a handler already authorized by `startAction` can reconcile its actual result against the exact checkpoint version. A pending marker is only a sticky hold signal: it is not a cancellation, terminal/fencing proof, permission to call `reconcileInterrupted`, or authorization to retry.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md`
- `docs/IMPLEMENTATION_BACKLOG.md`
- `ARCHITECTURE.md`
- [ADR-014](../decisions/ADR-014-l3-investigation-ledger.md)
- [ADR-017](../decisions/ADR-017-l3-single-step-execution.md)
- [ADR-031](../decisions/ADR-031-l3-bounded-coordinator-advance.md)
- [ADR-051](../decisions/ADR-051-l3-advance-replay-and-stage-timing.md)
- `apps/db/src/investigation-ledger.ts`
- `apps/worker/src/layers/l3-investigation/contracts.ts`
- `apps/worker/src/layers/l3-investigation/coordinator.ts`

## Allowed paths

- `apps/db/migrations/035_l3_advance_review_pending.sql`
- `apps/db/src/investigation-ledger.ts`
- `apps/db/test/investigation-ledger.test.ts`
- `apps/db/test/migrations.test.ts`
- `apps/worker/src/layers/l3-investigation/contracts.ts`
- `apps/worker/src/layers/l3-investigation/coordinator.ts`
- `apps/worker/src/layers/l3-investigation/telemetry.ts` and its focused test only if the repository interface change requires it
- `apps/worker/test/l3-investigation-coordinator.test.ts`
- `apps/worker/test/l3-reasoning-step-executor.test.ts`
- `apps/worker/test/l3-single-step-executor.test.ts`

Do not edit other files. If a required path is missing, a migration number changed, or correctness requires a contract/runtime outside this list, stop and report the exact dependency before expanding scope.

## Required behavior

1. Add a private, append-only per-investigation review-pending marker in migration 035. Keep only bounded operational identity and closed enums: dataset and investigation identity, the checkpoint version observed, a closed stage and reason, an optional reservation ID, and marked time. Do not persist error text, prompts, proposals, action inputs/results, evidence content, or output references. Enforce one sticky pending marker per investigation; an exact duplicate returns the original marker, while a conflicting duplicate returns a stable closed conflict without changing it.
2. Restrict marker `SELECT` and `INSERT` to `waspada_l3_coordinator`. Deny `UPDATE` and `DELETE` (including through a trigger); public, L1, L2, and L4 roles receive no access. Preserve existing role boundaries and migration ordering.
3. Serialize marker creation, reservation, and start under the same investigation-request row lock. If the marker commits first, later reservations/starts and new progress are denied. If `startAction` commits first, preserve its already-granted invocation; the marker cannot cancel it. The actual result of that exact started reservation may reconcile normally against its original checkpoint and budget, while the marker remains pending.
4. Gate coordinator entry on marker state before all early returns, including sufficient-context and replay paths. Recheck after planner/action reconciliation and before any subsequent action, refresh, or progress. Repository checks are authoritative; a coordinator read alone cannot close the start race.
5. Gate the repository's reserve/start and grounding-progress/resume paths under the same case lock, including replay reads that could otherwise return an actionable prior result. Do not let ordinary pause, resume, termination, or progress operations clear or bypass a marker. Permit accounting reconciliation for the already-started reservation; do not call `reconcileInterrupted` because a marker exists.
6. Request a marker only when the coordinator has explicit bounded evidence that the current advance entered a durable stage and cannot safely continue. Candidate branches include a validated planner result followed by invalid next-step state/time; a planner/action reservation replay without the result needed to continue; uncertain reserve/start/reconciliation; an executed action followed by malformed checkpoint/result, failed/invalid grounding refresh, or uncertain progress commit. Associate the marker with that exact stage and stable reservation identity where available. Track whether a durable stage was entered instead of inferring it from a generic error string.
7. A marker does not fence an in-flight coordinator or external handler. A refresh that began before marker commit may persist an unadopted context; after observing the marker, do not adopt that context or proceed to progress/another action. Document this limit. Do not claim the marker proves the prior attempt is terminal or safe to replay.
8. Keep the marker sticky in this task. Do not implement a moderator resolution path, marker clearing, Workflow binding, timeout recovery, automatic retries, action-result receipts, public route, or UI mutation.
9. Do not mark the initial stale-checkpoint branches: they reject before stage execution and include harmless duplicate requests after a completed advance. Do not mark from `reservation_in_flight` alone because it may refer to a still-running owner; do not treat generic `ledger_uncertain`, planner/action unavailable, known terminal results, or a concurrent stale outcome as sufficient evidence without a matching stage/reservation signal.

## Acceptance checks

- A marker insert is idempotent for the same case and bounded identity; conflicts preserve the original row.
- Both lock orderings are exercised: mark-before-start denies `mayInvoke`; start-before-mark preserves invocation and permits only its exact normal reconciliation.
- A started reservation is never released or timed out because of a marker, and its checkpoint version/budget are not stranded by the marker.
- A marker blocks new reservation/start, coordinator work, progress, and actionable replay; duplicate completed stale-checkpoint requests do not mark the case.
- Trigger tests distinguish uncertain post-stage failures from completed stale replays and do not mark a case on `reservation_in_flight` alone.
- Migration tests verify exact role grants and append-only behavior; unrelated roles cannot read or mutate the marker.
- PGlite tests are local ordering/privilege proofs only; do not claim they establish hosted, independent-session PostgreSQL fencing or cancellation.

## Verification commands

Run only in WSL Ubuntu-26.04 with the repository's existing dependencies. Record Linux Node/npm versions and actual results.

- `npm exec tsx -- --test apps/db/test/investigation-ledger.test.ts apps/db/test/migrations.test.ts`
- `npm exec tsx -- --test apps/worker/test/l3-investigation-coordinator.test.ts apps/worker/test/l3-reasoning-step-executor.test.ts apps/worker/test/l3-single-step-executor.test.ts`
- `npm test`
- `npm run typecheck`
- `npm run build`
- `git diff --check 1a5382e9b1b047409cb081348b6a8635fd98e47d..HEAD`

## Stop conditions

Stop and report if a safe implementation requires an execution fence/terminal proof, automatic retry or marker clearing, publication/moderator mutation, changes to schema 2.0/public API, access by non-L3 roles, paid resources, external service configuration, or Workflow/runtime/deployment wiring. Do not install dependencies, contact live sources, or test against hosted Neon.

## Root handoff record

Root will record the accepted implementation commit(s), exact messages, changed paths, actual WSL checks, limitations, and migration impact here after independent review. The implementer must return those details and must not merge or push.
