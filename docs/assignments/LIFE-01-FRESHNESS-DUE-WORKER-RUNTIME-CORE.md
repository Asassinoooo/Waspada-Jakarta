# LIFE-01-FRESHNESS-DUE-WORKER-RUNTIME-CORE — disabled-by-default scheduled composition

**Status:** Accepted on local `main` after root review.<br>
**Backlog ID:** `LIFE-01-FRESHNESS-DUE-WORKER-RUNTIME-CORE`<br>
**Implementation model:** GPT-6 Luna, max reasoning<br>
**Branch:** `work/LIFE-01-FRESHNESS-DUE-WORKER-RUNTIME-CORE`<br>
**Worktree:** `/mnt/c/Users/perry/.codex/worktrees/life-01-freshness-due-worker-runtime-core/RPL`<br>
**Assigned base:** `efc968bf60ff18f20b37fab1e046f49b43605ce0`.<br>
**Contract baseline:** Accepted freshness due reader/evaluator, exact-version transition ledger, migration 026 trace functions, `TransactionalSqlExecutor`, ADR-038/039, and existing Worker scheduled-event boundary. Do not change public API/DTOs or the freshness ledger/function contracts.

## Objective

Compose one bounded Layer 4 freshness evaluation page behind an opt-in Worker scheduled handler. The code must remain dormant unless exact live mode, an explicit enable flag, and a dedicated freshness-writer Hyperdrive connection are all present. This task adds local runtime code and tests only; it does not configure a Cron trigger, Hyperdrive resource, hosted login membership, deployment, source fetch, or live processing.

## Dependencies

`LIFE-01-FRESHNESS-DUE-RUN-TRACE-CORE`, `DB-POSTGRES-TRANSACTIONAL-SQL-EXECUTOR-CORE`, `LIFE-01-FRESHNESS-DUE-TARGET-READER-CORE`, `LIFE-01-FRESHNESS-DUE-EVALUATOR-CORE`, `LIFE-01-FRESHNESS-DUE-COMPOSITION-PGLITE-CORE`, ADR-038/039, and the existing Worker scheduled-event entrypoint.

## Required behavior

1. Add a runtime factory and scheduled-event adapter. Return an inactive runtime without opening a database client unless `DATASET_MODE === "live"`, `FRESHNESS_DUE_SCHEDULER_ENABLED === "true"`, and the dedicated `FRESHNESS_DUE_HYPERDRIVE.connectionString` is valid. Do not fall back to the public-reader or L1 connection.
2. Validate the platform `scheduledTime` and derive a stable, evaluator-compatible run/trace ID from that schedule slot. Use the schedule instant as the explicit freshness evaluation time so retries for the same slot retain the same idempotency identity.
3. Use one request-scoped transactional PostgreSQL client, enter `waspada_l4_freshness_writer` with `SET ROLE`, and restore the prior role during cleanup without masking the original failure. Compose the real SQL due reader, freshness recorder/ledger, bounded evaluator, and migration-026 begin/finalize functions. Do not directly insert or update trace rows. Preserve one-page/100-target bounds; do not add a loop over unbounded pages.
4. If begin reports `open`, evaluate at most one page and finalize the run with `succeeded` or `failed` plus exactly the evaluator's closed count summary. If begin reports an exact existing terminal status, do not reopen or repeat that run. A runtime/DB error must use a fixed content-free error and must not expose the connection, SQL, source, or driver details.
5. Invoke the freshness trigger from the existing Worker `scheduled()` handler. Keep current demo mode and missing-flag behavior dormant. Do not add a `crons` entry to Wrangler, a Hyperdrive resource ID, secret, provider, migration, dependency, external service change, role membership, or public contract.
6. Add deterministic Worker tests for disabled gates, invalid scheduled time, stable run identity, role and trace-function call order, terminal replay, bounded processing, failure finalization, and sanitized failures. Add a PGlite composition test that exercises the real runtime against migrations 024–026 in an isolated empty live test database and proves an audited final trace; use no external or retained incident data.

## Allowed paths

- `apps/worker/src/runtime/freshness-due-schedule-runtime.ts` (new)
- `apps/worker/src/runtime/freshness-due-schedule-trigger.ts` (new)
- `apps/worker/src/index.ts` (scheduled handler wiring only)
- `apps/worker/src/layers/l4-application-integration/api.ts` (optional environment binding/flag types only)
- `apps/worker/test/l4-freshness-due-schedule-runtime.test.ts` (new)
- `apps/worker/package.json` (test command entry only; no dependencies or version changes)
- `apps/db/test/freshness-due-schedule-runtime-composition.test.ts` (new PGlite composition test only)
- `docs/assignments/LIFE-01-FRESHNESS-DUE-WORKER-RUNTIME-CORE-HANDOFF.md` (new handoff)

Do not modify `wrangler.toml`, any migration, public contracts, schedule cadence, runtime provider configuration, existing source collection, deployment bindings, credentials, hosted role membership, or external services. Ask root if the runtime needs any other path or contract change.

## Acceptance and verification

- Default/demo configuration performs no database connection or scheduled freshness work.
- Live execution requires the separate freshness-writer connection and explicit opt-in; the runtime enters the L4 freshness role and never writes traces directly.
- Every scheduled run is stable for its slot, bounded to one page of at most 100 candidates, and auditable through exact begin/finalize functions. Replays do not reopen terminal traces.
- Worker and PGlite tests verify disabled paths, transition composition, terminal replay, boundedness, privacy-safe errors, and no public/API/source mutation.
- Use installed dependencies only; do not install packages or contact a hosted service. Run focused Worker/PGlite tests, `npm run db:test`, `npm run typecheck`, `npm test`, `npm run build`, and `git diff --check <assigned-base>..HEAD` in WSL Ubuntu-26.04. Record actual versions and results.
- Work only in the assigned branch/worktree. Commit the implementation/tests and handoff in coherent commits. Do not merge or push; root reviews and integrates.

## Stop conditions

Stop and report to root if the exact trace/evaluator contracts conflict, role switching requires changing an external login/membership now, the one-page bound cannot be preserved, or a Cron/Hyperdrive/external change becomes necessary. Do not implement such configuration in this slice; hosted role membership remains a later activation prerequisite. Escalate to Astra only if a Luna/max attempt documents a substantive unresolved technical blocker.
