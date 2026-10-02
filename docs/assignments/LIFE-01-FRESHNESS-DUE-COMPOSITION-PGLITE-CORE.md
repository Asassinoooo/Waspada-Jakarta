# LIFE-01-FRESHNESS-DUE-COMPOSITION-PGLITE-CORE — synthetic due-evaluation vertical composition

**Status:** Accepted and integrated on local `main`.<br>
**Backlog ID:** `LIFE-01-FRESHNESS-DUE-COMPOSITION-PGLITE-CORE`<br>
**Implementation model:** GPT-6 Luna, max reasoning<br>
**Branch:** `work/LIFE-01-FRESHNESS-DUE-COMPOSITION-PGLITE-CORE`<br>
**Worktree:** `/mnt/c/Users/perry/.codex/worktrees/life-01-freshness-due-composition-pglite-core/RPL`<br>
**Assigned base:** Exact local `main` SHA supplied in the root dispatch after this assignment is committed.<br>
**Contract baseline:** Existing internal Layer 4 due-reader/evaluator/recorder ports, append-only freshness ledger, current-public views, Schema 2.0 records, ADR-032/038; no API/DTO/OpenAPI change.

**Accepted commits:** `e0ec2cf4ce8557234e80154cf306a050507bb597` — `test(LIFE-01): compose freshness due evaluation in PGlite`; `2ee1d9b3ddaeac41104a9d99faa72c3282db7bdb` — `docs(LIFE-01): record due composition handoff`.<br>
**Changed paths:** `apps/db/test/freshness-due-evaluator-composition.test.ts`; `docs/assignments/LIFE-01-FRESHNESS-DUE-COMPOSITION-PGLITE-CORE-HANDOFF.md`.<br>
**Root review:** Full allowed-path diff reviewed; focused test passed 1/1; assigned-base `git diff --check` passed. The two commits were fast-forwarded to local `main`.

The agent's WSL Ubuntu-26.04 checks passed: `npm run db:test` (28/28 files), `npm test` (workspace 387 tests, DB 28/28 files, evaluation 12), `npm run typecheck`, `npm run build` (Vite production build and Wrangler dry-run), and assigned-base diff check. PGlite only; hosted Neon behavior remains unverified. The outbox row for this synthetic event is absent both before and after the test because the existing outbox is live-only. No runtime binding, schedule, migration, dependency, API, or external source changed. See the [implementation handoff](LIFE-01-FRESHNESS-DUE-COMPOSITION-PGLITE-CORE-HANDOFF.md).

## Objective

Add one focused, test-only PGlite composition that exercises the actual due-target reader, bounded due evaluator, deterministic transition recorder, SQL ledger, and current-public status projection together. Use an authored synthetic fixture and an explicit evaluation instant. Demonstrate that append-only freshness transitions change the effective current-public status while immutable published event and impact versions remain unchanged.

## Dependencies

`LIFE-01-FRESHNESS-TRANSITION-CORE`, `LIFE-01-FRESHNESS-LEDGER-CORE`, `LIFE-01-FRESHNESS-READ-PROJECTION-CORE`, `LIFE-01-FRESHNESS-DUE-TARGET-READER-CORE`, `LIFE-01-FRESHNESS-DUE-EVALUATOR-CORE`, ADR-032/038, and the existing PGlite test harness.

## Required behavior

1. Use the existing database harness and checked-in migrations. Seed only authored synthetic records needed by the test, including valid trace and publication lineage. Do not call live sources, providers, or external services.
2. Compose the real `createFreshnessDueTargetReader`, `createFreshnessDueEvaluator`, `createFreshnessTransitionRecorder`, and `createSqlFreshnessTransitionLedger` implementations over the same PGlite database/executor.
3. Use a caller-supplied RFC3339 instant and bounded page size. Demonstrate issuer-validity expiry and/or a missed review deadline against the exact event claim-set or exact referenced impact version. The evaluator must not claim evidence recovery or supply evidence references.
4. Verify the transition ledger contains the exact event/impact version, target, sequence, prior/resulting statuses, deterministic reason, evaluation time, trace, and idempotency identity emitted by this composition.
5. Verify the current-public read view exposes the new effective status, with event status derived by the existing conservative aggregate and impact status retained separately. Verify a subsequent due read does not return a target already transitioned to a non-current status.
6. Snapshot immutable event/impact record JSON, publication-decision rows, and outbox rows before evaluation; prove the composition leaves those publication records unchanged. Keep fixtures synthetic and clearly labeled.
7. Keep the test focused and deterministic. Do not introduce a scheduler, wall clock, network call, model, API route, application binding, migration, database grant, dependency, or runtime behavior change.

## Allowed paths

- `apps/db/test/freshness-due-evaluator-composition.test.ts` (new)
- `docs/assignments/LIFE-01-FRESHNESS-DUE-COMPOSITION-PGLITE-CORE-HANDOFF.md` (new implementation handoff)

If the existing synthetic fixture helpers cannot support a minimal valid event/impact publication lineage, stop and report the exact fixture seam to root rather than modifying production paths or broadening scope.

## Acceptance and verification

- The new test runs through the existing DB test runner and imports the existing Worker Layer 4 implementations without introducing a production dependency or package/configuration change.
- Assertions cover exact-version append-only transition records, deterministic status decisions, current-public overlay/aggregate, and unchanged immutable publication/outbox state.
- Run in WSL Ubuntu-26.04 using existing dependencies: focused test, `npm run db:test`, `npm run typecheck`, `npm test`, `npm run build`, and `git diff --check <assigned-base>..HEAD`. Record actual results, tool versions, and limitations; do not install dependencies.
- Work on the assigned branch/worktree and commit the implementation and handoff as coherent descriptive commits. Root independently reviews before acceptance or integration. Do not merge or push.

## Stop conditions

Stop and ask root if the test requires a contract or migration change, a production-path edit, privilege expansion, recovery evidence behavior, live source/provider access, scheduler/runtime wiring, or dependency installation. No model escalation is authorized unless Luna/max attempts and documents a substantive technical blocker.
