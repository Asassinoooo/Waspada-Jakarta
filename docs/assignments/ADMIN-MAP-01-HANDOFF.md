# ADMIN-MAP-01 — root integration handoff

**Date:** 10 October 2026 · Team 12

**Status:** Accepted locally on `codex/admin-map-dashboard`. Source baseline for final checks: `02d47a2`. This is the authorized read-only simulation and public-endpoint monitor, not an authenticated private operations release.

## Delivered and reviewed

`#admin` opens a separate web operations shell through the public “Admin demo” link. “Langsung ke peta dan daftar” moves keyboard focus to the workspace without changing screens. Desktop links the queue, dominant coordinate canvas and inspector; narrow web offers list/map switching. Flutter remains unchanged.

The paused-by-default simulator has ten finite steps and varied fictional cases: data preparation, parser quarantine, evidence disagreement, conditional budget-limited investigation, moderator hold, publication example, unmapped notice and source failure. Playback pauses while hidden and never calls a source, model or publication service. API mode observes only existing public context, a first page of at most 20 events and GeoJSON. It has 30-second polling after a cycle, one flight, a 15-second deadline per endpoint, abort/discard on inactivity, and failure backoff capped at five minutes. Its observations are independent reads, not an atomic database snapshot or full-stack telemetry.

Root review corrected old-snapshot exposure during a new context read, timestamp collisions at mode entry, date/range contract validation, synthetic API geometry being incorrectly hidden, and pipeline-completion wording on public projections. Event lifecycle, freshness, source validity, source publication/observation, event publication and browser retrieval remain separate. Public source attributions are unique by name/URL/timestamps and capped at 20; source links suppress referrers. Dataset kind is derived from validated `context.dataset_label`; the public event DTO does not independently expose a per-record dataset-kind field.

Map geometry matches exact loaded event/version identity. All six GeoJSON variants, polygon holes and multiple geometries per event retain their coordinates. Initial camera fit occurs once per mode when valid geometry arrives; subsequent equivalent refreshes preserve the manual camera. Annotation cards use bounded deterministic screen placement and leader lines without moving source vertices. No road network, administrative boundary, basemap, danger radius or area-safety inference is fabricated. When geometry is unobserved the map panel explains the missing observation; it does not label those events unmapped or report zero coverage.

Screenshot review found and fixed 320px/200% heading/chip/control overflow, overlapping initial map annotations, a 40px text action, and unnecessary desktop filter wrapping. Admin JavaScript and CSS load only with the admin route. Internal queue/model/tool/audit measurements remain unavailable in actual mode; simulation values never substitute for them.

## Agent commits and integration

Each implementer used its assigned branch/worktree, committed source and a separate handoff, and did not push. Luna/max handled data and UI; Sol 6.1/max handled complex SVG/map interaction only. Root reviewed, cherry-picked, corrected integration and periodically pushed the integration branch.

| Package | Agent source commits → root commits | Detailed handoff |
| --- | --- | --- |
| ADMIN-DATA-01 | `b450eae` → `e631961`; `965f6de` → `0902c55`; `97646bf` → `cd3bc75`; `3a8ec93` → `d8d4c96` | [Monitoring/data handoff](ADMIN-DATA-01-HANDOFF.md) |
| ADMIN-UI-01 | `5842ffa` → `61e37d1`; `14634e4` → `ec36b97`; `2d3b2e6` → `a0c1596` | [Dashboard UI handoff](ADMIN-UI-01-HANDOFF.md) |
| ADMIN-MAP-VISUAL-01 | `6b443bd` → `8c4c50d`; `74d7f79` → `9789375` | [Map visual handoff](ADMIN-MAP-VISUAL-01-HANDOFF.md) |

Root source changes include shared client types, lazy routing/styles, test registration, failed-geometry withholding and workspace navigation (`c317c9c`, `90bf6aa`, `57c31bf`, `02d47a2`). Source handoffs retain the implementers' actual checks at their branch checkpoints. Root applied the later data-handoff command clarification from amended `5f6adc1` after integrating original `8ba4d3f`; source `3a8ec93` was unchanged.

## Actual validation

Project commands ran in **WSL Ubuntu-26.04**, Node **24.21.0**, npm **11.19.0**, with existing dependencies. No compiler, package or runtime was installed for this wave.

| Check | Result |
| --- | --- |
| `npm run test --workspace=@waspada/web` | **112/112 passed**: 80 existing web tests plus 14 monitoring, 6 dashboard and 12 map tests |
| `npm run build` | Full web/Worker/DB/evaluation TypeScript passed; Vite production build and Worker deploy **dry-run** passed |
| `WASPADA_SMOKE_ORIGIN=http://127.0.0.1:55173 npm run smoke` | Local shell and real demo context/list/detail/history reads passed |
| Assigned-base WSL `git diff c2a4cd7 HEAD --check` | Passed after normalizing handoff whitespace |
| Changed Markdown local-link check | **712 local file targets resolve**; not an external-link or heading-anchor audit |

Browser automation used installed **headless Chrome** and bundled Playwright on Windows against Vite and Wrangler running in WSL. No visible browser/computer control was used. The final dashboard sweep passed **18 states / 36 screenshots** across 1440px, 1024px, 390px and 320px, including 200% root text size. It covered linked selection, filters, keyboard map/workspace/skip navigation, finite playback/pause/replay, actual demo Worker reads, a separately intercepted synthetic geometry/date/attribution fixture, partial/context errors, offline, hidden/pause/resume, mode isolation, reduced motion and public return. No browser runtime error or document horizontal overflow remained. The actual Worker returns two synthetic records, empty GeoJSON and no registered sources; populated-geometry browser checks were explicit QA fixtures. The public regression sweep also passed 16 layout variants plus detail, privacy-reset, context-failure and reduced-motion checks.

Temporary QA scripts, screenshots and production outputs remain ignored under `.codex-build` and app `dist` folders. Final dashboard evidence is under `.codex-build/screenshots/admin`; root inspected desktop, mobile/large-text and API screenshots before acceptance. This is not a manual screen-reader, human usability or physical-device audit. The Worker/DB test suites were not rerun for this client-only change; full project typechecking/build did include those packages.

### Production bundle

| Asset | Before wave kB / gzip kB | Final kB / gzip kB |
| --- | --- | --- |
| Public entry CSS | 53.17 / 9.92 | 53.17 / 9.92 |
| Public entry JavaScript | 352.11 / 100.42 | 354.46 / 101.32 |
| Conditional admin CSS | — | 30.04 / 6.34 |
| Conditional admin JavaScript | — | 99.09 / 27.92 |

Initial public CSS is unchanged and entry JavaScript adds about **0.90 kB gzip**. Opening admin loads about **34.26 kB gzip** of additional route assets. No runtime dependency, external font or tile request was added. These are local build sizes, not hosted latency or a free-tier capacity guarantee.

## Remaining gates

Private operations need a separately authenticated, least-privilege, redacted monitoring provider. Source rights, independently reviewed evaluation, real source/model runs, hosted Cloudflare/Neon Free behavior/recovery, manual accessibility and human usability remain open. No backend/public API, schema, migration, source connector, model provider, moderator write, Flutter code, deployment, hosted service or billing configuration changed. Annotation placement is bounded; densely coincident records can still overlap when there are more cards than screen slots, and the complete linked queue remains available.
