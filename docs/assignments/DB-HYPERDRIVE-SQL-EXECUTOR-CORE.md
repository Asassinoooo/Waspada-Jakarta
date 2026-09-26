# DB-HYPERDRIVE-SQL-EXECUTOR-CORE — adapt node-postgres to SqlExecutor

- **Backlog ID:** `DB-HYPERDRIVE-SQL-EXECUTOR-CORE`
- **Objective:** Add a Worker-compatible, request-scoped PostgreSQL driver adapter that consumes an explicit Hyperdrive connection string and implements the existing `SqlExecutor` contract.
- **Dependencies:** `DATA-01`, `DB-TEST-RUNNER-ISOLATION`, `PLATFORM-01`, `ADR-010`, `ADR-022`.
- **Requirements:** `NFR-01/07`.
- **Contract boundary:** Preserve `apps/db/src/sql.ts` types. Implement `SqlExecutor` only; do not add transaction support or modify repository contracts in this slice.
- **Allowed paths:** `apps/db/package.json`; root `package-lock.json`; `apps/db/src/postgres-sql-executor.ts`; `apps/db/test/postgres-sql-executor.test.ts`; `apps/db/test/run-db-tests.ts`; this assignment's implementation handoff only.
- **Forbidden scope:** No Worker binding, `WorkerEnvironment`, `index.ts` or API route wiring; no Cloudflare/Neon resource creation, secret or connection string; no Wrangler/deployment configuration; no transaction runner, migration, schema, repository query, API contract, dependency beyond `pg` and its TypeScript definitions, live data, source fetch or paid provider.
- **Branch/worktree:** Use branch `work/DB-HYPERDRIVE-SQL-EXECUTOR-CORE` in the prepared managed worktree `C:\Users\perry\.codex\worktrees\api-geojson-route-core\RPL` (WSL: `/mnt/c/Users/perry/.codex/worktrees/api-geojson-route-core/RPL`), starting from the root's pushed assignment commit. Do not edit through the root checkout.

## Context to read before editing

Read `AGENTS.md`, `SOFTWARE_DEVELOPMENT_PLAN.md`, `docs/IMPLEMENTATION_BACKLOG.md`, this assignment, [ADR-010](../decisions/ADR-010-cloudflare-neon-free.md), [ADR-022](../decisions/ADR-022-worker-postgres-driver.md), [platform compatibility](../PLATFORM_COMPATIBILITY.md), `apps/db/src/sql.ts`, the DB test runner and relevant repository tests, plus Cloudflare's current Hyperdrive/PostgreSQL driver references linked from `REFERENCES.md`.

## Required behavior

1. Add the smallest supported `pg` dependency and required TypeScript declarations to the DB workspace, recording exact installed versions in the handoff. Use Cloudflare's current supported minimum and compatibility notes from the official links.
2. Implement a factory/wrapper that accepts a Hyperdrive-compatible PostgreSQL connection string explicitly. Do not read environment variables, Worker bindings, files or process secrets.
3. Adapt a connected client to the existing `SqlExecutor`: parameterized `query<Row>` calls return only `{ rows }`; `execute(statement)` awaits execution and returns no driver metadata. Copy readonly parameter arrays into the driver's expected mutable value array without coercing their values.
4. Scope client creation, connection and closure to one injected async operation. Await cleanup on success and failure; reject if cleanup fails after a successful operation. If the operation/connect path already failed and cleanup also fails, preserve the original operational failure. Do not log or expose driver diagnostics from this adapter.
5. Tests use a fake injected client/factory. Cover typed rows, unchanged parameter order and values, execute behavior, connection failure, operation/query failure, successful cleanup, cleanup after failure, and close-error handling. No actual TCP, Neon, Hyperdrive or external account is used.
6. Keep `SqlExecutor`, Worker routes and synthetic demo behavior unchanged. Do not provide `SqlTransactionRunner`; this adapter is read-only infrastructure for subsequent runtime composition.

## Acceptance criteria

- The adapter satisfies the current `SqlExecutor` interface without widening the DB public contracts.
- Connection setup and shutdown have one clear owner and are exercised for success and failure paths.
- SQL parameters are passed through as bound values; tests verify the statement and values are unchanged.
- Driver errors remain internal exceptions for the caller to handle; no code logs SQL, query parameters, credentials or driver messages.
- `npm run db:test`, `npm test`, `npm run typecheck`, and `npm run build` pass under WSL Ubuntu-26.04; record any Wrangler result accurately. `git diff --check` passes.
- No binding, secret, hosted database, route, migration, transaction runner, paid service or live data is added.

## Verification (WSL Ubuntu-26.04 only)

Record Node.js, npm, Git, TypeScript, `pg`, type declaration, PGlite and Wrangler versions. Install only the assigned workspace dependency through the lockfile. Run the focused adapter test, `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`. Do not use Windows-host runtimes, live connections or paid APIs.

## Commit and handoff

Implement only on the assigned branch/worktree. Commit implementation/tests and this handoff in coherent descriptive commits, leave the checkout clean, and do not merge or push. Report branch/worktree, exact commit SHAs/messages, changed paths, behavior, actual WSL checks, limitations, dependency/configuration impact, and remaining decisions. Root independently reviews and integrates.

## Stop conditions

Stop and report if the current `SqlExecutor` contract cannot be implemented without transaction/session behavior, if the selected driver fails the Worker typecheck/build, or if implementation requires a provider binding or external resource. Escalate to GPT-6 Astra xhigh only after a GPT-6 Luna Max attempt fails on a substantive technical difficulty.

## Implementation handoff

Append exact branch/worktree, commit SHAs/messages, changed paths, behavior, actual WSL checks, limitations, dependency/configuration impact, and remaining decisions here. Do not merge or push.

## Implementation handoff — 27 September 2026

- **Branch/worktree:** `work/DB-HYPERDRIVE-SQL-EXECUTOR-CORE`; `C:\Users\perry\.codex\worktrees\api-geojson-route-core\RPL` (`/mnt/c/Users/perry/.codex/worktrees/api-geojson-route-core/RPL`).
- **Implementation commit:** `61fc47fa11ab4a6fc2697419e28c5f204a6ee542` — `feat(DB-HYPERDRIVE-SQL-EXECUTOR-CORE): add request-scoped pg adapter`.
- **Implementation paths:** `apps/db/package.json`, `package-lock.json`, `apps/db/src/postgres-sql-executor.ts`, `apps/db/test/postgres-sql-executor.test.ts`.
- **Behavior:** `withPostgresSqlExecutor` takes an explicit connection string, creates/connects one client for one async operation, adapts only the existing `SqlExecutor` query/execute methods, copies readonly parameters without changing values, and always awaits client closure. It returns query rows only, discards execute metadata, propagates close errors after successful work, and keeps the original connection/operation error if cleanup also fails. Tests inject a fake client factory; no network or provider connection is used.
- **Dependency/tool versions from WSL Ubuntu-26.04:** Node `v24.21.0`; npm `11.19.0`; Git `2.53.0`; TypeScript `7.0.2`; `pg` `8.16.3` (Cloudflare's documented minimum); `@types/pg` `8.23.1`; PGlite `0.5.8`, PostGIS extension `0.2.8`, pgvector extension `0.0.9`; Wrangler `4.137.0`.
- **Checks actually run:** focused adapter test passed `6/6`; `npm run db:test` passed `17/17` test files; `npm test` passed web `22/22`, Worker `186/186`, DB `17/17` files, evaluation `12/12`; `npm run typecheck` passed all workspaces and evaluation; `npm run build` passed typecheck, Vite build, and Wrangler deploy dry-run; `git diff --check` passed.
- **Wrangler detail:** dry-run completed with a `33.59 KiB` bundle (`8.42 KiB` gzip) and reported the existing `DATASET_MODE="demo"` binding only. The DB adapter is not wired into the Worker in this task, so the dry-run does not exercise or bundle it.
- **Configuration/migration impact:** adds exact `pg` runtime and `@types/pg` development dependencies to the DB workspace and updates the lockfile. No migration, schema, Worker binding/configuration, API route, or transaction runner was added.
- **Limitations and remaining work:** hosted Hyperdrive/Neon connectivity, deployed Worker Node compatibility, TLS/pooling behavior, and provider query/cost behavior remain unverified. A later runtime-composition assignment must inject the Hyperdrive connection string and decide how the read services use the request-scoped adapter.
- **Agent handoff commit:** `9ed90bfa027feb5286963410f1e5c2c512ba7938` — `docs(DB-HYPERDRIVE-SQL-EXECUTOR-CORE): record implementation handoff`; integrated to `main` as `351b83b`.
