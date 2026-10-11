# UI-04-SOURCE-MAP-CLUSTERS

Status: accepted locally after root review, 12 October 2026. User authorizes map clustering, followed by advice on models for the AI pipeline. This package implements clustering only; model advice does not authorize a provider, hosted binding, paid usage or model download.

## Objective and dependencies

Declutter the accepted UI-03 unified source map without changing loaded data, source acquisition, API contracts or published geometry. Read SOFTWARE_DEVELOPMENT_PLAN.md, the backlog, docs/UNIFIED_SOURCE_MAP.md and the existing map/tests first. Dependencies: accepted UI-03; public v1/schema2.0/source-preview-v1/context-sources-v1 remain unchanged.

Branch: `work/UI-04-SOURCE-MAP-CLUSTERS`. Dedicated worktree: `.codex-build/worktrees/ui04-source-map-clusters`. Root creates this from the exact planning commit before dispatch. Implementation agent: gpt-6-luna/max; no further agents.

Allowed paths: `apps/web/src/SourcePointMap.tsx`, `apps/web/src/source-point-map.css`, `apps/web/test/source-point-map.test.tsx`, optional new pure clustering helper under `apps/web/src/`, and this assignment. No App/explorer/client/API/backend/configuration/package/lockfile changes or root-checkout edits. Root registers any additional test file only if necessary; prefer the existing map test entry.

## Interaction and policy

- Enable clustering only in unified mode. Preserve Jakarta/regional legacy modes, attribution, source caveats, tile budget/fallback, keyboard/pointer pan/zoom and extents.
- Use a deterministic world-pixel grid (initial target64px) at zoom4..15. Build groups before viewport culling, ordered independently of input and stable during pan. At zoom16..18 render individual points. No dependencies or spatial/model service calls.
- Partition groups by provider: OSM reference facilities can group H/P/D with an accessible category breakdown; PetaBencana and USGS remain separate. A count means distinct loaded records, not corroboration, severity, current danger or independent events. Never deduplicate evidence or merge identities because coordinates coincide. Explain clusters as display groups, not event coordinates or impact boundaries.
- A cluster has a distinct numeric aggregate symbol, source text/title and native keyboard-operable button. Clicking/Enter/Space zooms into its member extent/anchor by a bounded step (target+2), preserves individual selection identity, and never calls `onSelect` for the aggregate. Cluster placement is a UI anchor derived from members; no synthetic Event/GeoJSON geometry is created.
- Exclude the selected point from clustering so it stays individually visible and linked to detail. Filtering, group refresh/reset and hidden selection continue to follow the existing parent policy. No reset of deliberate pan/zoom when filters retain the selected identity.
- Coincident points at the individual-point scale remain separate records accessible from the linked list; do not invent jittered coordinates. Invalid/nonfinite coordinates must not enter groups. Loaded list counts and all source/time/provenance meaning remain unchanged.
- Keep clusters legible on320/390px mobile, including with the companion drawer open. Existing source key must remain visible. No acquisition on cluster interaction. The source record limit remains100 per OSM/PetaBencana source plus30 USGS, not a global100-point limit.

## Acceptance and verification

Meaningful tests: stable reordered membership/IDs; source partitions and category counts; pan invariance; zoom expansion and high-zoom individual records; selected-point exclusion; invalid coordinates; lossless member accounting including coincident points; viewport culling; unified SSR labels/counts and legacy preservation. No tests that simply repeat implementation constants without testing behavior.

WSL Ubuntu-26.04 only. Native PATH `/home/perry/.nvm/versions/node/v24.21.0/bin:/usr/local/bin:/usr/bin:/bin`, Node24.21.0/npm11.19.0. Reuse existing root dependencies; do not install packages. From worktree: `node --import tsx --test apps/web/test/source-point-map.test.tsx`, `npm run typecheck --workspace=@waspada/web`, and `git diff --check <planning-base>` (staged check for new files). Root owns full web/typecheck/build/smoke and mocked headless desktop/mobile interactions/screenshots, then independent review, integration and push.

Stop/message root for scope/contract conflicts, missing decision or substantive unresolved technical difficulty; continue independent allowed work. No paid APIs, provider acquisition, upstream tiles, deployment, model download, merge, push or shared-service changes.

Commit coherent code/test changes and handoff on the assigned branch. Return exact base, branch/worktree, SHAs and exact messages, changed paths, behavior, actual checks/results, limitations, migrations/configuration impact and remaining decisions. Root alone sets acceptance status; implementers do not approve themselves.

## Implementation handoff — 12 October 2026

Status: implementation complete; root browser QA, independent review and acceptance remain pending. This handoff does not mark the backlog item accepted.

- Base: `1d9100abeab58dbc362fc31b2c57e372638b0d79`.
- Branch/worktree: `work/UI-04-SOURCE-MAP-CLUSTERS`, `.codex-build/worktrees/ui04-source-map-clusters`.
- Implementation commit: `8cef00bd0cb3a87168fa6f3648c4861a7ff22ef5` — `feat(UI-04): cluster unified source map points`.
- Changed paths: `apps/web/src/SourcePointMap.tsx`, `apps/web/src/source-point-map.css`, `apps/web/test/source-point-map.test.tsx`.

The unified map now creates provider-separated display groups on a deterministic 64 world-pixel grid at zoom 4–15. Stable IDs and sorted membership do not depend on viewport pan or input order. OSM groups expose H/P/D category counts; PetaBencana and USGS groups remain separate. Group counts preserve coincident loaded records, invalid coordinates are omitted, the selected record stays individual, and zoom 16+ renders every record individually. Native cluster buttons expose provider/count/ID hooks and accessible descriptions, zoom two bounded levels without selecting an aggregate, and restore focus to the map. Visible map guidance identifies group numbers and anchors as display aids, not incident locations or impact boundaries. Jakarta/regional legacy modes remain unclustered.

Checks actually run in WSL Ubuntu-26.04 with Node `24.21.0` and npm `11.19.0` from the assigned fixed PATH:

- `node --import tsx --test apps/web/test/source-point-map.test.tsx` — passed, 18/18.
- `npm run typecheck --workspace=@waspada/web` — passed.
- `git diff --check 1d9100abeab58dbc362fc31b2c57e372638b0d79` — passed.

Implementation used existing locked React/React DOM `19.3.0`, tsx `4.23.15`, TypeScript `7.0.2` and Vite `8.3.0`; no install was run. No dependency, package/lockfile, API, migration or configuration change was made. No provider, model or tile request was made by the checks. The implementation agent did not run the browser/screenshot suite; root owns that verification, including pointer/keyboard expansion focus and mobile layout. Remaining decisions: none in the assigned implementation scope; root review, browser QA and acceptance are outstanding.

## Collision review follow-up — 12 October 2026

The review found coincident provider aggregates could cover one another, and adjacent 64px grid cells could produce nearly identical anchors. Commit `6fee78c` — `fix(UI-04): separate colliding map clusters` — adds a deterministic display-only placement pass before viewport culling. Aggregate button centers keep at least 56px separation in projected world-pixel space, with offsets bounded to a 16-ring candidate grid (±896px per axis); the pass also leaves room around the selected individual marker. The pass is independent of pan and does not alter cluster membership, member coordinates, mean geographic anchors or source-specific zoom behavior. If inputs exceed the documented provider caps, the bounded helper selects its best-clearance candidate; the normal source caps allow a collision-free placement.

Aggregate buttons keep the `source-point-map__cluster` class and expose `data-source`, `data-count`, `data-cluster-id` and `data-layout-offset`. Visible source labels now use `0.625rem` text in 3rem symbols. The short key above the map explains that counts cover loaded records and symbol placement is display-only; the collapsed legend explains that symbols can shift while activation still zooms to the mean member anchor. The test suite now covers coincident sources, adjacent same-provider cells, stable bounded placement, selected-marker clearance, unchanged mean anchors, and distinct SSR button positions/source labels.

Follow-up checks run in the assigned WSL environment:

- `node --import tsx --test apps/web/test/source-point-map.test.tsx` — passed, 21/21.
- `npm run typecheck --workspace=@waspada/web` — passed.
- `git diff --check 1d9100abeab58dbc362fc31b2c57e372638b0d79` — passed.

The browser/screenshot suite remains root-owned and was not run from this worktree. Root should verify pointer hit-testing for three coincident source groups at 390px and 320px, expansion zoom and focus return, and the existing UI-03 scenarios before acceptance. No migration, configuration or dependency changes were made.

## Root acceptance — 12 October 2026

Accepted on `main` at merge `3c80de9e89a6e63a12e85b63fc6f7f085282f1d9` — `merge(UI-04): integrate reviewed source-map clustering`. Task commits and exact messages, preserved without rewriting history:

- `8cef00bd0cb3a87168fa6f3648c4861a7ff22ef5` — `feat(UI-04): cluster unified source map points`.
- `27d6e888720b08637041eec06320740ef7313d24` — `docs(UI-04): record cluster implementation handoff`.
- `6fee78c1554b01fb8ae456d102b6d5b818632db8` — `fix(UI-04): separate colliding map clusters`.
- `b2fcdcb8572a1f9e08b19f6756da11bbf9ef168b` — `docs(UI-04): record collision review fixes`.

Root reviewed the four allowed paths and the clean worktree, checked integration retained byte-identical component/CSS/test files, and accepted the collision/readability fixes. A separate Luna/max reviewer inspected final code/handoff and desktop/mobile screenshots, independently passed map21/21, web typecheck and assigned-base diff, and found no remaining blockers. Initial provider/adjacent-cell overlap and tiny visible source labels were corrected by the implementer before acceptance; it did not approve its own work.

Root checks in WSL Ubuntu-26.04, native Node24.21.0/npm11.19.0:

- `npm run test --workspace=@waspada/web` from the task worktree —126/126 passed, including map21/21.
- `npm run typecheck` from that worktree — all workspace/evaluation checks passed.
- `npm run build:web` — Vite8.3.0 build passed.
- `npm run smoke` on integrated main — UI/API local smoke passed.
- `git diff --check 0e0c79b` from root — full-turn integrated diff passed after cleaning documentation EOF whitespace.
- Ignored headless Playwright harness `.codex-build/checks/source-cluster-browser.mjs` against the task Vite server — twelve scenario groups passed, zero page errors. It reused existing browser/runtime dependencies, mocked all176 OSM tile requests and all5 source/4 context refresh requests; no upstream provider was acquired. Default preview reads used only the dated local snapshot/not-requested context.

Browser cases verify dense snapshot grouping with loaded100 list preserved; stable visible IDs/counts while panning; native Enter/Space expansion and focus return; no acquisition on cluster interactions; coincident source counts3 OSM/4 PetaBencana/3 USGS with distinct, center-hit-testable source buttons on desktop/390/320; activation to the unchanged geographic anchor; selected-record exclusion; all10 coincident identities at zoom16; prior mixed-source/list/filter/reset/independent-error/tile-failure/cancellation/unknown-live guard behavior. Thirteen desktop/mobile PNGs and the result/log record are under ignored `.codex-build/source-cluster-qa/`; root inspected representative desktop/mobile captures, and the independent reviewer inspected four final captures.

The first root browser attempt reached the existing scenarios but stopped when a new synthetic PetaBencana title violated the fixed-title client contract. Root corrected the fixture and USGS ID/URL correspondence, then the full harness passed; no product validator was loosened. The implementer's new adjacent-cell tests initially had readonly tuple type errors; those were corrected before final checks. No failed intermediate attempt is counted as passing.

Limitations: aggregate anchors/spacing are UI-only, not event geometry. World-space layout is bounded to the documented230-record cap; out-of-contract inputs use best-clearance fallback. Viewport-edge symbols can be clipped; panning and the linked list expose their records. Automated basemap tiles and nonempty report/quake cases are mocked and labelled; this does not establish real tile rendering, publisher accuracy/availability, city coverage, hosted free-tier fit or model quality. No API, migration, dependency, source budget, provider acquisition, model activation, auth mutation, database/cloud configuration or deployment changed. No clustering decision remains pending.
