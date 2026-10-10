# ADMIN-MAP-01 — web operations workspace

**Date:** 10 October 2026

**Status:** Assigned. Integration branch `codex/admin-map-dashboard`; root plans, reviews, integrates and pushes.

## Authorized scope

Team 12 requested a detailed, understandable, map-oriented admin dashboard that monitors data flow while open, for web only. The team selected **complete operational demo plus real monitoring of existing public endpoints**. Private authentication/monitoring and hosted configuration are not activated. This is a read-only operations workspace, not permission to expose private logs or enable moderator writes. Flutter and existing public contracts remain unchanged.

Two explicit modes must never be blended:

1. **Simulasi alur:** labelled fictional operational cases and geography demonstrate L1 ingestion/preparation, L2 retrieval/grounding, conditional L3 bounded investigation, L4 review/publication and cross-layer L5 monitoring. Any progression is a controlled local simulator, not live acquisition or telemetry.
2. **Pantauan API:** actual reads of existing context, bounded public event page and GeoJSON endpoints. Show measured browser request duration, last successful observation, source health from context, and returned published data/geometry. Internal queues, model usage, full-stack health and private traces are **unavailable**, not zero or estimated. Server demo/live dataset and individual dataset kind remain visible independently from connection status.

## Visual direction and wireframe

Reuse six named tokens: Tinta Kota `#18323A`, Kali Teal `#087B75`, Kertas `#FFFFFF`, Beton `#D5DEDB`, Kuning Perhatian `#E7B448`, Merah Tanda `#A7433B`. Reuse system/available typography; no external font or dependency. Dense readable labels, tabular times, 4/8px spacing, obvious focus and 44px controls. Operational severity is never a danger rating.

```text
Desktop
┌ Admin · read-only ─ mode switch ─ connection / observed time ─ refresh/pause ┐
│ Explicit demo/API provenance and dataset notice                             │
├ Filters ───────────────────────────────────────────────────────────────────┤
├ Case queue ────────────┬ Main geographic workspace ────────┬ Case inspector ┤
│ text/status/layer      │ linked selectable geometries     │ summary/evidence│
│ mapped + unmapped      │ zoom/pan/reset + legend           │ timeline/budget │
│ bounded visible count  │ no inferred danger radius        │ gates + reasons │
├ Five-layer process overview, including unavailable private measurements ──┤
├ Sources / recent activity / request observations / monitoring limits ─────┤
```

At narrow widths use a map/list switch and stacked inspector; do not hide unmapped cases or make map interaction mandatory. The page is available on the web only. A keyboard-operable geographic coordinate view is acceptable before approved basemap rights; no invented roads, municipal boundaries or real geography illustration presented as authoritative.

## Parallel ownership

| Slice | Branch/worktree | Model | Allowed paths |
| --- | --- | --- | --- |
| ADMIN-DATA-01 | `work/ADMIN-DATA-01`, `C:/Users/perry/.codex/worktrees/admin-data-v1/RPL` | GPT-6 Luna/max | `apps/web/src/admin-monitoring.ts`, `apps/web/src/admin-fixtures.ts`, `apps/web/test/admin-monitoring.test.ts`, own handoff |
| ADMIN-UI-01 | `work/ADMIN-UI-01`, `C:/Users/perry/.codex/worktrees/admin-ui-v1/RPL` | GPT-6 Luna/max | `apps/web/src/AdminDashboard.tsx`, `apps/web/src/admin-dashboard.css`, `apps/web/test/admin-dashboard.test.tsx`, own handoff |
| ADMIN-MAP-01 | `work/ADMIN-MAP-VISUAL-01`, `C:/Users/perry/.codex/worktrees/admin-map-v1/RPL` | GPT-6.1 Sol/max, complex map SVG/interaction only | `apps/web/src/AdminOperationsMap.tsx`, `apps/web/src/admin-map.css`, `apps/web/test/admin-map.test.tsx`, own handoff |
| Root | `codex/admin-map-dashboard` | Planner/reviewer | Shared `admin-types.ts`, routing/imports/scripts, planning/status docs, integration fixes and QA |

Agents read the SDP, UX/API spec, backlog and this assignment, use their own branch/worktree, commit source and a separate handoff, and do not push. Coordinate shared type decisions with root; do not overwrite other slices. Root periodically pushes integration checkpoints. Each handoff states actual checks and limitations.

## Acceptance and runtime budgets

- Route `#admin`, direct public-site return, persistent read-only/demo notice; no authentication claim, login/storage token, mutations, acquisition, inference or publication triggered by opening the page.
- Map and queue selection agree; preserve selection only while its exact item remains in the current filtered snapshot. Unmapped cases remain actionable. Synthetic geometry is confined to simulation; API mode renders only source-projected geometry whose event/version matches a loaded public record. Map covers only the loaded snapshot, not all Jakarta or every event.
- Five layers remain distinct. L3 is conditional with finite budgets, stop reason and escalation. L4 approval is a deterministic/human gate; no proposed event is shown as published. L5 is cross-layer observability, not another publication approval step.
- Existing real reads poll every **30 seconds** only while `#admin` is active, document visible, online and polling enabled. Single flight, bounded payload via existing clients, abort/discard late results, manual refresh cannot fan out; pause/unmount/hidden cancels requests/timers. Backoff on repeated failure; no browser persistence of operational snapshots. No event/detail fan-out or new backend query/endpoint.
- Show loading, zero returned records, unmapped geometry, unavailable sources, partial request failure, stale last observation, offline, paused and hidden behavior. Actual probe latency is browser-observed duration, not server latency or model performance. Failed telemetry is unavailable, never healthy/zero.
- Simulator progresses through a finite scripted sequence only while visible, with start/pause/replay and immutable input fixtures. Timings/counts/geometries are labelled synthetic. It never writes or changes existing demo publication data.
- WSL Ubuntu-26.04 meaningful unit/component tests, integrated web suite, full typecheck/build, local smoke and headless desktop/mobile screenshots plus keyboard/reduced-motion/large-text checks. No computer use, external tiles/font requests, new dependency, paid/hosted change or native build.

Live private operations, private source IDs/content, audit logs and real model/token/queue observations require a separate authenticated L4 projection and data provider. Document that gate clearly rather than fabricate coverage.
