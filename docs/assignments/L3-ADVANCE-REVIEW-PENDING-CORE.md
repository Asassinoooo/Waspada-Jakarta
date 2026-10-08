# L3-ADVANCE-REVIEW-PENDING-CORE — durable hold for uncertain partial advances

- **Status:** Accepted locally on `main` after independent root review
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
- `apps/db/test/public-event-updates.test.ts` only to keep its intentionally partial migration fixture excluding migration 035 and to preserve the expected list of migrations it explicitly applies
- `apps/worker/src/layers/l3-investigation/contracts.ts`
- `apps/worker/src/layers/l3-investigation/coordinator.ts`
- `apps/worker/src/layers/l3-investigation/coordinator-telemetry.ts` and `apps/worker/test/l3-coordinator-telemetry.test.ts` only to preserve the new closed review outcome
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
5. Gate the repository's reserve/start and grounding-progress/resume paths under the same case lock, including replay reads that could otherwise return an actionable prior result. Do not let ordinary pause, resume, termination, or progress operations clear or bypass a marker. Permit `releaseUninvoked` only for a reservation still proven `reserved` under that lock, so a denied start can refund its reserved budget while leaving the marker pending; never release a `started` reservation. Permit normal accounting reconciliation for the already-started reservation; do not call `reconcileInterrupted` because a marker exists.
6. Request a marker only when the coordinator has explicit bounded evidence that the current advance entered a durable stage and cannot safely continue. Candidate branches include a validated planner result followed by invalid next-step state/time; a planner/action reservation replay without the result needed to continue; uncertain reserve/start/reconciliation; and an executed action followed by malformed checkpoint/result, failed/invalid grounding refresh, failed progress preparation (including missing fingerprint key or invalid progress time), or uncertain progress commit. Associate the marker with that exact stage and stable reservation identity where available. Track whether a durable stage was entered instead of inferring it from a generic error string.
7. A marker does not fence an in-flight coordinator or external handler. A refresh that began before marker commit may persist an unadopted context; after observing the marker, do not adopt that context or proceed to progress/another action. Document this limit. Do not claim the marker proves the prior attempt is terminal or safe to replay.
8. Keep the marker sticky in this task. Do not implement a moderator resolution path, marker clearing, Workflow binding, timeout recovery, automatic retries, action-result receipts, public route, or UI mutation.
9. Do not mark the initial stale-checkpoint branches: they reject before stage execution and include harmless duplicate requests after a completed advance. Do not mark from `reservation_in_flight` alone because it may refer to a still-running owner; do not treat generic `ledger_uncertain`, planner/action unavailable, known terminal results, or a concurrent stale outcome as sufficient evidence without a matching stage/reservation signal.

## Acceptance checks

- A marker insert is idempotent for the same case and bounded identity; conflicts preserve the original row.
- Both lock orderings are exercised: mark-before-start denies `mayInvoke`; start-before-mark preserves invocation and permits only its exact normal reconciliation.
- A started reservation is never released or timed out because of a marker, and its checkpoint version/budget are not stranded by the marker.
- A marker-denied not-yet-started reservation may be released only while it remains `reserved`; that release preserves the marker and does not permit a new start.
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

The implementer worked on branch `work/L3-ADVANCE-REVIEW-PENDING-CORE` in `.codex-build/worktrees/l3-advance-review-pending-core`, based on `1a5382e9b1b047409cb081348b6a8635fd98e47d`. Agent commits, preserved on the task branch, were:

- `d563a61a386319fe397b6dfd2aaefba344f0ac9c` — `feat(L3): add durable advance review hold`
- `bb5e993c1cbf914a30ef916a2e8c01a8522fbe9c` — `fix(L3): close review marker identity and telemetry gaps`
- `1b010ef61b7f6415a9f945fc10cd5b937b82da35` — `fix(L3): serialize review markers and preserve planner uncertainty`
- `eb07866c4aba92b60b27655c2f5145f9dde8acca` — `fix(L3): bind pending markers to the exact started reservation`

Root cherry-picked these as `40dc18b3ecc3c2f44328b8f1df283e7f6eb14ef4` (`feat(L3): add durable advance review hold`), `01098da4870e8c3790a9ad80b6a144756b1a95c5` (`fix(L3): close review marker identity and telemetry gaps`), `a08a1d6e77baa5570524ae9d7785e94631ccc6d9` (`fix(L3): serialize review markers and preserve planner uncertainty`), and `f22e58170e8337b18e83157ade58ef2cf6e6c24f` (`fix(L3): bind pending markers to the exact started reservation`). The implementation changes 14 paths: migration `apps/db/migrations/035_l3_advance_review_pending.sql`; DB ledger and tests in `apps/db/src/investigation-ledger.ts`, `apps/db/test/investigation-ledger.test.ts`, `apps/db/test/migrations.test.ts`, and `apps/db/test/public-event-updates.test.ts`; L3 contracts, coordinator, and telemetry in `apps/worker/src/layers/l3-investigation/`; and the corresponding five focused Worker test files.

Migration 035 adds a private append-only per-investigation marker with L3-coordinator-only read/insert grants and request-row serialization. The coordinator checks it before replay and early-return paths, after reconciliation, and before subsequent work. It blocks new reservations, starts, progress, and actionable replays. A started action remains authorized to finish; a marker created during that action must identify its exact reservation, which can reconcile against its original checkpoint and budget. It does not cancel an in-flight handler, establish terminal state, or authorize retry. No public contract, schema 2.0 checkpoint, Workflow binding, or deployment configuration changed.

In WSL Ubuntu-26.04 using Node `v22.23.2` and npm `12.0.2`, the agent reported focused DB tests **37/37**, focused Worker tests **117/117**, full `npm test`, `npm run typecheck`, `npm run build`, and the assigned-base `git diff --check` passing. Root independently passed the focused DB suite **37/37**, focused Worker suite **88/88**, `npm run build` (workspace typecheck, Vite production build, and Wrangler dry-run), and reviewed the final code and both lock orderings. PGlite proves local ordering and role behavior only; it does not prove independent-session hosted PostgreSQL locking, Workflow fencing, or production recovery. Migration 035 is the only schema change; no new grant outside the L3 coordinator role or runtime/configuration change was made. No unresolved local design decision remains; hosted concurrency and recovery remain unverified.
