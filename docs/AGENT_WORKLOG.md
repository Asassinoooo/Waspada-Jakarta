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
| Updated | 24 Nov 2026 |
| `main` | `fb0348a` plus this doc (AGENT-LOG-01) |
| Production | https://waspada-jakarta.waspada-worker.workers.dev. Worker version `3b918744…`, deployed 24 Nov 2026 by CD (CI run 45147791923, jobs test, e2e and deploy all succeeded) |
| CD | Every push to `main` deploys once `test` and `e2e` pass (`.github/workflows/ci.yml`). The secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` were set on 24 Nov 2026 |
| Database | Neon Free through Hyperdrive. Migrations up to `063_password_reset_codes.sql` are applied to the hosted database (23 Nov 2026, `npm run hosted:bootstrap`) |
| Ingest | GitHub Actions `ingest.yml`, started by the Worker cron at `7,37 * * * *` |
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
| *(none)* | | | | |

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
- Run a real admin reset on a throwaway account (AUTH-RESET-01 hosted check).
- Record the UAT results from the teammate's laptop (T1–T5).
- Update the STD report in Google Docs.

## 4. Done log (newest first)

| Date | ID | Result | Checks actually run |
| --- | --- | --- | --- |
| 24 Nov 2026 | AGENT-LOG-01 | This file was added. `README.md` and `HANDOFF.md` link to it | Doc only |
| 24 Nov 2026 | CD-01 | The first automatic deploy worked after the secrets were set (Worker `3b918744…`) | CI run 45147791923: test, e2e and deploy succeeded; the CI smoke check passed; hosted reset probe returned 400 |
| 23 Nov 2026 | DOCS-2311 | Backlog, test summary, ST-N-03, UAT and ADR-065 updated for the items below | Merge `77e5c7c` |
| 23 Nov 2026 | NOTIFY-01 | "Area saya" notifications, local only: web while the tab is open, Android through WorkManager every 15 min | `flutter analyze` clean, `flutter test` 71 passed, web test files passed; CI green on `fb0348a`; **not verified on a device** |
| 23 Nov 2026 | E2E-CI-01, A11Y-01 | Offline Playwright journey and axe audit in CI; deploy waits for `e2e` | Audit of 32 combinations with 0 violations; keyboard pass; CI `e2e` succeeded |
| 23 Nov 2026 | AUTH-RESET-01 | Admin-issued one-time reset code, `#lupa-sandi`, migration 063 | Typecheck plus the changed tests; migration applied to Neon |
| 23 Nov 2026 | MAP-GEO-02, COPY-02, MOBILE-RECENT-01 | Multi-revision map points; "record" copy removed; mobile 24 h default | See the backlog rows |
| 23 Nov 2026 | PERF-03, PERF-04 | KV snapshot for public reads; briefing batched (F-50 fixed) | NFR-04 run 4: `docs/testing/evidence/2026-11-23/nfr04/` |
