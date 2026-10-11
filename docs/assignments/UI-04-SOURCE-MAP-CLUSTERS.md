# UI-04-SOURCE-MAP-CLUSTERS

Status: assigned, 12 October 2026. User authorizes map clustering, followed by advice on models for the AI pipeline. This package implements clustering only; model advice does not authorize a provider, hosted binding, paid usage or model download.

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
