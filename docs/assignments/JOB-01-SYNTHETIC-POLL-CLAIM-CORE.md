# JOB-01-SYNTHETIC-POLL-CLAIM-CORE - scoped synthetic source-poll claiming

**Parent package:** JOB-01, FR-02/03/13  
**Status:** Assigned for local implementation  
**Implementation model:** GPT-6 Luna, max reasoning  
**Branch:** `work/JOB-01-SYNTHETIC-POLL-CLAIM-CORE`  
**Worktree:** Reuse the clean managed `l3-coordinator-core` worktree after verifying no process uses it.  
**Base:** Exact `main` commit supplied by root after this assignment is committed.  
**Contract baseline:** Existing `AcquisitionJobRepository`, queue lease state, source registry and acquisition job schema; do not change public/API contracts or schema version.

## Context

`JOB-01-SCHEDULED-POLL-CORE` now enqueues due source-poll rows using configured source intervals. The queue has a general claim method and a synthetic moderator-submission claim, but no claim boundary for a later synthetic source-poll processor. A synthetic worker must not claim live or historical polls or lease a moderator submission by mistake.

## Objective

Add a typed repository operation that claims at most one due `source_poll` row from the `synthetic` dataset using the existing queue lease, attempt, ordering, and source-approval rules. This is a queue boundary only; it does not process fixtures or acquire source data.

## Required behavior

1. Accept caller-supplied RFC3339 time and the existing bounded optional lease duration; do not read an ambient clock.
2. Claim only `dataset_kind = 'synthetic'` and `job_kind = 'source_poll'` rows in `pending` or `retry` whose `available_at` is due.
3. Apply existing source checks before leasing: active, approved, automatic acquisition enabled, and a configured interval.
4. Reuse the existing deterministic queue ordering, `FOR UPDATE SKIP LOCKED`, attempt increment, lease token and expiry behavior.
5. Leave moderator submissions and live/historical source-poll rows untouched. Leasing must not mutate source health, reports, evidence, events or publications; the existing completion behavior remains unchanged.
6. Use the current least-privilege L1 queue role. Do not widen grants or add migrations.

## Allowed paths

- `apps/db/src/queue.ts`
- `apps/db/test/queue.test.ts`
- `docs/assignments/JOB-01-SYNTHETIC-POLL-CLAIM-CORE-HANDOFF.md`

Do not change Worker code, migrations, role grants, source registry policy, API contracts, dependencies, credentials, runtime bindings, external services, or the due-source scheduler.

## Acceptance and verification

- The focused PGlite queue test proves a due synthetic source-poll row is leased once with a finite token/expiry and incremented attempt count.
- Due moderator submissions, live polls and historical polls remain unclaimed by this method; future, terminal and source-ineligible rows are not leased.
- Exercise the method under `SET ROLE waspada_l1_pipeline` and verify no source-health or event-state change occurs at claim time.
- Run the focused queue tests, `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD` in WSL Ubuntu-26.04 with existing dependencies only. Record exact counts, versions, limitations, and the UTF-8-readable handoff.

## Stop and handoff

Stop if this operation requires a new schema, grant, public contract, source approval policy, provider, timer, or Worker runtime. Commit the implementation and handoff in coherent commits on the assigned branch. Do not merge or push. Report branch/worktree, exact base, commit SHAs/messages, changed paths, behavior, checks, limitations and migration/configuration impact. Root reviews and integrates accepted work.
