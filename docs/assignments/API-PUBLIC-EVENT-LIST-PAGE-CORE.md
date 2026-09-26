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

### Implementer handoff — 27 September 2026

- **Branch/worktree:** `work/API-PUBLIC-EVENT-LIST-PAGE-CORE`; WSL path `/mnt/c/Users/perry/.codex/worktrees/api-geojson-route-core/RPL` (Windows path `C:\Users\perry\.codex\worktrees\api-geojson-route-core\RPL`), based on assignment commit `5b47654f2bd6211b3f7a939d5f998ec8319cefa5`.
- **Implementation commit:** `325d8cca8b6bb0b22bf72bc1328e07a143b75540` — `feat(API-PUBLIC-EVENT-LIST-PAGE-CORE): compose cursor-backed EventPage`.
- **Changed paths:** `apps/worker/src/layers/l4-application-integration/public-event-list-page-service.ts`; `apps/worker/test/l4-public-event-list-page-service.test.ts`; this assignment handoff.
- **Behavior:** Added an injected Layer 4 `EventPage` service over `URLSearchParams`, the accepted list projection and cursor codec. Parser and cursor-decode errors map to one redacted `INVALID_REQUEST` service error before any list read. The service passes the parsed limit and typed filters, plus only the decoded internal keyset when continuing; it never forwards the opaque public cursor. Projection and cursor-issue failures map to the distinct redacted `PUBLIC_EVENT_LIST_READ_FAILED` error. A projection without a next keyset returns both cursor fields as `null`; otherwise the service issues a token bound to the same filters and copies the codec's exact expiry into `cursor_expires_at`. The response is constructed with only the existing `data` and `page` fields.
- **WSL tools/packages:** Ubuntu-26.04; Node.js `v24.21.0`, npm `11.19.0`, Git `2.53.0`; TypeScript `7.0.2`, tsx `4.23.15`, Vite `8.3.0`, Wrangler `4.137.0`. Existing dependencies were reused through a temporary symlink to `/mnt/d/Projects/RPL/node_modules`; the symlink was removed before handoff.
- **Checks:** Direct focused command `node --import /mnt/d/Projects/RPL/node_modules/tsx/dist/loader.mjs --test apps/worker/test/l4-public-event-list-page-service.test.ts` under the explicit WSL Node `v24.21.0` path — exit 0, 5/5. `npm test` — exit 0 (web 22/22, Worker 183/183, DB 16/16 files, evaluation 12/12); the new focused page-service file is not in the Worker aggregate and was run separately. `npm run typecheck` — exit 0. `npm run build` — exit 0, including Vite production build and Wrangler dry-run. `git diff --check` and staged diff checks — exit 0.
- **Limitations:** Tests use generated in-memory HMAC keys, deterministic time, synthetic `EventView`s and injected fake list projections. No live data, deployed Worker, route/runtime composition, production key, database connection, or hosted service was exercised.
- **Migration/configuration impact:** None. No route, OpenAPI/DTO, Worker binding, database adapter, migration, dependency, package script, production key, or deployment setting changed.
- **Remaining decisions:** None within this assigned slice. Root review and integration remain outstanding.
