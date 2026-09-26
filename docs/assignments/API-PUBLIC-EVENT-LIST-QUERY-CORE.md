# API-PUBLIC-EVENT-LIST-QUERY-CORE — parse public event-list query parameters

- **Backlog ID:** `API-PUBLIC-EVENT-LIST-QUERY-CORE`
- **Objective:** Parse the existing `GET /api/v1/events` query vocabulary into a bounded typed request for later route composition.
- **Dependencies:** `API-PUBLIC-EVENT-LIST-CURSOR-CORE`, `API-PUBLIC-EVENT-LIST-FILTERS-CORE`, `API-PUBLIC-EVENT-LIST-PROJECTION-CORE`, `SPEC-03`, `ADR-021`.
- **Requirements:** `FR-09/10`; `NFR-01/07`.
- **Contract boundary:** Preserve the existing OpenAPI parameters, `EventView`, and `EventPage`. This is a pure parsing utility only; do not wire a route or alter demo behavior.
- **Allowed paths:** `apps/worker/src/layers/l4-application-integration/public-event-list-query.ts`; `apps/worker/test/l4-public-event-list-query.test.ts`; this assignment's implementation handoff only.
- **Forbidden scope:** No edit to `api.ts`, route/runtime wiring, cursor encoding/decoding, key provisioning, database/Neon connection, OpenAPI/DTO, demo `PublicReadModel`, migration, dependency, package script, live data, or deployment configuration.
- **Branch/worktree:** Use branch `work/API-PUBLIC-EVENT-LIST-QUERY-CORE` in a dedicated worktree, starting from the root's pushed assignment commit. Do not edit through the root checkout.

## Context to read before editing

Read `AGENTS.md`, `SOFTWARE_DEVELOPMENT_PLAN.md`, `docs/IMPLEMENTATION_BACKLOG.md`, this assignment, [API-01 OpenAPI list contract](../api/openapi.yaml), [UX/API specification](../UX_API_SPEC.md), [ADR-021](../decisions/ADR-021-public-event-list-cursor.md), and the accepted event-list filter, projection and cursor assignments plus their source/tests.

## Required behavior

1. Export a narrow pure parser that accepts `URLSearchParams` and returns `{ limit, cursorToken, filters }`, where `limit` defaults to 20 and `cursorToken` is `null` when absent. `filters` uses the accepted `PublicEventListFilters` type.
2. Support the current OpenAPI list query names only: `cursor`, `limit`, `category`, `lifecycle`, `freshness`, `from`, `to`, `q`, and `place_id`. Reject unknown parameters and duplicate occurrences rather than selecting an ambiguous value.
3. Parse `limit` as a base-10 integer within 1–100; reject blank, non-integer, unsafe, zero, negative, or over-maximum values. Do not bind the page size into the cursor.
4. Preserve a supplied cursor string without decoding it here. Reject a blank cursor or one longer than 2,048 characters. The accepted cursor codec remains responsible for authenticity, expiry and filter binding.
5. Accept only the existing category, lifecycle and freshness enums. Preserve `from` and `to` as supplied strings so the accepted Layer 4 list service and cursor codec remain the semantic RFC-3339/range validators. Trim `q` and `place_id`, omit blank values, lowercase nonblank `q` using the established Indonesian locale, and enforce the existing 120/128-character limits after trimming.
6. Return fixed, bounded parser errors that do not echo raw query values, search terms, or cursor tokens. Do not log request parameters.
7. Tests use synthetic query strings only. Parsing has no database, model, source, key, clock, network, or side effect.

## Acceptance criteria

- Empty queries produce limit 20, no cursor and no effective filters.
- Each supported parameter parses to the intended typed field; dates remain byte-for-byte unchanged; text fields normalize consistently with the accepted filter and cursor services.
- Unknown and duplicate parameters, malformed limits, invalid enums, blank/oversized cursors, and overlong text/place inputs fail with a stable redacted error.
- The parser does not decode cursor contents, call the list service, access a key or change the existing demo route.
- No public contract, runtime configuration, dependency, route or fixture changes.

## Verification (WSL Ubuntu-26.04 only)

Record Node.js, npm, Git, and relevant package versions. Reuse existing dependencies. Run the focused Worker query test directly, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`. The Worker aggregate may not include the focused test; run it directly and report that accurately. Do not access live data, external providers or paid services.

## Commit and handoff

Implement only on the assigned branch/worktree. Commit implementation/tests and this handoff in coherent descriptive commits, leave the checkout clean, and do not merge or push. Report branch/worktree, exact commit SHAs/messages, changed paths, behavior, actual WSL checks, limitations, configuration impact, and remaining decisions. Root independently reviews and integrates.

## Stop conditions

Stop and report if preserving the current query vocabulary requires an OpenAPI/DTO change, if the existing types cannot represent a parsed request without changing accepted service contracts, or if parser validation would diverge from the accepted filter/cursor semantics in a way that could admit an invalid request to a data port. Escalate to GPT-6 Astra xhigh only after a GPT-6 Luna Max attempt fails on a substantive technical difficulty.

## Implementation handoff

Append exact branch/worktree, commit SHAs/messages, changed paths, behavior, actual WSL checks, limitations, configuration impact, and remaining decisions here. Do not merge or push.
