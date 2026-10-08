# UI-API-UPDATE-CENTER-CLIENT-COMPOSITION-CORE — compose the update poller with its HTTP clients

- **Status:** Assigned as a test-only client-composition slice.
- **Backlog ID:** `UI-API-UPDATE-CENTER-CLIENT-COMPOSITION-CORE`
- **Objective:** Prove the existing browser update-centre poller uses the default HTTP clients correctly for an authored correction and cursor expiry, without injecting replacement request functions.
- **Dependencies:** `UI-02-UPDATE-CENTER-CORE`, `API-PUBLIC-UPDATES-RUNTIME-CORE`, and root acceptance of `API-01-PUBLICATION-UPDATE-FEED-PGLITE-CORE`; ADR-026.
- **Requirements:** US-02; FR-11; NFR-01/03/07.
- **Contract baseline:** Existing `PublicUpdatePage`, `HistoryEntry`, and current-public `EventDetail` client contracts. No contract, route, DTO, OpenAPI, backend, database, preference-storage, or production UI changes.
- **Branch/worktree:** Use branch `work/UI-API-UPDATE-CENTER-CLIENT-COMPOSITION-CORE` in `.codex-build/worktrees/ui-api-update-center-client-composition-core`, based on the pushed assignment commit. Root records the exact base in the dispatch. Do not edit through the root checkout.
- **Model:** GPT-6 Luna, max reasoning.

## Read before editing

Read `AGENTS.md`, `SOFTWARE_DEVELOPMENT_PLAN.md`, `docs/IMPLEMENTATION_BACKLOG.md`, this assignment, [ADR-026](../decisions/ADR-026-public-update-feed-cursor.md), [UI-02](UI-02-UPDATE-CENTER-CORE.md), the [update-centre poller and component](../../apps/web/src/UpdatesCenter.tsx), the [HTTP API clients](../../apps/web/src/api-client.ts), and [existing update-centre tests](../../apps/web/test/updates-center.test.tsx). Confirm the default-client seams, request paths/query fields, page contract, cursor persistence timing, and existing 410 unit coverage before editing.

## Required behavior

1. Add one focused composition case to `apps/web/test/updates-center.test.tsx`; construct `createUpdateCenterPoller` without injected `getUpdates` or `getDetail`, so the default `getPublicUpdates` and `getEventDetailWithSignal` clients run.
2. Replace `globalThis.fetch` only for the test, restore it with the test cleanup hook, and make the fixture reject every unexpected route. Use authored fictional response objects and no real network, browser, Worker, database, source, provider, or model.
3. Start with empty local cursor storage. Return an empty no-cursor baseline page, then an authored `corrected` update page and a matching current-public detail response through their actual client routes. Verify the poller exposes the matched correction only after detail validation and advances the stored opaque cursor only after hydration. During the detail request, assert the previous baseline cursor is still stored; then render the resulting state with `UpdateCenterContent` and confirm the authored change summary and fetched current-event title reach the card.
4. Confirm the requests contain only the documented cursor/limit query parameters and no locally stored interests in URLs, headers, or request bodies. Storage contains only the existing opaque cursor key; no local interest, update, detail, match, or checked-at value is persisted.
5. On the next refresh, return HTTP 410 for the exact stored cursor. Verify the real API client error reaches the poller and the recorded order is expired-cursor request, no-cursor baseline, current-event snapshot refresh through existing `listEvents()`/`GET /api/v1/events`, then request using the rebased cursor. Verify previously displayed items are cleared, the reset notice remains true, and its existing neutral copy renders after recovery.
6. Keep the existing public DTOs, route behavior, preference rules, and UI unchanged. Do not duplicate the API-client parser tests or the poller's existing injected-client tests for page budgets, generic hydration failure, or 410 state ordering beyond what is needed to prove the real-client composition.

## Allowed paths

- `apps/web/test/updates-center.test.tsx`
- `docs/assignments/UI-API-UPDATE-CENTER-CLIENT-COMPOSITION-CORE.md` (implementation handoff section only)

No production code, API client implementation, route, contract, DTO, OpenAPI, database, dependency, configuration, source, deployment, or user-interactive browser change is authorized.

## Acceptance and verification

- The test uses the poller's default HTTP clients and strict authored fetch fixtures to cover a baseline, one correction with current-detail hydration, and a real-client 410 re-baseline flow, including the existing current-event list client. It proves request ordering, local-interest privacy, cursor commit after hydration, rendered correction data, and cleared display state plus the reset notice on rebase.
- Run checks in WSL Ubuntu-26.04 with installed dependencies: `npm exec --workspace=@waspada/web -- tsx --test test/updates-center.test.tsx`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD`. Record WSL, Node, npm, and actual outcomes. Do not install dependencies or use interactive browser tooling.
- Commit the test and handoff on this task branch in coherent descriptive commits, leave the worktree clean, and do not merge or push. Root independently reviews and integrates accepted work.

Stop and report if the actual default clients cannot be composed using the existing fetch seam without production, contract, or dependency changes. Escalate to GPT-6 Astra xhigh only after a GPT-6 Luna Max attempt fails on a substantive technical difficulty.

## Implementation handoff

Append the branch/worktree, exact assigned base, commit SHAs/messages, changed paths, behavior, actual WSL checks, runtime versions, limitations, configuration impact, and remaining decisions here. Do not merge or push.
