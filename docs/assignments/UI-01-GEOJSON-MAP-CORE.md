# UI-01-GEOJSON-MAP-CORE — connect supported GeoJSON to the linked map

- **Backlog ID:** `UI-01-GEOJSON-MAP-CORE`
- **Objective:** Read the existing public GeoJSON endpoint in the web client and render only returned source-supported geometry in the existing linked list/map interface.
- **Dependencies:** `API-GEOJSON-ROUTE-CORE`, `API-PUBLIC-GEOJSON-PROJECTION-CORE`, `API-PUBLIC-GEOJSON-RUNTIME-CORE`, `UI-00`, `UI-01-FEED-FILTERS-CORE`, `UI-API-DETAIL-HISTORY-CORE`, `SPEC-03`, [ADR-018](../decisions/ADR-018-jakarta-geojson-query-envelope.md). This narrow client task uses accepted endpoint/contract slices; it does not claim API-01 or PUB-01 completion.
- **Requirements:** `US-01`; `FR-09/10/15`; `NFR-03/07/08`.
- **Layer:** L4 browser application integration over the existing public HTTP APIs. It must not infer or alter L1/L2/L3/L4 publication decisions.
- **Contract boundary:** Keep the existing `PublicFeatureCollection`, `GET /api/v1/events.geojson` query vocabulary, `application/geo+json` response, and safe error behavior unchanged.
- **Branch/worktree:** `work/UI-01-GEOJSON-MAP-CORE` in the reusable managed checkout `C:\Users\perry\.codex\worktrees\api-geojson-route-core\RPL` (WSL: `/mnt/c/Users/perry/.codex/worktrees/api-geojson-route-core/RPL`), based on pushed root main. Do not edit through the root checkout.
- **Owner:** GPT-6 Luna Max implementation agent. Root plans, reviews, integrates, and pushes.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md` (first repository document), then `docs/IMPLEMENTATION_BACKLOG.md` and this assignment
- [UI/API specification](../UX_API_SPEC.md), [GeoJSON OpenAPI operation](../api/openapi.yaml), [ADR-018](../decisions/ADR-018-jakarta-geojson-query-envelope.md), and [the public API contract](../../apps/worker/src/contracts/public-api.ts)
- `apps/web/src/App.tsx`, `EventFeed.tsx`, `MapPanel.tsx`, `EventDetail.tsx`, `ModeratorReview.tsx`, `api-client.ts`, `styles.css`, and the existing web tests
- [Accepted GeoJSON runtime assignment](API-PUBLIC-GEOJSON-RUNTIME-CORE.md) and its endpoint/runtime tests

## Reviewed visual direction and tokens

Keep the existing civic coordinate sheet: a quiet list remains the source of truth, with an adjacent CRS84 geometry view that plainly says there is no basemap. Geometry should be the distinctive element; grid lines, controls, and evidence copy stay restrained. Never add decorative gradients, generic dashboard metrics, a tile service, or geometry that is not present in the API response.

| Role | Existing token |
| --- | --- |
| Hujan pagi — page/background | `#F4F7F5` |
| Tinta kota — primary text | `#18323A` |
| Kali teal — links/selected geometry | `#087B75` |
| Beton — coordinate grid/borders | `#D5DEDB` |
| Kuning perhatian — attention status | `#E7B448` |
| Merah tanda — explicit critical status | `#A7433B` |

Use the existing **Plus Jakarta Sans** stack for interface text, with the established heading scale and tabular numerals for coordinates and counts. Keep content left-aligned. Desktop retains the current feed-first split at roughly 62% feed / 38% map. Mobile defaults to the list with the existing visible map switch. Reuse the current spacing rhythm (4/8/12/16/24/32 px) and focus, reduced-motion, and contrast styles.

```text
1. Desktop map + linked feed
┌ Waspada Jakarta · status dataset dari API · sumber ─────────┐
│ cari / filter kategori, siklus, kesegaran                   │
├───────────────────────────────┬─────────────────────────────┤
│ Daftar API yang dimuat        │ Geometri CRS84              │
│ • judul + waktu + bukti       │ • garis koordinat tipis     │
│ • pilih → sorot geometri      │ • hanya feature API        │
│ • tanpa geometri tetap tampil │ • tanpa peta dasar          │
└───────────────────────────────┴─────────────────────────────┘

2. Mobile list-first; map is an explicit switch
┌ header + status data ─────────┐
│ cari + ringkas filter         │
│ [ Daftar ] [ Peta ]           │
│ record / empty / retry state  │
│ (default: daftar)             │
└───────────────────────────────┘

3. Event detail (existing, unchanged)
┌ judul + lifecycle + freshness ┐
│ waktu kejadian / perubahan    │
│ asal bukti + waktu sumber     │
│ geometri hanya bila didukung  │
└──────────────────────────────┘

4. Moderator evidence review (existing, unchanged and read-only)
┌ event claim ─────────┬ evidence and provenance ┐
│ label / ringkasan    │ source + observed time  │
│ history              │ no approve/retract UI   │
└──────────────────────┴────────────────────────┘
```

Screens 3 and 4 are included to preserve the current product hierarchy. This task must not change their behavior or add moderator controls.

## Required behavior

1. Add a browser API client for the existing GeoJSON route. Send `Accept: application/geo+json`, serialize only its documented bbox/category/lifecycle/freshness parameters, and keep response parsing/errors bounded. Do not change OpenAPI, server query parsing, Worker behavior, or data contracts.
2. Keep the feed usable when the map request fails. Fetch/map status has its own loading, empty, and unavailable states; a map error cannot replace or hide a successfully loaded feed.
3. Render only valid features returned by the API, using their original CRS84 positions and their returned event IDs/properties. Support all contract geometry types—`Point`, `MultiPoint`, `LineString`, `MultiLineString`, `Polygon`, and `MultiPolygon`—with a deterministic coordinate projection into the existing no-basemap view. Reject malformed or out-of-envelope positions without drawing them. Do not infer place names, radii, warning zones, road closures, or any geometry.
4. Keep geometry linked to the loaded feed page: apply the currently selected category/lifecycle/freshness filters and local text search consistently, and show only features whose event ID is among the visible loaded records. Make the loaded-page limitation clear; do not imply citywide completeness. Selecting a visible feature selects its feed record and provides the existing detail link. Keep matching text controls/list items keyboard accessible; do not make a gesture-only map.
5. Keep the list as the complete fallback for records without geometry. An empty FeatureCollection or an unmapped event says no supported geometry is available; it never says an area is safe or has no reports.
6. Drive the header's dataset mode and demo banner from `PublicContext.dataset_mode`; while context is unavailable, say the dataset status is unavailable instead of asserting demo/live. In demo mode, label API records synthetic and keep the documented presentation fixture clearly separate. In live mode, hide the presentation fixture entirely and label API records as live without implying they are fresh or complete. Never attach synthetic geometry to an API event. Do not expose debug, SQL, source-private or unapproved fields.
7. Preserve the existing mobile list-first switch, event detail, read-only moderator screen, and current category/status/evidence/time distinctions. No review mutations.

## Allowed paths

- `apps/web/src/api-client.ts`
- `apps/web/src/App.tsx`
- `apps/web/src/EventFeed.tsx`
- `apps/web/src/MapPanel.tsx`
- `apps/web/src/styles.css`
- New focused UI/API tests under `apps/web/test/`
- `apps/web/package.json` — focused test registration only
- This assignment's implementation handoff only

Do not edit public API contracts, OpenAPI, backend/API source, Wrangler/deployment configuration, lockfiles, sources/provider configuration, or other UI screens. Do not add a dependency, map-tile host, remote asset, external service, credential, or live-data fixture. Do not use computer-use/desktop automation; check for existing headless browser tooling in WSL and use it only if already installed. Do not install a browser or package just for screenshot review.

## Acceptance criteria

- The browser calls only the documented endpoint and supported query parameters; it does not request tile servers or change the backend contract.
- Valid `Point`, `MultiPoint`, `LineString`, `MultiLineString`, `Polygon`, and `MultiPolygon` response features render from their returned coordinates; malformed geometry never renders. Source coordinates are shown as returned, with a visible “peta koordinat, tanpa peta dasar” description.
- Map selection and feed selection remain linked; selected API events without geometry stay in the feed and have a clear “Tidak dipetakan” explanation.
- Map loading/empty/error/demo states are clear and keep list discovery usable. No empty result claims safety, complete citywide coverage, freshness, or resolution.
- Mobile remains list-first with a visible map switch; controls and feature selection are keyboard-operable and text alternatives remain present.
- Existing detail, history, and moderator read-only behavior is preserved. Demo keeps an explicitly synthetic presentation fixture; live mode hides it. No unauthorized review mutation or synthetic/live blending occurs.
- No dependency, API/DTO/OpenAPI, backend, source, provider, secret, binding or deployment configuration changes.
- In WSL Ubuntu-26.04, run focused web tests, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`. Inspect desktop/mobile screenshots using already-present headless browser tooling if available; record actual results or the precise tool limitation.

## Design and review references

- [Anthropic Frontend Design skill](https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md) — keep the existing product identity; make no unrelated restyle.
- [Vercel Web Design Guidelines skill](https://github.com/vercel-labs/agent-skills/tree/main/skills/web-design-guidelines) — before final review, fetch the linked latest guideline content if the web tool is available and review the changed UI files. Report concise file/line findings and address relevant issues.

## Stop conditions

Stop and report the exact gap if the existing GeoJSON contract cannot support the documented coordinate view, if an external basemap or API change appears necessary, or if accepted UI controls would imply completeness/safety. Do not weaken backend validation or show synthetic geometry as live. Do not install new dependencies. Escalate to GPT-6 Astra xhigh only after a GPT-6 Luna Max attempt fails on a substantive technical difficulty.

## Implementation handoff

Append branch/worktree, commit SHAs/messages, changed paths, behavior, actual WSL checks and screenshot results/limitations, configuration impact, and remaining decisions here.

### Handoff — 2026-09-27

- **Branch/worktree:** `work/UI-01-GEOJSON-MAP-CORE` at `C:\Users\perry\.codex\worktrees\api-geojson-route-core\RPL` (`/mnt/c/Users/perry/.codex/worktrees/api-geojson-route-core/RPL` in WSL Ubuntu-26.04).
- **Implementation commit:** `f652f45b99abaadaadfad658dca8143d33553d51` — `feat(UI-01-GEOJSON-MAP-CORE): render supported public GeoJSON`.
- **Changed paths:** `apps/web/package.json` (focused test script registration only); `apps/web/src/api-client.ts`; `apps/web/src/App.tsx`; `apps/web/src/EventFeed.tsx`; `apps/web/src/MapPanel.tsx`; `apps/web/src/styles.css`; `apps/web/test/geojson-map.test.tsx`; `apps/web/test/preferences.test.tsx`; `apps/web/test/ui.test.tsx`.
- **Behavior:** The browser calls only `/api/v1/events.geojson` with documented category/lifecycle/freshness filters and the GeoJSON Accept header, then bounds and validates the response, keeps only public allowlisted properties, and rejects unsupported, malformed, oversized, or out-of-envelope data. It renders all six supported geometry types in a deterministic local CRS84 view without a basemap, links selectable keyboard-operable features to exact visible event versions, shows returned coordinates, and keeps map loading/empty/error states separate from the list. Search and supported filters round-trip through the URL while preserving panel and hash state. Context drives live/demo/unknown labels; the synthetic presentation fixture is only rendered after demo context is confirmed, including direct hash routes. A selected event filtered off the loaded page no longer receives a false “Tidak dipetakan” explanation.
- **Checks (WSL Ubuntu-26.04):** `npm test` passed with 33 web tests, 223 worker tests, all 18 DB test files, and 12 evaluation cases. After the final copy-only updates, `npm test --workspace=@waspada/web` passed 33/33 and `npm run typecheck --workspace=@waspada/web` passed. Root `npm run typecheck` passed, and final `npm run build` passed the Vite build and Wrangler `--dry-run`; final `git diff --check` and staged `git diff --cached --check` passed. Runtime versions used: Node 24.21.0, npm 11.19.0, TypeScript 7.0.2, React/react-dom 19.3.0, Vite 8.3.0, `@vitejs/plugin-react` 6.1.1, and Wrangler 4.137.0.
- **Screenshot review:** Not available. WSL has no Chromium, Chrome, Firefox, Playwright, or Puppeteer executable/module installed. No browser or dependency was installed, and no desktop automation was used.
- **UI guideline review:** Reviewed the latest [Vercel Web Interface Guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md). Addressed findings at `apps/web/src/App.tsx:51` and `:173` (filter URL state and demo-only fixture route), `apps/web/src/MapPanel.tsx:123` and `:179` (keyboard selection and exact visible-version guard), `apps/web/src/styles.css:1019` and `:1072` (geometry sizing and visible interaction focus), and `apps/web/src/EventFeed.tsx:149` (labelled search with an example placeholder). No remaining actionable guideline findings.
- **Configuration/migration impact:** None. No dependency was added; the package change only registers the focused test. No API/DTO/OpenAPI, backend, lockfile, source/provider, secret, binding, deployment, or migration file changed.
- **Remaining decisions:** None identified. Root review and integration remain pending.
