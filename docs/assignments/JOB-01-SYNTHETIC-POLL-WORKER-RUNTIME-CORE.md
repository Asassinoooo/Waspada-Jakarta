# JOB-01-SYNTHETIC-POLL-WORKER-RUNTIME-CORE — bounded fixture-poll execution

**Status:** Accepted on local `main` after root review.<br>
**Backlog ID:** `JOB-01-SYNTHETIC-POLL-WORKER-RUNTIME-CORE`<br>
**Implementation model:** GPT-6 Luna, max reasoning<br>
**Branch:** `work/JOB-01-SYNTHETIC-POLL-WORKER-RUNTIME-CORE`<br>
**Worktree:** `C:\Users\perry\.codex\worktrees\job01-synthetic-poll-worker-runtime\RPL` (`/mnt/c/Users/perry/.codex/worktrees/job01-synthetic-poll-worker-runtime/RPL` in WSL)<br>
**Assigned base:** `2cf9612ea365b8a72801c04049c3af3abe7bc9ec` (the implementation branch is cut from this exact root `main` commit; the root-owned ADR/backlog assignment will be committed separately on `main`).<br>
**Dependencies:** `JOB-01-SCHEDULED-POLL-CORE`, `JOB-01-SYNTHETIC-POLL-CLAIM-CORE`, `JOB-01-SYNTHETIC-POLL-PROCESSOR-CORE`, `JOB-01-SYNTHETIC-POLL-CYCLE-PGLITE-CORE`, `JOB-01-SYNTHETIC-SCHEDULE-RUNTIME-CORE`, `DB-POSTGRES-TRANSACTIONAL-SQL-EXECUTOR-CORE`, `OBS-01-FRESHNESS-DUE-TELEMETRY-CORE`, ADR-002/033/040.<br>
**Contract baseline:** Existing synthetic queue, runner, `FixturePipelinePorts`, `SyntheticSourcePollFixtureCatalog`, typed `ModelCapabilityAdapter.extract`, existing L1 role, and `L1_HYPERDRIVE`. Public APIs and database contracts are unchanged.

## Objective and read order

Read `SOFTWARE_DEVELOPMENT_PLAN.md` first, then the JOB-01 backlog rows and [ADR-040](../decisions/ADR-040-synthetic-poll-processing-runtime.md). Read ADR-033, the existing synthetic scheduler runtime/trigger, the synthetic poll runner and pipeline, SQL repository/transaction adapters, the PGlite cycle test, Worker environment and `scheduled()` entrypoint, and the source/model boundary docs.

Implement a separate Worker runtime/trigger for one bounded synthetic source-poll job. Preserve the existing scheduler as enqueue-only and reuse the real accepted L1 runner and repositories. The model capability and authored fixture catalog are injected boundaries; do not provide a production mock or fabricate model success.

## Required behavior

1. Create a runtime only for exact `DATASET_MODE=demo`, exact `SYNTHETIC_POLL_PROCESSOR_ENABLED=true`, a valid dedicated `L1_HYPERDRIVE` connection, an injected exact-source-ID `SyntheticSourcePollFixtureCatalog`, and an injected fixed L2 extraction adapter. Missing dependencies return before opening a client or claiming a job. Never fall back to the public-reader `HYPERDRIVE`.
2. Validate the platform scheduled epoch before database access using the same safe UTC constraints as the existing synthetic scheduler. Pass its RFC3339 instant to `runSyntheticSourcePollJob`; do not read wall-clock time for job transitions.
3. Use one request-scoped PostgreSQL client and the existing L1 role. Reset role on every completion path and preserve the original bounded failure if cleanup fails. Do not hold an explicit transaction open across an L2 extraction call. Use existing per-repository transactions, job lease/retry logic, stable job identity, idempotent replay, and acknowledgement ordering.
4. Compose the real SQL repository ports required by `FixturePipelinePorts` and call the existing `runSyntheticSourcePollJob`, which is already bounded to at most one job. Do not add a loop, sleep, catch-up scan, or claim other dataset/job kinds.
5. Wire a separate processor trigger after the existing synthetic enqueue trigger in `Worker.scheduled()`. Keep the two runtimes independently gated. The checked-in entrypoint supplies no provider or fixture catalog, so it must remain unable to claim/process jobs; tests inject dependencies. Leave the existing freshness trigger and public `fetch()` behavior intact.
6. Preserve source-ID fixture matching, schema-2.0 report/evidence lineage, L1 preprocessing and persistence, safe queue failures, and no-publication behavior. Do not use filesystem reads, HTTP/fetch, live sources, real model APIs, L3, event proposals, or publication code.
7. Add no migration, grant, schema, dependency, secret, Cloudflare binding/resource, Cron config, provider, or external service. Add only the processor flag to the Worker environment type; do not edit `wrangler.toml` or deployment settings. Root owns ADR, SDP, backlog, and checkpoint updates.

## Allowed paths

- `apps/worker/src/runtime/synthetic-source-poll-process-runtime.ts` (new)
- `apps/worker/src/runtime/synthetic-source-poll-process-trigger.ts` (new)
- `apps/worker/src/index.ts` (scheduled trigger composition only)
- `apps/worker/src/layers/l4-application-integration/api.ts` (environment type only)
- `apps/worker/test/synthetic-source-poll-process-runtime.test.ts` (new)
- `apps/db/test/synthetic-source-poll-process-runtime.test.ts` (new PGlite composition test)
- `apps/worker/package.json` (test command registration only)
- `docs/assignments/JOB-01-SYNTHETIC-POLL-WORKER-RUNTIME-CORE-HANDOFF.md` (new handoff)

If current repository ports cannot provide the required L1 capabilities without a schema/grant change, stop and report the concrete least-privilege gap; do not widen permissions. Ask root before changing any path above or the runtime contract.

## Acceptance and verification

- Worker tests prove each disabled gate, missing catalog/model adapter, invalid time, public-binding fallback denial, fixed redacted errors, one-job bound, role reset, and safe success/retry outcomes.
- A PGlite test under the existing L1 role composes the runtime with authored fixtures and a test-only fixed L2 adapter double. It verifies persisted report/evidence/extraction/chunk/geometry data precedes acknowledgement, exact source matching, replay behavior, and zero Event/publication writes.
- Tests prove that no real network/model provider is called, and missing provider/catalog does not claim queued work.
- In WSL Ubuntu-26.04, use installed dependencies only. Run focused Worker and PGlite tests, `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD`. Record actual Node/npm/package versions, results, failures/reruns, and limits. No paid calls or installs.
- Work only in the assigned branch/worktree, after root has advanced it to the assignment commit. Commit implementation and handoff in coherent commits. Do not merge, push, deploy, change external resources, or spawn more agents.

## Stop conditions

Stop and report to root if the runtime needs model selection/provider credentials, source rights, a grant/schema/API change, external service setup, or any broadened activation gate. Do not treat an injected test adapter as evidence of real model quality or live-source behavior. Escalate to Astra only after a substantive Luna/max technical attempt remains unresolved.
