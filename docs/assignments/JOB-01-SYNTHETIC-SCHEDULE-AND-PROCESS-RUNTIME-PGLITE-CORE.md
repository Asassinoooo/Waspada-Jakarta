# JOB-01-SYNTHETIC-SCHEDULE-AND-PROCESS-RUNTIME-PGLITE-CORE — compose scheduled enqueue and processing

**Parent package:** JOB-01, FR-02/03/13, NFR-01/05/07  
**Status:** Accepted locally at root merge `ab24c15b6a11cfdc6690d1a1287f050bfede5323` after independent review and integrated WSL validation
**Implementation model:** GPT-6 Luna, max reasoning  
**Branch:** `work/JOB-01-SYNTHETIC-SCHEDULE-AND-PROCESS-RUNTIME-PGLITE-CORE`  
**Worktree:** `.codex-build/worktrees/job-01-synthetic-schedule-process-runtime-pglite-core` (WSL: `/mnt/d/Projects/RPL/.codex-build/worktrees/job-01-synthetic-schedule-process-runtime-pglite-core`)  
**Base:** `0f9d2baabe88448e5448fd255558eb2ba06e49ef`
**Dependencies:** `JOB-01-SCHEDULED-POLL-CORE`, `JOB-01-SYNTHETIC-SCHEDULE-RUNTIME-CORE`, `JOB-01-SYNTHETIC-POLL-CLAIM-CORE`, `JOB-01-SYNTHETIC-POLL-PROCESSOR-CORE`, `JOB-01-SYNTHETIC-POLL-CYCLE-PGLITE-CORE`, `JOB-01-SYNTHETIC-POLL-WORKER-RUNTIME-CORE`, `DATA-01`, and `DB-TEST-RUNNER-ISOLATION`; ADR-002/033/040.  
**Contract baseline:** Existing scheduler, queue, fixture runner, L1 schema and roles, and synthetic report/extraction contracts. No public, API, or database contract change.

## Objective

Add one isolated PGlite composition test that invokes the accepted synthetic scheduled-enqueue runtime and then the accepted synthetic poll processor runtime against the same disposable database. This closes the local assurance gap between separate scheduler and processor proofs. Use only an authored synthetic source row, a fixed timestamp, an in-memory exact-source fixture, and a deterministic injected L2 extraction adapter.

This test composes the two runtime factories. It does not add or activate a Worker entrypoint, Cron schedule, source connector, provider, or live acquisition path.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md` and `docs/IMPLEMENTATION_BACKLOG.md`
- `ARCHITECTURE.md`, `docs/DOMAIN_MODEL.md`, `docs/decisions/ADR-002-job-queue-and-scheduler.md`, `ADR-033-synthetic-scheduled-poll-runtime.md`, and `ADR-040-synthetic-poll-processing-runtime.md`
- `docs/assignments/JOB-01-SCHEDULED-POLL-CORE.md`
- `docs/assignments/JOB-01-SYNTHETIC-SCHEDULE-RUNTIME-CORE.md` and its handoff
- `docs/assignments/JOB-01-SYNTHETIC-POLL-CYCLE-PGLITE-CORE.md` and its handoff
- `docs/assignments/JOB-01-SYNTHETIC-POLL-WORKER-RUNTIME-CORE.md` and its handoff
- `apps/worker/src/runtime/synthetic-poll-schedule-runtime.ts`
- `apps/worker/src/runtime/synthetic-source-poll-process-runtime.ts`
- `apps/db/test/synthetic-poll-schedule-runtime.test.ts`
- `apps/db/test/synthetic-source-poll-process-runtime.test.ts`
- `apps/db/test/run-db-tests.ts` to confirm automatic discovery of `*.test.ts`

## Required behavior

1. Add a fresh PGlite database test with the current migrations and isolated, authored synthetic rows only. Configure the singleton dataset namespace as `synthetic`; do not depend on other DB tests or shared state.
2. Use one explicit valid scheduled timestamp. Invoke the real `createSyntheticPollScheduleRuntime` with exact demo/scheduler gates and a dedicated test L1 connection. Verify it creates its persisted synthetic trace and enqueues the due, approved synthetic source poll under the existing L1 role.
3. Invoke the real `createSyntheticSourcePollProcessRuntime` against that same database with exact demo/processor gates, an in-memory fixture catalog keyed by the scheduled source ID, and a fixed test-only L2 extraction adapter. Verify it claims and completes the exact job created by the scheduler and does not process an unrelated source fixture.
4. Verify the authored report revision and linked evidence, extraction, chunk, and supported geometry writes are present after processing, and no event version or publication decision was created. Preserve the existing tests for acknowledgement ordering, role cleanup, retry, replay, and processor failure handling.
5. Use only ephemeral PGlite state. Do not acquire, retain, or embed external source content; do not call `fetch`, an LLM/model API, L3, or any hosted service. Do not use an ambient clock to decide scheduler or job state.
6. Keep the checked-in Worker and its triggers untouched. The runtime factories' injected adapter and fixture catalog are test seams, not evidence that a deployed schedule is enabled.

## Allowed paths

- `apps/db/test/synthetic-schedule-process-runtime-composition.test.ts` (new; the DB runner auto-discovers `*.test.ts`)
- `docs/assignments/JOB-01-SYNTHETIC-SCHEDULE-AND-PROCESS-RUNTIME-PGLITE-CORE-HANDOFF.md` (new)

Root owns this assignment, `SOFTWARE_DEVELOPMENT_PLAN.md`, `docs/IMPLEMENTATION_BACKLOG.md`, `docs/CURRENT_CHECKPOINT.md`, architecture, decisions and delivery log. Stop before editing any other path if the test exposes a runtime, schema, grant, contract or configuration gap.

## Acceptance and verification

- The focused PGlite composition proves scheduler trace/job creation followed by exact-source fixture processing and successful completion in the same database.
- Assertions distinguish the acquisition job/report state from Event lifecycle, publication status, and safety claims; the test produces no public event or publication.
- Existing synthetic schedule and process runtime behavior remains unchanged.
- In WSL Ubuntu-26.04, using existing dependencies only, run the focused test, `npm run db:test`, `npm test`, `npm run typecheck`, and `git diff --check <assigned-base>..HEAD`. Record exact commands, Node/npm/PGlite versions, results, failures/reruns, and limitations in a UTF-8 handoff. Build is not required for this test-only assignment.
- Commit the test and handoff in coherent, descriptive commits on the assigned branch. Do not merge, push, deploy, configure external services, or spawn agents.

## Stop conditions

Stop and report if composing the accepted factories requires production changes, a migration/grant/schema/API change, a Cron/Worker trigger change, source rights, real source access, a provider, or external configuration. Do not escalate models unless a substantive Luna/max technical attempt remains unresolved.

## Handoff fields

Report branch/worktree, exact assigned base, commit SHA(s) and exact messages, changed paths, behavior proven, actual checks and results, versions, limitations, migration/configuration impact, failures/reruns, and remaining decisions. Root independently reviews and accepts the result.

## Root review and acceptance — 9 October 2026

Root reviewed the test-only diff and accepted it at merge `ab24c15b6a11cfdc6690d1a1287f050bfede5323`. Agent commits preserved in the merge: `4f2d92e5fa3657ba0a2f2c2fed605d115116ab4e` — `test(JOB-01): compose synthetic schedule and processing runtimes`; `e6236498dd53f7de8447834c99ef2d6d0ceca7ea` — `docs(JOB-01): record schedule-process composition handoff`. Root independently reran the focused PGlite test (1/1). Integrated WSL checks passed `npm run db:test` (45/45 files), `npm test` (web 61/61, Worker 464/464, DB 45/45 files, evaluation 19/19), `npm run typecheck`, and `npm run build` (Vite production build and Wrangler dry-run). The agent's focused test passed 1/1; the agent did not run broad suites, typecheck, or build. The integrated test composes factories only: the Worker entrypoint and Cron remain disabled, and hosted execution is unverified.
