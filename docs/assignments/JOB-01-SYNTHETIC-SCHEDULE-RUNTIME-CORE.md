# JOB-01-SYNTHETIC-SCHEDULE-RUNTIME-CORE — Synthetic scheduled enqueue runtime

- **Status:** Accepted locally on `main`; hosted execution remains unverified
- **Agent:** GPT-6 Luna / max
- **Branch:** `work/JOB-01-SYNTHETIC-SCHEDULE-RUNTIME-CORE`
- **Worktree:** `C:\Users\perry\.codex\worktrees\l3-coordinator-core\RPL` (`/mnt/c/Users/perry/.codex/worktrees/l3-coordinator-core/RPL`)
- **Dependencies:** JOB-01, JOB-01-SCHEDULED-POLL-CORE, DB-HYPERDRIVE-SQL-EXECUTOR-CORE, DB-TEST-RUNNER-ISOLATION; ADR-002/022/033
- **Requirements:** FR-02/14; NFR-01/05/07/08
- **Contracts:** domain/message schema 2.0; unchanged public DTO/OpenAPI; existing SqlExecutor and SourcePollScheduler

## Objective and read order

Read SOFTWARE_DEVELOPMENT_PLAN.md first, the relevant backlog entries, ADR-033, ADR-002, ADR-022, the current queue/scheduler/SQL executor and Worker entrypoint. Implement ADR-033's opt-in synthetic enqueue runtime and scheduled trigger adapter. The source scheduler is already implemented; compose it, do not duplicate its due-source/idempotency policy.

## Required behavior

- Export a testable runtime factory gated on exact demo mode, exact enabled string `true`, and only the separate L1 connection configuration. Missing/invalid/other configuration creates no SQL client. Never use the public-reader connection as a fallback.
- Accept only a validated platform scheduled epoch (finite, safe integer, nonnegative, UTC year at most 9999); reject malformed input before SQL. Use the resulting UTC RFC3339 instant throughout.
- In one lazy SQL-client operation, begin a transaction, `SET LOCAL ROLE waspada_l1_pipeline`, and verify exactly one synthetic namespace row before writes. Persist a new synthetic trace, instantiate the real SqlAcquisitionJobRepository and SqlSourcePollScheduler on the same executor, schedule once, finish the trace, and commit. Trace creation/finishing may use narrowly scoped parameterized SQL instead of changing repository interfaces. Use an unpredictable generated trace ID; no runtime caller supplies identity or metadata.
- Use closed trace metadata: a fixed trigger kind and the four existing scheduler counts. Validate counts before persistence. Do not change source health, claim/process jobs, invoke L2/L3, or create event/publication records.
- Roll back on any error including namespace mismatch and trace completion failure; use a bounded redacted error without raw cause/details. Ensure the existing client wrapper closes the connection. Do not retry implicitly or hide execution failure as success.
- Wire `index.ts`'s `scheduled` entrypoint to the runtime and platform controller time. Keep all public fetch behavior unchanged. It is acceptable to expose a small trigger adapter with an injected runtime factory for tests. No Cron expression, provider binding, secret or enable flag is added to checked-in configuration.
- Add migration `021_l1_scheduler_namespace_read.sql` with only the namespace dataset column read grant. Use PGlite to verify the runtime can read under L1 and cannot change namespace, and unrelated roles gain no permission.

## Allowed paths

- `apps/worker/src/runtime/synthetic-poll-schedule-runtime.ts`
- `apps/worker/src/runtime/synthetic-poll-schedule-trigger.ts` if needed for testable wiring
- `apps/worker/src/index.ts` — scheduled wiring only
- `apps/worker/src/layers/l4-application-integration/api.ts` — environment type additions only
- `apps/worker/test/synthetic-poll-schedule-runtime.test.ts`
- `apps/worker/package.json` — test registration only
- `apps/db/migrations/021_l1_scheduler_namespace_read.sql`
- `apps/db/test/synthetic-poll-schedule-runtime.test.ts`
- `apps/db/test/migrations.test.ts` and `apps/db/test/public-event-updates.test.ts` — migration staging/inventory assertions only as needed for 021
- `docs/assignments/JOB-01-SYNTHETIC-SCHEDULE-RUNTIME-CORE-HANDOFF.md`

No other production/schema/grant changes, new dependencies, runtime configuration, real source/model calls, routes, auth, UI, deployment, purchases, merges or push. Root owns backlog/SDP/architecture/ADR updates. Stop and report if additional paths or decisions are needed; continue independent assigned checks.

## Acceptance and verification

Prove disabled/invalid/non-demo gates open no SQL connection; public HYPERDRIVE alone never schedules; malformed epoch opens no connection; namespace mismatch writes nothing; exact role and same executor are used; approved due sources enqueue; repeated timestamp enqueues no duplicate job; successful trace closes with count-only metadata; failures roll back and reveal no secrets; PGlite records stay synthetic with no event/publication writes; L1 namespace mutation remains forbidden. Compile the actual entrypoint. Hosted behavior and true multi-session concurrency remain unverified.

Use WSL Ubuntu-26.04 only. Existing Node path is `/home/perry/.nvm/versions/node/v24.21.0/bin`; include it in PATH. Do not install packages. Temporarily link this worktree's node_modules to `/mnt/d/Projects/RPL/node_modules` if absent and remove it before handoff. WSL Git needs GIT_DIR `/mnt/d/Projects/RPL/.git/worktrees/RPL5` and GIT_WORK_TREE set to this worktree because the managed pointer is a Windows path.

Run focused Worker/DB tests, `npm test`, `npm run typecheck`, `npm run build` (Vite plus Wrangler dry-run), and `git diff --check <assigned-base>..HEAD`. No paid/external calls. Record actual versions, counts, commands, failures and reruns. Commit coherent changes on the assigned branch; return exact SHAs/messages, changed files, behavior, checks, limitations, migration/configuration effect, remaining decisions. Do not approve your own work or spawn agents.
