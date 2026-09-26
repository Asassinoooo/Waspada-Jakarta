# UI-01-FEED-FILTERS-CORE — accessible feed filters

- **Status:** Accepted on `main` at handoff `76aba84` after root review
- **Parent work package:** UI-01 — Map, feed and event detail
- **Requirements:** US-01; FR-09/10/15; NFR-03/07/08
- **Dependencies:** BOOT-01, UI-00, SPEC-03
- **Layer:** L4 application integration / frontend presentation
- **Contract baseline:** Existing `EventView` and `EventPage`; no API or DTO change
- **Implementation model:** GPT-6 Luna, max reasoning
- **Branch:** `work/UI-01-FEED-FILTERS-CORE`
- **Worktree:** `C:\Users\perry\.codex\worktrees\api-geojson-route-core\RPL` (reuse the completed, clean managed checkout; verify clean state and branch before editing)
- **Owner:** Luna Max implementation agent; root plans, reviews, accepts, integrates, and pushes

## Objective

Add accessible category, lifecycle, and freshness filters to the existing civic incident feed. Apply all selected filters together to the `EventView` records already loaded by the existing demo API request. Keep the feed and its text search useful without the map. Make clear that filtering the loaded page is not a complete incident census and that no matching records do not mean an area is safe.

This is a frontend-only slice over the current synthetic demo response. Do not add events or claim the demo values represent Jakarta conditions.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md` (first repository document), then `docs/IMPLEMENTATION_BACKLOG.md`
- `docs/UX_API_SPEC.md`
- `apps/worker/src/contracts/public-api.ts`
- `apps/web/src/App.tsx`, `apps/web/src/EventFeed.tsx`, `apps/web/src/display.ts`, `apps/web/src/MapPanel.tsx`, `apps/web/src/styles.css`, and `apps/web/test/ui.test.tsx`

## Required behavior

1. Add labelled native controls for category, lifecycle, and freshness using only the existing public-contract enum values and existing Indonesian display labels. Each control includes an explicit all-values choice. Multiple selected filters combine with AND semantics.
2. Keep the existing text search. Clearly state that search and filters apply to records already loaded from the API page. Show the matching count against the loaded-record count; do not call it the total number of Jakarta incidents.
3. When filters produce no matches, show an accessible neutral empty state, a clear-filters action, and a short statement that an empty result does not mean the area is safe. Distinguish this from an empty API page and the existing loading/unavailable states.
4. A filter change must not leave a filtered-out event appearing as the current map selection. Reset the selection when filter/search state changes; preserve the existing map and no-geometry safeguards.
5. A clear-filters action resets category, lifecycle, freshness, and text search. Keep keyboard access, visible focus, current responsive layout, dataset/demo labels, time distinctions, evidence labels, and current empty/error behavior.
6. Do not add query-string/API parameters or refetches for local filtering. Do not change route, DTO, API, geometry, evidence, source, publication, or event lifecycle behavior.

## Explicitly out of scope

- Live or historical data, new/modified synthetic event fixtures, source access, backend filtering, server pagination, GeoJSON fetching/rendering, basemap or map geometry changes.
- Changes to the OpenAPI/domain contract, other UI routes, moderation/authentication, dependencies, Cloudflare/Neon configuration, or external services.
- Claims about report completeness, current conditions, safety, or user-specific relevance.

## Allowed paths

- `apps/web/src/App.tsx`
- `apps/web/src/EventFeed.tsx`
- `apps/web/src/styles.css`
- `apps/web/test/ui.test.tsx`
- This assignment's implementation handoff only

Root owns shared contracts, API behavior, plans/backlog, source decisions, and architecture. Ask root about contract/scope conflicts; otherwise complete the bounded UI slice.

## Acceptance and checks

- Tests use explicit test-only `EventView` variants to prove each individual filter and combined AND behavior without changing checked-in demo fixtures.
- Tests cover default/all-values behavior, result counts, clear-filters, a neutral filtered-empty state, explicit safety wording, and selection reset. Existing loading/unavailable/empty API and mobile view-switch behavior remains intact.
- Inspect the filter layout at desktop and mobile sizes with an available headless browser workflow. Do not use computer-use/visible desktop controls or install a browser/dependency; if no existing headless browser is available, record that limitation and rely on the existing UI tests.
- In WSL Ubuntu-26.04 run the focused UI tests, full `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`; record tool versions and actual results.
- Commit implementation and handoff in coherent descriptive commits on the assigned branch. Do not merge or push. Leave the worktree clean and report exact branch/path, SHAs/messages, changed paths, behavior, checks/results, limitations, and migration/configuration impact.

## Stop/escalation conditions

Stop and report if completion requires changing the API contract, inventing data or geometry, enabling a source, or changing UI-00's civic design direction. Escalate to GPT-6 Astra xhigh only after a substantive technical difficulty was attempted and remains unresolved by GPT-6 Luna max.

## Implementation handoff

Append the implementation report here. Root independently reviews and verifies the branch before acceptance or integration.

### Implemented handoff — 26 September 2026

- **Branch/worktree:** `work/UI-01-FEED-FILTERS-CORE`; `C:\Users\perry\.codex\worktrees\api-geojson-route-core\RPL` (WSL: `/mnt/c/Users/perry/.codex/worktrees/api-geojson-route-core/RPL`).
- **Implementation commit:** `3d00b29c6fa144e2f7304da4af245c60d253562b` — `feat(UI-01): add loaded-page feed filters`.
- **Changed paths:** `apps/web/src/App.tsx`, `apps/web/src/EventFeed.tsx`, `apps/web/src/styles.css`, and `apps/web/test/ui.test.tsx`.
- **Behavior:** Added labelled native category, lifecycle, and freshness selects with all-values defaults. Search and all filters apply with AND semantics to the loaded API page, whose matching/loaded count and non-census scope are stated explicitly. Filtered-empty results include a neutral no-safety inference and clear-all action. Search/filter changes and clear-all reset map selection. Existing demo labels, time/evidence display, loading/API-empty/unavailable states, map safeguards, and mobile list/map switch remain in place.
- **Checks (WSL Ubuntu 26.04 LTS; Linux Node v24.21.0; npm v11.19.0):** focused UI tests passed 9/9; full `npm test` passed 249/249 (web 22, Worker 137, DB 78, casebook 12); `npm run typecheck` passed; `npm run build` passed (Vite production build and Wrangler dry-run); `git diff --check` passed. The temporary `node_modules` link to the existing repository dependencies was removed.
- **Visual QA:** No screenshot captured. No preinstalled headless browser or Playwright/Puppeteer package was available in WSL, and no browser was installed.
- **Migration/configuration impact and remaining decisions:** None. No API/DTO, dependency, configuration, or migration changed.

### Root review and acceptance — 26 September 2026

- Root reviewed the complete task diff on `work/UI-01-FEED-FILTERS-CORE` and fast-forwarded it to local `main` at handoff commit `76aba84577a1be1a0bb4ed5e678f572f31779f6a` (`docs(UI-01): record feed filter handoff`), following implementation commit `3d00b29c6fa144e2f7304da4af245c60d253562b` (`feat(UI-01): add loaded-page feed filters`). Changed paths are limited to the four UI/test paths above and this task handoff.
- Root independently passed focused UI tests (9/9), full `npm test` (249/249: web 22, Worker 137, DB 78, casebook 12), `npm run typecheck`, `npm run build` (Vite production build and Wrangler dry-run), and WSL `git diff --check`.
- Screenshot review could not be completed: WSL has no preinstalled headless browser or Playwright/Puppeteer package. No browser or dependency was installed; the existing UI tests were used as the available verification.
- Acceptance is limited to local loaded-page filtering over synthetic demo API records. It does not establish current conditions, completeness, safety, backend filtering, live GeoJSON, or data-source rights.
