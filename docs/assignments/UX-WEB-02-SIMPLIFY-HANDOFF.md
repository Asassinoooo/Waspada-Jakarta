# UX-WEB-02 — navigation and admin clarity handoff

Date: 13 October 2026 · Team 12. Status: accepted locally after independent Luna/max review and root verification. [Assignment](UX-WEB-02-SIMPLIFY.md), [ADR-058](../decisions/ADR-058-ux-web-integration.md). This refines accepted UX-WEB-01; source integration provenance remains in its [handoff](UX-WEB-01-INTEGRATION-HANDOFF.md).

## Delivered behavior

Public primary navigation now has four choices: **Beranda**, **Peta & laporan**, **Untuk Anda**, and **Bantuan**. Labelled contextual choices keep published reports/source maps and interests/updates accessible. Help combines guide/privacy under one main landmark; old `#panduan` and `#privasi` links focus their sections. Privacy confirmation, verified deletion of the two owned browser keys, preservation of unrelated keys and root refresh callback remain. Operator tools are linked through help/footer, outside resident primary navigation. The local inspector link and route require development plus confirmed demo; production excludes the private module/endpoint/text.

Admin explains its purpose as reading reports, source evidence, time/status and location. Default hierarchy is search, report list, map and selected detail. **Contoh tampilan** shows paused finite fictional examples; **Data aplikasi** observes existing public GET data. Filters and complete source/time/ID/process/request details are native, keyboard-accessible disclosures. Missing private telemetry remains unavailable. Simulation-only priority remains in optional details and explicitly describes workflow order, not danger or severity. Source-supported vertices, lifecycle/freshness/validity semantics and separate source/event/publication/browser times remain unchanged. Grid lines are coordinate guides, not official boundaries or inferred zones.

Screenshot review led to tighter desktop header/control spacing, a transport/search row that stacks on mobile, subordinate map heading and clearer location labels. For the same default seven fictional items at1440×1000, the full-page capture fell from3643px in UX-WEB-01 to2360px. The first UX-WEB-02 canvas began near978px; final canvas begins at782px and workspace at468px. These are local fixture layout measurements, not general usability or performance guarantees. Expanded details remain complete; no clipping replaces content.

Existing unified source map/clusters, read-only evidence review, local private inspector/proxy and15-minute model waits remain. Public monitor behavior is unchanged: existing context/first20 events/GeoJSON only,30-second active/visible polling,15-second GET deadline, cancellation and bounded backoff. No backend/API/type/model/provider/auth/source/hosting/dependency/migration/grant changes occurred.

## Branches and coherent commits

| Package / assigned branch and worktree | Exact package commit and message | Root copy |
| --- | --- | --- |
| NAV / `codex/ux-web-grouped-navigation` / `.codex-build/worktrees/ux-web-grouped-navigation` | `d023f1aa664f2f56d50658884bb909ec584eeecc` — `feat(UX-WEB-02): group resident navigation and help` | 4b3d178 |
| NAV, same branch/worktree | `ee86c032abe40b23f8382466e7d6d50f0bf8d0ca` — `fix(UX-WEB-02): gate inspector and clarify operator tools` | f5decf6 |
| NAV, same branch/worktree | `1a4fc05546770e8290564e988b99a71c860c79fd` — `test(UX-WEB-02): assert grouped preferences navigation` | c5f9b7a |
| ADMIN / `codex/ux-web-clear-admin` / `.codex-build/worktrees/ux-web-clear-admin` | `3129fe865213060ebe3fdeca504413f902b0f277` — `fix(UX-WEB-02-ADMIN): simplify read-only dashboard` | 36bde68 |
| ADMIN, same branch/worktree | `3382fa2e85ff64ecb7b8a67701e5f994ec8e4154` — `fix(UX-WEB-02-ADMIN): clarify map location labels` | e20512d |
| ADMIN, same branch/worktree | `e74b0522b203e4ad20a0615cdb26f013b9168843` — `fix(UX-WEB-02-ADMIN): disclose example processing order` | 6932750 |
| ADMIN, same branch/worktree | `c7e0f85bc0b0ddaa87759c524fc6d729ef9e115c` — `style(UX-WEB-02-ADMIN): compact desktop dashboard header` | 3c03750 |

Root assignment `d7c89e2` — `docs(UX-WEB-02): assign grouped menus and readable admin`; task tracking `0a6915f` — `docs(UX-WEB-02): track navigation and admin clarity packages`. Root reviewed diffs before copying; independent Luna/max reviewer cleared final packages. No Astra escalation, subdelegation or agent push occurred. Meaningful edits/checks/commits used assigned isolated worktrees. During a NAV follow-up the agent briefly created an unnecessary temporary worktree; root corrected the handoff and the unused tree/branch was removed before the assigned changes were completed.

Changed code/test paths: App/main/styles; HelpPage/help CSS; embedded ReadGuide/PrivacyPage; AdminDashboard/AdminOperationsMap and CSS; display copy only in admin fixtures; ui/experience/preferences/admin-dashboard/admin-map tests. Root maintains plan/architecture/UX/backlog/README, ADR/index, assignment/handoff and delivery log. No contract/client/monitoring/Worker/database/source connector/provider/Vite configuration or lockfile changed.

## Actual checks

All runtime checks used WSL Ubuntu-26.04 with existing native Node24.21.0/npm11.19.0, React19.3/Vite8.3/tsx4.23.15/TypeScript7.0.2/Wrangler4.137.0. No installation or upgrade.

| Check | Actual result |
| --- | --- |
| NAV `node --import tsx --test test/ui.test.tsx test/experience.test.tsx` from `apps/web` | 23/23; web typecheck/build and diff checks passed. |
| NAV follow-up including `test/preferences.test.tsx` | 36/36; typecheck and diff checks passed. |
| ADMIN dashboard/map/monitoring focused command | Initially32/32; final33/33 after the priority regression; web typecheck and diff checks passed. |
| Independent reviewer | Five affected suites55/55 and web typecheck passed; final dashboard/map follow-up19/19. Read-only final code/CSS/screenshot review found no remaining concrete issue. |
| Root `npm run test --workspace=@waspada/web` | **183/183 passed**. The first complete run was182/183 because one preferences navigation test expected the old menu label; fixed on the assigned NAV branch and rerun. |
| Root `npm run build` | All workspace/tool typechecks, production Vite build and Wrangler deploy **dry-run** passed. |
| Root `npm run smoke` | Local shell/context/list/detail/history, demo/time/evidence/geometry checks passed. |
| WSL headless Playwright | **23 scenario groups / 26 screenshots**; zero browser errors and document overflow at checked sizes. Desktop1440, mobile390 and320px with200% root text. |
| Production bundle inspection | Private pipeline route/endpoint/module/text absent from emitted JS; separate lazy admin JS/CSS absent from initial HTML. |
| Local documentation links | 796 links across the ten updated delivery documents resolve to existing files. |
| Diff checks | Passed. Broader Worker/DB/model suites were not rerun for presentation-only changes. |

Browser coverage includes four primary groups/contextual navigation; landing loading/empty/error/pending recovery; help single main/section aliases/focus and confirmed reset preserving unrelated storage; paused simulator without network, search empty/recovery, complete expanded trace/priority, start/pause, mobile list/map/selected detail; actual public monitor and expanded source/status/time details; exact-version synthetic geometry fixture; unknown geometry on fetch failure; pause/offline/hidden-visible recovery and mode isolation; retained unified source map/private inspector; reduced motion. Root inspected desktop, mobile, expanded/detail and large-text screenshots, refined the header spacing and reran QA.

Browser external requests were blocked. All observed API/inspector methods were GET; zero network mutations, source acquisition or model calls. Actual public API contains four synthetic records and its default GeoJSON is empty. The populated geometry test explicitly intercepts one authored matching synthetic point; it is not published or persisted. The private view only reads earlier stored synthetic pipeline results, including a zero-claim/one-unresolved proposal.

Ignored evidence lives under `.codex-build/checks/ux-web-simplify-*` and `.codex-build/ux-web-simplify-qa/receipt.json` with26 captures. Final build: main JS434.11kB/122.18kB gzip, CSS93.62kB/15.34kB gzip; lazy admin JS97.75kB/27.07kB gzip, CSS31.45kB/6.42kB gzip. Unchanged Worker997.75KiB/192.63KiB gzip. These local outputs do not verify hosted latency/capacity.

## Startup and remaining gates

In WSL `/mnt/d/Projects/RPL`:

```sh
export PATH=/home/perry/.nvm/versions/node/v24.21.0/bin:/usr/local/bin:/usr/bin:/bin
npm run dev
```

Open [Beranda](http://127.0.0.1:5173/#beranda), [Bantuan](http://127.0.0.1:5173/#bantuan), [Pengelola](http://127.0.0.1:5173/#admin), or [Peta sumber](http://127.0.0.1:5173/#demo-sumber). Existing dev servers remain available. Private state ownership/startup remains in [LOCAL_PRIVATE_PIPELINE.md](../LOCAL_PRIVATE_PIPELINE.md); do not open a second process for the same PGlite state.

Authenticated private monitoring, real-source rights/retention/model-transfer terms, independent human quality labels, hosted Cloudflare/Neon verification and manual screen-reader/physical-device usability remain gates. This work activates no provider/source, public event, moderator write, deployment, cloud configuration or paid service. Root pushes reviewed integration checkpoints; checkpoint c5f9b7a already reached origin/main before final CSS/documentation.
