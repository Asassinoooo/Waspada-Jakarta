# L1-FIXTURE-RUNNER-CORE — bounded synthetic fixture job runner

- **Status:** Assigned; local-only coordinator slice
- **Parent work package:** L1 fixture ingestion and JOB-01 scheduling
- **Requirements:** FR-02/03/13; NFR-05/07/08
- **Dependencies:** JOB-01, L1-FIXTURE-PIPE-CORE, DATA-01, DB-TEST-RUNNER-ISOLATION
- **Layer:** L1 data pipeline; no L3 orchestration
- **Contract baseline:** Existing acquisition-job records and synthetic fixture pipeline ports; no public API or domain-contract change
- **Implementation model:** GPT-6 Luna, max reasoning
- **Branch:** `work/L1-FIXTURE-RUNNER-CORE`
- **Worktree:** Create a dedicated managed worktree from the pushed task-assignment commit; do not edit the root checkout.
- **Owner:** Luna Max implementation agent; root plans, reviews, accepts, integrates, and pushes

## Objective

Compose the accepted durable job queue with the existing injected synthetic fixture processor. One invocation claims and processes at most one due synthetic moderator-submission job. This closes the local queue-to-processor gap without adding a source connector, timer, Cloudflare trigger, database connection, or live-data behavior.

The runner accepts an explicit timestamp and injected queue, exact-URL fixture catalog, and L1 persistence ports. It reports only a bounded outcome and record counts; it never returns or logs a submitted URL, fixture text, raw payload, actor ID, or database exception.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md` (first repository document), then `docs/IMPLEMENTATION_BACKLOG.md`
- `docs/DOMAIN_MODEL.md` and `docs/decisions/ADR-002-job-queue-and-scheduler.md`
- `docs/assignments/JOB-01.md` and `docs/assignments/L1-FIXTURE-PIPE-CORE.md`
- `apps/db/src/queue.ts`, `apps/db/test/queue.test.ts`
- `apps/worker/src/layers/l1-data-knowledge/synthetic-fixture-pipeline.ts`
- `apps/db/test/synthetic-fixture-pipeline.test.ts`

## Required behavior

1. Add a bounded queue claim path constrained in SQL to `dataset_kind='synthetic'` and `job_kind='moderator_submission'`. The filter must be applied before the `FOR UPDATE SKIP LOCKED` lease, not after a generic claim. Preserve existing unfiltered queue callers and their behavior.
2. Implement a dependency-injected L1 runner that claims at most one due job per call and then invokes `processSyntheticFixtureJob` with the existing exact-URL catalog and accepted L1 persistence adapters. It must not duplicate fixture parsing, text preparation, chunking, geometry rules, retry policy, or acknowledgement logic.
3. Pass a single caller-supplied RFC 3339 timestamp through claiming and the processor's transition. Use the queue's existing finite lease policy. Do not read wall-clock time, sleep, poll, or loop inside the runner.
4. If no eligible job is due, return an explicit idle outcome. If a job is claimed, return only a closed outcome and bounded counts. Convert unexpected queue/runner failures to a stable redacted result; never expose exception text.
5. Tests must prove that a due live `source_poll` and a due historical/synthetic non-moderator job are not leased by this runner, while the intended synthetic moderator fixture job is processed and acknowledged only after persistence. Existing generic queue behavior must remain intact.
6. Keep fixture-catalog misses and processor failures on the existing retry/terminal path. A stale or lost lease remains an explicit non-owned outcome; never acknowledge it twice. Empty fixtures complete without creating evidence or implying an all-clear.

## Explicit boundaries

- Synthetic namespace and already-buffered, authored fixture catalog only.
- No URL fetch, redirect, filesystem catalog, RSS/API connector, model call, inference, publication, source-health mutation, or event-version write.
- No moderator authentication or job enqueue/API endpoint; a separate authorized caller is responsible for creating a submission.
- No Cloudflare Cron/Workflow binding, Neon/Hyperdrive driver, secret, new dependency, external service, or deployment.
- Do not process or lease any job outside the exact synthetic moderator-submission filter.

## Allowed paths

- `apps/db/src/queue.ts`
- `apps/db/test/queue.test.ts`
- `apps/worker/src/layers/l1-data-knowledge/synthetic-fixture-runner.ts` (new)
- `apps/worker/test/synthetic-fixture-runner.test.ts` (new)
- `apps/worker/package.json` — test script only
- `apps/db/test/synthetic-fixture-pipeline.test.ts` — only for one real queue/PGlite/runner composition case
- This assignment's implementation handoff only

Root owns the backlog, SDP, architecture, contracts, source-rights decisions, and runtime/provider composition. Report a scope conflict instead of broadening this assignment.

## Acceptance and checks

- Focused tests prove SQL pre-lease filtering, one-job execution limit, idle behavior, correct ordering, retry/terminal propagation, lost-lease behavior, safe bounded output, and no processing of live/historical/other synthetic job kinds.
- A PGlite integration uses only authored synthetic test values, runs under the existing L1 role, and proves queue claim → fixture persistence → stable completion with no event/publication rows. Test rows are not source-rights or factuality evidence.
- In WSL Ubuntu-26.04 run focused queue/runner tests, `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`; record Node/npm versions and each actual result.
- Commit implementation and handoff as coherent descriptive commits on the assigned branch. Leave the task worktree clean. Do not merge or push.

## Stop/escalation conditions

Stop and report if safe implementation requires an unfiltered claim, a public/authenticated enqueue route, a live source or network request, a contract/schema change, or a runtime database/provider binding. GPT-6 Astra xhigh is allowed only after a substantive technical difficulty was attempted by Luna max and remains unresolved.

## Implementation handoff

Append exact branch/worktree, commit SHAs and messages, changed paths, behavior, actual checks, limitations, migration/configuration impact, and remaining decisions. Root independently reviews and verifies before acceptance.

### Implementation handoff — 26 September 2026

- **Status:** Implementation and local checks are complete on the task branch; independent root review and acceptance remain pending. Nothing was merged or pushed.
- **Branch/worktree:** `work/L1-FIXTURE-RUNNER-CORE`; `C:\Users\perry\.codex\worktrees\l1-fixture-runner-core\RPL` (`/mnt/c/Users/perry/.codex/worktrees/l1-fixture-runner-core/RPL` in WSL).
- **Commits:** `a9dcde633b9bde0bed06680df5035dd13bbe2ac4` — `feat(L1-FIXTURE-RUNNER-CORE): claim and process one synthetic fixture`; implementation handoff recorded separately in `docs(L1-FIXTURE-RUNNER-CORE): record implementation handoff`.
- **Changed paths:** `apps/db/src/queue.ts`, `apps/db/test/queue.test.ts`, `apps/db/test/synthetic-fixture-pipeline.test.ts`, `apps/worker/package.json`, `apps/worker/src/layers/l1-data-knowledge/synthetic-fixture-runner.ts`, `apps/worker/test/synthetic-fixture-runner.test.ts`, and this assignment handoff.
- **Behavior:** Added `claimDueSyntheticModeratorSubmission`, whose SQL constrains dataset and job kind inside the candidate selection before `FOR UPDATE SKIP LOCKED`; generic `claimDueJob` remains unfiltered. The injected runner validates and passes one caller-supplied RFC 3339 timestamp to one queue claim and the existing processor, which uses the queue's finite default lease policy. It processes at most one exact in-memory fixture, preserves the processor's retry, terminal, empty, and lost-lease behavior, and returns only closed outcomes with counts or stable redacted codes. The PGlite composition test proves due live polls, historical submissions, and synthetic polls stay pending with no lease while the synthetic moderator fixture is persisted and completed under the L1 role. No publication or event version is created.
- **WSL runtime:** Ubuntu-26.04, Node.js `v24.21.0`, npm `11.19.0`. `npm ci --offline --no-audit --no-fund` restored the existing lockfile dependencies (88 packages; no manifest or lockfile dependency changes).
- **Checks:** Focused runner tests passed **8/8**; focused queue tests passed **11/11**; focused PGlite pipeline/runner composition passed **2/2**. `npm run db:test` passed **10/10** isolated DB test files. `npm test` completed with Web **22/22**, Worker **145/145**, DB **80** tests across 10 files, and evaluation **12/12**. `npm run typecheck` passed. `npm run build` passed typecheck, Vite production build, and Wrangler deploy dry-run. WSL `git diff --check HEAD` and `git diff --cached --check` passed.
- **Limitations:** The integration uses local single-session PGlite and does not establish hosted PostgreSQL/Neon locking or Worker behavior. No source was fetched and no Cron binding, runtime DB/provider connection, route, publication, or deployment was added.
- **Migration/configuration impact:** None. No migration, runtime configuration, dependency, lockfile, API contract, or deployment setting changed; the Worker package change only registers the runner test.
- **Remaining decisions:** Root review and acceptance. Hosted database behavior remains unverified as specified by the assignment.
