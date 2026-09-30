# JOB-01-SYNTHETIC-POLL-PROCESSOR-CORE — bounded authored-fixture processing

**Parent package:** JOB-01, FR-02/03/13, NFR-01/05/07  
**Status:** Assigned for local synthetic-only implementation  
**Implementation model:** GPT-6 Luna, max reasoning  
**Branch:** `work/JOB-01-SYNTHETIC-POLL-PROCESSOR-CORE`  
**Worktree:** Reuse the clean managed `l3-coordinator-core` worktree after verifying no process uses it. Do not edit through the root checkout.  
**Base:** Exact root commit to be recorded before implementation starts.  
**Dependencies:** `JOB-01-SCHEDULED-POLL-CORE`, `JOB-01-SYNTHETIC-POLL-CLAIM-CORE`, `L1-FIXTURE-PIPE-CORE`, `L1-FIXTURE-EXTRACTION-CORE`, `L1-EXTRACTION-REPLAY-CORE`, `ING-PARSE-01`, and `DB-TEST-RUNNER-ISOLATION`.  
**Contract baseline:** Existing `AcquisitionJobRepository`, synthetic schema 2.0 fixture/persistence contracts, queue lease and retry policy; no public/API contract change.

## Objective

Complete one local Layer 1 path from an already queued synthetic source poll to persisted, unreviewed report/evidence records using caller-authored, already-buffered fixtures. The processor is an injected local proof of the synthetic path; it does not contact a source or enable any production connector.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md`, then `docs/IMPLEMENTATION_BACKLOG.md`
- `ARCHITECTURE.md`, `docs/DOMAIN_MODEL.md`, `docs/decisions/ADR-002-job-queue-and-scheduler.md`
- `docs/assignments/JOB-01.md`
- `docs/assignments/JOB-01-SCHEDULED-POLL-CORE.md`
- `docs/assignments/JOB-01-SYNTHETIC-POLL-CLAIM-CORE.md` and its handoff
- `docs/assignments/L1-FIXTURE-PIPE-CORE.md`, `L1-FIXTURE-EXTRACTION-CORE.md`, and `L1-EXTRACTION-REPLAY-CORE.md`
- `apps/db/src/queue.ts`, `apps/db/test/synthetic-fixture-pipeline.test.ts`
- `apps/worker/src/layers/l1-data-knowledge/synthetic-fixture-pipeline.ts` and `synthetic-fixture-runner.ts`

## Required behavior

1. Add a dependency-injected L1 runner that accepts caller-supplied RFC3339 time and claims at most one job through `claimDueSyntheticSourcePoll`. Do not use the general claim, read an ambient wall clock, loop, sleep, or schedule work inside the runner.
2. Accept only an already-leased `synthetic` `source_poll` job with a non-null source ID and lease token. A `moderator_submission`, live/historical job, malformed job, or lost lease must not enter the processor.
3. Use a typed in-memory fixture catalog keyed by the exact source ID. Entries contain authored, already-buffered payload and explicit manifests only. The fixture, every manifest source ID, and every persisted report source ID must equal the claimed source ID. The exact fixture URL and manifest canonical URLs must agree. Never fetch URLs, follow redirects, read files as a runtime catalog, or scrape an external source.
4. Reuse the accepted bounded parser, deterministic text preparation/chunking, fixed injected L2 extraction capability, exact evidence persistence, geometry evidence rules, and create-or-verify replay behavior. Refactor shared internals only as needed; preserve the existing moderator-submission path and its `manual_fixture` restrictions.
5. Validate the source registry state under the existing L1 read boundary. The claim already enforces active, approved, automatically enabled and configured interval rules before leasing; processing must at least ensure the fixture source is the same source and automatic publication remains disabled. Do not change source policy or widen grants.
6. Persist all report/evidence/extraction/chunk/explicit geometry writes before completing the queue job. Use only caller-supplied timestamps for queue transitions. Preserve the existing bounded retry, terminal, uncertain-ack replay, and lost-lease behavior. A catalog miss or invalid fixture must produce a stable redacted failure code; never store raw exception or fixture content in queue metadata or telemetry.
7. An empty authored feed is a successful empty poll, with no report/evidence/event/publication writes. Source-health changes may occur only through the existing queue transition behavior after the poll result; expiry, an empty feed, or source health never changes incident status or implies area safety.
8. Keep the whole feature synthetic-only. Do not call L3, propose/create/publicize Events, activate real source rows, add a timer/Cron/Workflow route, or configure a provider.

## Allowed paths

- `apps/worker/src/layers/l1-data-knowledge/synthetic-fixture-pipeline.ts`
- `apps/worker/src/layers/l1-data-knowledge/synthetic-source-poll-runner.ts` (new)
- `apps/worker/test/synthetic-source-poll-runner.test.ts` (new)
- `apps/db/test/synthetic-fixture-pipeline.test.ts` (only for real PGlite/runner composition coverage)
- `apps/worker/package.json` (test script registration only, if required)
- `docs/assignments/JOB-01-SYNTHETIC-POLL-PROCESSOR-CORE-HANDOFF.md` (new)

Root owns the plan, architecture, backlog, contracts, source-rights decisions, and provider/runtime composition. Do not change migrations, grants, database schemas, API contracts, model dependencies, bindings, external services, or the prior JOB-01 scheduler/claim implementation.

## Acceptance and verification

- Unit tests prove one-job maximum, idle behavior, exact source-ID lookup, closed bounded outcomes, timestamp validation, rejected job kinds/datasets, and fixed failure/retry behavior.
- A PGlite composition test enqueues and claims one authored synthetic poll under `SET ROLE waspada_l1_pipeline`, then verifies deterministic report/evidence/extraction/chunk persistence, successful acknowledgement only after writes, idempotent recovery, and no event or publication state.
- Tests prove that live, historical, moderator-submission, future and source-ineligible rows remain untouched by the source-poll runner. Empty fixture content completes without incident or publication writes.
- In WSL Ubuntu-26.04 with existing dependencies only, run focused runner and PGlite composition tests, `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD`. Record exact results and versions in a UTF-8 handoff.
- Commit coherent implementation and handoff commits on the assigned branch. Do not merge or push.

## Stop conditions

Stop and report to the root planner if safe implementation appears to require a schema/migration/grant, public contract, live source permission or access, external acquisition, provider, Cron/Workflow/runtime database binding, or a change to publication authorization. Do not escalate models unless a substantive technical issue was attempted by Luna/max and remains unresolved.

## Handoff fields

Report branch/worktree, exact base, commit SHAs and messages, changed paths, behavior, commands and actual results, versions, earlier failures, limitations, migration/configuration impact, and remaining decisions.
