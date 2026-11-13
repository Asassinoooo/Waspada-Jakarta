# User acceptance test plan (UAT)

Project: Waspada Jakarta (Team 12, RPL course).
Document: UAT. Status: draft for review, 13 November 2026.
Basis: SDP section 10 and the requirement tables (US-01 to US-03, NFR-03, NFR-07); TEST-PLAN.md, acceptance row.

**Human acceptance is pending.** No human sessions are planned (decision of 13 November 2026). The automated runs in this plan are an *automated walkthrough (browser subagent)*. They are not user acceptance, and they do not evidence NFR-03. Report them under that label only.

## 1 Purpose and scope

The purpose is to show whether the user tasks in the SDP can be completed in the local demo, in a browser at desktop and phone widths. Each step gets a result, and each task gets seconds.

In scope:
- T1 to T3 for a public visitor: discovery (US-01), following updates (US-02) and origins and history (US-03).
- T4 for a moderator: review and decide one proposal (US-03).
- T5 for an administrator: the demo-only source preview.
- Desktop 1440 × 900 and phone 390 × 844, including the phone list fallback.

Out of scope:
- The live dataset (`serve:live`), real sources and model calls. The matched-update checks in US-02 need live data, so they stay pending (T2).
- Hosted deployment (Cloudflare Workers, Neon), source rights and password reset.
- A full accessibility audit. Section 7 lists the only layout and text-size checks.

## 2 Method

### 2.1 Automated walkthrough (browser subagent): the current method

- Playwright Chromium, headless. There is one script per task in `tools/e2e/uat/`, run one at a time with `npx tsx tools/e2e/uat/<file>.ts` from the repository root.
- Demo dataset only, against the local dev servers in section 5. Each script first checks that the server reports `dataset_mode` as `demo`, and stops if it does not.
- Each step is recorded with its name, pass or fail, milliseconds and error message. Timings include page load and waits, so they are an upper bound on a user's own time.
- Results are labelled "automated walkthrough (browser subagent)". They are not user acceptance and must not be reported as such.
- A *skipped* check cannot run on the demo dataset, or its label cannot be confirmed from the source. It is neither a pass nor a fail, and it is listed in section 6.6.

### 2.2 Human-session protocol: not planned

This protocol is kept so that sessions can be run later without redesign. It is not scheduled. A session would use the tasks in section 6 on a phone and on a desktop, with think-aloud, a facilitator who does not help with the task, and an observer. The observer records the step where the participant stopped, the seconds per task and short quotes, with no personal data. Results would be labelled "human session" and reported separately from the automated walkthrough.

## 3 Participants

None for now. The automated walkthrough has no participants.

A human session would need 6 to 8 people from outside the team. They should speak Bahasa Indonesia and use a phone and a desktop (SDP NFR-03). Team members, course staff and anyone who knows the demo passwords do not count as participants.

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
- Start the stack, in this order:
  1. `npm run accounts:local -- --enable --demo --state accounts-demo`
  2. `WASPADA_LOCAL_ACCOUNTS=true npm run dev`. Vite serves on 127.0.0.1:5173 and proxies `/api/v1` to the Worker on :8787. It proxies `/api/v1/auth` and `/api/v1/account` to the accounts runtime on :8789.
- Browser: Chromium for Playwright (root devDependency `playwright`, ^1.64.1).
- Dataset: demo. The Worker's `DATASET_MODE` is `demo` in `wrangler.toml`. Each script checks this before it runs.
- Accounts: `demo.warga` (user), `demo.moderator` (moderator) and `demo.admin` (administrator), defined in `tools/accounts/demo-accounts.ts`. The password is the constant `SYNTHETIC_DEMO_PASSWORD` in that file. It is never printed in this document, in logs or in reports.
- Not used: `serve:live`, live sources, NineRouter or any other model quota, `ai:smoke` and `test:e2e`. The UAT scripts do not read `.env.local` or `.dev.vars`.
- Machine limit: run one script at a time, and do not run UAT alongside the heavy suites (CLAUDE.md, local test policy).
- Browser state: light theme, locale id-ID, device scale 1. T2 saves an interest in browser storage. Each viewport run uses a new browser context, so no interest carries over. T4 changes one proposal in the local demo database. Reject is the default decision. If the moderation queue is empty on a repeat run, rebuild the demo state before repeating T4 (NFR-06).

## 6 Tasks

Every route below was checked against `routeFromHash` in `apps/web/src/App.tsx` (lines 138 to 175). The routes are `#peta` (discover), `#masuk` (login), `#ringkasan-saya` (preferences), `#pembaruan` (updates), `#detail/api/<id>` (API detail) and `#admin/<tab>`, with tabs `tinjau` and `sumber` used here. Visible labels were read from the web source. The exceptions are noted under each task.

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
| T1 | Desktop 1440 × 900 | | | | |
| T1 | Phone 390 × 844 | | | | |
| T2 | Desktop 1440 × 900 | | | | |
| T2 | Phone 390 × 844 | | | | |
| T3 | Desktop 1440 × 900 | | | | |
| T3 | Phone 390 × 844 | | | | |
| T4 | Desktop 1440 × 900 | | | | |
| T4 | Phone 390 × 844 | | | | |
| T5 | Desktop 1440 × 900 | | | | |
| T5 | Phone 390 × 844 | | | | |
| T1 and T2 | 320 px (manual) | | | | |
| T1 and T2 | 200% text (manual) | | | | |

## 10 Defects

- Every failed step is logged in `docs/testing/DEFECTS.md` by the orchestrator, which is written after the runs. Each entry gives the task and step, the viewport, what was observed, what was expected, the run ID and the evidence path. `DEFECTS.md` is not created in this phase.
- Blocked results (precondition not met) and pending results (live data needed) are not defects. They are tracked under section 6.6.
- A fatal failure sets the script's exit code to 1. A non-fatal check (a label not confirmed, or a proposed time limit) is reported in the log but does not change the exit code.
