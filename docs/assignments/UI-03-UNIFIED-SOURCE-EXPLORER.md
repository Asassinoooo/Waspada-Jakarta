# UI-03-UNIFIED-SOURCE-EXPLORER

Objective: implement [one unified source screen](../UNIFIED_SOURCE_MAP.md). Dependencies: accepted UI-01/UI-02, source-preview-v1 and context-sources-v1 (unchanged), SourceMapPoint existing union and public static detail/table helpers. Branch `work/UI-03-UNIFIED-SOURCE-EXPLORER`, worktree `.codex-build/worktrees/ui03-unified-explorer`; record exact planning base.

Allowed paths: `apps/web/src/UnifiedSourceExplorer.tsx`, `apps/web/src/unified-source-explorer.css`, `apps/web/test/unified-source-explorer.test.tsx`, this assignment. Do not edit App/main/package/map/old views/clients/contracts/API, acquire sources, add dependencies, deploy, merge, push, spawn agents or edit root checkout.

Read SDP, backlog, UX_API_SPEC, unified scope, existing clients and static UI helpers before coding. Export `UnifiedSourceExplorer({datasetMode,renderMap?})`; map callback `(points:readonly SourceMapPoint[],selectedId:string|null,onSelect:(id:string)=>void,onReturnToList:()=>void)=>ReactNode`. Root supplies one map with unified mode. Two independent bounded request groups use existing strict clients; exact demo only. Default snapshot/local context, explicit acquisition buttons, independent retry/error/loading, snapshot restore and context reset. Abort/ignore stale results and clear only refreshed group's data; surviving group remains usable. No new provider calls or autonomous actions.

One combined filtered list and one selected detail for OSM/PetaBencana/USGS, one map callback invocation. Map-oriented latest user steer: a large persistent map is primary on desktop and mobile. A compact companion panel/drawer has Daftar, Detail, Cuaca, Sumber views; no long provenance/forecast/status blocks before the map. Source health appears in compact toolbar text, detailed provenance in the Sumber panel. Reuse SourcePreviewStatusCard/SourcePreviewRecordDetails, WeatherForecastTable/EarthquakeRecordDetails where helpful; do not render full old screens or EarthquakeContextCard's separate list/map. Weather stays a collapsible model table with source attribution, nulls, validity and missing issue time, no marker. Source/kind/search filtering is shared with map, mobile map-first panel switch. Show USGS window/magnitude filter even when empty, provider status != Waspada review, OSM centres approximate, no empty=safe. Source attribution/licence and original timestamps remain inspectable. CSS only imported by root main; preserve SSR importability. Existing civic tokens and compact layout.

Acceptance: meaningful tests for mixed source/kind/search filtering and selection; one map callback with only supported points, no weather marker; partial group data/error, no fabricated/default/live data, source/time/licence/snapshot/unknown honesty, map-first/one detail. Export pure helper/presentational view as needed for tests; do not add test deps. WSL Ubuntu-26.04 native Node24.21/npm11.19 fixed PATH: focused `node --import tsx --test apps/web/test/unified-source-explorer.test.tsx`, web typecheck, assigned-base diff check. No broad suite needed in agent branch. Commit code and this handoff on own branch; return exact SHAs/messages/paths/actual checks/limits/config impact. Missing contract/scope conflict: message root and continue unrelated work. Root owns integration/browser QA/acceptance.

## Implementation handoff (2026-10-10)

Implementation branch: work/UI-03-UNIFIED-SOURCE-EXPLORER; worktree: .codex-build/worktrees/ui03-unified-explorer; planning base: 95d7537085b08ede9525330252b019341fff8589.

Changed paths:
- apps/web/src/UnifiedSourceExplorer.tsx
- apps/web/src/unified-source-explorer.css
- apps/web/test/unified-source-explorer.test.tsx

The screen combines OSM, PetaBencana.id and USGS records into one selection/filter path and invokes the supplied map renderer once. It keeps the map before the companion views on both viewport sizes, exposes Daftar/Detail/Cuaca/Sumber views, starts only snapshot/local requests in exact demo mode, and keeps explicit source/context acquisition, retry and reset states independent. Weather remains context-only. Source timing, attribution/licence, unknown forecast values, bounded/partial results and non-safety semantics remain visible in the relevant panel.

Checks run from WSL Ubuntu-26.04 with Node 24.21.0/npm 11.19.0 and the fixed PATH:
- node --import tsx --test apps/web/test/unified-source-explorer.test.tsx — 9/9 passed after the follow-up.
- npm run typecheck --workspace=@waspada/web — passed.
- git diff --check 95d7537085b08ede9525330252b019341fff8589 — passed for tracked diff; untracked files were subsequently staged for the final whitespace check.

Limitations: app wiring and desktop/mobile browser QA remain with root. No API, provider, dependency or configuration changes. No local Prettier/Biome executable exists, and the installed TypeScript 7 package does not export the compiler-printer API; source was kept multiline without acquiring tooling dependencies. Reviewer may normalize style during integration.

## Follow-up handoff (2026-10-10)

Selection now follows visible identity: a selected record remains selected while it survives shared filters, but a visibility effect clears its ID after filtering, reset, or request-group data clearing removes it. Restoring a filter does not restore selection or recenter the map; the user selects the record again. Detail falls back to the generic choose-a-record prompt.

The Sumber panel now shows the USGS request scope even for an empty fetched catalog: fixed magnitude floor 2.5, the contract policy's seven-day window, 30-record maximum, and the policy envelope. The copy states that this envelope is a retrieval window, not a Jakarta impact area or official danger boundary. The focused tests cover hidden/retained/cleared selection identity and the empty-catalog scope/window.

Final runtime verified in WSL Ubuntu-26.04: Node v24.21.0 and npm 11.19.0. Follow-up commit records these changes; no API, provider, dependency, or configuration changes.
