# LIFE-01-SOURCE-REVISION-FRESHNESS-WORKER-RUNTIME-CORE — disabled-by-default scheduled composition

**Status:** Paused by Team 12 decision to keep the runtime paused; no role or grant change is authorized.
**Backlog ID:** `LIFE-01-SOURCE-REVISION-FRESHNESS-WORKER-RUNTIME-CORE`
**Implementation model:** GPT-6 Luna, max reasoning
**Branch:** `work/LIFE-01-SOURCE-REVISION-FRESHNESS-WORKER-RUNTIME-CORE`
**Worktree:** `.codex-build/worktrees/life01-source-revision-freshness-worker-runtime-core`
**Assigned base:** `56d65005fe47cce6fdb6d43608d270043012cac8` (task assignment commit).
**Contracts:** source-revision review-candidate reader, exact freshness-target reader, transition coordinator, append-only freshness ledger, private run-state repository (schema 1.0), `TransactionalSqlExecutor`, ADR-047/048. Keep the public API/DTO/OpenAPI and database contracts unchanged.

## Context and dependencies

Read `AGENTS.md`, `SOFTWARE_DEVELOPMENT_PLAN.md`, `ARCHITECTURE.md`, `docs/DOMAIN_MODEL.md`, `docs/IMPLEMENTATION_BACKLOG.md`, ADR-038/039/042/043/044/045/046/047/048, and the accepted assignments/handoffs for source observations, report-revision impact reading, the L2 source-revision gate, review candidates, exact freshness targets, source-revision transitions, run state, and the generic freshness Worker runtime.

Dependencies: `LIFE-01-SOURCE-REVISION-WITHDRAWN-FRESHNESS-CORE`, `LIFE-01-SOURCE-REVISION-FRESHNESS-RUN-STATE-CORE`, `LIFE-01-SOURCE-REVISION-FRESHNESS-TRANSITION-CORE`, `LIFE-01-SOURCE-REVISION-REVIEW-CANDIDATE-READER-CORE`, `LIFE-01-SOURCE-REVISION-FRESHNESS-TARGET-READER-CORE`, `LIFE-01-SOURCE-REVISION-OBSERVATION-CORE`, `DB-POSTGRES-TRANSACTIONAL-SQL-EXECUTOR-CORE`, `DB-TEST-RUNNER-ISOLATION`, and the existing Worker scheduled-event boundary.

The one-page coordinator, migration 034 withdrawn policy, private run-state, exact readers, and freshness writer grants are accepted. ADR-047 explicitly keeps their scheduled runtime separate. Source rights remain pending; this task reads only already-persisted observations and uses authored PGlite fixtures. It does not acquire source data or configure a deployment.

## Objective

Compose one bounded source-revision freshness page per Worker scheduled slot, using the existing private run-state and deterministic Layer 4 coordinator. The scheduled path must remain inactive unless exact live mode, an independent opt-in flag, and the existing dedicated freshness-writer connection are available.

## Required behavior

1. Add a runtime factory and scheduled-event adapter. Return an inactive runtime before database access unless `DATASET_MODE === "live"`, `SOURCE_REVISION_FRESHNESS_SCHEDULER_ENABLED === "true"`, and `FRESHNESS_DUE_HYPERDRIVE.connectionString` passes the existing connection-string validator. Reuse that existing dedicated connection for the existing `waspada_l4_freshness_writer` role. Do not fall back to public `HYPERDRIVE` or the L1 connection; do not add another connection binding.
2. Validate platform `scheduledTime` before connecting, derive its stable RFC3339 instant and run/trace identity, and use that instant as the coordinator's explicit `now`. Repeated delivery of the same scheduled slot must derive the same trace identity and run start time.
3. Use one request-scoped transactional PostgreSQL client. Enter `waspada_l4_freshness_writer` with `SET ROLE`, restore the prior role during cleanup, and preserve the primary failure if cleanup also fails. Compose the accepted candidate and exact-target readers, SQL freshness ledger, source-revision run-state repository, and one-page transition coordinator. Use existing database functions for begin, checkpoint advance, and finalize; never write trace or run-state tables directly.
4. Begin the stable slot run before reading candidates. If it is already `succeeded` or `failed`, treat it as terminal replay and perform no coordinator, advance, or finalize work. For an `open` run, process exactly one page with limit 100, the persisted input cursor, the scheduled instant, and the same trace ID.
5. Advance the private checkpoint only when the coordinator returns `completed`. Pass the exact input cursor returned by `begin` and the coordinator's exact `nextCursor`; accept only `advanced` or idempotent `replayed`. A coordinator failure/conflict or checkpoint conflict must leave progress unadvanced and finalize the open trace as `failed`. Finalize a successful run only after successful or replayed checkpoint advancement. Preserve the exact bounded coordinator count summary; if no valid summary is available after a failure, use a closed all-zero failure summary. Never log or return cursors or observation/event/impact IDs.
6. A retry of an unfinished same-slot run uses the immutable saved input cursor from `begin`. A later slot starts from the durable checkpoint. Partial per-target writes remain safe through the existing exact-version freshness ledger and idempotent retries; do not loop over additional pages inside one invocation.
7. Invoke the new trigger from the existing `scheduled()` handler after the existing schedule calls, without changing their gates, order, or error semantics. Keep the checked-in Worker dormant: do not add a Cron expression, secret, binding/resource ID, hosted role membership, or deployment change.
8. Return only fixed, content-free runtime errors. Do not expose SQL, connection values, source/evidence text, cursors, or database-driver details. No new telemetry event is required in this slice; the accepted fixed-purpose run trace is the audit record.
9. Test authored PGlite fixtures only. Worker tests must cover disabled gates without connection, invalid schedule time, stable slot identity, fixed one-page limit, cursor/now/trace propagation, role and trace-function order, terminal replay, successful advance/finalize, failed and conflict paths without checkpoint movement, failed-run finalization, and redacted storage/cleanup errors. A PGlite composition test must apply the current migrations, exercise the real readers/coordinator/ledger/run-state under the existing role, prove cursor advancement/retry and audit summary, and confirm public projections and immutable publication content remain unchanged.

## Allowed paths

- `apps/worker/src/runtime/source-revision-freshness-schedule-runtime.ts` (new)
- `apps/worker/src/runtime/source-revision-freshness-schedule-trigger.ts` (new)
- `apps/worker/src/index.ts` (scheduled handler wiring only)
- `apps/worker/src/layers/l4-application-integration/api.ts` (new scheduler flag type only; reuse existing writer binding type)
- `apps/worker/test/source-revision-freshness-schedule-runtime.test.ts` (new)
- `apps/db/test/source-revision-freshness-schedule-runtime-composition.test.ts` (new PGlite integration test)
- `apps/worker/package.json` (focused test command registration only, if needed; no dependency/version changes)
- `docs/assignments/LIFE-01-SOURCE-REVISION-FRESHNESS-WORKER-RUNTIME-CORE-HANDOFF.md` (new)

Do not modify migrations, `wrangler.toml`, public contracts, schedule cadence, database grants, role membership, connection resources, credentials, existing L1/source collection, providers, external services, or deployed configuration. Ask root if another path or contract change appears necessary.

## Acceptance and verification

- Demo mode and missing/invalid gates return before opening a client.
- Live execution uses only the existing dedicated freshness-writer Hyperdrive binding and runs under the existing L4 role.
- Each scheduled slot has stable identity, performs at most one 100-candidate page, and uses the private cursor state machine; only completed pages advance, and terminal replay does no work.
- Worker and authored PGlite tests prove retry, failure, conflict, privacy, role, audit, and public-immutability behavior.
- In WSL Ubuntu-26.04 with existing dependencies, run the focused Worker and PGlite tests, `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD`. Record actual Node/npm and relevant package versions/results. Do not install packages, use live or retained incident data, or contact hosted Neon/Cloudflare.
- Work only on the assigned branch and worktree from the exact pinned base. Commit implementation/tests and handoff separately with descriptive messages. Do not merge or push. Handoff includes branch/worktree/base, commit SHAs/messages, changed paths, behavior, actual checks, limitations, and migration/configuration impact.

## Stop conditions

Stop and report to root if the existing L4 grants cannot run all accepted readers/functions, retry behavior conflicts with ADR-047, a multi-page loop is required, or a binding/role/schema/public-contract/external change becomes necessary. Do not add schedule/deployment configuration or live source access to work around a blocker. Escalate only after a GPT-6 Luna/max attempt documents a substantive technical blocker.
