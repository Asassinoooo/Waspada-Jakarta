# UX-WEB-01 — integration handoff

Date: 13 October 2026 · Team12. Status: accepted locally after independent Luna/max review and root checks. [Assignment](UX-WEB-01-INTEGRATION.md), [ADR-058](../decisions/ADR-058-ux-web-integration.md). Source: **Main Development (UX)**, read through the referenced task before use; clean branch `codex/admin-map-dashboard` at `cad1d2ef7776692ea8911d48e6fc161887df49af`. Original source IDs UI-LANDING-01/UI-EXPERIENCE-01/UI-HERO-02/ADMIN-MAP-01 are preserved.

## Delivered

`#beranda` and an empty hash open the account-free landing with a static decorative Jakarta SVG, short reading guide, first-three report preview, claim-scoped attribution and explicit demo/empty/error/loading states. Pending dataset context has its own loading state and cannot expose prior reports or offer premature retry. Linked `#panduan` and `#privasi` resolve; privacy reset confirms and verifies only the existing preferences/update-cursor keys and preserves unrelated browser data. Map-tile request disclosure reflects the current OpenStreetMap integration.

`#admin` lazy-loads a separate read-only web operations shell. Default is paused finite simulation, with fictional processes/geography labelled throughout. Public monitor reads existing context, the first20 events and GeoJSON; it polls every30seconds while active/visible, bounds GETs at15seconds, backs off and cancels on pause/offline/inactivity. These public-GET limits do not change15-minute local AI waits. Private queue/model/tool/audit/gate metrics remain unavailable. Exact event/version geometry appears on a coordinate canvas, without invented basemap/boundaries/danger radius. No private operations, authentication or publication writes are enabled.

Main's existing unified source map/clusters, current API clients, local pipeline development/demo guards, Vite proxy and backend/config remain. Landing/admin use current colors/typography, flat surfaces, small corners and readable controls. Large-text QA required bounded root CSS fixes to intrinsic grid width and text wrapping in the existing map/pipeline; source vertices, camera logic, requests, budgets and data did not change. Unrelated Flutter, stale shared snapshots, global public-polish styles and colliding source ADR054/055 documents were not imported. This is selective web integration, with original source provenance recorded below.

## Branches and commits

| Implementer / branch / worktree | Exact source-package commits and messages | Root accepted copies |
| --- | --- | --- |
| Landing / `codex/ux-web-landing-integration` / `.codex-build/worktrees/ux-web-landing-integration` | `02e04aab03a1c56a9c3f5b133154f44a2b477db8` — `feat(UI-LANDING-01): add landing and privacy experience` | 8f8e8c8 |
| Landing, same branch/worktree | `f5ad9961969d611254edfa98daef09ff7d5e7a7e` — `fix(UI-LANDING-01): disclose map tile requests in privacy page` | 40af003 |
| Landing, same branch/worktree | `a724f7ddcfec2b17c2ebaa2bc18de8eb8c886d19` — `fix(UI-LANDING-01): wrap landing content on narrow screens` | ef16ce3 |
| Landing, same branch/worktree | `57c18e976979bef238619b91ed2162eef68d62a3` — `fix(UI-LANDING-01): distinguish pending dataset context` | caec575 |
| Admin / `codex/ux-web-admin-integration` / `.codex-build/worktrees/ux-web-admin-integration` | `a3b0ea781aa3cec0c32450d3c7456e56b88e33f9` — `feat(web): integrate read-only admin map dashboard` | df07d4d |

Root planning `90be91f` — `docs(UX-WEB-01): assign landing and admin branch integration`; composition `e865e87` — `feat(UX-WEB-01): compose landing and read-only admin routes`; root CSS `40575ba` — `fix(UX-WEB-01): keep existing views readable at large text`. Root reviewed diffs before copying; independent reviewer cleared final components/composition and remaining CSS. Agents changed only assigned paths, committed on clean isolated task trees, did not push/subdelegate, and used Luna/max without escalation.

Changed paths: nine landing/guide/privacy source/test paths and eleven admin source/test paths; root App/main entry, existing navigation/global CSS, source/pipeline responsive CSS, web test script and route test; plan/architecture/UX specification/backlog/README, ADR/index and handoff/log. No lockfile/dependency, Worker code, public contract, database schema/migration/grant, model/provider, real-source connector, Vite proxy, hosted or billing configuration changed.

## Actual checks

WSL Ubuntu-26.04, installed native Node24.21.0/npm11.19.0, React19.3/Vite8.3/tsx4.23.15/TypeScript7.0.2/Wrangler4.137.0. No install.

| Check | Actual result |
| --- | --- |
| Agent landing/experience focused suites | Initially14/14; final pending-state follow-up15/15; web typecheck passed. Mobile CSS package also passed full typecheck/Vite/Worker dry-run build. |
| Agent admin focused suites | 32/32; web typecheck and diff checks passed. |
| Independent reviewer | Five focused suites46/46, typecheck/build and diff checks; follow-up landing15/15 and read-only final CSS review cleared. No provider/source/private-inspector calls. |
| Root `npm run test --workspace=@waspada/web` | **181/181 passed**; earlier composition180/180 before the new pending-state test. Existing map/clustering/pipeline suites remained registered. |
| Root `npm run build` | Workspace/tool typechecks, Vite production build and Worker deploy **dry-run** passed. |
| Root `npm run smoke` | Local shell/context/list/detail/history, demo labels, returned times and honest evidence/geometry states passed. |
| Root WSL headless Playwright | **22 scenario groups /16 screenshots**, zero browser errors/document overflow at checked sizes. Desktop1440, mobile390,320px with200% root text. External requests blocked, no source/model acquisition or network mutation. |
| Production bundle inspection | Admin JS/CSS separate and absent from initial HTML; private pipeline endpoint/route/module/text absent from emitted JS. |
| `git diff --check` / staged diff check | Passed; existing unrelated CRLF notices do not represent changed content. |

Browser groups cover account-free landing; claimed-data/context gates; loading/empty/error; pending-context recovery; guide/skip/workspace navigation; confirmed privacy reset preserving an unrelated key; paused simulation with no network; start/pause and mobile list/map; actual local public API monitoring; exact-version geometry in an explicitly intercepted synthetic fixture; unavailable geometry; pause/offline/visible recovery and mode isolation; return to public UI; existing unified map and private pipeline; reduced motion. Root inspected desktop/mobile/admin API/large-text screenshots. Actual default public API GeoJSON remains empty; the populated point was a QA fixture, not a new published event. The private view reads the earlier successful stored synthetic proposal (zero claims/one unresolved item) without re-running AI.

QA corrections are retained honestly: the first large-text checks found new nav/CTA overflow and pre-existing implicit map/pipeline grid widths, fixed with wrapping instead of hiding/cropping; initial harness used a wrong privacy heading and attempted to change fixture mode via same-document hash navigation without reloading, corrected before final22 groups. The16 count is the final screenshot set; three older `*-overflow.png` captures are retained separately as failure evidence. The old owned root dev Worker stopped responding to bounded health probes; root stopped only its verified root dev/QA processes and restarted `npm run dev`. The new service passed health/smoke, source-task servers and private inspector were preserved. These interrupted/failed checks are not reported as passes. No new model timeout diagnosis or backend fix is claimed.

Final build sizes: initial web JS431.13kB/121.62kB gzip, CSS91.79kB/15.05kB gzip; lazy admin JS99.09kB/27.92kB gzip, CSS29.90kB/6.18kB gzip. Worker unchanged997.75KiB/192.63KiB gzip. Measurements are local build outputs, not hosted capacity/latency guarantees. Wider Worker/DB/model test suites were not rerun for this client-only change; typechecks/build include those workspaces.

## Startup and remaining gates

From WSL `/mnt/d/Projects/RPL`, use the existing Node PATH and `npm run dev`, then open [Beranda](http://127.0.0.1:5173/#beranda), [Admin demo](http://127.0.0.1:5173/#admin) or [Demo sumber](http://127.0.0.1:5173/#demo-sumber). The root dev pair was left available. Existing private inspector ownership/profile commands remain in [LOCAL_PRIVATE_PIPELINE.md](../LOCAL_PRIVATE_PIPELINE.md); admin cannot start/read that pipeline. Do not start a second process for the same PGlite state.

Production private operations require separately authenticated/redacted monitoring; real-source rights, human quality labels, hosted Cloudflare/Neon behavior and manual screen-reader/usability/physical-device checks remain open. No deployment, service purchase/configuration, model call, publication or moderator mutation occurred. Root pushes reviewed integration checkpoints; the source UX branch is retained unchanged.
