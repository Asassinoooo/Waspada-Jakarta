# Agent worklog (living handoff)

**Read this first, update it last.** This file holds the current state of the work so that any agent (Claude, Codex, Copilot, a human) can take over without the previous conversation. The longer records stay where they are:
- `docs/IMPLEMENTATION_BACKLOG.md`: one row per task ID, with its design and status.
- `docs/testing/`: defects, test summary and evidence.
- `docs/decisions/`: ADRs.

This file links to them. It does not copy them.

## Rules for every agent

1. **At the start of a task:**
   - read sections 1–3 of this file;
   - add your task to section 2, with its ID, branch and a one-line goal.
2. **While working:**
   - when the state changes (merged, deployed, blocked, owner decision), update section 1 or 2 in the same branch as the code;
   - don't wait for the end of the session, because sessions run out of context.
3. **At the end of a task:**
   - move it from section 2 to section 4 (newest first), with the commit or merge SHA and the checks you actually ran;
   - add any follow-up to section 3;
   - add or update the task's row in `IMPLEMENTATION_BACKLOG.md`.
4. **What goes in:** facts only. Use dates in the form `24 Nov 2026`, SHAs, commands and results. Never write "tests pass" without saying which command ran. Mark anything not checked as **not verified**.
5. **What stays out:** secrets, keys, endpoints, raw prompts, vectors, and real user data.
6. **Commits:** commit this file with the work it describes, using the task's own commit message (`docs(<ID>): ...` for doc-only changes). Commits use the local Git identity and carry no AI attribution.
7. **Length:**
   - keep section 4 to about the last 20 entries, and move older ones into the backlog rows;
   - keep the whole file under about 300 lines.

## 1. Current state

| Item | Value |
| --- | --- |
| Updated | 24 Nov 2026 (plan: `PERF/MOBILE-REL/HIST-UI/GUI-03` round approved by owner) |
| `main` | `fb0348a` plus this doc (AGENT-LOG-01) |
| Production | https://waspada-jakarta.waspada-worker.workers.dev. Worker version `3b918744…`, deployed 24 Nov 2026 by CD (CI run 45147791923, jobs test, e2e and deploy all succeeded) |
| CD | Every push to `main` deploys once `test` and `e2e` pass (`.github/workflows/ci.yml`). The secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` were set on 24 Nov 2026 |
| Database | Neon Free through Hyperdrive. Migrations up to `063_password_reset_codes.sql` are applied to the hosted database (23 Nov 2026, `npm run hosted:bootstrap`) |
| Ingest | GitHub Actions `ingest.yml`, started by the Worker cron at `7 * * * *` (hourly since HOSTED-26, 28 Nov 2026, to save Neon Free compute) |
| Mobile | Flutter `apps/mobile`. Debug APK built on 23 Nov 2026 (not committed; sha256 in `docs/testing/evidence/2026-11-23/mobile/NOTIFY-01-apk.md`) |

**Hosted checks on 24 Nov 2026:**
- `POST /api/v1/auth/password-reset` with an unknown user and code returned `400 invalid_reset_code`.
- `/api/v1/events.geojson` returned 42 features.

**Not verified on the hosted site:**
- a full admin-issued reset (it needs the owner's admin login);
- screenshots of `#lupa-sandi`.

**Not verified on a device:** the Android NOTIFY-01 background poll, the permission prompt and opening an event from a notification tap.

### Owner rules that bind every agent
These are summarised here, with the source in brackets.
- **No AI attribution** in commits or PRs: no `Co-Authored-By` and no "Generated with". Never force-push `main`. Merge finished work branches into `main` and push, so that CI runs. Fix CI failures forward.
- **Local checks are cheap only:** `npm run typecheck` plus the changed test files, run one at a time. Never run the full worker suite, `db:test`, `npm test` or `npm run build` locally, because the 7 GB WSL host crashes on them.
- **Never run without explicit, bounded permission:** `serve:live`, `ai:smoke:live`, `ai:pipeline-smoke`, `test:e2e` with the env file, or ZAP active scans against production.
- **Design and UI work** is done by the main model, not delegated to small models.
- Use one branch and worktree per task: `git worktree add -b work/<ID>-slug ../waspada-<slug> main`.
- Product invariants: see `CLAUDE.md` / `HANDOFF.md` section 3.
  - The site is not an emergency service, and it never says an area is safe.
  - Public views show only published versions.
  - Never draw an invented point or radius.

## 2. In progress

| ID | Branch | Goal | Owner/agent | Started |
| --- | --- | --- | --- | --- |
| HIST-UI-01 (UI) | done 25 Nov 2026 (web 560a74a, Flutter merged) | Web: closed `<details>` "Lihat perubahan" under each history entry with `changes` (`apps/web/src/history-changes.tsx`; test `hist-ui-01.test.tsx` 6/6). Flutter: `HistoryEntry.changes` parsed tolerantly (malformed items skipped), shown by `HistoryChangesTile` (`lib/src/history_changes.dart`), names announced as "Ditambahkan:"/"Dihapus:"; `flutter analyze` 0 issues, `flutter test` 82/82. Not yet in an APK; not checked on hosted with a v2+ event | main model | |
| MOBILE-REL-01 (page + key) | done 25 Nov 2026 | Release `mobile-v0.2.0` published by run 45560478218 (3 signed APKs + SHA256SUMS; bot commit d3064b4 wrote `apps/web/public/mobile-release.json`). Key: PKCS12 RSA 4096, alias `waspada-release`, cert SHA-256 `30:A5:06:18:…:A9:90:23`, kept outside the repo in the owner's home folder (owner backs it up offline); 4 GitHub secrets set. `#unduh` page (`apps/web/src/DownloadPage.tsx`, lazy, not warmed) reads the manifest, accepts only this project's GitHub Release links, shows version/date/size, arm64 primary + other ABIs, SHA-256, install steps, emergency notice, privacy note; links from both footers and `#bantuan`. Test `apps/web/test/download-page.test.tsx` 7/7. Not installed on a device yet | main model | |
| FIX-MOD-UI | merged to main 25 Nov 2026 | Review screen: a proposal with `category_mismatch_review` now shows a required choice in the approval modal. Options are `primary_category` (dari penyaring awal) and `interpretation_category` (dari interpretasi agen). Publish stays disabled until one is chosen, then sends `category_resolution` and `resolved_category` (the chosen candidate). Without a mismatch the request is unchanged. Worker refusals (CATEGORY_* and category_not_candidate) show Indonesian text. Changed: `apps/web/src/ModeratorReview.tsx`, new `apps/web/test/fix-mod-ui.test.tsx` (added to the web `test` list), and this file. Worker not touched. Checks, 25 Nov 2026: `npm run typecheck` from the worktree root on Node 24.21.0 exit 0; `fix-mod-ui.test.tsx` 13 of 13; `moderator-review.test.tsx` 27 of 27; `ui.test.tsx` 5 of 23 pass, and the same 18 fail on unmodified main (`React is not defined`, pre-existing). Not verified: a browser click-through (no DOM test library in the repo) | main model (UI) | 25 Nov 2026 |
| FIX-MOD-SESSION | merged to main 25 Nov 2026 (c0679f5) | `readModeratorPrincipal` uses the eager `withAccountStore`, so each moderation, SSE and embedding request without a session cookie opened one Neon connection (FIX-SESSION-ANON's lazy store does not cover it). Now returns null before the store when there is no cookie (`accountCookieCredential`); cookie plus bearer is also refused without a connection. With no cookie and the DB down the answer is now 401, not 503. Checks: typecheck; `fix-mod-session` 8/8 (6 failed before the change); `fix-session-anon` 6/6, `fetch-mode-moderator-gate` 14/14, `embedding-visualization-api` 6/6, `accounts-api` 17/17, `accounts-runtime` 4/4. Not committed | implementer subagent (main model reviews) | 25 Nov 2026 |
| PERF-09b | merged 25 Nov 2026 (bf96d6f), deployed | Idle warm-up removed; header/footer links prefetch their route chunk on pointer/focus/touch. Demo `PresentationDetail`, the GeoJSON `MapPanel` and the full account client left the entry. **CI-measured main chunk: 103.35 kB gz (run 45560101806) → 100.19 kB gz (run 45565640646); still 0.19 kB over the 100 kB target.** Next lever: lazy `OnboardingIntro` (~1.4 kB gz; owner call, it changes when the first-visit intro appears) | main model | |
| PERF-09c | merged + deployed 25 Nov 2026 (ba63b50, merge 57e6e82; CI 45593124964 test/e2e/deploy green) | Intro dialog now lazy (`OnboardingIntro` chunk 1.20 kB gz). **Correction to PERF-09b number:** run 45565640646 also loaded a separate `react` chunk (3.00 kB gz) + `jsx-runtime` (0.61) at startup, so first-load JS was ~103.8 kB gz, not 100.19. After PERF-09c Rollup folded React back into `index` → **entry 102.35 kB gz, first-load JS down ~1.45 kB; still ~2.4 kB over 100 kB.** Hosted check (Playwright, 390 px): new visitor gets the intro and loads the chunk; returning visitor does not load it; "Lihat pengenalan lagi" on #bantuan opens it | main model | |
| FIX-CI-UICHANGE | merged 27 Nov 2026 | Main CI red after PR #5 (`uiChange`, 914f0e1): 6 web tests asserted old markup. Updated `header-reflow`, `map-home` (toolbar now two groups, search moved into list panel), `perf09-lazy-routes` (header className template). **Restored** the Area saya privacy note and `BriefingResults` that PR #5 removed: it was the only web entry for FR-11/ST-F-02 briefing. Removed from the repo: UAT form responses CSV (participant names), a personal report PDF (name + student ID), the signed MoU PDF, 4 `Zone.Identifier` files; root STD PDF moved to `docs/testing/Waspada-Jakarta-STD-final.pdf`; `.gitignore` blocks root PDFs/CSVs and `*Zone.Identifier`. Files are still in Git history (not rewritten). Local: web tsc ok; header-reflow 2/2, map-home 31/31, perf09-lazy-routes 13/13, preferences 15/15 | main model | |
| Hosted check 25 Nov 2026 | done | After deploy of 8aa0898: `/mobile-release.json` 200; `GET /api/v1/moderation/proposals` without cookie 401; 39 published events have version ≥ 2, and their history returns `changes` (e.g. one detik event has 8 entries with changes) | main model | |
| GUI-05 | `work/GUI-05-admin-pages` (merged 4f01fe2), `work/GUI-05-report-shots` | Owner asked 28 Nov 2026 for items 6, 7, 8, 5, 2. **6:** Alur agen and Peta embedding joined the workspace design (neutral layer chips and lanes, state colour only for waiting/failing, segmented time range, plain copy, theme-following 3D stage and grid via `--viz-*` tokens, coordinate table visually hidden for screen readers only, Tugu mark in the workspace top bar). **7:** owner chose to follow the teammate: logo click keeps collapsing the header; "Area saya" / "Ringkasan saya" unchanged. **8:** one motion vocabulary in `design/v4.css` (overlays rise, backdrops and page heads fade, lists appear at once, 1px press on every button family, zero-specificity colour transitions, reduced motion off). **5/2:** hosted re-shoot and report/STD screenshots in progress; review screen tidied (duplicate "Kembali ke peta" footer, decorative emoji on queue cards and facility chips removed, "Tinjauan tertahan" casing); `tools/gui/admin-shots.ts` gains `GUI_REVIEW_FIXTURE=1` (synthetic proposals, `tools/gui/review-fixtures.ts`). Hosted re-shoot (`tools/gui/report-shots.ts`, one file per report figure in `docs/testing/evidence/2026-11-28/report/`) found the 320px header clipping "Area saya": below 360px the account trigger is now a 44px icon button (word kept as accessible name) and nav spacing tightens. | main model | 28 Nov 2026 |
| ADMIN-PERF-01 | `work/GUI-05-report-shots` | Owner reported 28 Nov 2026 that the admin Ringkasan is slow to show data. Cause: `apiAttemptBaseline` started `undefined` in live mode, so `currentApiObservation` never treated a reading as current and the overview stayed on "Memuat data publik…" until a mode toggle (the data itself arrived in ~2 s; hosted context/events/geojson 0.2–0.5 s; Neon cold session lookup 1.2 s after 8 min idle). Fix: start live mode with a `null` baseline; also preload the admin-entry and overview chunks with the session check (`preloadAdminRoute`), ~0.5 s sooner at 250 ms RTT. Tests: admin-dashboard (fails without the fix), perf09-lazy-routes. | main model | 28 Nov 2026 |
| ADMIN-BRIEF-01 | `work/ADMIN-BRIEF-01` | Owner asked 28 Nov 2026 to align the admin Ringkasan with the current system while keeping the five layers, and chose to remove all old parts. New `AdminOverview.tsx` + `admin-overview-model.ts` read the pipeline-flow-v1 snapshot (same as Alur agen) and the public event list: "Perlu tindakan" (failing stages, stuck AI jobs, failed feeds → Sumber for admins / Alur agen for moderators, proposals waiting → Tinjau bukti; empty state never claims safety), five L1–L5 cards (worst stage health, two figures, unknown = dash not 0, window named once), "Terbit terakhir" (5 newest by publication time). Removed: AdminDashboard (simulation mode, admin SVG map, record inspector, public-API monitor), AdminOperationsMap, admin-monitoring, admin-dashboard.css, admin-map.css and their three tests (ADMIN-PERF-01's fix went with them). Test list: +admin-overview, −admin-dashboard/admin-map/admin-monitoring. Checks: `npm run typecheck`; admin-overview 8/8, admin-workspace 17/17, perf09-lazy-routes 14/14; rendered at 1440 and 390 px with a realistic flow snapshot. | main model | 28 Nov 2026 |
| BRAND-01 | merged 28 Nov 2026 | Logo candidates requested 28 Nov 2026: A Tugu (Monas, flame = dot of an "i"), B Gigi Balang (Betawi eave + W), C Elang Bondol (Jakarta mascot kite). SVGs in `docs/design/logo/`, 64-unit grid, ink/paper + one teal accent, self-switching light/dark (favicon-ready). Checked by rendering at 16/24/32/48 px and in the header, browser tab and Android launcher. **Owner picked A Tugu (28 Nov 2026).** Applied: header `.brand-mark` (`apps/web/src/ui/BrandMark.tsx`, flame colour per theme in `design/v4.css`), `public/favicon.svg` (self-switching) + `apple-touch-icon.png` + new theme-color values in `index.html`, Android adaptive/legacy launcher vectors (ink background) and the 5 mipmap PNGs. Checks: web typecheck; header-reflow (3, incl. new BRAND-01 test), accounts, map-home, experience, ui tests pass; `aapt2 compile` OK for every changed Android resource; header screenshots (1280/390, light/dark). Android icon ships with the next APK tag. | main model | 28 Nov 2026 |
| GUI-03 / GUI-04 | applied 27 Nov 2026 without review (owner asleep, then asked for awwwards-level unity) | GUI-03 direction A: detail 35bcae4, map 2f19552, Area saya 8e8001b, polish 2a834c8, Android b90c524. GUI-04 design layer `design/v4.css` + tabbed sign-in 7e73527; admin a22f592; page column 6c07f89; Android palette aligned to the web tokens (flutter analyze clean, 83 tests pass; ships with the next APK tag). **Owner decisions listed in `docs/design/GUI-03-owner-notes.md`** (content headlines, logo click, page name, bundle, git history, basemap provider, APK tag) | main model | |

## 3. Next candidates (not started; the owner picks)

### Latency (measured 24 Nov 2026 from WSL, Jakarta ISP, curl, 3 requests per route)

| Route | First request | Warm |
| --- | --- | --- |
| `GET /` (static HTML) | 129 ms | 129–146 ms |
| `GET /api/v1/events?limit=20` (47 KB) | **1,438 ms**, then 1,073 ms | 137 ms |
| `GET /api/v1/events.geojson` (22 KB) | 275 ms | 249–275 ms on every request |
| `GET /api/v1/updates`, `/api/v1/context` | 120–280 ms | |
| Main web bundle | | 135 KB compressed JS, 25 KB CSS |

Since PERF-03/04 (F-50), the reads come from a KV snapshot. But each request still makes one fingerprint query to Neon through Hyperdrive. The slow first requests after an idle period are **likely** a cold isolate plus Neon waking from suspend. This is not yet measured per stage; PERF-08 would measure it.

| ID (proposed) | Change | Expected effect |
| --- | --- | --- |
| PERF-05 | Put the Cache API (`caches.default`) in front of the snapshot reads, keyed by URL plus snapshot generation. Check the fingerprint at most once every ~15 s per colo instead of on every request | Warm 250 → ~30–60 ms; less Neon load |
| PERF-06 | Push-based snapshot: ingest and moderator publish write the KV snapshot and a generation key, and public reads trust KV with **no Neon call** | Removes the 1+ s cold path (Neon suspend) from public reads |
| PERF-07 | The Worker injects the first page of events into `index.html`, or adds `<link rel=preload>` for `/api/v1/events` and the GeoJSON | Saves one round trip before the map and list show |
| PERF-08 | Add a `Server-Timing` header (KV, DB, render) and a CI timing probe | Makes regressions visible; evidence for NFR-04 |
| PERF-09 | Split the web bundle: lazy-load the admin, moderator and `#alur-agen` routes | Smaller first load on phones |

### Features
- **WEB-PWA-01:** an installable web app with an offline copy of the last snapshot, read-only and labelled with its age. This does not change the NOTIFY-01 decision (no push).
- **SHARE-01:** a share link or QR code per event (Web Share API, Android share sheet).
- **MOBILE-REL-01:** a signed release APK and a distribution page (the APK is debug-only today).
- **HIST-UI-01:** show what changed between published versions of an event (the data exists in `/api/v1/updates`).

### Owner actions waiting
- ~~Set `SNAPSHOT_REFRESH_KEY`~~ **Done 25 Nov 2026:** set as Worker secret (production) and GitHub secret; hosted refresh route now answers 401 to a wrong key (was 404). First ingest-triggered 202 not yet observed.
- Android release key + 4 secrets (MOBILE-REL-01), see `apps/mobile/README.md` "Rilis APK".
- Check Neon **Usage** (CU-hours this month). Estimate from 12 ingest runs of 7–11 min each, 48 a day: about 80 of the 100 free CU-hours a month. If it is close, reduce the ingest cadence.
- PR #4 (AUDIT-2411 report, doc only): read; not merged yet.
- Run a real admin reset on a throwaway account (AUTH-RESET-01 hosted check).
- Record the UAT results from the teammate's laptop (T1–T5).
- Update the STD report in Google Docs.

## 4. Done log (newest first)

| Date | ID | Result | Checks actually run |
| --- | --- | --- | --- |
| 24 Nov 2026 | Hosted check after CI run 45384560432 (test, e2e, deploy all succeeded) | Server-Timing on hosted: list `snap kv, db 0`, total 236 ms first / 184 ms; GeoJSON `db 0`, total 17–24 ms; **`edge;desc="hit"` seen on the second request, so the Cache API does work on workers.dev: keep PERF-05**. `GET /api/v1/auth/session` 200; refresh route 404 (secret not set yet). Client TTFB from this host is not representative: the local ISP DNS now returns `blockpage.xlaxiata.id` for `*.workers.dev` (F-17); probed via DoH-resolved IP | curl with `--resolve`, 24 Nov 2026 |
| 24 Nov 2026 | PERF-06 (+PERF-05 trial) | Public reads never wait on Neon while KV has a snapshot. Companion key `public-snapshot:v1:verified`; background fingerprint check at most every 5 min per isolate (writes the verified key only when stale, to protect the 1,000 KV writes/day). `POST /api/v1/internal/public-snapshot/refresh` (Bearer `SNAPSHOT_REFRESH_KEY`; 404 when unset, 401 wrong, 202 ok) called by `ingest.yml` after each run. Edge cache (`caches.default`) trial: keep only if hosted `Server-Timing` shows `edge;desc="hit"`. **Owner decision 24 Nov 2026:** pushed changes (ingest, moderator, auto-publish) within ~60 s; other DB changes (e.g. freshness evaluator) may take up to ~5 min | Typecheck; `perf03-public-snapshot` 24/24 (6 new) on merged main |
| 24 Nov 2026 | FIX-MOD-PARAMS | Reject `reason` stored (record + audit); publish `reason`, `category_resolution`, `resolved_category` (must be a recorded candidate; gate re-checks), `evidence_label` recorded on the decision only (not applied to claims: would bypass the per-claim gate). Moderation 500s return a generic message + request id | Typecheck; `fix-mod-params` 10/10 (mutation-checked). Existing moderation/gate DB tests left to CI |
| 24 Nov 2026 | FIX-SESSION-ANON | Account runtime opens the transactional DB connection only on the first store call, so anonymous `GET /api/v1/auth/session` (every page load) and refused pre-session requests skip Neon; anonymous response body unchanged | Typecheck; `fix-session-anon` 6/6 (3 fail on old code), 10 related account/moderation test files all pass |
| 24 Nov 2026 | FIX-ADMIN-MON | Admin monitoring parser allows the contract's optional EventView keys (`location_display`, `location_label`, `severity`, `incident_type`; type-checked, unknown keys still rejected); categories `other`/`unclassified` accepted in admin-monitoring, api-client and update-matching, labelled "Lainnya"/"Belum diklasifikasikan" | Web typecheck; `admin-monitoring` 19/19 (2 failed before the fix), `updates-center` 19/19, plus 7 label/map test files all pass; not checked on hosted admin (needs admin login) |
| 24 Nov 2026 | FIX-MOB-GEOJSON | Android `HttpPublicApi` accepts `application/geo+json` for `/api/v1/events.geojson` only (other reads stay `application/json`); the map tab failed on production before. Not yet in any released APK | `flutter analyze` clean; `public_api_test` 11/11 (2 new); full `flutter test` 73 passed; **not verified on a device** |
| 24 Nov 2026 | PERF-07 fix | CI `e2e` failed from `073a16f` to `3ce39f1` (deploys skipped): the `index.html` preload ran on every route, so the moderation page cached a pre-publish list for 15 s and the map reused it (journey step 9). Preload removed; `startEarlyEventListLoad()` runs from `main.tsx` on discover routes only and is used once within 10 s | Reproduced locally (`build:web` + `test:e2e:ci` failed at step 9), then passed after the fix; `event-list-pages` 8/8, `perf09-lazy-routes` 9/9, web typecheck |
| 24 Nov 2026 | MOBILE-REL-01 (CI) | `build.gradle.kts` signs release from `android/key.properties` (falls back to debug); `.github/workflows/mobile-release.yml` on tag `mobile-v*`: tests, split APKs, SHA256SUMS, GitHub Release, commits `mobile-release.json` to main and dispatches CI; pubspec 0.2.0+2. Workflow never run | `flutter analyze` clean; `flutter build apk --release --split-per-abi` OK (arm64 21.5 MB, v7a 19.0 MB, x86_64 23.3 MB); throwaway-key signing path checked locally |
| 24 Nov 2026 | PERF-09 | Lazy routes (Preferences, UpdatesCenter, HelpPage, account pages, admin gate) + split-out helpers; idle warm-up of route chunks. Main chunk 136.7 → 102.1 kB gzip (target 100 not quite met) | Web typecheck; `perf09-lazy-routes` 9/9; 36 other web test files 405 pass, 0 fail; no browser check |
| 24 Nov 2026 | HIST-UI-01 (backend) | `HistoryEntry.changes?` (additive): text/enum/time diffs, scope names added/removed (approved `public_scope_names` only; unresolved names skip only that scope field), claim/impact counts; summary capped at 600 chars; read from published versions only, still 2 statements per history page | Typecheck; worker `hist-ui-01-history-changes` 15/15, `l4-public-event-history-projection-service` 12/12, `public-event-history-runtime` 5/5, `perf04-briefing-history` 11/11, `source-revision-freshness-public-projection` 1/1; db `public-event-history` 8/8, `manual-publication-public-read-chain` 3/3 |
| 24 Nov 2026 | PERF-08 | `Server-Timing: snap;desc="memo|kv|check|rebuild", kv, db, build, total` on snapshot-served 200/304 (not on errors or DB-fallback answers). `npm run perf:probe` (`tools/perf/latency-probe.ts`); the CI deploy job appends a 3-round probe to the job summary (`continue-on-error`) | Typecheck; `perf03-public-snapshot` 18/18 (5 new). Hosted probe before deploy (10:16Z): `?limit=100` TTFB 425 ms, `/api/v1/events` 57 ms, GeoJSON 35 ms |
| 24 Nov 2026 | PERF-07 | First event load is one `?limit=100` request (was 4 x 20 for 66 events), preloaded from `index.html` | Web typecheck; `event-list-pages` 7/7, `updates-center` 18/18, `public-published-feed` 12/12, `admin-monitoring` 15/15 |
| 24 Nov 2026 | AGENT-LOG-01 | This file was added. `README.md` and `HANDOFF.md` link to it | Doc only |
| 24 Nov 2026 | CD-01 | The first automatic deploy worked after the secrets were set (Worker `3b918744…`) | CI run 45147791923: test, e2e and deploy succeeded; the CI smoke check passed; hosted reset probe returned 400 |
| 23 Nov 2026 | DOCS-2311 | Backlog, test summary, ST-N-03, UAT and ADR-065 updated for the items below | Merge `77e5c7c` |
| 23 Nov 2026 | NOTIFY-01 | "Area saya" notifications, local only: web while the tab is open, Android through WorkManager every 15 min | `flutter analyze` clean, `flutter test` 71 passed, web test files passed; CI green on `fb0348a`; **not verified on a device** |
| 23 Nov 2026 | E2E-CI-01, A11Y-01 | Offline Playwright journey and axe audit in CI; deploy waits for `e2e` | Audit of 32 combinations with 0 violations; keyboard pass; CI `e2e` succeeded |
| 23 Nov 2026 | AUTH-RESET-01 | Admin-issued one-time reset code, `#lupa-sandi`, migration 063 | Typecheck plus the changed tests; migration applied to Neon |
| 23 Nov 2026 | MAP-GEO-02, COPY-02, MOBILE-RECENT-01 | Multi-revision map points; "record" copy removed; mobile 24 h default | See the backlog rows |
| 23 Nov 2026 | PERF-03, PERF-04 | KV snapshot for public reads; briefing batched (F-50 fixed) | NFR-04 run 4: `docs/testing/evidence/2026-11-23/nfr04/` |
