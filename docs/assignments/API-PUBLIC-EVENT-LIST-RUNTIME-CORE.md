# API-PUBLIC-EVENT-LIST-RUNTIME-CORE — compose the optional live event-list read path

- **Backlog ID:** `API-PUBLIC-EVENT-LIST-RUNTIME-CORE`
- **Objective:** Compose the accepted public event-list database repositories and Layer 4 services at the Worker entrypoint, gated by explicit live-mode configuration.
- **Dependencies:** `API-PUBLIC-EVENT-LIST-ROUTE-CORE`, `API-PUBLIC-EVENT-LIST-PAGE-CORE`, `API-PUBLIC-EVENT-LIST-FILTERS-CORE`, `API-PUBLIC-EVENT-LIST-PROJECTION-CORE`, `DB-HYPERDRIVE-SQL-EXECUTOR-CORE`, `ADR-021`, `ADR-022`.
- **Requirements:** `FR-09/10`; `NFR-01/07`.
- **Contract boundary:** Keep the existing `EventPage`, error envelope, repository contracts, SQL schema, publication rules and cursor semantics unchanged. Live mode may expose only the current-public event-list route in this slice.
- **Allowed paths:** `apps/worker/src/index.ts`; `apps/worker/src/layers/l4-application-integration/api.ts`; new `apps/worker/src/runtime/public-event-list-runtime.ts`; `apps/worker/test/api.test.ts`; new `apps/worker/test/public-event-list-runtime.test.ts`; `apps/worker/package.json` (test script only); this assignment's implementation handoff only.
- **Forbidden scope:** No change to `apps/worker/wrangler.toml`, OpenAPI/DTO, database schema/migrations/repositories, `SqlExecutor`, publication/review writes, detail/history/GeoJSON/context live routes, model/source acquisition, real cursor key, secret value, Hyperdrive binding ID, Cloudflare or Neon resource, live connection/data, paid provider, dependency, or deployment.
- **Branch/worktree:** Use branch `work/API-PUBLIC-EVENT-LIST-RUNTIME-CORE` in the prepared managed worktree `C:\Users\perry\.codex\worktrees\api-geojson-route-core\RPL` (WSL: `/mnt/c/Users/perry/.codex/worktrees/api-geojson-route-core/RPL`), starting from the root's pushed assignment commit. Do not edit through the root checkout.

## Context to read before editing

Read `AGENTS.md`, `SOFTWARE_DEVELOPMENT_PLAN.md`, `docs/IMPLEMENTATION_BACKLOG.md`, this assignment, [ADR-021](../decisions/ADR-021-public-event-list-cursor.md), [ADR-022](../decisions/ADR-022-worker-postgres-driver.md), `apps/worker/src/index.ts`, `apps/worker/src/layers/l4-application-integration/api.ts`, the accepted event-list page/filter/projection services, the three existing public-event database repositories, and `apps/db/src/postgres-sql-executor.ts`.

## Required behavior

1. Preserve demo behavior. The checked-in Wrangler configuration stays at `DATASET_MODE="demo"`; an unset mode continues to use the existing synthetic demo reader. Do not configure an external binding or secret.
2. Build the database-backed service only when `DATASET_MODE` is exactly `live` and the request is `GET /api/v1/events`. The runtime input may describe an injected Hyperdrive binding structurally by its `connectionString`, but no binding ID is checked in.
3. Accept the cursor secret through an optional Worker secret input named `PUBLIC_EVENT_LIST_CURSOR_HMAC_KEY_HEX`. It must be exactly 64 hexadecimal characters (32 bytes). Import it as a non-extractable HMAC-SHA-256 key for signing and verification. Do not generate, persist, log, or commit a production key. Invalid or missing connection/key configuration must fail closed with the existing bounded unavailable response and must not construct or connect a database client.
4. Compose the accepted `createPublicEventListRepository`, snapshot and lookup repositories, strict event projector, list projection, cursor codec and page service. Use the existing SQL/publication views and allowlists; do not duplicate query, cursor, projection or publication logic.
5. Scope all SQL reads for one page through one invocation of `withPostgresSqlExecutor`; create the SQL-bound repositories inside its operation callback. Use no transaction runner. Invalid URL query parameters or cursor tokens must be rejected by the accepted page service before opening a database connection. Database or projection failures must remain unavailable errors and must never become an empty successful page.
6. In live mode allow only the list route when the configured page service exists. Other public routes remain unavailable in live mode in this slice. When live-mode configuration is incomplete, return unavailable rather than falling back to synthetic data. Do not loosen the existing non-demo gate for unknown modes.
7. Test with fake connection/executor ports and generated test-only HMAC keys. Cover default/demo behavior, exact live-mode gating, missing and malformed configuration without client creation, list composition with an empty current-public result, one request-scoped SQL operation, invalid request/cursor before any connection, DB failure as unavailable, and all non-list live routes staying unavailable. No TCP, provider account or actual secret is used.

## Acceptance criteria

- The Worker composes the already accepted components without changing public response/schema contracts or adding implementation responsibilities to L3.
- A valid list request in live mode has one request-scoped PostgreSQL client; malformed requests/cursors and incomplete configuration open none.
- Query results still pass through the strict current-public projector and only the existing `EventPage` is returned.
- Demo mode remains the checked-in/default behavior; live mode cannot expose synthetic fallback routes.
- No secrets, IDs, live rows, bindings or provider resources are added.
- Under WSL Ubuntu-26.04, the focused runtime test, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check` pass. Record exact versions and Wrangler output accurately.

## Verification (WSL Ubuntu-26.04 only)

Record Node.js, npm, Git, TypeScript, `pg`, `@types/pg`, PGlite and Wrangler versions. Run the focused runtime test separately, then `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`. Use fake database/client/key material only. Do not connect to Neon/Hyperdrive or provision any account resources.

## Commit and handoff

Implement only on the assigned branch/worktree. Commit implementation/tests and this handoff in coherent descriptive commits, leave the checkout clean, and do not merge or push. Report branch/worktree, exact commit SHAs/messages, changed paths, behavior, actual WSL checks, limitations, configuration impact, and remaining decisions. Root independently reviews and integrates.

## Stop conditions

Stop and report if the existing public repositories cannot be composed without changing contracts/schema/publication rules; if invalid request/cursor validation cannot happen before connection setup; if the build requires a deployment binding/config change outside the allowed paths; or if Worker compatibility fails with the already committed runtime configuration. Do not bypass these conditions or provision resources. Escalate to GPT-6 Astra xhigh only after a GPT-6 Luna Max attempt fails on a substantive technical difficulty.

## Implementation handoff

Append exact branch/worktree, commit SHAs/messages, changed paths, behavior, actual WSL checks, limitations, configuration impact, and remaining decisions here. Do not merge or push.
