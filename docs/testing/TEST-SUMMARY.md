# Test summary: Waspada Jakarta

Project: Waspada Jakarta (Team 12, RPL course). Status date: 18 November 2026. Draft for review. Baseline: `main` at `6fff929`.
Updated 18 November 2026 (TG-DOCS-02) for the hosted site, CI run 44211263890 and the register. Section 3 is as of 13 November 2026.
Branch: `work/TG-DOCS-02-test-docs` (based on `main` at `6fff929`).
Related: `docs/testing/TEST-PLAN.md`, `docs/testing/SYSTEM-TEST.md`, `docs/testing/INTEGRATION-TEST.md`, `docs/testing/UAT.md`, `docs/testing/test-cases.csv`, `docs/testing/DEFECTS.md`.

No test, build or server was run to write this summary. It compiles records that already exist, and each figure is cited to its source.

## 1 Scope and status

- **What was tested.** The local live mode (`npm run serve:live`, backlog LIVE-LOCAL-01, accepted 8 November 2026; `CLAUDE.md`) and the synthetic demo (`DATASET_MODE=demo`). The scope covers `apps/web`, `apps/worker`, `apps/db` and `apps/intelligence` (`TEST-PLAN.md` sections 1 and 2; `SYSTEM-TEST.md` section 1).
- **Against which requirements.** FR-02 to FR-16 (FR-01 withdrawn on 13 Nov 2026) and NFR-01 to NFR-08 (`SOFTWARE_DEVELOPMENT_PLAN.md` section 4), and user stories US-01 to US-03 (SDP section 2).
- **Register.** `docs/testing/test-cases.csv` has 136 rows, counted on 18 November 2026 with a parser (every row has 15 fields). The 109 earlier rows were kept. 27 rows were added: 10 hosted system rows (ST-H-01 to ST-H-10), 6 integration rows (IT-HOST-01 to IT-HOST-06) and 11 unit rows (UT-HOST-01 to UT-HOST-11).
  By level: system 38, acceptance 23, integration 51, unit 24. By status: Evidence exists 53, Partial 44, Pass (local run reported; not re-run in TG-DOCS) 21, Pass (CI run 44211263890) 3, Pass (hosted, read-only, 17 Nov 2026) 1, points-only scope 4, Blocked 6, Not evidenced 2, Pending run 2. By actual_result: Pass 107, Partial 15, Blocked 6, Not run 8.
- **Result columns.** `actual_result` is Pass when every automated file cited in the row is in a suite that passed in run 44211263890. Manual rows show Partial, Blocked or Not run. `run_date` and `run_ref` name the run or the document. `defect_ids` lists the F- and R- IDs named in the notes. ST-N-06 is Not run although its cited files pass, because its check (a restore rehearsal) has not been run.
- **Not complete.** No human session is planned. The live path is not tested end to end in CI. The hosted site (Cloudflare Workers and Neon Free) was deployed on 17 November 2026 and has read-only checks in rows ST-H-01 to ST-H-10. It has no timed latency run, no off-provider backup and no rights clearance. The release checks in SDP section 10 are not met (section 8 below).

## 2 Automated evidence from CI

**Docs commit `a9ddcc7` (TG-DOCS-02), run 44220257264.** The first attempt failed when the runner's Node 24.22.2 crashed (V8 fatal error in a WebAssembly allocation) inside `apps/db/test/l3-investigation-publication-gate.test.ts`; see D-04 in `DEFECTS.md`. The re-run of the failed job passed with the same totals as below (2,555 passed, 0 failed). The commit changes documentation only.

**Current result: run 44211263890** (commit `6fff929`, 18 November 2026, conclusion success). Ubuntu 24.04 runner, Node 24. Every step passed (checked with the GitHub CLI and the run log on 18 November 2026). Totals from the run log:

| CI step | Count in log | Result in log |
| --- | --- | --- |
| 5 Typecheck | no count | pass |
| 6 Database | 58 files, 399 tests | 399 pass, 0 fail |
| 7 Web | 443 tests | 443 pass, 0 fail |
| 8 Worker | 1,311 tests | 1,311 pass, 0 fail |
| 9 Intelligence | 189 tests | 189 pass, 0 fail |
| 10 Pipeline | 58 cases | 58 pass, 0 fail |
| 11 Accounts | 81 tests | 81 pass, 0 fail |
| 12 Evaluation and AI | 74 tests | 74 pass, 0 fail |
| 13 Build | no count | pass |

**Total: 2,555 tests and cases** (2,555 pass, 0 fail).

**History: run 43238566925** (commit `cec9358`, 12 November 2026, conclusion success). Source: CI log kept locally at `.codex-build/ci-logs/cec9358/SUMMARY.md`. Its total was checked against the run log on 18 November 2026. The table below is that run.

| CI step | Command (`.github/workflows/ci.yml`) | Count in log | Result in log |
| --- | --- | --- | --- |
| 5 Typecheck | `npm run typecheck` | no count | no error lines |
| 6 Database | `npm run db:test` | 56 files, 381 tests | 381 pass, 0 fail |
| 7 Web | `npm run test --workspace=@waspada/web` | 335 tests | 335 pass, 0 fail |
| 8 Worker | `npm run test --workspace=@waspada/worker` | 1,089 tests | 1,089 pass, 0 fail |
| 9 Intelligence | `npm run test:intelligence` | 104 tests | 104 pass, 0 fail |
| 10 Pipeline | `npm run pipeline:test` | 58 cases | 58 pass, 0 fail |
| 11 Accounts | `npm run accounts:test` | 3 tests | 3 pass, 0 fail |
| 12 Evaluation and AI | `tsx --test` on the tools files (`ci.yml` line 47) | 64 tests | 64 pass, 0 fail |
| 13 Build | `npm run build` (Wrangler dry-run) | no count | dry-run completed, no error lines |

**Total for run 43238566925 (12 November 2026): 2,034 tests and cases** (381 + 335 + 1,089 + 104 + 58 + 3 + 64; re-added on 13 November 2026).

**CI failures on `main`, 16 to 17 November 2026 (fixed forward).** Runs 43882651216 (`aae6501`), 43883966354 (`8324c11`) and 43890955604 (`5717d37`) failed on 16 November. Run 44003526985 (`181d331`) failed on 17 November. The next green run was 44009413390 (`330b20d`). Every later run on `main`, including 44211263890, passed.

Points on this evidence:
- **Where each test appears in the run.** `CI-VISIBILITY.md` lists every test file, its step in the GitHub Actions run, and whether its names appear in that run. `test-cases.csv` gives the same per test (column `ci_visibility`). Six files are not in the run: one is not run by CI, one was merged after it, and four were added after it.

- **Overall run conclusion.** Runs 43238566925 (12 November) and 44211263890 (18 November) both concluded success, checked with the GitHub CLI. An earlier draft cited a run id that does not exist; the 12 November run is 43238566925.
- **Commit range (12 November run).** The log is for `cec9358`. `main` is 13 commits ahead (`git rev-list --count cec9358..main`), including `71022ee` (TEST-INT-01) and `d6b6e4a` (FLOW-RANGE-01). This CI evidence does not cover them. `SYSTEM-TEST.md` section 7, item 5 says "ten commits ahead". Ten is the count from `cec9358` to `ae75527`, the worktree base, so that line is stale.
- **Aggregate counts only.** A passing step does not show a pass for each file. The per-file statuses in `test-cases.csv` rest on file membership in a CI step (`SYSTEM-TEST.md` status key).
- **How membership was checked.** The worker and web test lists are explicit in `apps/worker/package.json` and `apps/web/package.json`. The database runner (`apps/db/test/run-db-tests.ts`), the intelligence runner (`test/*.test.ts`) and the pipeline runner (`tools/local-pipeline/run-tests.ts`) select files by glob, so files in those directories count as listed. The CSV uses the `CI step <n>` label only after this check; all 145 CI-step labels were re-checked against the package files.
- **Node version.** `ci.yml` line 19 sets Node 24. `CLAUDE.md` says CI uses Node 22. See F-08 in `DEFECTS.md`.

## 3 Local-only evidence (not in CI)

- **Flutter analysis and 41 tests (apps/mobile).** Recorded on 15 October 2026 in `SOFTWARE_DEVELOPMENT_PLAN.md` line 7 (the AUTH-01 entry: "Android analyze, 41 tests"). The Chapter 4 Table 4.3 presentation is in the Google Docs report, which is not in this repository. Not in CI. Not re-run for this cycle. Android device testing is not done (`TEST-PLAN.md` section 1).
- **Browser checks at 320 px and 200% text.** Headless QA recorded in `docs/DELIVERY_LOG.md` line 31: zero browser errors and no document overflow at the tested desktop, mobile, 320 px and 200% text settings. Not in CI. No browser check is automated in the repository. Screenshots at 320 px and 200% are not kept (BR-01, BR-02 in `test-cases.csv`).
- **Local typecheck and changed-file tests.** Owner policy of 12 November 2026 (`CLAUDE.md`, `TEST-PLAN.md` section 6). No local result is recorded in this summary.

## 4 New tests this cycle

- **TEST-INT-01** (commit `71022ee` on `main`, "test(TEST-INT-01): cover L3 ledger to L4 publication gate"). File: `apps/db/test/l3-investigation-publication-gate.test.ts`, with two cases, later joined by two F-04 cases added in `593f849`:
  - TI-01, "L3 ledger supported context is bridged to a canonical proposal, published by the manual gate, and read publicly" (line 100).
  - TI-02, "L3 stopped case with a disputed claim is held by the publication gate before any write or public read" (line 164).
- **Local result.** Run locally on 13 November 2026 after the title change and before the commit: 2 tests, 2 pass, 0 fail (exit 0). The rebase onto `main` did not change the file.
- **CI result.** Run 44211263890 (18 November 2026) ran the file in the database step: 58 of 58 DB files passed. The file now has four tests: TI-01 and TI-02, plus two F-04 cases (the stopped-case refusal and its control). The `cec9358` log did not cover it.
- **What TI-02 shows.** The hold comes from the disputed claim and the unresolved field, not from the ledger status. The gate does not read `stopped_for_review` (F-04 in `DEFECTS.md`).

## 5 UAT (acceptance)

- **Run on 13 November 2026, locally, against the demo dataset.** Logs are in `.codex-build/uat/run-01/` and `run-02/` (gitignored). Results are in `UAT.md` section 9. Every row is an automated walkthrough (browser subagent). None is user acceptance.
- **Local results (13 November 2026).** T1 passes, with the warning-boundary check skipped (F-01). T2 and T3 pass, with 3 and 2 checks skipped (F-02 and `UAT.md` section 6.6). T5 passes on desktop after a script correction (R-02), and fails one step on phone (R-01). T4 is blocked on both viewports: the demo moderation queue is empty (R-04), and the phone login was rate-limited (R-03).
- **Hosted run, 17 November 2026 (`UAT.md` section 9.2).** Read-only, on the production site. T4 passed on desktop and phone (15 steps in total across both viewports) and made no decision. T5 passed on desktop and phone (23 steps in total) and never clicked approve or revoke. The public U3 phone check found R-09 and R-10, fixed in `88bcf69`. Rows ST-H-06 to ST-H-08 hold these results.
- **Acceptance rows.** AT-01 and AT-02 are Partial. AT-03 is Blocked on the local run, because its T4 run was blocked. The hosted T4 pass of 17 November is not yet traced to AT-03. See `test-cases.csv`.
- **Open decisions behind the blocks.** F-01 (warning boundary), F-02 (matched-update checks need live data), R-01 (phone demo label) and R-04 (a demo proposal for T4).
- **Persona walkthroughs (local live app, 13 Nov 2026).** Five personas ran through the interface on the local live app, read-only: U1 resident, U1 visitor, U1 worker, U2 commuter and U2 student. Results are in `UAT.md` section 9.1. Most checks pass. Several cases are blocked because the live feed had no flood, stale, copied, group or transport-impact event at run time. Two confirmed defects are open: R-05 (live records shown with demo wording) and R-06 (stale account menu after sign-out). The moderator (U3) and administrator steps were skipped by decision and are not yet run.
- **Human acceptance is not planned.** Decision of 13 November 2026 (`UAT.md` line 7; section 2.2 is the protocol kept for later; `TEST-PLAN.md` section 9). NFR-03 is not evidenced (ST-N-03).

## 6 Open findings

Status as of 18 November 2026 for this section. Details, evidence and status for each finding are in [DEFECTS.md](DEFECTS.md), section B.

- **F-01** Decided, points only (owner, 16 Nov 2026). US-01 and FR-09 are narrowed to points. No boundary display is built or claimed.
- **F-02** Open. Matched-update checks in T2 need live data (US-02).
- **F-03** Fixed in `cffc865` (on `origin/main`; in CI run 44211263890, which passed). Residual F-03-1: one allowlisted L5 telemetry import.
- **F-04** Fixed in `593f849` (on `origin/main`; in CI run 44211263890, which passed). Residuals: the expiry sweep takes no lock; grounding sufficiency is not read; the L4 role cannot read `investigation_id` or `case_status` on hosted Neon, so the check fails closed there.
- **F-05** Open. No PGlite test for the webhook route or the BMKG CAP parser.
- **F-06** Open. No dedicated test for `freshness-aggregate-policy.ts`.
- **F-07** Open. SDP section 3.1 is stale about the moderator view (sign-in and authenticated moderation exist, ADR-060).
- **F-08** Open. The WSL distribution and the CI Node version are stated inconsistently.
- **F-09** Open. Copied reports are not flagged in the source count (FR-06).
- **F-10** Open. Expired-warning wording differs between card and detail (minor copy).
- **F-11** Open. "Unknown time" wording differs between card and detail (minor copy).
- **F-12** Decided, points only (owner, 16 Nov 2026). Same scope decision as F-01.
- **F-13** Fixed in `de0b77f` (on `origin/main`; in CI run 44211263890, which passed). Component-level test only; not checked in a browser.
- **F-14** Fixed in `588e375` (on `origin/main`; in CI run 44211263890, which passed). Residual: since HOSTED-21 (`f8463b6`, 17 November 2026) a missing event time is waived for auto-publish as `event_time_unknown`. Only a malformed time stays `time_missing` in the moderator queue, and a correction that would remove the event time is still refused. Earlier rows keep processing-time starts until they are republished.

**UAT defects.** R-05 (live event detail shows demo wording) and R-06 (account menu stale after sign-out) are fixed in `7cf6c0f` (HOSTED-05); the re-run is pending. R-09 (hosted detail header says 'API lokal') and R-10 (duplicate source line per claim) are fixed in `88bcf69` (HOSTED-24A) and were checked on the live site (ADR-065).

## 7 Limitations

1. The hosted site (Cloudflare Workers and Neon Free) was deployed on 17 November 2026 and has read-only checks (ST-H rows). It has no timed latency run (`PERFORMANCE.md`), no off-provider backup (ADR-065 limitation 2), and no rights clearance: hosted use runs under the ADR-065 rights limitation (`local_relaxed`).
2. PGlite is not Neon. The database tests run on PGlite (`TEST-PLAN.md` section 6).
3. The live path is not tested end to end in CI. `serve:live` flow wiring is typechecked but not run live (`CLAUDE.md` known gaps; `INTEGRATION-TEST.md` section 7, item 6).
4. The live intelligence path (`apps/intelligence`) bypasses the Worker L2 and L3 modules (`CLAUDE.md` architecture; `INTEGRATION-TEST.md` section 3.2).
5. No real-user sessions. NFR-03 is not evidenced.
6. The held-out casebook evaluation is not done. It needs source rights and human labels (SDP section 10; `TEST-PLAN.md` section 1). The synthetic casebook (`docs/evaluation/fixtures/synthetic-casebook.json`) is not an adjudicated release set (ST-N-01).
7. Android device testing is not done (`TEST-PLAN.md` section 1).
8. No penetration test. No file covers malicious-source, redirect, secret-handling or retention checks (ST-N-07).
9. Password reset is not implemented (`CLAUDE.md` known gaps).
10. No latency has been measured (ST-N-04).
11. In deployment, freshness runs only inside the GitHub Actions ingest, one pass per run. The Worker cron (`7,37 * * * *`) starts that ingest; the Worker does not run freshness itself in production (ST-F-14).
12. Statuses rest on file names and CI membership. The assertions have not all been read against each expected result (`SYSTEM-TEST.md` section 7, item 6).
13. Coverage is not measured, and no mutation testing is used (`TEST-PLAN.md` section 3).
14. Reviewer independence is partial: the team has three members (`TEST-PLAN.md` section 7).
15. Browser evidence is local only (BR rows).

## 8 Release-blocking checks (SDP section 10)

SDP section 10 names the first five checks below. It also lists "stale/retracted evidence reinstated as current", which is the sixth row. No check is evidenced as passed for release.

| Check | Linked test IDs | Status | Notes |
| --- | --- | --- | --- |
| Unsupported publication | ST-F-03, ST-F-07, ST-N-01, IT-B3-02, TI-02 | Partial | Gate and policy tests exist. F-04 is fixed in `593f849` (checked 16 Nov 2026), with residuals: the expiry sweep takes no lock, grounding sufficiency is not read, and the L4 role cannot read `investigation_id` or `case_status` on hosted Neon, so the check fails closed there. No adjudicated release scenarios (ST-N-01). Audit record not named (ST-F-07). |
| Exposed personal data | ST-N-07, ST-F-06, IT-B2-06 | Partial | Access checks and telemetry allowlists are tested. No retention or secret-handling test is named (ST-N-07). |
| Wrong active warning geometry | ST-F-01, ST-N-01, IT-B1-07 | Partial | Geometry projection tests exist. Scope is points only (decided 16 Nov 2026, F-01 and F-12), so no warning boundary is drawn. The ST-F-01 status in the CSV is 'points-only scope (owner, 16 Nov 2026)'. F-13 is fixed in `de0b77f`, with a component-level test only. |
| Budget bypass | ST-N-02, IT-B1-04, IT-B2-08, IT-B3-01 | Partial | Tests are Worker or local only. The live path bypasses L3. The 5-attempt and 4-turn limits are not named by any file. |
| Unauthorised moderation | ST-F-06, ST-F-07, ST-N-07, IT-B3-08 | Partial | Route and role tests exist (`moderation-api.test.ts`, `l4-moderator-authorization.test.ts`, `pipeline-flow-route.test.ts`). T4 ran read-only on the live site on 17 November 2026 (ST-H-06) and made no moderation decision. |
| Stale or retracted evidence reinstated (in SDP section 10; not in the brief's list of five) | ST-F-13, ST-F-14, ST-N-05 | Partial | F-14 is fixed in `588e375`: freshness is no longer set to current from processing time. Stale-write conflict is not named by a file. In deployment, freshness runs only inside the GitHub ingest (ST-F-14). |

## 9 Decisions needed from the owner

Status as of 16 November 2026.

1. **F-01 and F-12: decided, points only (owner, 16 Nov 2026).** Closed as a scope decision, not as a fix. No decision is open on these.
2. **F-02.** Run T2 step 7 on live data (under explicit authorisation), or record the US-02 matched-update criterion as not evidenced.
3. **F-03 and F-04: fixed (`cffc865`, `593f849`).** No decision is open. The residuals are listed in section 6.
4. **F-07.** Update the SDP section 3.1 text (the root planner's document; this summary does not change the SDP).
5. **F-08.** Confirm the WSL distribution for the recorded runs, and the CI Node version stated in `CLAUDE.md`.
6. **R-05.** Remove the hardcoded demo wording from the live event detail, or choose it from the dataset mode.
7. **R-06.** Refresh the account state after sign-out, so that the header updates on the same page.
8. **F-09 to F-11.** Decide the copied-report wording (FR-06), and the expired and unknown-time wording (F-10, F-11). F-12 is closed under item 1.
9. **Hosted decisions (ADR-065, 16 Nov 2026).** Still open: the revoke behaviour for sources (ADR-065 limitation 6). The SDP wording that said hosted or public use is not permitted was replaced in `5ea3c83` (HOSTED-01) with the ADR-065 rights wording, so this conflict is closed.
10. **Table 2.3, Week 10.** The report's Table 2.3 lists usability sessions in Week 10. SDP M6 (Weeks 11 to 12) covers usability (`TEST-PLAN.md` section 9). Align the two, or mark the sessions as not held. Table 2.3 is in the Google Docs report and is not in this repository.

## 10 Next steps

1. Done (18 November 2026): the overall conclusion of run 44211263890 is success. The 12 November run is 43238566925.
2. Decide R-01, R-04, F-01 and F-02, then record each decision in `DEFECTS.md` and `UAT.md` section 6.6. Re-run T4 once the demo queue has a proposal and the login rate limit has reset, and re-run T5 phone after R-01 is decided. The scripts run one at a time against the demo dataset (`npx tsx tools/e2e/uat/<file>.ts`, from the repository root, as `UAT.md` section 2.1 describes). Do not run them alongside the heavy suites.
3. Results are recorded in `UAT.md` section 9. Failed steps are logged in `DEFECTS.md` section D with an `R-nn` entry.
4. Take the decisions in section 9 above.
5. Read the assertions behind the Partial rows, where a reviewer who did not write them is available (`SYSTEM-TEST.md` section 7, item 6).
