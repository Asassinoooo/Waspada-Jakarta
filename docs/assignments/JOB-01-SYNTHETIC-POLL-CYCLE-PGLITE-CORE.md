# JOB-01-SYNTHETIC-POLL-CYCLE-PGLITE-CORE — verify the local scheduled ingestion path

**Parent package:** JOB-01, FR-02/03/13, NFR-01/05/07  
**Status:** Assigned for synthetic-only PGlite verification  
**Implementation model:** GPT-6 Luna, max reasoning  
**Branch:** `work/JOB-01-SYNTHETIC-POLL-CYCLE-PGLITE-CORE`  
**Worktree:** Reuse the clean managed `l3-coordinator-core` worktree after confirming the prior task is complete and no process uses it. Root supplies the Windows/WSL paths and exact `main` base at dispatch.  
**Dependencies:** `JOB-01-SCHEDULED-POLL-CORE`, `JOB-01-SYNTHETIC-POLL-CLAIM-CORE`, `JOB-01-SYNTHETIC-POLL-PROCESSOR-CORE`, `DATA-01`, and `DB-TEST-RUNNER-ISOLATION`.  
**Contract baseline:** Existing `SqlSourcePollScheduler`, `AcquisitionJobRepository`, `SyntheticSourcePollRunner`, schema 2.0 fixture/persistence contracts, and current L1 role. No API, DTO, schema, or grant change.

## Objective

Add one meaningful PGlite integration test proving that the accepted local source scheduler, synthetic-only queue claim, and exact-source fixture processor compose into one bounded Layer 1 path. This is a test-only task. It makes no runtime trigger or live acquisition capability.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md` and `docs/IMPLEMENTATION_BACKLOG.md`
- `ARCHITECTURE.md`, `docs/DOMAIN_MODEL.md`, and `docs/decisions/ADR-002-job-queue-and-scheduler.md`
- `docs/assignments/JOB-01.md`
- `docs/assignments/JOB-01-SCHEDULED-POLL-CORE.md`
- `docs/assignments/JOB-01-SYNTHETIC-POLL-CLAIM-CORE.md`
- `docs/assignments/JOB-01-SYNTHETIC-POLL-PROCESSOR-CORE.md` and its handoff
- `apps/db/src/source-poll-scheduler.ts`, `apps/db/src/queue.ts`
- `apps/db/test/queue.test.ts`, `apps/db/test/synthetic-fixture-pipeline.test.ts`
- `apps/worker/src/layers/l1-data-knowledge/synthetic-source-poll-runner.ts`

## Required behavior

1. Add a PGlite case using only authored synthetic registry rows, trace records, and in-memory fixture payload/manifests. Do not read a real source, network, filesystem fixture catalog, or ambient clock.
2. Under `SET ROLE waspada_l1_pipeline`, invoke the existing `SqlSourcePollScheduler` with an explicit timestamp, synthetic dataset, and persisted synthetic trace. Verify it enqueues the expected bounded synthetic poll.
3. Run `runSyntheticSourcePollJob` with the real SQL queue repository as its claim port and the already-accepted fixture pipeline ports. Verify the processor claims that due poll, resolves only its exact source-ID fixture, persists the authored report and related evidence/extraction/chunk/geometry rows, then completes the same queue job.
4. Assert persistence is complete before the queue completion call can acknowledge the job. Assert source-health timestamps/status change through successful completion only, and remain separate from registry approval, event lifecycle, and incident safety.
5. Assert the path creates no event version or publication decision. Keep due moderator submissions and any synthetic-test live/historical source-poll rows unclaimed and unchanged where practical; the focused queue and runner tests remain authoritative for their individual scope checks.
6. Use stable authored IDs and fixtures that cannot collide with existing test cases. Preserve existing retry/replay coverage. Do not add a production coordinator, runtime trigger, Workflow, migration, grant, dependency, source row, external provider, or API behavior.

## Allowed paths

- `apps/db/test/synthetic-fixture-pipeline.test.ts`
- `docs/assignments/JOB-01-SYNTHETIC-POLL-CYCLE-PGLITE-CORE-HANDOFF.md` (new)

The root owns this assignment, status, backlog, architecture, ADR, and delivery log. Stop before editing other paths if the test reveals a needed production or contract change.

## Acceptance and verification

- The focused PGlite test proves the schedule → persisted queue request → synthetic-only claim → fixture parse/extraction/persistence → acknowledgement flow using real local repositories under the L1 role.
- The test checks source identity and timestamps, queue status, completion-after-writes ordering, successful source-health update, and zero event/publication writes.
- Existing queue and fixture pipeline tests remain unchanged in behavior and pass.
- In WSL Ubuntu-26.04 with existing dependencies only, run the focused composition test, `npm run db:test`, `npm test`, `npm run typecheck`, and `git diff --check <assigned-base>..HEAD`. Record exact counts, commands, and runtime versions in a UTF-8 handoff. Build is not required because this assignment is test-only.
- Commit the test and handoff in coherent commits on the assigned task branch. Do not merge or push.

## Stop conditions

Stop and report to root if composition requires production code, a schema/migration/grant, a changed queue/pipeline contract, runtime timer/Cron/Workflow wiring, source rights, real source access, or external provider configuration. Do not escalate models unless a substantive technical issue was attempted with Luna/max and remains unresolved.

## Handoff fields

Report branch/worktree, exact base, commit SHAs and exact messages, changed paths, behavior verified, actual commands/results and versions, limitations, migration/configuration impact, transient failures, and remaining decisions. Root independently reviews and accepts the work; code being written is not acceptance.
