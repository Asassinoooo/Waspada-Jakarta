# API-PUBLIC-EVENT-LIST-PROJECTION-CORE — compose bounded event-list pages

- **Backlog ID:** `API-PUBLIC-EVENT-LIST-PROJECTION-CORE`
- **Objective:** Add a read-only Layer 4 service that composes a bounded current-public candidate page with the existing strict `EventView` projection service.
- **Dependencies:** `API-PUBLIC-EVENT-LIST-CANDIDATE-CORE`, `API-PUBLIC-PROJECTION-SERVICE-CORE`, `API-PROJECT-CORE`, `SPEC-03`, `ADR-012`.
- **Requirements:** `FR-09/10`; `NFR-01/07`.
- **Contract boundary:** Preserve the existing `EventView`/`EventPage` contracts. This internal service returns projected `EventView`s and an internal `PublicEventListCursor`; it does not serialize a public cursor token.
- **Allowed paths:** `apps/worker/src/layers/l4-application-integration/public-event-list-projection-service.ts`; `apps/worker/test/l4-public-event-list-projection-service.test.ts`; this assignment's implementation handoff only.
- **Forbidden scope:** No edits to public DTOs, OpenAPI, demo list behavior, query/filter semantics, HTTP routes, Worker database bindings/connections, database readers/migrations, review/publication writes, source acquisition, real data, paid services, dependencies, package scripts, or runtime configuration.
- **Branch/worktree:** Use branch `work/API-PUBLIC-EVENT-LIST-PROJECTION-CORE` in a dedicated managed worktree. Start from the root's pushed assignment commit; do not edit through the root checkout.

## Context to read before editing

Read `AGENTS.md`, `SOFTWARE_DEVELOPMENT_PLAN.md`, `docs/IMPLEMENTATION_BACKLOG.md`, this assignment, [API-01 OpenAPI list contract](../api/openapi.yaml), [ADR-012](../decisions/ADR-012-public-projection-boundary.md), [API-PROJECT-CORE](API-PROJECT-CORE.md), [API-PUBLIC-PROJECTION-SERVICE-CORE](API-PUBLIC-PROJECTION-SERVICE-CORE.md), [API-PUBLIC-EVENT-LIST-CANDIDATE-CORE](API-PUBLIC-EVENT-LIST-CANDIDATE-CORE.md), and the corresponding source/tests.

## Required behavior

1. Define narrow injected ports for the accepted candidate repository and the existing `PublicEventProjectionService`; do not create a database connection or import Worker runtime code.
2. Accept only a closed page request with optional `limit` (default 20, maximum 100) and optional exact `{ firstPublishedAt, eventId }` cursor. Validate the complete request before calling either port.
3. Treat candidate pages as internal untrusted results. Validate the exact page/candidate/cursor envelopes, bounded candidate count, unique IDs, descending initial-publication ordering with ascending ID ties, and cursor continuation. Require a non-null next cursor to match the last returned candidate and to accompany a full candidate page.
4. Project each candidate by its event ID through the existing strict `PublicEventProjectionService`. Limit concurrent projector calls to four. Preserve candidate order in the result. If a candidate disappeared between reads, omit that item but preserve the candidate reader's continuation cursor so paging advances. Accept a newly projected version only when its event ID matches and version is at least the candidate version; current content may advance while the immutable first-publication cursor remains stable.
5. Return only `{ events: EventView[], nextCursor: PublicEventListCursor | null }`. Never copy candidate `recordJson`, reader diagnostics, or arbitrary projector fields into the result. Fail the whole page with stable redacted errors on invalid candidate pages, mismatched projector identity/version, or port failures; do not return partial pages after a port error.
6. This is not a historical snapshot. It does not filter the page, parse URL query parameters, encode/expire public cursor tokens, or change the demo `EventPage`. Those are later API-01 work and must preserve the existing OpenAPI vocabulary and `PageInfo` contract.
7. Tests use authored fictional records and injected ports only. They do not establish source rights, publication truth, hosted Neon behavior, or a public HTTP route.

## Acceptance criteria

- Request and injected candidate-page validation are closed, bounded and fail before projection calls when invalid.
- Candidate ordering/cursor are preserved; duplicate, out-of-order, oversized, mismatched or malformed pages fail with redacted errors.
- Projected items pass through the existing Layer 4 EventView service, maintain candidate order, reject mismatched IDs or older versions, and omit newly withdrawn/missing items without losing cursor progress.
- Projector fan-out never exceeds four concurrent calls; any provider-port error fails closed with a stable message.
- Candidate record JSON and unknown fields never appear in output; no public contract, filter behavior, route, runtime binding, migration, dependency or configuration changes.
- Focused tests cover valid pages, empty/end pages, missing-after-candidate behavior, newer versions, order and cursor preservation, concurrency bound, invalid inputs/results, and redacted failures.

## Verification (WSL Ubuntu-26.04 only)

Record `node --version`, `npm --version`, `git --version`, and relevant package versions. Reuse existing dependencies. Run the focused test directly, then `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`. Report actual results only; hosted Neon behavior is outside verification.

## Commit and handoff

Implement only on the assigned branch/worktree. Commit implementation/tests and this handoff in coherent descriptive commits; leave the checkout clean and do not merge or push. Report branch/worktree, exact commit SHAs/messages, changed paths, behavior, actual WSL checks, limitations, migration/configuration impact, and remaining decisions. Root independently reviews and integrates.

## Implementation handoff

Append exact branch/worktree, commit SHAs/messages, changed paths, behavior, actual WSL checks, limitations, migration/configuration impact, and remaining decisions here. Do not merge or push.
