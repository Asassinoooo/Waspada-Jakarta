# API-PUBLIC-DETAIL-RUNTIME-CORE — compose and route the live EventDetail reader

- **Backlog ID:** `API-PUBLIC-DETAIL-RUNTIME-CORE`
- **Objective:** Connect the accepted current-public detail repositories and strict Layer 4 projector to the existing read-only `GET /api/v1/events/{event_id}` route behind exact live-mode configuration.
- **Dependencies:** `API-PUBLIC-DETAIL-PROJECTION-CORE`, `DB-HYPERDRIVE-SQL-EXECUTOR-CORE`, `API-PUBLIC-EVENT-LIST-RUNTIME-CORE`, `API-DETAIL-HISTORY-ROUTES-CORE`, `ADR-012`, `ADR-022`.
- **Requirements:** `FR-09/10`; `NFR-01/07`.
- **Contract boundary:** Preserve the existing `EventDetail`, `NOT_FOUND`, `INVALID_REQUEST`, and generic temporary-unavailable response shapes/statuses. Keep all database records untrusted until accepted L4 projection.
- **Allowed paths:** `apps/worker/src/index.ts`; `apps/worker/src/layers/l4-application-integration/api.ts`; new `apps/worker/src/runtime/public-event-detail-runtime.ts`; `apps/worker/src/runtime/public-event-list-runtime.ts` only if extracting a shared connection-string validator without changing list behavior; `apps/worker/test/api.test.ts`; new `apps/worker/test/public-event-detail-runtime.test.ts`; `apps/worker/package.json` (test script only); this assignment's implementation handoff only.
- **Forbidden scope:** No event-list behavior or contract changes; history or GeoJSON live route; OpenAPI/DTO; database schemas, migrations, views or repositories; publication/review writes or auth; source acquisition; production secret; Hyperdrive binding ID; Cloudflare/Neon resources; live connection/data; new dependency; Wrangler/deployment edits; paid service.
- **Branch/worktree:** Use branch `work/API-PUBLIC-DETAIL-RUNTIME-CORE` in the prepared managed worktree `C:\Users\perry\.codex\worktrees\api-geojson-route-core\RPL` (WSL: `/mnt/c/Users/perry/.codex/worktrees/api-geojson-route-core/RPL`), based on the root's pushed assignment commit. Do not edit through the root checkout.

## Context to read before editing

Read `AGENTS.md`, `SOFTWARE_DEVELOPMENT_PLAN.md`, `docs/IMPLEMENTATION_BACKLOG.md`, this assignment, [ADR-012](../decisions/ADR-012-public-projection-boundary.md), [ADR-022](../decisions/ADR-022-worker-postgres-driver.md), the accepted [detail projection](../../apps/worker/src/layers/l4-application-integration/public-event-detail-projection-service.ts), its underlying [EventView projection](../../apps/worker/src/layers/l4-application-integration/public-event-projection-service.ts), the [snapshot repository](../../apps/db/src/public-event-snapshot.ts), [reviewed lookup repository](../../apps/db/src/public-projection-lookups.ts), [geometry repository](../../apps/db/src/public-event-geometries.ts), [SQL adapter](../../apps/db/src/postgres-sql-executor.ts), accepted event-list runtime, and current API/index tests.

## Required behavior

1. Build a detail read service only for exact `DATASET_MODE=live` `GET /api/v1/events/{event_id}` requests with a valid injected Hyperdrive connection string. No cursor secret is needed for detail reads.
2. Compose `createPublicEventSnapshotRepository`, `createPublicProjectionLookupRepository`, `createPublicEventGeometriesRepository`, and `createPublicEventDetailProjectionService` over one invocation of `withPostgresSqlExecutor` per request. Construct SQL-bound repositories inside the operation callback. Do not use a transaction runner or duplicate SQL/publication/projection rules.
3. Decode and validate the route event ID before opening a database connection. A current public projection returns the existing `EventDetail`; an absent or withdrawn event remains `NOT_FOUND`; any DB, lookup, geometry or projection failure remains a generic redacted unavailable response, never a synthetic fallback or partial detail.
4. In live mode enable only the event-list route already accepted by `API-PUBLIC-EVENT-LIST-RUNTIME-CORE` and this detail route. Keep history, GeoJSON, context and unknown routes unavailable. Preserve all demo and unset-mode behavior.
5. Validate missing/malformed configuration before constructing the client. Keep error telemetry free of event IDs, connection details, source content and projection internals.
6. Test using fake SQL executor ports and authored fictional records only; no TCP, live database, provider account, actual secret or fabricated event is allowed. Cover exact route/mode gates, demo compatibility, missing/malformed configuration without executor calls, malformed event IDs before executor setup, missing/current public result mapping, one SQL operation per detail read, redacted failure handling, and continued event-list behavior.

## Acceptance criteria

- A configured exact-live detail request uses one request-scoped SQL client for snapshot, approved lookup and exact geometry reads.
- Invalid IDs and incomplete configuration open no database connection; a missing/current-withdrawn event returns only the existing 404 envelope.
- Only the accepted strict detail projector can construct the public `EventDetail`; DB records, storage fields and excerpts are never serialized directly.
- Demo remains the configured/default behavior. Live history and GeoJSON remain unavailable in this slice.
- No contract, schema, migration, dependency, provider resource, secret or deployment configuration is added.
- Under WSL Ubuntu-26.04, the focused runtime test, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check` pass. Record exact versions and Wrangler output.

## Verification (WSL Ubuntu-26.04 only)

Record Node.js, npm, Git, TypeScript, `pg`, `@types/pg`, PGlite and Wrangler versions. Run the focused detail-runtime test separately, then `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`. Use fake database/executor behavior only; do not connect to Neon/Hyperdrive or provision account resources.

## Commit and handoff

Implement only on the assigned branch/worktree. Commit implementation/tests and this handoff in coherent descriptive commits, leave the checkout clean, and do not merge or push. Report branch/worktree, exact commit SHAs/messages, changed paths, behavior, actual WSL checks, limitations, configuration impact, and remaining decisions. Root independently reviews and integrates.

## Stop conditions

Stop and report if a contract/schema/publication change is required, if malformed IDs cannot be rejected before connection setup, or if Worker compatibility requires deployment configuration outside the allowed paths. Do not provision resources or enable live data. Escalate to GPT-6 Astra xhigh only after a GPT-6 Luna Max attempt fails on a substantive technical difficulty.

## Implementation handoff

Append the exact branch/worktree, commit(s), changed paths, behavior, actual WSL checks, limitations and remaining decisions here. Do not merge or push.
