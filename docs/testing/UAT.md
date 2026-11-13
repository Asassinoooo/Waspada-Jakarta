# User acceptance test plan (UAT)

Project: Waspada Jakarta (Team 12, RPL course).
Document: UAT. Status: draft for review, 13 November 2026.
Basis: SDP section 10 and the requirement tables (US-01 to US-03, NFR-03, NFR-07); TEST-PLAN.md, acceptance row.

**Human acceptance is pending.** No human sessions are planned (decision of 13 November 2026). The automated runs in this plan are an *automated walkthrough (browser subagent)*. They are not user acceptance, and they do not evidence NFR-03. Report them under that label only.

## 1 Purpose and scope

The purpose is to show whether the user tasks in the SDP can be completed in the local app, in a browser at desktop and phone widths, by three target users (section 3). Each step gets a result, and each task gets seconds. The tasks run in two places: the demo dataset for T1 to T5, and the local live app for the persona cases (section 5).

In scope:
- Three target users (section 3): U1 resident (discovery, US-01), U2 commuter (following updates, US-02) and U3 moderator (review, US-03).
- T1 to T3 on the demo dataset, and the matching persona cases on the local live app (section 6.0).
- T4 for U3 on the demo dataset: review and decide one proposal.
- T5 for the administrator (operator, not a target user): the demo-only source preview.
- Desktop 1440 × 900 and phone 390 × 844, including the phone list fallback.

Out of scope:
- Starting or stopping the live server, real source fetches and model calls. The persona cases read the live app and do not change its data. The matched-update checks in US-02 need live data and stay pending (T2).
- Hosted deployment (Cloudflare Workers, Neon), source rights and password reset.
- A full accessibility audit. Section 7 lists the only layout and text-size checks.

## 2 Method

### 2.1 Automated walkthrough (browser subagent): the current method

- Playwright Chromium, headless. There is one script per task in `tools/e2e/uat/`, run one at a time with `npx tsx tools/e2e/uat/<file>.ts` from the repository root.
- T1 to T5 run on the demo dataset. Each script checks that the server reports `dataset_mode` as `demo`, and stops if it does not. The persona cases run on the local live app, and each checks for `live` and stops if it does not (section 5).
- Each step is recorded with its name, pass or fail, milliseconds and error message. Timings include page load and waits, so they are an upper bound on a user's own time.
- Results are labelled "automated walkthrough (browser subagent)". They are not user acceptance and must not be reported as such.
- A *skipped* check cannot run on the demo dataset, or its label cannot be confirmed from the source. It is neither a pass nor a fail, and it is listed in section 6.6.

### 2.2 Human-session protocol: not planned

This protocol is kept so that sessions can be run later without redesign. It is not scheduled. A session would use the tasks in section 6 on a phone and on a desktop, with think-aloud, a facilitator who does not help with the task, and an observer. The observer records the step where the participant stopped, the seconds per task and short quotes, with no personal data. Results would be labelled "human session" and reported separately from the automated walkthrough.

## 3 Target users

The UAT covers three target users, which is the limit for this plan. Each one corresponds to a user story in section 1.4 of the report.

| Target user | Story | Who it represents | Account | Use cases |
| --- | --- | --- | --- | --- |
| U1 Resident (public reader) | US-01 Discover relevant information | Residents, visitors, workers and students who look for incidents near them | None, or a Pengguna account | T1, T3, RES-01 to RES-03, WRK-01, WRK-02, VIS-01 to VIS-03 |
| U2 Commuter (follower) | US-02 Follow developments that affect me | Commuters and students who follow places, services and groups | Pengguna account optional; interests are saved in the browser | T2, COM-01, COM-02, STU-01 |
| U3 Moderator (reviewer) | US-03 Maintain trustworthy information | Platform moderators | Pengguna account, then the Moderator role granted by an administrator | MOD-00, T4, MOD-02 |

**Operator, not a target user.** An administrator assigns the Moderator role to the U3 account and checks the source tab (T5). These steps prepare U3 and are reported with it.

**Personas folded into the three users.**

- Students are covered by U2 (group interests) and by U1 (group notices in the feed).
- Workers are covered by U1. The copied-report and expired-warning checks are reader checks.
- Visitors are covered by U1 (reading and searching without an account).

**Method.** Each target user is played by a browser agent that uses the app only through its interface, as that user would. These are automated walkthroughs. They are not user acceptance by people. The human-session protocol in section 2.2 is not run. Human sessions would need 6 to 8 people from outside the team (SDP NFR-03).

## 4 Consent and privacy protocol (for future human sessions)

1. Before a session, explain in Bahasa Indonesia that the app is a prototype with synthetic demo data, that it is not an emergency service and gives no safety assessment, and that the participant may stop at any time without giving a reason.
2. Record consent as yes or no on the session sheet, against a participant code (P1, P2, and so on). Do not record names, contact details, identity numbers, locations, device identifiers or photographs of the participant.
3. Use the demo accounts only (section 5). A participant never uses a personal account or enters personal data.
4. For interests, ask participants to choose a public place name, such as a district, and not their home address.
5. Do not make screen recordings. Keep screenshots only after checking that they show demo data only.
6. A participant may stop at any time. A stopped session is logged as stopped, with the step reached. Its data is kept only if the participant agrees.
7. Session notes are stored outside the repository. Only aggregated results enter the report.

## 5 Environment

- Toolchain: Node 24.21.0 in WSL Ubuntu-26.04, as recorded in CLAUDE.md. Do not use Windows-host Node.
- Browser: Chromium for Playwright (root devDependency `playwright`, ^1.64.1).
- Two runtimes are used, and their results are reported separately.
  - **Demo stack (T1 to T5, runs 01 and 02).** Start `npm run accounts:local -- --enable --demo --state accounts-demo`, then `WASPADA_LOCAL_ACCOUNTS=true npm run dev`. Vite serves on 127.0.0.1:5173 and proxies `/api/v1` to the Worker on :8787. It also proxies `/api/v1/auth` and `/api/v1/account` to the accounts runtime on :8789. The dataset is `demo`, and each script refuses to run otherwise.
  - **Local live app (persona cases, 13 November 2026).** `npm run serve:live` runs on the same ports. The dataset is `live`, and each persona script refuses to run unless `/api/v1/context` reports `live`. Live feeds and model calls run in this app. The UAT does not start it and does not spend model quota.
- **Accounts on the local live app.** The persona runs register their own accounts through the interface: `uat.resident01`, `uat.commuter01`, `uat.student01` and `uat.worker01`. `uat.moderator01` is planned. Passwords are kept in `.codex-build/uat/accounts/`, which is gitignored. They are never printed in this document, in logs or in reports. The accounts are real rows in the local live database and stay there.
- **Demo accounts.** `demo.warga`, `demo.moderator` and `demo.admin` are defined in `tools/accounts/demo-accounts.ts`. The password is the constant `SYNTHETIC_DEMO_PASSWORD` in that file, and it is never printed.
- **Operator account on the local live app.** The administrator account comes from `WASPADA_ADMIN_USERNAME` and `WASPADA_ADMIN_PASSWORD` in `.env.local`. The scripts read these through `node --env-file`, never print them, and skip the administrator steps if they are unset.
- **Read-only on live.** Persona scripts never click a control that fetches from providers ("Ambil ...", "Reset", "Atur ulang", refresh or "Coba lagi"). They never publish, reject, correct or edit a record. Interests are saved only in the browser.
- **Not used.** The scripts do not start the live server, do not run `ai:smoke` or `test:e2e`, and do not spend model quota. They do not read the contents of `.env.local` or `.dev.vars`.
- **Machine and login limits.** Run one browser script at a time. Login is rate-limited, and repeated sign-ins can return "Terlalu banyak percobaan masuk" (R-07). Space the runs out.
- **Browser state.** Light theme, locale id-ID, device scale 1. Each viewport uses a new browser context. T4 changes one proposal in the local demo database, and reject is the default decision. If the moderation queue is empty on a repeat run, rebuild the demo state before repeating T4 (NFR-06).

## 6 Tasks

Every route below was checked against `routeFromHash` in `apps/web/src/App.tsx` (lines 138 to 175). The routes are `#peta` (discover), `#masuk` (login), `#ringkasan-saya` (preferences), `#pembaruan` (updates), `#detail/api/<id>` (API detail) and `#admin/<tab>`, with tabs `tinjau` and `sumber` used here. Visible labels were read from the web source. The exceptions are noted under each task.

### 6.0 Use cases by target user

Each row names the target user (section 3) and the state of the run so far. "Demo" runs are T1 to T5 on the demo dataset. "Live" runs are the persona scripts on the local live app. Blocked means the data was absent, so the case was not tested.

| Use case | Target user | Requirement | Demo runs | Live runs (13 Nov 2026) |
| --- | --- | --- | --- | --- |
| T1 Find an applicable event | U1 | US-01, FR-10 | Pass; boundary check skipped (F-01) | RES-01 blocked: no flood or weather event listed |
| T2 Follow an update | U2 | US-02, FR-11, FR-13 | Pass; three checks need live data (F-02) | COM-01 pass |
| T3 Inspect origins and history | U1 | US-03, FR-10 | Pass; two checks skipped | VIS-03 pass; finding R-05 |
| T4 Review one proposal | U3 | US-03, FR-12 | Blocked: empty demo queue (R-04) | Not run |
| T5 Source preview (operator) | Operator | NFR-07 | Pass on desktop after correction (R-02); phone fails one step (R-01) | Not run |
| RES-01 Find a flood or weather event | U1 | US-01, FR-10 | Not run | Blocked: none listed |
| RES-02 Crime event detail, no safety claim | U1 | FR-10, NFR-01 | Not run | Pass |
| RES-03 Expired or stale warning | U1 | FR-13 | Not run | Blocked: none listed |
| WRK-01 Copied report not counted as corroboration | U1 | FR-06 | Not run | Blocked: no copied report; see F-09 |
| WRK-02 Expired warning labelled, never resolved | U1 | FR-13 | Not run | Blocked: none listed |
| VIS-01 Search without an account | U1 | US-01, FR-10 | Not run | Pass: search narrows 3 cards to 1 |
| VIS-02 Unmapped location, no invented point | U1 | FR-09, NFR-01 | Not run | Partly skipped: radius not checked |
| VIS-03 Freshness and time shown separately | U1 | FR-10, FR-13 | Not run | Pass; finding R-05 |
| COM-01 Follow a transport place | U2 | US-02, FR-11 | Not run | Pass: saved, kept after reload, removed |
| COM-02 Transport-impact event, status and timing separate | U2 | FR-10 | Not run | Pass |
| STU-01 Group notice without geography | U2 | FR-09, FR-11 | Not run | Blocked: no group notice listed; interest steps pass |
| ACC-01 Register, onboard, role reads Pengguna | U1, U2, U3 | FR-12, NFR-07 | Not run | Pass for commuter, student, worker and resident |
| ACC-02 Sign out | U1, U2, U3 | FR-12 | Not run | Pass; stale header menu after sign-out (R-06) |
| MOD-00 No moderation access before the role change | U3 | FR-12, NFR-07 | Not run | Skipped by decision (13 Nov 2026); U3 not run yet |
| MOD-02 History shows reviewed versions only | U3 | FR-13 | T3 pass | Skipped by decision (13 Nov 2026); U3 not run yet |

**Success cases named in the report.** Section 1.3 of the report names four success cases: copied reports, ambiguous locations, expired warnings and corrections. Copied reports are covered by WRK-01, expired warnings by RES-03 and WRK-02, and ambiguous locations by VIS-02. Corrections are covered only as MOD-02 (reviewed versions only), because section 1.3 defers correction to a later release. **Decision needed:** keep correction as a success case, or remove it from section 1.3.

### T1 Find an applicable event (US-01)

- **Requirement:** US-01 (discovery). NFR-03 (time target).
- **Start state:** anonymous visitor on `#peta`, demo dataset, empty browser storage.
- **Steps:**
  1. Open `#peta`. If the first-visit introduction opens, choose "Lewati".
  2. On a phone, open the list with "Daftar laporan".
  3. In "Laporan terbit", read the first report card: its event time ("Waktu kejadian") and its source count.
  4. Choose the card. In the popup, read the location wording: "Titik lokasi dari sumber." or "Lokasi belum dipetakan dari sumber."
  5. Choose "Lihat detail". In "Detail laporan", read "Waktu kejadian" and "Waktu dan cakupan".
  6. Decide whether the item is a point or a warning boundary.
- **Success criterion:** the participant states the event time, the source count and whether the report has a mapped point. The participant must not read a mapped point, a source count or a missing point as proof that an area is safe. Step 6 cannot be completed on the public map as built (see the open item below). The list gives the same information as the map, so the map is optional (UX spec section 5).
- **Time limit:** 60 seconds, from opening `#peta` to reading the event time and location type. This is the NFR-03 target.
- **Script:** `tools/e2e/uat/t1-discover.ts`.
- **Open item:** the public map has no warning-boundary wording and no polygon branch. The popup captions every mapped marker as a point (`MapPopup.tsx:56-57`). Polygons appear only in the fixture presentation (`#detail/presentation`) and in the admin views. The owner must decide whether a boundary must appear on `#peta`.

### T2 Follow an update (US-02)

- **Requirement:** US-02 (following updates).
- **Start state:** signed in as `demo.warga`. "Ringkasan saya" has no saved interests in this browser.
- **Steps:**
  1. Sign in at `#masuk` with "Username", "Kata sandi" and "Masuk".
  2. Open "Ringkasan saya" (`#ringkasan-saya`). Under "Tambah tempat", enter a public place name and choose "Tambah".
  3. Choose "Simpan di perangkat ini". Confirm "Minat berhasil disimpan di browser ini." and that the place appears under "Minat tempat".
  4. Reload the page. Confirm the place is still listed.
  5. Read the briefing area. On the demo dataset it shows "Briefing live tidak tersedia pada mode demo."
  6. Open "Pembaruan" (`#pembaruan`). On the demo dataset it shows "Pembaruan live tidak tersedia pada mode demo."
  7. *Live dataset only, not run in this phase:* open a matched update and read "Mengapa muncul". Check that one change appears once, with no duplicate alert, and that its version history or source can be opened.
- **Success criterion:** steps 1 to 6 complete on the demo dataset, and the demo gates appear with no live match shown. Step 7 is pending a live run. The US-02 criterion (a relevant update with its reason, and a correction without duplicate alerts) is not evidenced by this walkthrough.
- **Time limit:** 120 seconds (proposed; the SDP sets no time limit for US-02).
- **Script:** `tools/e2e/uat/t2-updates.ts`.
- **Open item:** the matched-update checks cannot run on the demo dataset (`BriefingResults.tsx:164-166`, `UpdatesCenter.tsx:668`). A live run needs `serve:live`, real feeds and model quota, which are outside this phase.

### T3 Inspect origins and history (US-03)

- **Requirement:** US-03 (inspect origins, evidence and history).
- **Start state:** anonymous visitor on `#peta`, demo dataset.
- **Steps:**
  1. Choose the first report card, then "Lihat detail".
  2. Read the "Perubahan" section, which has the kicker "Riwayat fixture sintetis". Read the entries, or the empty or error message.
  3. Read "Bukti", which has the kicker "Klaim per sumber". Read the claims and their sources, or the message that no evidence is recorded for this demo record.
  4. Open the same event through `#detail/api/<id>`. Confirm that the same sections appear.
- **Success criterion:** the history and claims are readable. The views label the history as synthetic fixture data and do not present it as the current state. An empty history is not read as a sign that nothing happened.
- **Time limit:** 120 seconds (proposed).
- **Script:** `tools/e2e/uat/t3-history.ts`.
- **Label notes:** the public view has no "origins" heading. "Bukti" and "Klaim per sumber" are treated as the origins view. The note "Riwayat sintetis ini bukan keadaan terkini." appears only while the history loads (`EventDetail.tsx:147`), so the script checks the kicker instead. Per-claim source attribution is not confirmed in the markup, so it is a skipped check.

### T4 Review one proposal (moderator, US-03)

- **Requirement:** US-03 (evidence comparison and disputed-claim review). NFR-07 (protected moderator access).
- **Start state:** signed in as `demo.moderator`. The moderation queue holds at least one proposal. This is a precondition.
- **Steps:**
  1. Sign in at `#masuk`.
  2. Open "Tinjau bukti" (`#admin/tinjau`). Check that "Demo sumber" and "Akun & peran" are not offered.
  3. In "Antrean Proposal", choose a proposal. Read its identity section, its time, its claims and any discrepancy callout.
  4. Decide. Publish with "Setujui & Terbitkan", then "Konfirmasi & Terbitkan". Or reject with "Tolak". "Investigasi" is not part of this walkthrough.
- **Success criterion:** the moderator reviews the claims. The decision goes through the server's L4 gate and gives a feedback message. A rejected proposal is not published. A moderator sees only the moderator tabs. Role checks in the page are presentation only, and the server still guards the data.
- **Time limit:** 300 seconds (proposed).
- **Script:** `tools/e2e/uat/t4-moderator.ts`. The decision is set by `UAT_T4_ACTION`, with `reject` as the default. The desktop run makes the decision, and the phone run only reviews, so the demo queue changes once per run.
- **Precondition:** if the queue is empty, the script records "precondition not met". That result is blocked, not a pass.

### T5 Source preview, demo only (administrator)

- **Requirement:** no SDP requirement names the "Demo sumber" tab. It supports US-03 (origins) and NFR-07 (administrator-only access). The team should confirm this trace.
- **Start state:** signed in as `demo.admin`.
- **Steps:**
  1. Sign in at `#masuk`.
  2. Open "Demo sumber" (`#admin/sumber`).
  3. Check the demo-only notice: "Demo sumber · pratinjau terpisah", "DEMO · belum dipublikasi" and "Belum melalui publikasi Waspada".
  4. Check "Default lokal; permintaan penyedia hanya setelah tindakan Anda." This means provider requests happen only after the user acts.
  5. Check that the live-mode guard ("hanya tersedia pada mode demo") does not appear on the demo dataset.
- **Success criterion:** the tab opens for the administrator only. It states that the preview is demo-only and not published. The page makes no provider request before the user acts. The script records the external hosts that load while the tab is open, as a note for review.
- **Time limit:** 120 seconds (proposed).
- **Script:** `tools/e2e/uat/t5-admin-sources.ts`.

### 6.6 Open items found while preparing the scripts

- The login field label "Username" is English (`AccountPages.tsx:173-176`). NFR-03 asks for understandable labels.
- The public map has no warning-boundary wording or shape (T1, step 6).
- The US-02 matched-update checks need live data (T2, step 7).
- `tools/e2e/tsconfig.json` includes only `tools/e2e/*.ts`. The root `npm run typecheck` therefore does not cover `tools/e2e/uat/` until a config is added there. This phase did not add one.
- T5 script correction (run 01 to run 02). The first T5 run failed 8 steps. The source-copy wording in `UnifiedSourceExplorer.tsx` is hidden on the map view by design (`unified-source-explorer.css:802-807`, commit `f0395b0`). T5 now opens the companion Sumber panel and checks the wording that panel shows: "Mode demo terisolasi" and "penyedia tidak dihubungi untuk data ini". The four original source-copy checks are reported as skipped, not passed. The run 01 log stays as evidence (R-02).
- The demo moderation queue holds no proposal, so T4 is blocked (R-04). A demo proposal fixture would let T4 run. This needs a decision.
- Repeated demo logins in one session returned HTTP 429 (R-03). Space the logins out, or split the runs.
- T3: the note 'Riwayat sintetis ini bukan keadaan terkini' shows only while history loads (`EventDetail.tsx:147`). The check is skipped and the kicker is checked instead.
- R-05, R-06 and R-08 were found in the persona runs (section 9.1). Their entries are in `DEFECTS.md` section D.
- Moderator (U3) and administrator steps were skipped by decision on 13 November 2026 and are not yet run.
- Skipped checks in the logs are listed with their reasons. They are not passes.

## 7 Viewports

| Viewport | Size | Coverage |
| --- | --- | --- |
| Desktop | 1440 × 900 | All tasks, scripted |
| Phone | 390 × 844 | All tasks, scripted. The list fallback is used in T1 and T3. |
| Narrow | 320 px wide | T1 and T2, manual, not scripted |
| Large text | 200% text size | T1 and T2, manual, not scripted |

For the manual checks, use browser zoom or the system text size. Record any step where content is clipped, or where the page scrolls sideways at phone width.

## 8 Evidence

- Output folder: `.codex-build/uat/<run-id>/`. It is gitignored and is never committed. `<run-id>` is the `UAT_RUN_ID` variable, or a timestamp if the variable is unset.
- Each script writes `<script>.json`. It records the task, the requirement, the dataset, the start and finish times, the time limit, the seconds per viewport, each step's name, pass or fail, milliseconds and error, the skipped checks with reasons, and notes.
- Each script writes one screenshot per step, named `<viewport>-<nn>-<ok|fail>.png`.
- Error text is redacted for the demo password. Logs contain no model output, prompts or endpoint addresses.
- Screenshots show demo data only. Check them before quoting them in the report.

## 9 Result table

Result values: pass, fail, blocked (precondition not met), pending (live data needed) or not run. Task and viewport are filled in. The other columns are left for the run. Automated rows are labelled "automated walkthrough (browser subagent)". No human-session rows exist, because none are planned.

| Task | Viewport | Result | Seconds | Notes | Evidence |
| --- | --- | --- | --- | --- | --- |
| T1 | Desktop 1440 × 900 | Pass, 1 check skipped (F-01) | 8.3 | 20 steps passed. The warning-boundary check cannot run on the public map. The 60 s limit was met. | `.codex-build/uat/run-01/t1-discover.json` |
| T1 | Phone 390 × 844 | Pass, 1 check skipped (F-01) | 4.7 | 20 steps passed. List fallback used. | `.codex-build/uat/run-01/t1-discover.json` |
| T2 | Desktop 1440 × 900 | Pass, 3 checks skipped (F-02) | 3.5 | 17 steps passed. The matched-update checks need live data. | `.codex-build/uat/run-01/t2-updates.json` |
| T2 | Phone 390 × 844 | Pass, 3 checks skipped (F-02) | 2.7 | 17 steps passed. | `.codex-build/uat/run-01/t2-updates.json` |
| T3 | Desktop 1440 × 900 | Pass, 2 checks skipped | 6.3 | 16 steps passed. The 'bukan keadaan terkini' note shows only while history loads (`EventDetail.tsx:147`). The claim-source label needs a screenshot judgement. | `.codex-build/uat/run-01/t3-history.json` |
| T3 | Phone 390 × 844 | Pass, 2 checks skipped | 4.2 | 16 steps passed. The same two skips. | `.codex-build/uat/run-01/t3-history.json` |
| T4 | Desktop 1440 × 900 | Blocked (precondition not met, R-04) | 61.9 | The demo moderation queue is empty. The decision steps were not reached. | `.codex-build/uat/run-02/t4-moderator.json` |
| T4 | Phone 390 × 844 | Blocked, login rate-limited (R-03) | 75.9 | Login returned HTTP 429 after repeated demo logins in this session. The queue is also empty. | `.codex-build/uat/run-02/t4-moderator.json` |
| T5 | Desktop 1440 × 900 | Pass, after a script correction (R-02) | 4.6 | Run 02: 22 steps passed. Run 01 failed 8 steps on source-copy wording that is hidden on the map view by design. | `.codex-build/uat/run-02/t5-admin-sources.json`; `run-01/t5-admin-sources.json` |
| T5 | Phone 390 × 844 | Fail, 1 step (R-01) | 18.5 | The drawer shows 'Mode demo terisolasi'. At 390 px the admin header shows only a dot for 'Data contoh', and the 'Pratinjau sumber (demo)' label is hidden. | `.codex-build/uat/run-02/t5-admin-sources.json`; `run-02/phone-19-fail.png` |
| T1 and T2 | 320 px (manual) | Not run | — | Manual check, not scripted. | — |
| T1 and T2 | 200% text (manual) | Not run | — | Manual check, not scripted. | — |

### 9.1 Persona walkthroughs on the local live app (13 Nov 2026)

Each run is an automated walkthrough by a browser agent that acts as one target user through the interface (section 3). The runs are read-only on live data. Accounts were registered through the interface and are real rows in the local live database. Passwords are not recorded here. The live feed held two or three published reports at run time, with no flood, expired, copied, group or transport-impact case among them.

| Run | Target user | Account | Result | Findings |
| --- | --- | --- | --- | --- |
| visitor-run-01 | U1 resident (guest) | None | 43 pass, 0 hard fail, 2 skipped, 2 finding fails. VIS-01 pass. VIS-02 partly skipped (radius not checked). VIS-03 pass. | R-05 |
| resident-run-01 | U1 resident | uat.resident01 | 40 pass, 0 fail, 3 skipped, 4 blocked. ACC-01 pass. RES-02 pass. RES-01 and RES-03 blocked. | R-05 |
| worker-run-01 | U1 resident (worker) | uat.worker01 | ACC-01 pass on desktop (phone skipped: not applicable). ACC-02 pass. WRK-01 and WRK-02 blocked. | F-09 (no copy wording in the interface) |
| commuter-run-01 | U2 commuter | uat.commuter01 | ACC-01, COM-01, COM-02 and ACC-02 pass on both viewports (attempt 2). | R-05; R-08 (script, attempt 1) |
| student-run-01 | U2 commuter (student) | uat.student01 | ACC-01 pass. STU-01 blocked: no group notice, interest steps pass. ACC-02 pass, with a stale menu on desktop and phone. | R-06; R-07 |

Not run: U3 (moderator) and the administrator steps, skipped by decision on 13 November 2026. The 320 px and 200% text checks were not run.

## 10 Defects

- Every failed step is logged in `docs/testing/DEFECTS.md` by the orchestrator, which is written after the runs. Each entry gives the task and step, the viewport, what was observed, what was expected, the run ID and the evidence path. `DEFECTS.md` is not created in this phase.
- Blocked results (precondition not met) and pending results (live data needed) are not defects. They are tracked under section 6.6.
- A fatal failure sets the script's exit code to 1. A non-fatal check (a label not confirmed, or a proposed time limit) is reported in the log but does not change the exit code.
