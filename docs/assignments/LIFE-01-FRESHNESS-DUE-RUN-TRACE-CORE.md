# LIFE-01-FRESHNESS-DUE-RUN-TRACE-CORE — narrow run-trace capability

**Status:** Accepted on local `main` after root review.<br>
**Backlog ID:** `LIFE-01-FRESHNESS-DUE-RUN-TRACE-CORE`<br>
**Implementation model:** GPT-6 Luna, max reasoning<br>
**Branch:** `work/LIFE-01-FRESHNESS-DUE-RUN-TRACE-CORE`<br>
**Worktree:** `/mnt/c/Users/perry/.codex/worktrees/life-01-freshness-due-run-trace-core/RPL`<br>
**Assigned base:** `0525feff019c42fb75c88b23a848a836d9f676a8`.<br>
**Contract baseline:** ADR-038 append-only freshness ledger, ADR-039 run-trace decision, existing `waspada.traces`, and `waspada_l4_freshness_writer`; no public API/DTO or Worker runtime contract change.

## Objective

Add narrow database functions that let the existing freshness writer capability create/resume and finalize its own scheduled evaluation trace, without direct trace-table insert/update grants. This is a database-only prerequisite for a future disabled-by-default Worker scheduler; it does not implement or enable that scheduler.

## Dependencies

`LIFE-01-FRESHNESS-LEDGER-CORE`, `LIFE-01-FRESHNESS-DUE-COMPOSITION-PGLITE-CORE`, `DB-POSTGRES-TRANSACTIONAL-SQL-EXECUTOR-CORE`, ADR-038/039, and the existing PGlite migration/test harness.

## Required behavior

1. Add migration `026_freshness_due_run_traces.sql` with two fixed-purpose functions: begin-or-resume a run trace and finalize it. The functions use `SECURITY DEFINER`, a fixed safe `search_path`, fully qualified relations, and bounded input validation.
2. Fix dataset kind to `live` and trigger metadata to `freshness_due_evaluation`. Accept only a bounded run trace ID, explicit start/finish instants, terminal outcome `succeeded` or `failed`, and a closed count-only summary with non-negative integer counters for `written`, `replayed`, `noChange`, `conflicts`, and `failures`.
3. Begin must create an `open` trace or return the existing status for an exact same-ID/time/metadata replay. Reuse of the trace ID with different identity or time must fail closed. An open trace may be resumed; a terminal trace must remain terminal.
4. Finalize only the exact open freshness-run trace, preserve the fixed trigger identity, and record its bounded summary. Replaying the exact final state must be idempotent; changing outcome, timestamp, or counts must fail closed.
5. Revoke function execution from `PUBLIC` and grant it only to `waspada_l4_freshness_writer`. Do not grant that role direct trace `INSERT` or `UPDATE`; prove unrelated roles cannot call the functions and existing roles/trace rows are unaffected.
6. Add PGlite migration tests for creation, exact replay, open resume, successful/failed finalization, changed replay conflicts, invalid count/ID/time inputs, fixed metadata, and least-privilege execute/table grants. Use synthetic data only.

## Allowed paths

- `apps/db/migrations/026_freshness_due_run_traces.sql` (new)
- `apps/db/test/freshness-due-run-traces.test.ts` (new)
- `apps/db/test/migrations.test.ts` (root-authorized update to ordered migration/count/latest-version expectations for 026)
- `apps/db/test/public-event-updates.test.ts` (root-authorized update to exclude 026 from the pre-024 fixture subset and include it in the full applied list)
- `docs/assignments/LIFE-01-FRESHNESS-DUE-RUN-TRACE-CORE-HANDOFF.md` (new implementation handoff)

Do not change the existing migration files, runtime/Worker code, package manifests or lockfiles, role membership for a hosted login, deployment bindings, Cron configuration, external services, or any public contract. ADR-039 is the accepted design baseline; ask root if the function boundary or privilege scope proves insufficient.

## Acceptance and verification

- The migration adds no direct trace-table write privilege to the freshness writer or any other application role; function execution is revoked from `PUBLIC` and granted only to the freshness writer.
- Tests prove fixed run identity, idempotent begin/finalize behavior, closed count schema, safe metadata, privilege denial, and unchanged unrelated traces.
- Use the existing PGlite harness and dependencies only; do not install packages. Record actual WSL Ubuntu-26.04 tool versions and results.
- Run the focused migration test, `npm run db:test`, `npm run typecheck`, `npm test`, `npm run build`, and `git diff --check <assigned-base>..HEAD` in WSL Ubuntu-26.04.
- Work only on the assigned branch/worktree. Commit the migration/test and handoff coherently. Do not merge or push. Root reviews before acceptance.

## Stop conditions

Stop and report to root if migration ordering, PGlite function security semantics, or least-privilege behavior cannot be verified, or if runtime wiring, external role membership, public contract, or provider setup becomes necessary. No model escalation unless Luna/max attempts and documents a substantive technical blocker.
