# JOB-01-SCHEDULED-POLL-CORE — bounded due-poll scheduling

**Parent package:** JOB-01, FR-02/13  
**Status:** Assigned for local implementation  
**Implementation model:** GPT-6 Luna, max reasoning  
**Branch:** `work/JOB-01-SCHEDULED-POLL-CORE`  
**Worktree:** Reuse the clean managed `l3-coordinator-core` worktree after checking no process uses it; root supplies its WSL and Windows paths at dispatch.  
**Base:** Exact `main` commit supplied by root after this assignment is committed.  
**Contract baseline:** Existing `DatasetKind`, `AcquisitionJobRepository`, source registry and acquisition job schema; do not change public/API contracts or schema version.

## Context

JOB-01 provides durable queue primitives and a `enqueueSourcePoll` operation whose caller supplies a stable idempotency key. No local source-poll scheduler currently enumerates approved sources and derives those keys. ADR-002 says a timer or Cron trigger only requests due work; PostgreSQL remains authoritative. This package fills that local L1 scheduling boundary using synthetic database rows. It does not add an actual timer, Cloudflare Cron/Workflow binding, connector, or source access.

## Objective

Add a deterministic, bounded L1 service that enqueues due source-poll jobs from existing source registry configuration. It receives an explicit evaluation time, dataset, and already-persisted trace identity. It never reads an ambient clock, claims a job, fetches source content, calls L2/L3, or changes source health.

## Scheduling policy

1. A source is eligible only when it is active, approved, automatic acquisition is enabled, and `polling_interval_seconds` is configured. Do not invent or change a polling interval.
2. A source is due when `last_checked_at` is null or `last_checked_at <= now - polling_interval_seconds`; equality is due. Compare timestamps as database instants.
3. Suppress a new poll while the same dataset/source has a `pending`, `leased`, or `retry` source-poll job. Completed and terminal jobs do not suppress later due work.
4. Compute a stable idempotency key from dataset-scoped source identity, configured interval, and the current UTC polling slot. Repeated and concurrent triggers for a slot must resolve to one logical queue row through the existing unique key.
5. Schedule only the current slot after downtime; do not replay every missed slot. Keep due-source selection bounded to at most 100 per invocation and order deterministically so later invocations can advance after earlier jobs become active.
6. Return a closed summary with counts only; do not return source URLs, content, or unbounded source records.

## Allowed paths

- `apps/db/src/queue.ts` and, if separation improves the boundary, `apps/db/src/source-poll-scheduler.ts`
- `apps/db/test/queue.test.ts`
- `docs/assignments/JOB-01-SCHEDULED-POLL-CORE-HANDOFF.md`

Do not change migrations, role grants, source registry policy, Cloudflare configuration, `apps/worker/**`, APIs, dependencies, credentials, or external services. If the current least-privilege role cannot perform the read/write safely, stop and report the interface gap rather than broadening grants.

## Acceptance and verification

- Tests cover eligible and ineligible sources, exact due-time equality, configured intervals without defaults, stable slot keys across equivalent offset timestamps, repeated same-slot calls, active-job suppression, terminal-job behavior, and the 100-source bound/progress.
- Concurrent or retried triggers cannot create duplicate jobs for the same source/interval/slot.
- Scheduling only inserts queue requests. It must not claim jobs, fetch data, call models, mutate source health, or alter event state.
- Use authored synthetic PGlite rows only. No live source, model, cloud credential, or external service is contacted.
- Run in WSL Ubuntu-26.04 with existing dependencies: focused queue tests, `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD`. Record actual commands and results, versions, migration/configuration impact, and limitations. Do not install packages.

## Stop and handoff

Stop if the policy requires a change to source approval/access, a public contract, schema/migration or role grant, actual Cron/Workflow wiring, or a polling cadence not supplied by source configuration. Ask root about that boundary and continue no unrelated scope. Commit the implementation and handoff in coherent commits on the assigned branch. Do not merge or push. Report exact branch/worktree, base, commit SHAs/messages, changed paths, behavior, checks, limitations and remaining decisions. Root independently reviews and integrates accepted work.
