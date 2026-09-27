# API-PUBLIC-UPDATES-RUNTIME-CORE — exact-live update-feed route

- **Status:** Assigned
- **Backlog ID:** `API-PUBLIC-UPDATES-RUNTIME-CORE`
- **Objective:** Wire `GET /api/v1/updates` to the accepted bounded update reader and Layer 4 projection service in exact live mode, preserving the existing `UpdatePage` and error-envelope contracts.
- **Dependencies:** `API-PUBLIC-UPDATES-PROJECTION-CORE`, `API-PUBLIC-UPDATES-READER-CORE`, `API-PUBLIC-EVENT-LIST-RUNTIME-CORE`, `API-DETAIL-HISTORY-ROUTES-CORE`, `DB-HYPERDRIVE-SQL-EXECUTOR-CORE`, `ADR-021`, `ADR-022`, `ADR-026`.
- **Requirements:** `FR-10/11/13`; `NFR-01/04/05/07/08`.
- **Contract boundary:** Keep OpenAPI, `HistoryEntry`, `UpdatePage`, cursor payload and existing API error envelope unchanged. No update-feed behavior is enabled for synthetic/demo data.
- **Allowed paths:** `apps/worker/src/index.ts`; `apps/worker/src/layers/l4-application-integration/api.ts`; new `apps/worker/src/runtime/public-event-updates-runtime.ts`; `apps/worker/test/api.test.ts`; new `apps/worker/test/public-event-updates-runtime.test.ts`; `apps/worker/package.json` (test script only); and this assignment's implementation handoff only.
- **Forbidden scope:** No API/OpenAPI/DTO change, DB SQL/repository/view/schema/migration/grant change, UI or browser polling, user-interest matching, source acquisition, agent/model invocation, moderation/publication writes, production key or new secret, Hyperdrive binding ID/provider resource, live connection/record, Wrangler deployment edit, paid service, dependency, or unrelated path.
- **Branch/worktree:** Use branch `work/API-PUBLIC-UPDATES-RUNTIME-CORE` in a dedicated managed worktree based on the pushed assignment commit. Do not edit through the root checkout.
- **Configuration:** Reuse `HYPERDRIVE.connectionString` and the existing `PUBLIC_EVENT_LIST_CURSOR_HMAC_KEY_HEX`. The key must be exactly 64 hex characters and imported as a non-extractable HMAC-SHA-256 key for signing and verification. Do not generate, persist, log, or commit a production key. The checked-in Worker remains `DATASET_MODE="demo"`.

## Context to read before editing

Read `AGENTS.md`, `SOFTWARE_DEVELOPMENT_PLAN.md`, `docs/IMPLEMENTATION_BACKLOG.md`, this assignment, [ADR-021](../decisions/ADR-021-public-event-list-cursor.md), [ADR-022](../decisions/ADR-022-worker-postgres-driver.md), [ADR-026](../decisions/ADR-026-public-update-feed-cursor.md), the existing [OpenAPI update operation](../api/openapi.yaml), `apps/worker/src/layers/l4-application-integration/api.ts`, `apps/worker/src/index.ts`, the accepted [update reader](../../apps/db/src/public-event-updates.ts), [update service](../../apps/worker/src/layers/l4-application-integration/public-event-updates-service.ts), [cursor codec](../../apps/worker/src/layers/l4-application-integration/public-event-updates-cursor.ts), [PostgreSQL executor](../../apps/db/src/postgres-sql-executor.ts), and [repeatable-read runtime pattern](../../apps/worker/src/runtime/public-briefing-runtime.ts). Confirm current route gates, `UpdatePage` and error shapes, key validation/import behavior, query bounds, repository methods, and transaction cleanup patterns before coding.

## Required behavior

1. Build the database-backed updates runtime only for exact `DATASET_MODE="live"`, a valid injected Hyperdrive-compatible connection string, and the existing 64-character list-cursor HMAC secret. Reuse the existing connection-string validator and key name. Invalid or missing configuration fails closed without constructing or connecting a database client.
2. Enable only exact `GET /api/v1/updates` in live mode. Preserve all existing route behavior. In unset/demo mode, updates remain unavailable and never fall back to synthetic history. Unsupported dataset modes remain gated. Other HTTP methods keep the existing read-only method response.
3. Accept only the documented `cursor` and `limit` query names. Reject unknown or repeated parameters, an empty/over-2,048-character cursor, and a noncanonical or out-of-range limit before opening SQL. The limit defaults to 20 and is bounded from 1 through 100. Use authored deterministic tests for the parser.
4. Before opening SQL, verify a supplied cursor with the accepted domain-separated cursor codec so malformed, tampered, wrong-scope, or expired values never open a connection. Map malformed input/token to the existing fixed `INVALID_REQUEST` 400 envelope and an expired cursor to `CURSOR_RESTART_REQUIRED` HTTP 410. The accepted service may validate the token again during composition; do not change its contract or duplicate its signature implementation.
5. For a valid request, compose `createPublicEventUpdatesRepository` and `createPublicEventUpdatesService` inside one invocation of the request-scoped `withPostgresSqlExecutor`. Within that same executor callback run `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, read the watermark and any candidates through the same repository/executor snapshot, then commit on success. Roll back on any read, service, commit, or response-projection failure; cleanup failures must remain generic. An ahead-of-watermark cursor maps to HTTP 410 and never reads candidate rows. Do not return partial items.
6. Return the unchanged `UpdatePage` from the strict Layer 4 service. Map typed service/runtime errors to fixed responses: invalid request to 400, cursor restart to 410, and unexpected read/configuration failures to the existing generic unavailable error response. Never include the raw token, query string, sequence, SQL, candidate data, summary, reviewer identity, connection string, or crypto details in responses or telemetry.
7. Keep the feed read-only and outside L3. The database reader remains authoritative for latest-approved/current-public filtering. Preserve the user's rule that withdrawn versions and every version of a latest-withdrawn event stay hidden; do not create withdrawal tombstones. No polling, relevance matching, source call, model inference, publication action, or new provider is part of this slice.
8. Use only fake SQL executor/client ports, ephemeral test HMAC keys, and authored fictional rows. No network, hosted database, provider, real source, real moderator decision, or production credential is permitted.

## Acceptance criteria

- A valid exact-live request reads its watermark and bounded candidate page inside one request-scoped repeatable-read, read-only SQL transaction and returns only the exact `UpdatePage` shape.
- Omitted cursor returns an empty bootstrap page. Normal cursors continue according to the accepted service. Expired and ahead-of-watermark cursors return HTTP 410; malformed, tampered, noncanonical, wrong-scope, oversized, duplicate, repeated, or unknown query values return bounded 400 responses.
- Malformed input, malformed/expired cursor, incomplete configuration, and non-live mode never open a SQL connection. Ahead-of-watermark responses do not read candidates; they roll back the read-only transaction safely.
- Database, crypto, transaction and reader/projection failures return only the generic unavailable envelope; the route never returns a partial page or synthetic fallback.
- Latest-withdrawn events and all their history stay hidden even if a reviewed summary exists for an earlier version. No withdrawal item is synthesized.
- Existing routes, OpenAPI, DTOs, DB migrations/grants, package dependencies, deployment config and checked-in demo mode are unchanged.

## Verification (WSL Ubuntu-26.04 only)

Use the already available Linux Node runtime and existing workspace dependencies; do not install packages. Record Node.js, npm, Git, TypeScript, `pg`, `@types/pg`, PGlite, tsx, Vite and Wrangler versions. Run the focused runtime test and API test separately, followed by `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`. The fake executor must assert transaction boundaries and that invalid queries/tokens make zero client calls. Report actual output; do not claim hosted Neon/Cloudflare behavior.

## Commit and handoff

Implement only on the assigned branch/worktree. Commit implementation/tests and this handoff in coherent descriptive commits, leave the checkout clean, and do not merge or push. Report branch/worktree, exact commit SHAs/messages, changed paths, behavior, actual WSL checks, limitations, configuration impact, and remaining decisions. Root independently reviews and integrates.

## Stop conditions

Stop and report if exact-live route composition cannot preserve the existing response/error envelope, if query/token validation cannot happen before connection setup, if watermark and candidates cannot share one repeatable-read snapshot through the existing SQL executor, or if any change to a contract, schema, secret/binding configuration, provider resource, or source/data right would be needed. Do not provision resources or expose live rows. Escalate to GPT-6 Astra xhigh only after a GPT-6 Luna Max attempt fails on a substantive technical difficulty.

## Implementation handoff

Append the exact branch/worktree, commit SHA(s) and messages, changed paths, behavior, actual WSL checks/results, runtime versions, limitations, configuration impact, and remaining decisions here. Do not merge or push.
