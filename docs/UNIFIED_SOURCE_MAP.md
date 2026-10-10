# UI-03: unified source explorer

Status: assigned, 10 October 2026. User requests one unified map. Scope is the existing `#demo-sumber` educational preview, not published Event geometry or new providers. Existing source-preview-v1/context-sources-v1 and acquisition budgets remain unchanged.

## Interaction and visual direction

Reuse the existing civic tokens (tinta-kota, kali-teal, merah-tanda, surface, soft-panel, beton), typography, compact labels and visible focus states. Desktop: one introduction/control strip, a compact source-status area, source/kind/search filters, linked list alongside a single persistent map, one selected-record detail and a collapsible hourly weather table. Mobile: list-first with one Daftar/Peta switch; the same map and selected record remain linked. Avoid a second regional map or a duplicate quake feed/detail. Weather model-grid coordinates appear in text only, never as an incident marker.

```text
Peta sumber Jakarta          [Ambil fasilitas & banjir] [Ambil cuaca & gempa]
Source status: OSM | PetaBencana | Open-Meteo | USGS  (expand provenance)
Search                     Source filter             Kind filter
Linked list: H/P/D/B/G      One OSM map: H/P/D/B/G
                           [Jakarta awal] [Kawasan gempa]
Selected record: original source, kind, source-specific timestamps and link
Weather model context: hourly table, unknowns, attribution; no warning geometry
```

Map starts at Jakarta. One regional extent button and selected-quake centering expose distant epicentres in that same viewport. Returning to Jakarta retains the loaded quake layer and selection identity. All source markers keep separate source descriptions and category symbols; no inferred circles, polygons, event lifecycle or Waspada-verification labels. The legend and notice explain all three point providers. Filter counts describe loaded records, not safety metrics or verified incident counts.

## State and data ownership

New `UnifiedSourceExplorer` owns two independent request groups using existing strict clients. Only exact server-confirmed demo permits requests. Initial requests load the dated OSM snapshot and the local not_requested context projection, with no new provider acquisition. Explicit buttons preserve each group's existing fixed upstream scope. Source refresh clears only its requested group's old result while the other group remains usable; both request groups abort on unmount/mode change and ignore old responses. Snapshot restore and context reset must remain no-acquisition actions. No cross-source deduplication, derived claims or API schema changes.

Combine only validated OSM/PetaBencana records and USGS records into the existing SourceMapPoint union (max100+30). Shared search/source/kind filters drive both list and map. Selection must resolve against the current filtered records and become visibly absent when hidden or reset; map clicks and list clicks update the same identity. USGS detail uses earthquake origin/revision/catalog/fetch metadata; PetaBencana creation is report creation, not physical event time. Source status, data mode, generated time and acquisition stay separate. Empty/failure/partial-source/unknown/live guards remain explicit and never imply safety. All synthetic QA records are labelled; no new snapshots/providers/dependencies.

## Packages and root review

- UI-03-UNIFIED-SOURCE-EXPLORER: new screen/CSS and meaningful pure-selector/SSR tests; existing clients/static detail/table components reused. No App/main/package/map/client/API edits.
- UI-03-UNIFIED-SOURCE-MAP: additive unified map mode, both extents, source-aware notice/legend and source-aware selected view; preserve Jakarta/regional modes, geometry/tile budgets/accessibility and tests.
- Root: App/CSS/test registration, cross-review, WSL web tests/typecheck/build/smoke, headless desktop/mobile screenshots and mixed-source/filter/reset/error/selection verification with stubbed tiles/providers, documentation, commits and push. No cloud activation/provider acquisition is needed for this UI-only task.

Detailed assignments define allowed paths, checks and exact branch/worktree bases. Root alone accepts and integrates; no implementer approves its own work.
