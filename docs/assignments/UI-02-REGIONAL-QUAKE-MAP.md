# UI-02-REGIONAL-QUAKE-MAP

Objective/dependencies: source-aware quake-origin map option for [context expansion](../CONTEXT_SOURCE_EXPANSION.md), existing SourcePointMap, committed EarthquakeContextRecord in context-sources-v1. Existing public/source-preview-v1 unchanged. Branch `work/UI-02-REGIONAL-QUAKE-MAP`; worktree `.codex-build/worktrees/ui02-quake-map`; record planning base.

Allowed paths: `apps/web/src/SourcePointMap.tsx`, `apps/web/src/source-point-map.css`, `apps/web/test/source-point-map.test.tsx`, this assignment only. No contracts/client/ContextSources/globalCSS/App/packages edits. No root editing/deps/provider calls/merge/push/deploy/furtheragents.

Map input becomes a separate exported union of PreviewRecord and EarthquakeContextRecord, no changes to either DTO. Add optional `viewMode:"jakarta"|"regional_earthquakes"` default Jakarta; regional initial/reset centre106.8,-6.8 zoom6, meaningful regional reset/control labels. Quake point identity/coords/source geometry only; category G with distinct symbol/shape. Point accessible text says USGS epicentre, no established Jakarta impact. Regional-only map header/notice/legend omit facility readiness/OSM-centre/flood claims and explain window is a query region, not official boundary/danger area. Existing Jakarta map source labels/legend/keyboard/pan/zoom/selection/tile fallback remain functional. No impact circles/polygons, geocoder or model. Preserve OSM tile attribution/caching/referrer, visible bounded requests, no automated upstream tiles. Weather is not a marker.

Acceptance/checks: existing six tests plus meaningful regional rendering and source-description/default-mode regression; existing projection/viewport/selection and tile bounds unchanged. WSL Ubuntu-26.04 native Node24.21/npm11.19: focused map suite, web typecheck, assigned-base diff check. Commit code/handoff own branch; return SHAs/exact messages/changed paths/actual checks/limits. Root visual QA/acceptance later. Stop/message any contract or scope conflict.

## Implementation handoff — 10 October 2026

The third agent assignment and reuse of an earlier agent both encountered the session's agent-thread limit. Root implemented this bounded slice on the assigned branch/worktree instead of substituting a model. Independent review has been requested from the running core agent; acceptance remains pending that review and integrated browser QA.

Base: `481d6ec816c149fde35553b8c42326fd573a16e9`. Implementation commit: `d190d4e3cb269c117b995005f8a808d247a29d2e` — `feat(UI-02): add source-aware regional quake map`. Changed paths: `apps/web/src/SourcePointMap.tsx`, `apps/web/src/source-point-map.css`, `apps/web/test/source-point-map.test.tsx`, and this handoff.

The map accepts a separate union without changing either DTO. Regional mode has its own centre, zoom, reset, source text and legend. USGS origins have outlined square G symbols and no inferred impact area. Both maps retain OSM basemap attribution and viewport-bounded tile behavior. React instance IDs avoid duplicate heading/help IDs when both maps are mounted.

Actual WSL Ubuntu-26.04 checks, Node 24.21.0/npm 11.19.0: `node --import tsx --test apps/web/test/source-point-map.test.tsx` **9/9 passed**; `npm run typecheck --workspace @waspada/web` **passed**; `git diff --check` **passed**. An initial negative test used an overbroad regex spanning unrelated legend text; its assertion was corrected and the final focused suite passed. No dependencies, contracts, migration, provider calls, hosted configuration or deployment changed. Integrated interaction/screenshot verification remains root's next check.
