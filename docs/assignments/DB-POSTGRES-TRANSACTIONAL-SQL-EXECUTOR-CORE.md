# DB-POSTGRES-TRANSACTIONAL-SQL-EXECUTOR-CORE — transactional node-postgres adapter

**Status:** Assigned for isolated implementation.<br>
**Backlog ID:** `DB-POSTGRES-TRANSACTIONAL-SQL-EXECUTOR-CORE`<br>
**Implementation model:** GPT-6 Luna, max reasoning<br>
**Branch:** `work/DB-POSTGRES-TRANSACTIONAL-SQL-EXECUTOR-CORE`<br>
**Worktree:** `/mnt/c/Users/perry/.codex/worktrees/db-postgres-transactional-sql-executor-core/RPL`<br>
**Assigned base:** Exact local `main` SHA supplied in the root dispatch after this assignment is committed.<br>
**Contract baseline:** Existing `SqlExecutor` and `TransactionalSqlExecutor` in `apps/db/src/sql.ts`, node-postgres adapter in `apps/db/src/postgres-sql-executor.ts`, and ADR-022. No application API or Worker binding change.

## Objective

Extend the existing request-scoped node-postgres adapter with an explicit transaction-capable operation for repositories that require `TransactionalSqlExecutor`, including the freshness transition ledger. Preserve the existing plain `withPostgresSqlExecutor` behavior.

## Dependencies

`DB-HYPERDRIVE-SQL-EXECUTOR-CORE`, the existing `TransactionalSqlExecutor` interface, and the accepted LIFE-01 freshness transition ledger/composition.

## Required behavior

1. Export a new `withPostgresTransactionalSqlExecutor` that accepts a supplied connection string, an async operation receiving `TransactionalSqlExecutor`, and the existing injectable client-factory test seam.
2. Use one connected `pg.Client` for the whole operation. Forward typed query rows and parameter values with the existing adapter semantics. The exposed `transaction(work)` must pass a transaction-bound `SqlExecutor` to `work`, run `BEGIN`, then `COMMIT` on success, and attempt `ROLLBACK` if the work or commit fails.
3. Preserve the original work/commit error if rollback also fails. If the outer operation succeeds but client cleanup fails, surface the cleanup error; if the operation already failed, preserve that operation error if cleanup also fails. A failed connect must skip the operation and still attempt cleanup.
4. Do not automatically wrap the whole outer operation in a transaction; only calls to `executor.transaction(...)` start one. Do not add retries, nested transaction support, isolation-level configuration, or connection pooling.
5. Add deterministic fake-client coverage for transaction statement order and same-client use, successful commit, work failure with rollback, commit failure with rollback attempt, cleanup/connect failure behavior, and unchanged existing nontransactional adapter behavior.

## Allowed paths

- `apps/db/src/postgres-sql-executor.ts`
- `apps/db/test/postgres-sql-executor.test.ts`
- `docs/assignments/DB-POSTGRES-TRANSACTIONAL-SQL-EXECUTOR-CORE-HANDOFF.md` (new implementation handoff)

Do not edit Worker runtime/route/environment files, package manifests or lockfiles, SQL schemas/migrations/grants, Wrangler configuration, secrets, live providers, or deployment resources.

## Acceptance and verification

- The new helper satisfies the existing `TransactionalSqlExecutor` type without weakening or changing the interface.
- Fake-client tests prove transaction order, commit/rollback outcomes, error preservation, one-client scope, and close semantics. The existing `withPostgresSqlExecutor` tests remain unchanged in behavior.
- Use existing dependencies only; do not install packages. Record actual WSL Ubuntu-26.04 tool versions and results.
- Run the focused adapter suite, `npm run typecheck`, `npm test`, `npm run build`, and `git diff --check <assigned-base>..HEAD` in WSL Ubuntu-26.04.
- Work only in the assigned branch/worktree. Commit implementation and handoff in coherent descriptive commits. Do not merge or push. Root independently reviews before acceptance.

## Stop conditions

Stop and report to root if this requires changing SQL contracts, dependencies, application/runtime wiring, worker bindings, provider configuration, schema or migrations. Model escalation is not authorized unless Luna/max attempts and documents a substantive technical blocker.
