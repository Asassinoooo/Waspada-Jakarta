# UI-API-DETAIL-HISTORY-CORE — connect synthetic detail and history routes

- **Status:** Assigned; UI/API integration using synthetic demo data only
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
