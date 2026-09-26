# API-PUBLIC-HISTORY-RUNTIME-CORE — compose the live reviewed history reader

- **Backlog ID:** `API-PUBLIC-HISTORY-RUNTIME-CORE`
- **Objective:** Wire the existing read-only `GET /api/v1/events/{event_id}/history` route to the accepted current-public version reader, exact-version moderator-review metadata reader, and strict Layer 4 `HistoryPage` projector.
- **Dependencies:** `API-PUBLIC-HISTORY-PROJECTION-CORE`, `API-PUBLIC-HISTORY-READER-CORE`, `API-PUBLIC-HISTORY-REVIEW-METADATA-CORE`, `DB-HYPERDRIVE-SQL-EXECUTOR-CORE`, `API-PUBLIC-DETAIL-RUNTIME-CORE`, `API-DETAIL-HISTORY-ROUTES-CORE`, `ADR-012`, `ADR-022`.
- **Requirements:** `FR-09/10`; `NFR-01/07`.
- **Contract boundary:** Preserve the existing OpenAPI `HistoryPage`, cursor and error envelope. Every public change label and summary must come from complete, exact-version moderator-approved metadata.
- **Allowed paths:** `apps/worker/src/index.ts`; `apps/worker/src/layers/l4-application-integration/api.ts`; new `apps/worker/src/runtime/public-event-history-runtime.ts`; `apps/worker/test/api.test.ts`; new `apps/worker/test/public-event-history-runtime.test.ts`; `apps/worker/package.json` (test script only); this assignment's implementation handoff only.
- **Forbidden scope:** No detail/list behavior or contract changes; no GeoJSON route; no review or publication writes/auth; no source acquisition; no OpenAPI/DTO or database schema/view/repository/migration change; no production key, Hyperdrive ID, provider resource, live connection/record, new dependency, Wrangler/deployment edit, paid service, or direct serialization of database rows.
- **Branch/worktree:** Use branch `work/API-PUBLIC-HISTORY-RUNTIME-CORE` in the prepared managed worktree `C:\Users\perry\.codex\worktrees\api-geojson-route-core\RPL` (WSL: `/mnt/c/Users/perry/.codex/worktrees/api-geojson-route-core/RPL`), based on the root's pushed assignment commit. Do not edit through the root checkout.

## Context to read before editing

Read `AGENTS.md`, `SOFTWARE_DEVELOPMENT_PLAN.md`, `docs/IMPLEMENTATION_BACKLOG.md`, this assignment, [ADR-012](../decisions/ADR-012-public-projection-boundary.md), [ADR-022](../decisions/ADR-022-worker-postgres-driver.md), the accepted [history projection](../../apps/worker/src/layers/l4-application-integration/public-event-history-projection-service.ts), the [history candidate reader](../../apps/db/src/public-event-history.ts), [reviewed disclosure reader](../../apps/db/src/public-event-history-disclosure.ts), [SQL adapter](../../apps/db/src/postgres-sql-executor.ts), [detail runtime](../../apps/worker/src/runtime/public-event-detail-runtime.ts), current API/index tests, and `docs/api/openapi.yaml` history operation and shared query parameters.

## Required behavior

1. Build a history service only for exact `DATASET_MODE=live` `GET /api/v1/events/{event_id}/history` requests with a valid injected Hyperdrive connection string. No cursor-signing secret is needed by the accepted history projector.
2. Compose `createPublicEventHistoryRepository`, `createPublicEventHistoryDisclosureRepository`, and `createPublicEventHistoryProjectionService` inside one invocation of `withPostgresSqlExecutor` per history request. Construct the SQL-bound readers within that operation callback. Do not duplicate the SQL, disclosure, or projection rules.
3. Decode and validate the event ID and parse the history query before opening a database connection. Keep the OpenAPI query vocabulary (`cursor`, `limit`) and maximum 100. Preserve the documented default page size of 20 by passing an explicit limit to the projection. For live history, accept only the canonical positive decimal version cursor emitted by the accepted projector; do not interpret it as a demo offset or permit an arbitrary opaque value. Reject repeated, unknown, overlong, or malformed parameters with the existing generic 400 envelope before SQL setup. Keep the demo parser/behavior unchanged.
4. Return only the strict existing `HistoryPage`. A missing, non-live, withdrawn, or latest-withdrawn event is `NOT_FOUND`; never fall back to earlier versions. Missing, held, revoked, or incomplete moderator-review coverage and any reader/projection failure return a generic redacted unavailable response; never return partial history or infer a label/summary.
5. Enable only the existing history route in addition to the already accepted live list and detail routes. Keep live GeoJSON, context, and unknown routes unavailable. Preserve all demo and unset-mode fixture behavior, including the current demo page convention.
6. Keep telemetry free of event IDs, raw query values, reviewer IDs, summaries, SQL, connection details, and source content. Tests use fake SQL executors and authored fictional rows only; no network/database/provider call or real review decision is allowed.

## Acceptance criteria

- A configured exact-live history request reads candidate versions and exact-version disclosures through one request-scoped SQL executor operation.
- The current-public reader and strict projector enforce that withdrawn events and their earlier versions remain hidden. Only complete approved moderator-reviewed change labels and summaries appear.
- Invalid IDs and queries, and incomplete configuration, open no SQL connection. Errors stay bounded and redacted.
- Demo responses and the unchanged DTO remain compatible; other live routes keep their existing gates.
- No contract, schema, migration, dependency, provider resource, secret, deployment configuration or live data is added.
- Under WSL Ubuntu-26.04, the focused history-runtime test, API route test, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check` pass. Record exact tool versions and Wrangler output.

## Verification (WSL Ubuntu-26.04 only)

Record Node.js, npm, Git, TypeScript, `pg`, `@types/pg`, PGlite and Wrangler versions. Run the focused history-runtime test separately (the Worker package test script enumerates files), then the API test, full `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`. Use fake SQL executors only; do not connect to Neon/Hyperdrive or provision provider resources.

## Commit and handoff

Implement only on the assigned branch/worktree. Commit implementation/tests and this handoff in coherent descriptive commits, leave the checkout clean, and do not merge or push. Report branch/worktree, exact commit SHAs/messages, changed paths, behavior, actual WSL checks, limitations, configuration impact, and remaining decisions. Root independently reviews and integrates.

## Stop conditions

Stop and report if the accepted readers or projector cannot preserve the hidden-after-withdrawal rule, if missing disclosure cannot be distinguished from complete coverage without changing a contract/schema, or if route composition requires MOD-01 writes/authentication, source rights or deployment configuration. Do not provision resources or expose live rows. Escalate to GPT-6 Astra xhigh only after a GPT-6 Luna Max attempt fails on a substantive technical difficulty.

## Implementation handoff

Append the exact branch/worktree, commits, changed paths, behavior, actual WSL checks, limitations and remaining decisions here. Do not merge or push.
