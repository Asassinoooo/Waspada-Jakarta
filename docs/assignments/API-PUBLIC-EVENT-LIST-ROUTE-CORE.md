# API-PUBLIC-EVENT-LIST-ROUTE-CORE — route the injected event-list page service

- **Backlog ID:** `API-PUBLIC-EVENT-LIST-ROUTE-CORE`
- **Objective:** Connect the accepted `PublicEventListPageService` to the existing read-only `GET /api/v1/events` handler through explicit dependency injection, retaining the synthetic demo reader as the default when no service is supplied.
- **Dependencies:** `API-PUBLIC-EVENT-LIST-PAGE-CORE`, `API-DETAIL-HISTORY-ROUTES-CORE`, `SPEC-03`, `ADR-021`.
- **Requirements:** `FR-09/10`; `NFR-01/07`.
- **Contract boundary:** Keep the existing `EventPage`, `ApiError`, status/error behavior and OpenAPI schemas. This is an application route adapter only; it does not configure or activate a live dataset.
- **Allowed paths:** `apps/worker/src/layers/l4-application-integration/api.ts`; `apps/worker/test/api.test.ts`; this assignment's implementation handoff only.
- **Forbidden scope:** No edit to `apps/worker/src/index.ts` or `WorkerEnvironment`; no database connection/adapter, production cursor key, secret binding, migration, OpenAPI/DTO, demo fixture, dependency, package script, deployment configuration, source acquisition, live data or paid provider.
- **Branch/worktree:** Use branch `work/API-PUBLIC-EVENT-LIST-ROUTE-CORE` in the prepared managed worktree `C:\Users\perry\.codex\worktrees\api-geojson-route-core\RPL` (WSL: `/mnt/c/Users/perry/.codex/worktrees/api-geojson-route-core/RPL`), starting from the root's pushed assignment commit. Do not edit through the root checkout.

## Context to read before editing

Read `AGENTS.md`, `SOFTWARE_DEVELOPMENT_PLAN.md`, `docs/IMPLEMENTATION_BACKLOG.md`, this assignment, [OpenAPI](../api/openapi.yaml), [UX/API specification](../UX_API_SPEC.md), [ADR-021](../decisions/ADR-021-public-event-list-cursor.md), the accepted [page service](../../apps/worker/src/layers/l4-application-integration/public-event-list-page-service.ts) and its tests, and the existing API handler/tests.

## Required behavior

1. Add an optional, explicitly injected route dependency to `handlePublicApiRequest` for a `PublicEventListPageService`. Keep existing call sites source-compatible and leave `WorkerEnvironment` unchanged.
2. On a successful `GET /api/v1/events`, call the injected service with the request's `URLSearchParams` and return its `EventPage` through the existing JSON response helper. Do not mutate, widen, or reinterpret the page response.
3. When no page service is injected, preserve the current synthetic `PublicReadModel.events` behavior byte-for-byte, including the offset cursor, demo filtering, and existing headers.
4. Map `PublicEventListPageServiceError` with code `INVALID_REQUEST` to the existing `400 INVALID_REQUEST` API error envelope and a fixed safe message. Map its internal read-failure code to the existing generic `TEMPORARILY_UNAVAILABLE` failure response without exposing service, query, cursor, SQL, key, source, or exception details.
5. Preserve method checks, the `DATASET_MODE` gate, generic handling for unrelated exceptions, no-store/nosniff response headers, and privacy-safe request telemetry. No service injection may bypass the current non-demo runtime gate.
6. Tests use synthetic `EventPage` values and fake injected services. Prove injected success forwards query values and returns the exact public envelope, both typed errors are mapped and redacted, unrelated exceptions stay generic, demo mode without the injection retains its existing behavior, and request telemetry remains bounded.

## Acceptance criteria

- An injected service handles only the existing list route and is invoked once with the route's search parameters.
- Response JSON has exactly the existing `EventPage` shape and response headers remain unchanged.
- Invalid service requests produce HTTP 400 and `INVALID_REQUEST`; internal service failures use the existing generic temporary-failure body/status.
- Error responses never include raw query values, cursor tokens, service exception text, key material, database details, or source content.
- Omitting the dependency leaves the current synthetic demo response unchanged; a non-demo `DATASET_MODE` continues to return unavailable before the injected service is called.
- No new Worker binding, key, database adapter, route, contract, dependency, migration, fixture or deployment configuration is added.

## Verification (WSL Ubuntu-26.04)

Record Node.js, npm, Git and relevant package versions. Reuse the existing WSL dependencies. Run the API route test directly if needed, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`. The route tests are included in the Worker aggregate; report them as such. Do not use live data, provider services or paid APIs.

## Commit and handoff

Implement only on the assigned branch/worktree. Commit implementation/tests and this handoff in coherent descriptive commits, leave the checkout clean, and do not merge or push. Report branch/worktree, exact commit SHAs/messages, changed paths, behavior, actual WSL checks, limitations, configuration impact, and remaining decisions. Root independently reviews and integrates.

## Stop conditions

Stop and report if typed service failures cannot be mapped without changing the public error contract, if default demo behavior cannot be preserved, or if injection would require a Worker binding or database/runtime setup. Escalate to GPT-6 Astra xhigh only after a GPT-6 Luna Max attempt fails on a substantive technical difficulty.

## Implementation handoff

Append exact branch/worktree, commit SHAs/messages, changed paths, behavior, actual WSL checks, limitations, configuration impact, and remaining decisions here. Do not merge or push.
