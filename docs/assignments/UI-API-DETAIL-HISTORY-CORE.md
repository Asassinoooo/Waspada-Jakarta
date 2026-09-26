# UI-API-DETAIL-HISTORY-CORE — connect synthetic detail and history routes

- **Status:** Accepted on `main` at handoff `e53caf5`; synthetic demo UI/API integration only. Root review and independent checks are recorded in [the delivery log](../DELIVERY_LOG.md).
- **Depends on:** UI-00, API-DETAIL-HISTORY-ROUTES-CORE, SPEC-03
- **Requirements:** US-01; FR-09/10/15; NFR-03/07/08
- **Contract:** Existing OpenAPI 3.1 `EventDetail` and `HistoryPage`; unchanged
- **Layer:** L4 application/UI integration over the L4 route contract
- **Implementation model:** GPT-6 Luna, max reasoning
- **Branch/worktree:** `work/UI-API-DETAIL-HISTORY-CORE`; `.codex-build/worktrees/ui-api-detail-history-core`
- **Owner:** Luna Max implementation agent; root plans and reviews

## Objective

Connect the existing `#detail/api/{event_id}` view to `GET /api/v1/events/{event_id}` and `/history`, which now return only explicitly synthetic fixtures. Replace stale copy that says these routes do not exist. Preserve the approved UI-00 visual direction and make request states easy to understand without adding data, locations, source claims, or map geometry.

This is a front-end integration task. The routes are demo-only, and their response content must remain visibly synthetic. Do not treat fixture history, lifecycle, freshness, or empty evidence as a current safety signal.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md`, `docs/IMPLEMENTATION_BACKLOG.md`, and `docs/UX_API_SPEC.md`
- `docs/assignments/API-DETAIL-HISTORY-ROUTES-CORE.md` and its accepted handoff
- `apps/worker/src/contracts/public-api.ts`
- `apps/web/src/App.tsx`, `apps/web/src/EventDetail.tsx`, `apps/web/src/EventFeed.tsx`, and `apps/web/src/api-client.ts`
- `apps/web/src/MapPanel.tsx`, `apps/web/src/styles.css`, and `apps/web/test/ui.test.tsx`

## Required behavior

- Fetch typed EventDetail and HistoryPage responses using safely encoded event IDs and the existing API base paths. Keep page requests read-only and do not add network sources or dependencies.
- Load detail and history independently: an unavailable history request must not hide a successfully loaded detail. Prevent stale async responses from replacing a newer route; support retry for failed requests.
- Provide accessible Indonesian loading, 404/not-found, unavailable/5xx, and empty-history states. Use the shared `role="status"` / `role="alert"` patterns and existing button/focus styles. Do not expose raw exception text.
- Show the API fixture's fictional title/summary and preserve the global demo banner. Render only fields received in EventDetail. Render history fields from the HistoryPage, with the demo summary and timestamp clearly identified as fixture data. If the history list is empty, state that no history entry is present in this fixture; do not infer safety or resolution.
- Keep evidence, source attribution, event/observation/fetch/publication time, freshness, and user relevance distinct. Empty claims/sources must say evidence is unavailable in the fixture; do not fabricate corroboration, citations, currentness, or relevance.
- Keep the map/list behavior unchanged. The accepted routes provide `geometries: []`; show the existing no-geometry fallback and never derive a point or warning area.
- Respect the desktop and mobile UI-00 layouts, labels, keyboard access, and demo-data rules. Inspect screenshots at desktop and mobile sizes, critique against the existing civic design, and refine only defects introduced by this integration. Do not add gradients, animations, oversized cards, metrics, or AI-themed decoration.
- OpenAPI 3.1, backend routes, domain contracts, styling tokens, and API semantics remain unchanged unless a concrete UI-only accessibility correction is necessary; report any such deviation.

## Explicitly out of scope

- GeoJSON/viewport/basemap work, `/bbox`, live or historical sources, server-side database reads, authenticated moderation, publication mutations, or source/data-rights claims.
- New dependencies, model/provider calls, cloud resources, API/OpenAPI changes, and changing UI-00's visual direction.

## Allowed paths

- `apps/web/src/App.tsx`
- `apps/web/src/EventDetail.tsx`
- `apps/web/src/api-client.ts`
- `apps/web/src/styles.css` — only small state/accessibility adjustments if required
- `apps/web/test/ui.test.tsx`
- `apps/web/test/api-client.test.ts` (new, if useful)
- `apps/web/package.json` — test registration only, if a new test file is added
- This assignment's implementation handoff only

Root owns the shared API/domain contract, other routes, viewport decision, architecture/backlog acceptance, and any source or provider decision. Stop and report if the current visual structure cannot communicate an API state without inventing evidence or implying real-world safety.

## Acceptance and checks

- Tests cover typed request URLs, encoded IDs, successful detail/history rendering, independent history failure, detail 404, loading, unavailable/retry, empty history, and no fabricated evidence/geometry.
- Desktop and mobile screenshots are inspected; record viewport sizes and the critique/refinement. No screenshot may present a synthetic fixture as live data.
- In WSL Ubuntu-26.04 run focused UI/API client tests, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`; record actual runtime/tool versions.
- Commit coherent implementation and handoff on the assigned branch; leave a clean worktree and do not push or merge. Root independently reviews and verifies the result.

## Stop/escalation conditions

Stop and ask root if the existing API response is insufficient to populate the UI without adding inferred information, if a route requires live data/authorization, or if the visual changes would alter UI-00's approved design. Do not escalate to Astra unless Luna Max has attempted and failed to resolve a substantive technical issue.

## Handoff

Append the implementation report here.

### Implementation handoff — 26 September 2026

- **Branch/worktree:** `work/UI-API-DETAIL-HISTORY-CORE` at `D:\Projects\RPL\.codex-build\worktrees\ui-api-detail-history-core` (`/mnt/d/Projects/RPL/.codex-build/worktrees/ui-api-detail-history-core` in WSL).
- **Implementation commit:** `113e032d2b39f088dfcf3edb1c2b9630395c4d4c` — `feat(UI-API-DETAIL-HISTORY-CORE): connect synthetic detail and history`.
- **Changed implementation paths:** `apps/web/package.json`; `apps/web/src/App.tsx`; `apps/web/src/EventDetail.tsx`; `apps/web/src/api-client.ts`; `apps/web/test/ui.test.tsx`; `apps/web/test/api-client.test.ts`. The only additional path is this handoff record.
- **Behavior:** The `#detail/api/{event_id}` page now fetches typed `EventDetail` and `HistoryPage` responses from the existing GET routes with `encodeURIComponent` IDs. The reads have independent loading, 404, unavailable, and retry states, so a failed history request leaves a loaded event visible. Effect cleanup cancels stale route requests, and state is keyed by event ID so one route's response cannot render for another. The page shows the fixture title, summary, received fields, distinct event/publication/context/source times, freshness, evidence and relevance labels, returned history summaries/timestamps, and the existing empty-geometry fallback. Empty evidence and history remain explicitly unavailable in the fixture. The global DEMO banner and presentation-only fixture remain unchanged; no geometry, source claim, citation, currentness, or relevance was added.
- **Checks:** WSL Ubuntu 26.04, Node.js `v24.21.0`, npm `11.19.0`, TypeScript `7.0.2`, tsx `4.23.15`, Vite `8.3.0`, and Wrangler `4.137.0`. Focused web/API tests passed 9/9. Full `npm test` passed: web 9/9, Worker 131/131, isolated DB 78/78 across 10 files, and casebook 12/12 (230 total). `npm run typecheck` passed. `npm run build` passed, including Vite production output and Wrangler dry-run. WSL `git diff --cached --check` exited 0. A temporary `node_modules` symlink to the existing root dependency cache and generated Wrangler/build outputs were removed after verification.
- **Screenshot review:** Inspected the local page at desktop `1440×900` and mobile `390×844`; the mobile body scroll width was 375px, with no horizontal overflow. Desktop keeps the event heading, status strip and detail panels in the existing two-column direction. Mobile stacks the facts, no-geometry explanation and history in a readable order. The existing geometry fallback is visually tall but clear, so no CSS refinement was needed. The in-app browser could not be shown to the parent from this subagent thread; background viewport and scroll screenshots were available. A full-page capture repeated the lower panels visually while the live DOM contained one map panel and one history panel, so the critique used viewport and scroll captures.
- **Migration/configuration/dependency impact:** None. OpenAPI, Worker/API behavior, domain contracts, styling tokens, dependencies, migrations and runtime configuration are unchanged.
- **Limitations and remaining decisions:** The UI reads only the existing synthetic demo routes; this provides no live/database-backed data or current safety information. The assigned fixtures contain empty evidence/geometries and one history entry. No unresolved decision remains within this assignment.
