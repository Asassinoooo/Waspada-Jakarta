# UI-01-OSM-MAP-DEMO

Objective: dependency-free interactive OSM tile map for the isolated source preview. Dependencies: `docs/DEMO_DATA_INTEGRATION.md`, source-preview-v1. Existing public v1/schema 2.0 unchanged.

Branch `work/UI-01-OSM-MAP-DEMO`, worktree `.codex-build/worktrees/ui01-osm-demo`. Base: planning commit containing assignment; record exact SHA. Allowed: `apps/web/src/SourcePointMap.tsx`, `apps/web/src/source-point-map.css`, `apps/web/test/source-point-map.test.tsx`, this assignment's handoff only. No App, existing MapPanel, global CSS, package, shared contract edits. Root registers tests.

Interface: `SourcePointMap({points, selectedId, onSelect, onReturnToList?})`, `points: readonly PreviewRecord[]`, selection string|null; callback `(id:string)=>void`; return callback `()=>void`. Import `PreviewRecord` from `@waspada/worker/source-preview-contracts` (root will add export). Use only these source-supported points, default central Jakarta viewport centre `[106.83,-6.19]`, zoom12. Web Mercator tiles, viewport-only HTTPS OSM tiles, ordinary browser cache/Referer, visible copyright/link, no bulk prefetch/offline/service-worker/proxy. Configurable tile template prop optional; strict HTTPS XYZ template if provided. Include pan/zoom/reset with bounds, keyboard and pointer drag controls, category letters/labels beyond colour, selection highlighting and recentering, no radii/geolocation/danger score. Handle ResizeObserver and SSR initial dimensions, mobile sizes, tile failures with useful list fallback. Avoid requests for out-of-world tiles or rendering unbounded tiles. Honour reduced-motion/no animations. Selected controls must not bubble into pan; prevent unintended page scrolling only when map focused. Scoped CSS uses existing civic token palette. Clearly distinguish OSM facility references versus unreviewed citizen reports; source extent centres are approximate. UI can't imply operational response availability.

Verification in WSL Ubuntu-26.04: existing Node v24.21.0 PATH/dependencies; `node --import tsx --test apps/web/test/source-point-map.test.tsx`; relevant typecheck if export available; diff check. Test projection alignment/inverse, bounds/tile counts, labels/attribution/selection/empty state with synthetic fixtures explicitly named as such; no actual tile/source network. Browser screenshot QA done by root with mocked tiles. Stop for contract/scope/dependency changes. Commit implementation plus handoff; no merge/push/deploy/provider configuration/further agents.

## Handoff

**Branch/worktree:** `work/UI-01-OSM-MAP-DEMO`, `.codex-build/worktrees/ui01-osm-demo`.

**Base:** The assignment was created on `95c4113490cf41b920978811184fde312534d43e`. Before implementation, the root fast-forwarded this task branch to `0270af0c0b0233f467bcf680315f3df49f76a331` to include the approved `source_created_at` field correction in `source-preview-v1`; implementation used that corrected contract.

**Implementation commit:** `4e4df751975bbc2a5557a807e7a74872277b2b8b` — `feat(UI-01): add source preview OSM point map`.

**Review follow-up:** `472ff6e0cb833041b94a3fbf348117268b77a755` — `fix(UI-01): simplify map fallback and referrer policy`. This removes the decorative tile fallback pattern, shortens the map notice to the three source-specific cautions, and sets `strict-origin-when-cross-origin` on tile images.

**Changed paths:** `apps/web/src/SourcePointMap.tsx`, `apps/web/src/source-point-map.css`, `apps/web/test/source-point-map.test.tsx`.

The component renders only the supplied source-supported points on bounded viewport-only Web Mercator OSM tiles. It starts at central Jakarta `[106.83, -6.19]`, zoom 12, and supports keyboard and pointer panning, bounded zoom, reset, selected-point recentering and highlighting, compact category symbols with labels revealed on hover, keyboard focus, or selection, OSM attribution, SSR dimensions with `ResizeObserver` updates, tile failure messaging/retry, and an optional return-to-list callback. OSM facility references and unreviewed PetaBencana citizen reports are labelled separately; OSM extent-centre points are described as approximate. No danger radius, geolocation, safety rating, upstream source acquisition, or public incident contract was added.

**Checks run in WSL Ubuntu-26.04:**

- `node --import tsx --test apps/web/test/source-point-map.test.tsx` — 6/6 passed with synthetic fixtures; no tile or source network was used.
- `npm run typecheck --workspace=@waspada/web` — passed.
- `git diff --cached --check` — passed before the implementation commit.

Versions at implementation: Node.js 24.21.0, npm 11.19.0, React/React DOM 19.3.0, tsx 4.23.15, and TypeScript 7.0.2. No dependency was added or installed.

**Impact and remaining work:** No migration, package, runtime configuration, or shared contract change. The root must import the scoped CSS and register the new test, then complete app integration and desktop/mobile screenshot QA with mocked tile requests. Browser behavior against real OSM tiles and live source data was not tested. Root acceptance remains pending.

**Visual refinement:** `c2def5f` — `fix(UI-01): compact source map markers`. After root screenshot QA showed the 100 visible facility labels merging into a large cluster, inactive map markers were reduced to 1.9rem H/P/D/B symbols. Hospital uses a circle, police a rounded square, fire station a diamond, and PetaBencana a red octagon; the legend uses matching shapes. Category and point-name labels expand on pointer hover, keyboard focus, or selection, with the active marker layered above neighboring markers. Full accessible button labels and titles remain available. Changed paths: `apps/web/src/SourcePointMap.tsx`, `apps/web/src/source-point-map.css`, `apps/web/test/source-point-map.test.tsx`, and this handoff.

**Visual refinement checks:** `node --import tsx --test apps/web/test/source-point-map.test.tsx` — 6/6 passed; `npm run typecheck --workspace=@waspada/web` — passed; `git diff --check` — passed. No live tile or source network was used. Root desktop/mobile screenshot review with mocked tile requests is still pending.
