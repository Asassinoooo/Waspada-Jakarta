# UI-03: unified source explorer

Status: accepted locally, 11 October 2026. User requests one unified, map-oriented view. Scope is the existing `#demo-sumber` educational preview, not published Event geometry or new providers. Existing source-preview-v1/context-sources-v1 and acquisition budgets remain unchanged. This replaces the separate UI-01/UI-02 source-preview layouts; the published incident discovery route is outside this slice.

## Interaction and visual direction

Reuse the existing civic tokens (tinta-kota, kali-teal, merah-tanda, surface, soft-panel, beton), typography, compact labels and visible focus states. Desktop: one introduction/control strip, a compact source status/filter toolbar, a large primary map alongside a compact companion panel (Daftar, Detail, Cuaca, Sumber). Mobile: map-first with compact controls and a companion drawer/panel; the same map remains the primary view. No long source metadata or forecast table ahead of the map. Avoid a second regional map or a duplicate quake feed/detail. Weather model-grid coordinates appear in text only, never as an incident marker.

Existing tokens: tinta-kota `#18323A` (headings/quake outline), kali-teal `#087B75` (focus/reference facilities), merah-tanda `#A7433B` (source-report symbol), surface `#FFFFFF` (controls/panel), soft-panel `#EAF0ED` (quiet background), beton `#D5DEDB` (dividers). Inherit the existing Jakarta Sans/system stack; compact headings, readable body copy and tabular source timestamps. Left alignment, 0.5–0.8rem control gaps and a wider map column keep source reading secondary to geographic exploration; no new fonts, packages or decoration.

```text
Peta sumber Jakarta          [Ambil fasilitas & banjir] [Ambil cuaca & gempa]
Source status: OSM | PetaBencana | Open-Meteo | USGS
[Search and source/kind filters: disclosure]
Large primary OSM map: H/P/D/B/G    Companion panel: list/detail/weather/sources
                           [Jakarta awal] [Kawasan gempa]
Detail panel: selected source, kind, source-specific timestamps and link
Cuaca panel: model hourly table, unknowns, attribution; no warning geometry
Sumber panel: full provenance, snapshot restore and context reset
```

Mobile uses the same order with a single compact title/control strip, collapsed filters and primary map. A persistent bottom navigation opens the Daftar, Detail, Cuaca or Sumber companion drawer without replacing the map. Selecting a marker opens Detail; Kembali ke peta closes the drawer and returns keyboard focus to the map. While the drawer is open, acquisition/filter controls are hidden to keep the selected point visible; closing restores those controls. The drawer has its own vertical scroll, while only the forecast table scrolls horizontally. Long provenance and reset controls belong inside Sumber. Source status can scroll within its named, keyboard-focusable strip; the page must not overflow horizontally. A compact H/P/D/B/G key and source caveat precede the map, with the longer caption and collapsed legend below it. The map is visible in the initial mobile viewport, without requiring a map/list switch. Legacy modes retain their original order.

Map starts at Jakarta. One regional extent button and selected-quake centering expose distant epicentres in that same viewport. Returning to Jakarta retains the loaded quake layer and selection identity. All source markers keep separate source descriptions and category symbols; no inferred circles, polygons, event lifecycle or Waspada-verification labels. The legend and notice explain all three point providers. Filter counts describe loaded records, not safety metrics or verified incident counts.

## State and data ownership

New `UnifiedSourceExplorer` owns two independent request groups using existing strict clients. Only exact server-confirmed demo permits requests. Initial requests load the dated OSM snapshot and the local not_requested context projection, with no new provider acquisition. Explicit buttons preserve each group's existing fixed upstream scope. Source refresh clears only its requested group's old result while the other group remains usable; both request groups abort on unmount/mode change and ignore old responses. Snapshot restore and context reset must remain no-acquisition actions. No cross-source deduplication, derived claims or API schema changes.

Combine only validated OSM/PetaBencana records and USGS records into the existing SourceMapPoint union (max100+30). Shared search/source/kind filters drive both list and map. Selection must resolve against the current filtered records. Hiding, resetting or clearing a selected point cancels its identity; restoring a filter does not silently restore selection or change the map view. Filters that leave the chosen record visible preserve selection and deliberate pan/zoom. Map clicks and list clicks update the same identity. USGS detail uses earthquake origin/revision/catalog/fetch metadata, with seven-day/minimum-magnitude/record-limit scope visible even when the result is empty; PetaBencana creation is report creation, not physical event time. Source status, data mode, generated time and acquisition stay separate. Empty/failure/partial-source/unknown/live guards remain explicit and never imply safety. All synthetic QA records are labelled; no new snapshots/providers/dependencies.

## Packages and root review

- UI-03-UNIFIED-SOURCE-EXPLORER: new screen/CSS and meaningful pure-selector/SSR tests; existing clients/static detail/table components reused. No App/main/package/map/client/API edits.
- UI-03-UNIFIED-SOURCE-MAP: additive unified map mode, both extents, source-aware notice/legend and source-aware selected view; preserve Jakarta/regional modes, geometry/tile budgets/accessibility and tests.
- Root: App/CSS/test registration, cross-review, WSL web tests/typecheck/build/smoke, headless desktop/mobile screenshots and mixed-source/filter/reset/error/selection verification with stubbed tiles/providers, documentation, commits and push. No cloud activation/provider acquisition is needed for this UI-only task.

Detailed assignments define allowed paths, checks and exact branch/worktree bases. Root alone accepts and integrates; no implementer approves its own work.

## Acceptance evidence and limits

Explorer branch commits `d8fbf76` and `b0c7787` are integrated at `5b7cf38`; map branch commits `c866499`, `f5a6fbb` and `d972e3a` are integrated at `fd83ff2`. Root wiring and screenshot-led refinements are committed at `f0395b0` (`feat(UI-03): wire map-first explorer and mobile companion drawer`) and `9ba0dda` (`fix(UI-03): expose map caveats and keyboard source status`). Separate Luna/max code and visual reviewers found no remaining blockers after the two source-key/keyboard findings were resolved. Exact messages, review evidence and process limitations are recorded in the assignments and delivery log.

WSL Ubuntu-26.04, native Node24.21.0/npm11.19.0: web117/117, all-workspace/evaluation typecheck, Vite8.3.0 build, local UI/API smoke and assigned-base diff check passed. Independent final code review reran map/explorer21/21 and web typecheck. Headless browser QA passed ten scenario groups, including mixed source scales/selection, filters, independent failure/retry/reset, held-request navigation cancellation, unknown/live guards, tile failure, and 320/390px mobile drawer/overflow/focus behavior. Desktop1440x1000 and mobile screenshots were visually inspected and refined. Automated basemap tiles and nonempty report/quake fixtures are mocked and labelled; no upstream provider acquisition occurred for this UI task.

This remains an educational source preview. It does not enable L2/RAG, L3 investigation, incident publication, source persistence, auth mutations or cloud deployment, and does not establish factual accuracy, real basemap rendering, source availability, geographic coverage or hosted free-tier behavior. Earlier source acquisitions and UI-01/UI-02 checks remain historical evidence, not checks of this new screen.
