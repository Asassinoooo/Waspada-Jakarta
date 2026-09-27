# UI-02-UPDATE-CENTER-CORE — user-controlled browser update centre

- **Status:** Assigned
- **Backlog ID:** `UI-02-UPDATE-CENTER-CORE`
- **Objective:** Add an accessible browser update centre that presents current-public, moderator-reviewed event changes matching locally stored user interests, using the accepted exact-live updates and event-detail endpoints.
- **Dependencies:** `API-PUBLIC-UPDATES-RUNTIME-CORE`, `UI-02-BRIEFING-UI-CORE`, `UI-02-LOCAL-PREFERENCES-CORE`, `UI-01`, `SPEC-03`, `ADR-026`.
- **Requirements:** `US-02`; `FR-11`; `NFR-03/07/08`.
- **Contract boundary:** Use the existing `GET /api/v1/updates` `UpdatePage` (`items`, `next_cursor`, `cursor_expires_at`, `checked_at`) and existing current-public event detail response. Do not change OpenAPI, DTOs, routes, Worker behavior, database contracts, or the briefing request contract.
- **Allowed paths:** `apps/web/src/App.tsx`; `apps/web/src/api-client.ts`; `apps/web/src/Preferences.tsx` only if needed to link to the centre; new `apps/web/src/UpdatesCenter.tsx`; `apps/web/src/styles.css`; `apps/web/test/api-client.test.ts`; `apps/web/test/ui.test.tsx`; new `apps/web/test/updates-center.test.tsx`; `apps/web/package.json` (test script only); and this assignment's implementation handoff only.
- **Forbidden scope:** No API/OpenAPI/DTO or backend change, new dependency, server-side storage of interests, persisted update history/items, push notifications, location/geofencing, AI inference, relevance requests, source acquisition, live fixture, browser automation using the user's interactive computer, paid service, or deployment/provider change.
- **Branch/worktree:** Use branch `work/UI-02-UPDATE-CENTER-CORE` in a dedicated managed worktree based on the pushed assignment commit. Do not edit through the root checkout.
- **Data handling:** Synthetic data is visibly labelled. The checked-in Worker remains demo-only, so the centre must be unavailable in demo/unknown mode and must never use fixtures as live updates. Store only the opaque updates cursor in browser storage; update items, hydrated details, match reasons, and checked-at values remain in memory.

## Context to read before editing

Read `AGENTS.md`, `SOFTWARE_DEVELOPMENT_PLAN.md`, `docs/IMPLEMENTATION_BACKLOG.md`, this assignment, [ADR-026](../decisions/ADR-026-public-update-feed-cursor.md), the [updates OpenAPI operation](../api/openapi.yaml), [public API contracts](../../apps/worker/src/contracts/public-api.ts), the accepted [preferences store](../../apps/web/src/preferences-store.ts), [briefing component](../../apps/web/src/BriefingResults.tsx), [API client](../../apps/web/src/api-client.ts), application route/shell, current detail/history UI, and the existing web test patterns. Confirm exact `UpdatePage`, `HistoryEntry`, `EventDetail` fields, local-interest normalization, route lifecycle, and available test dependencies before coding.

## Required behavior

1. Add a directly navigable `Pembaruan` view to the existing application shell. Run it only when the server-provided context is exactly `live`, the user has readable non-empty local interests, and the document is visible. Demo, unknown, empty-interest, malformed-preference, and unavailable-storage states make no update/detail requests and explain the next action in Bahasa Indonesia.
2. Add a strict, bounded browser client for `GET /api/v1/updates`. Request pages with `limit=20`; send only `cursor` and `limit`. Validate closed response shapes, cursor bounds and timestamps before using data. Preserve HTTP status for an explicit 410 reset path, while rendering other failures with fixed, non-sensitive user copy.
3. Read interests only from the existing browser-local preference store. Never include interests in polling requests, query strings, telemetry, cursor storage, or server persistence. Match current event `category` exactly and text interests against event, claim, and impact scope names using the existing NFC/trimmed Indonesian case-insensitive exact-match semantics. Do not use fuzzy matching, tags, title text, AI, or inferred geography.
4. For each unique `event_id` in a page, fetch the existing current-public detail endpoint with no more than four concurrent requests. Validate every field used for matching/display: event ID/version, category, lifecycle, freshness, event time, publication time, and event/claim/impact scope objects; reject malformed payloads. Do not display an update unless its current event detail was fetched and validated. A 404 is a resolved unavailable-current event and is safely omitted; network, 5xx, or malformed-payload failures leave that page's cursor unadvanced for retry. Do not partially commit a page.
5. Keep event identity/version history separate from current event status. Deduplicate displayed items in memory by `(event_id, version)`. Show the reviewed change label and summary, the changed/publication time from `changed_at`, the current event category/lifecycle/freshness and event time from the fetched detail, and the server `checked_at` separately. Link to the existing current detail/evidence and history screen. Do not assert a withdrawn version or its history; the accepted API hides all history for latest-withdrawn events.
6. On first use with no valid stored cursor, call the updates endpoint without a cursor to establish the current baseline; do not replay pre-baseline history. Persist only the returned opaque `next_cursor`, and persist it only after a whole page has been hydrated and processed successfully. Do not store items, detail payloads, local interests, or an update list in browser storage.
7. Poll no more often than every 60 seconds while the update view is active and `document.visibilityState` is `visible`. Stop the timer and start no new request while hidden or when the route is inactive. A refresh cycle may request no more than five consecutive pages of 20; if the fifth is full, continue from its cursor on the next cycle. Show a manual refresh control and a visible Jakarta-local last-check time. Ignore stale responses after route, context, preference, or visibility changes.
8. On HTTP 410, discard the stored cursor and in-memory items, establish a new baseline without a cursor, refresh the first bounded current-event page through the existing public list endpoint, then resume polling. Show a neutral message that older update summaries are unavailable after re-basing. Do not invent a replacement retraction, restore lost history, or imply that the current area is safe.
9. Provide clear initial loading, baseline, matching-results, no-matching-updates, unavailable, partial-detail-retry, and cursor-reset states. Use labels and text in addition to color; keep lifecycle, freshness, evidence access, update time, system check time, and local relevance distinct. Keep the feed useful without the map and do not imply live sources are configured merely because mode is `live`.
10. No screenshots or checks may use the user's interactive computer. Use existing headless browser tooling only if it is already present in WSL; do not install anything to enable visual review.

## Acceptance criteria

- The update centre is reachable by direct hash navigation and stops polling as soon as it becomes inactive or hidden.
- Demo, unknown, empty, malformed, or inaccessible local-interest states generate zero updates and event-detail calls; live requests contain no interest fields.
- Cursor bootstrap, 20-item paging, five-page refresh budget, event-ID hydration concurrency limit 4, exact category/scope matching, `(event_id, version)` deduplication, and checked-at handling are covered by deterministic tests.
- A transient or malformed detail hydration does not expose a partial page or advance its cursor; a confirmed 404 detail is omitted; a successful page stores only its continuation cursor.
- HTTP 410 clears cursor and in-memory history, establishes a no-cursor baseline, refreshes the existing bounded current event list, then allows polling to resume. The reset state is neutral and says older update summaries are unavailable.
- View clearly separates reviewed update content/time from current event lifecycle/freshness/event time and from system check time; detail/history navigation uses existing routes.
- Loading, empty, unavailable, retry, and reset states are accessible and do not communicate an all-clear or physical safety conclusion.
- No API/DTO/backend/OpenAPI/schema/configuration/dependency/push-notification/live-data change is made.

## Verification (WSL Ubuntu-26.04 only)

Use existing WSL Node and workspace dependencies; do not install packages. Record Node, npm, Git, TypeScript, Vite and test/browser-tool versions actually available. Run the focused update-centre and API-client/UI tests, then `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`. Test hidden/inactive polling, stale-response suppression, interest privacy, cursor persistence, page retry, reset ordering, exact-match behavior, event hydration cap, and accessible state copy with fakes/fixtures. Use only authored fictional records; do not request live data or use paid APIs. Report actual output. Hosted services, live source data, and any headless visual review not actually performed must remain explicitly unverified.

## Commit and handoff

Implement only on the assigned branch/worktree. Commit implementation/tests and this handoff in coherent descriptive commits, leave the checkout clean, and do not merge or push. Report branch/worktree, exact commit SHAs/messages, changed paths, behavior, actual WSL checks and results, runtime versions, limitations, storage/configuration impact, and remaining decisions. Root independently reviews and integrates.

## Stop conditions

Stop and report if the existing public detail response cannot support the documented exact category/scope matching, if cursor rebase ordering cannot be represented through current APIs without a contract change, if local interests would need to be transmitted for polling, or if a new permission, source, data right, paid service, package, or provider capability would be required. Do not make user-interactive computer/browser changes. Escalate to GPT-6 Astra xhigh only after a GPT-6 Luna Max attempt fails on a substantive technical difficulty.

## Implementation handoff

Append the exact branch/worktree, commit SHAs and messages, changed paths, behavior, actual WSL checks/results, runtime versions, limitations, storage/configuration impact, and remaining decisions here. Do not merge or push.
