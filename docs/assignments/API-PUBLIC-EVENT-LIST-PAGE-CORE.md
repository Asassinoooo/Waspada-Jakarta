# API-PUBLIC-EVENT-LIST-PAGE-CORE — compose a published event-list page

- **Backlog ID:** `API-PUBLIC-EVENT-LIST-PAGE-CORE`
- **Objective:** Compose the accepted query parser, cursor codec and current-public list projection into the unchanged public `EventPage` response.
- **Dependencies:** `API-PUBLIC-EVENT-LIST-QUERY-CORE`, `API-PUBLIC-EVENT-LIST-CURSOR-CORE`, `API-PUBLIC-EVENT-LIST-FILTERS-CORE`, `API-PUBLIC-EVENT-LIST-PROJECTION-CORE`, `API-PROJECT-CORE`, `SPEC-03`, `ADR-021`.
- **Requirements:** `FR-09/10`; `NFR-01/07`.
- **Contract boundary:** Preserve the existing `EventPage`, `EventView`, OpenAPI and error response schemas. This is an injected Layer 4 service only; do not modify or wire the Worker HTTP route.
- **Allowed paths:** `apps/worker/src/layers/l4-application-integration/public-event-list-page-service.ts`; `apps/worker/test/l4-public-event-list-page-service.test.ts`; this assignment's implementation handoff only.
- **Forbidden scope:** No edit to `api.ts` or `WorkerEnvironment`; no production secret/key provisioning, database connection/adapter, migration, contract/DTO, demo reader, dependency, package script, deployment configuration, source acquisition, live data or paid provider.
- **Branch/worktree:** Use branch `work/API-PUBLIC-EVENT-LIST-PAGE-CORE` in a dedicated worktree, starting from the root's pushed assignment commit. Do not edit through the root checkout.

## Context to read before editing

Read `AGENTS.md`, `SOFTWARE_DEVELOPMENT_PLAN.md`, `docs/IMPLEMENTATION_BACKLOG.md`, this assignment, [OpenAPI list contract](../api/openapi.yaml), [UX/API specification](../UX_API_SPEC.md), [ADR-021](../decisions/ADR-021-public-event-list-cursor.md), and the accepted list query, cursor, filter and projection code, tests and assignments.

## Required behavior

1. Define an injected Layer 4 page service that accepts `URLSearchParams`, the existing `PublicEventListProjectionService`, and the injected `PublicEventListCursorCodec`. Do not access environment bindings, secrets, storage or network directly.
2. Parse the query with `parsePublicEventListQuery`. If an opaque cursor token is present, decode and verify it against the parsed filters before calling the list projection. Invalid, expired or filter-mismatched cursors never reach the list service.
3. Call the projection with the parsed page size, typed filters, and decoded internal cursor when present. Do not pass the opaque public token into the internal DB/list service.
4. Return only the existing `EventPage` shape: `data` contains the projected `EventView`s; when the projection has no internal `nextCursor`, return `page.next_cursor = null` and `page.cursor_expires_at = null`; otherwise issue a signed cursor bound to the same filters and use its exact expiry value.
5. A valid page-size change between requests does not invalidate a cursor; filter changes remain rejected by the codec. Preserve the accepted filter, event-projection, publication, withdrawal and geometry rules; do not infer safety, freshness, relevance or geometry.
6. Map parser and cursor-decode failures to one stable redacted `INVALID_REQUEST` service error. Map projection failures and cursor-issue failures to a distinct stable redacted internal read error. Never echo raw query values, cursor strings, keys, event IDs, model/source content or underlying exception messages.
7. Tests use generated in-memory Web Crypto keys, deterministic clocks, synthetic EventViews and fake list projections. Prove decode-before-read, filter binding, page-size flexibility, page/expiry null behavior, exact response allowlist, stable redacted errors, and no calls after invalid input. No real key or DB is configured.

## Acceptance criteria

- A first-page request reaches the list service without an internal cursor and yields the exact `EventPage` envelope.
- A continuation request decodes its cursor first and passes only the internal keyset plus parsed filters/page size to the projection service.
- A changed effective filter, malformed token, or expired cursor returns `INVALID_REQUEST` without a list-service call; a page-size-only change continues successfully.
- A returned internal keyset becomes an authenticated opaque token with the exact `cursor_expires_at`; no keyset becomes null cursor and null expiry.
- Projection/cursor-issue errors use a bounded non-sensitive internal failure code/message; underlying details do not leak.
- No OpenAPI/DTO, HTTP route, Worker binding, DB adapter, dependency, runtime secret, or demo behavior changes.

## Verification (WSL Ubuntu-26.04 only)

Record Node.js, npm, Git and relevant package versions. Reuse existing dependencies. Run the focused Worker page-service test directly, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`. The Worker aggregate may not include the focused file; run it directly and report that accurately. Do not access live data, provider services or paid APIs.

## Commit and handoff

Implement only on the assigned branch/worktree. Commit implementation/tests and this handoff in coherent descriptive commits, leave the checkout clean, and do not merge or push. Report branch/worktree, exact commit SHAs/messages, changed paths, behavior, actual WSL checks, limitations, configuration impact, and remaining decisions. Root independently reviews and integrates.

## Stop conditions

Stop and report if the existing response contract cannot be represented without a DTO change, if cursor errors cannot be kept separate from internal failures, or if list/cursor ports cannot be injected without touching runtime wiring. Escalate to GPT-6 Astra xhigh only after a GPT-6 Luna Max attempt fails on a substantive technical difficulty.

## Implementation handoff

Append exact branch/worktree, commit SHAs/messages, changed paths, behavior, actual WSL checks, limitations, configuration impact, and remaining decisions here. Do not merge or push.
