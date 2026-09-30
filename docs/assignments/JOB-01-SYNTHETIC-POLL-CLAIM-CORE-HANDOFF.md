# JOB-01-SYNTHETIC-POLL-CLAIM-CORE handoff

**Branch:** `work/JOB-01-SYNTHETIC-POLL-CLAIM-CORE`
**Worktree:** `C:\Users\perry\.codex\worktrees\l3-coordinator-core\RPL` (`/mnt/c/Users/perry/.codex/worktrees/l3-coordinator-core/RPL` in WSL)
**Assigned base:** `d314cf9fba5bcdc37be550c3a00c480979126316`
**Implementation commit:** `a7179d26316b8419145674618e5de4fd2b02aa9c` - `feat(JOB-01): add synthetic source-poll claim scope`
**Handoff commit message:** `docs(JOB-01): record synthetic poll claim handoff` (SHA is in the orchestrator report.)

## Behavior

Added `AcquisitionJobRepository.claimDueSyntheticSourcePoll(now, leaseDurationMs?)`. It delegates to the existing atomic claim path with a fixed `dataset_kind = 'synthetic'` and `job_kind = 'source_poll'` scope. It retains the existing due statuses and time check, active/approved/automatic-acquisition/configured-interval source checks, deterministic ordering, `FOR UPDATE SKIP LOCKED`, attempt increment, lease token, and expiry behavior.

The PGlite test calls the method under `SET ROLE waspada_l1_pipeline`. It proves that one due eligible synthetic poll gets a lease, while live and historical polls, a future poll, a terminal poll, polls whose sources are paused/unapproved/disabled/unconfigured, and a synthetic moderator submission remain unchanged. It also compares source-health rows, event-version rows, and publication-decision rows before and after the claim.

Changed paths:

- `apps/db/src/queue.ts`
- `apps/db/test/queue.test.ts`
- `docs/assignments/JOB-01-SYNTHETIC-POLL-CLAIM-CORE-HANDOFF.md`

## Verification

Environment: WSL Ubuntu-26.04; Node `v24.21.0`; npm `11.19.0`; `@electric-sql/pglite 0.5.8`; `tsx 4.23.15`; TypeScript `7.0.2`; Wrangler `4.137.0`. Existing dependencies were reused through the root dependency tree; no packages were installed. The temporary worktree `node_modules` symlink was removed before committing.

- From `apps/db`, `tsx --test test/queue.test.ts`: exit 0; 17 passed, 0 failed.
- From the repository root, `npm run db:test`: exit 0; 21/21 DB test files passed, including the queue suite (17/17).
- From the repository root, `npm test`: exit 0; 334 workspace tests, all 21 DB test files, and 12 evaluation casebook tests passed.
- From the repository root, `npm run typecheck`: final exit 0. The first attempt exited 1 because the new test used `AcquisitionJobRecord` without a type-only import; the import was added and the command passed.
- From the repository root, `npm run build`: exit 0; web build and Wrangler worker dry-run completed.
- `git diff --check d314cf9fba5bcdc37be550c3a00c480979126316..HEAD`: exit 0 after the implementation and handoff commits.
- UTF-8 validation of this file with Python `data.decode("utf-8")` and ASCII validation: exit 0.

Early focused-test iterations exposed fixture-only failures, all resolved before the passing final run. The first run exited 1 because source fixtures were changed to paused, unapproved, or interval-free while automatic acquisition remained enabled; the database eligibility check rejected those updates, and two later scheduler assertions saw rows left by the aborted fixture. The second run exited 1 because the temporary event fixture did not satisfy the linked publication-decision/event-version foreign keys; downstream scheduler assertions again saw leftover rows. After deferring the linked fixture inserts, a third run reached cleanup but the append-only event-version trigger correctly rejected deletion; the leftover event row also affected an existing completion assertion and two scheduler assertions (13 passed, 4 failed). The test now avoids inserting/deleting incident fixtures and compares the relevant persisted event tables before and after claim. The final focused run passes 17/17.

## Scope and impact

No migration, grant, schema, public contract, API, Worker, timer, source access, provider, dependency, or runtime configuration changed. There is no migration or configuration impact. The method only claims a synthetic source-poll queue row; processing and source acquisition remain outside this package. No remaining architecture decisions are required for this bounded slice.
