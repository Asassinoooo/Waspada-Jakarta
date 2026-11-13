# Test summary: Waspada Jakarta

Project: Waspada Jakarta (Team 12, RPL course). Status date: 13 November 2026. Draft for review.
Branch: `work/TEST-DOC-01-chapter5` (based on `main` at `ae75527`).
Related: `docs/testing/TEST-PLAN.md`, `docs/testing/SYSTEM-TEST.md`, `docs/testing/INTEGRATION-TEST.md`, `docs/testing/UAT.md`, `docs/testing/test-cases.csv`, `docs/testing/DEFECTS.md`.

No test, build or server was run to write this summary. It compiles records that already exist, and each figure is cited to its source.

## 1 Scope and status

- **What was tested.** The local live mode (`npm run serve:live`, backlog LIVE-LOCAL-01, accepted 8 November 2026; `CLAUDE.md`) and the synthetic demo (`DATASET_MODE=demo`). The scope covers `apps/web`, `apps/worker`, `apps/db` and `apps/intelligence` (`TEST-PLAN.md` sections 1 and 2; `SYSTEM-TEST.md` section 1).
- **Against which requirements.** FR-02 to FR-16 (FR-01 withdrawn on 13 Nov 2026) and NFR-01 to NFR-08 (`SOFTWARE_DEVELOPMENT_PLAN.md` section 4), and user stories US-01 to US-03 (SDP section 2).
- **Register.** `docs/testing/test-cases.csv` has 61 rows: 31 system and acceptance rows (ST-F, ST-N, BR, AT), 5 UAT tasks (T1 to T5), 2 TEST-INT-01 cases (TI-01, TI-02) and 23 integration build tests (IT-B1, IT-B2, IT-B3). Status counts: Evidence exists 28, Partial 21, Not evidenced 3, Blocked 3, Pending run 6.
- **Not complete.** No UAT walkthrough has run. No human session is planned. The live path is not tested end to end in CI. Hosted Cloudflare and Neon are not tested. The release checks in SDP section 10 are not met (section 8 below).

## 2 Automated evidence from CI

Source: CI log for run 117086838832 (commit cec9358), kept locally at `.codex-build/ci-logs/cec9358/SUMMARY.md`.

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

**Total: 2,034 tests and cases** (381 + 335 + 1,089 + 104 + 58 + 3 + 64; re-added on 13 November 2026).

Points on this evidence:
- **Where each test appears in the run.** `CI-VISIBILITY.md` lists every test file, its step in the GitHub Actions run, and whether its names appear in that run. `test-cases.csv` gives the same per test (column `ci_visibility`). Six files are not in the run: one is not run by CI, one was merged after it, and four were added after it.

- **Overall run conclusion is not in the log.** The log shows step results only. Confirm the conclusion of run 117086838832 on the GitHub Actions page before stating that "CI passed".
- **Commit range.** The log is for `cec9358`. `main` is 13 commits ahead (`git rev-list --count cec9358..main`), including `71022ee` (TEST-INT-01) and `d6b6e4a` (FLOW-RANGE-01). This CI evidence does not cover them. `SYSTEM-TEST.md` section 7, item 5 says "ten commits ahead". Ten is the count from `cec9358` to `ae75527`, the worktree base, so that line is stale.
- **Aggregate counts only.** A passing step does not show a pass for each file. The per-file statuses in `test-cases.csv` rest on file membership in a CI step (`SYSTEM-TEST.md` status key).
- **How membership was checked.** The worker and web test lists are explicit in `apps/worker/package.json` and `apps/web/package.json`. The database runner (`apps/db/test/run-db-tests.ts`), the intelligence runner (`test/*.test.ts`) and the pipeline runner (`tools/local-pipeline/run-tests.ts`) select files by glob, so files in those directories count as listed. The CSV uses the `CI step <n>` label only after this check; all 145 CI-step labels were re-checked against the package files.
- **Node version.** `ci.yml` line 19 sets Node 24. `CLAUDE.md` says CI uses Node 22. See F-08 in `DEFECTS.md`.

## 3 Local-only evidence (not in CI)

- **Flutter analysis and 41 tests (apps/mobile).** Recorded on 15 October 2026 in `SOFTWARE_DEVELOPMENT_PLAN.md` line 7 (the AUTH-01 entry: "Android analyze, 41 tests"). The Chapter 4 Table 4.3 presentation is in the Google Docs report, which is not in this repository. Not in CI. Not re-run for this cycle. Android device testing is not done (`TEST-PLAN.md` section 1).
- **Browser checks at 320 px and 200% text.** Headless QA recorded in `docs/DELIVERY_LOG.md` line 31: zero browser errors and no document overflow at the tested desktop, mobile, 320 px and 200% text settings. Not in CI. No browser check is automated in the repository. Screenshots at 320 px and 200% are not kept (BR-01, BR-02 in `test-cases.csv`).
- **Local typecheck and changed-file tests.** Owner policy of 12 November 2026 (`CLAUDE.md`, `TEST-PLAN.md` section 6). No local result is recorded in this summary.

## 4 New tests this cycle

- **TEST-INT-01** (commit `71022ee` on `main`, "test(TEST-INT-01): cover L3 ledger to L4 publication gate"). File: `apps/db/test/l3-investigation-publication-gate.test.ts`, with two cases:
  - TI-01, "L3 ledger supported context is bridged to a canonical proposal, published by the manual gate, and read publicly" (line 100).
  - TI-02, "L3 stopped case with a disputed claim is held by the publication gate before any write or public read" (line 164).
- **Local result.** Run locally on 13 November 2026 after the title change and before the commit: 2 tests, 2 pass, 0 fail (exit 0). The rebase onto `main` did not change the file.
- **No CI result is claimed.** The database glob includes the file on `main`. The `cec9358` log does not cover it.
- **What TI-02 shows.** The hold comes from the disputed claim and the unresolved field, not from the ledger status. The gate does not read `stopped_for_review` (F-04 in `DEFECTS.md`).

## 5 UAT (acceptance)

- **Run on 13 November 2026, locally, against the demo dataset.** Logs are in `.codex-build/uat/run-01/` and `run-02/` (gitignored). Results are in `UAT.md` section 9. Every row is an automated walkthrough (browser subagent). None is user acceptance.
- **Results.** T1 passes, with the warning-boundary check skipped (F-01). T2 and T3 pass, with 3 and 2 checks skipped (F-02 and `UAT.md` section 6.6). T5 passes on desktop after a script correction (R-02), and fails one step on phone (R-01). T4 is blocked on both viewports: the demo moderation queue is empty (R-04), and the phone login was rate-limited (R-03).
- **Acceptance rows.** AT-01 and AT-02 are Partial. AT-03 is Blocked, because it depends on T4. See `test-cases.csv`.
- **Open decisions behind the blocks.** F-01 (warning boundary), F-02 (matched-update checks need live data), R-01 (phone demo label) and R-04 (a demo proposal for T4).
- **Persona walkthroughs (local live app, 13 Nov 2026).** Five personas ran through the interface on the local live app, read-only: U1 resident, U1 visitor, U1 worker, U2 commuter and U2 student. Results are in `UAT.md` section 9.1. Most checks pass. Several cases are blocked because the live feed had no flood, stale, copied, group or transport-impact event at run time. Two confirmed defects are open: R-05 (live records shown with demo wording) and R-06 (stale account menu after sign-out). The moderator (U3) and administrator steps were skipped by decision and are not yet run.
- **Human acceptance is not planned.** Decision of 13 November 2026 (`UAT.md` line 7; section 2.2 is the protocol kept for later; `TEST-PLAN.md` section 9). NFR-03 is not evidenced (ST-N-03).

## 6 Open findings

Each finding is open and needs a decision. None is a confirmed defect. Details, evidence and the decision needed are in [DEFECTS.md](DEFECTS.md), section B.

- **F-01** The public map shows no warning-boundary display (US-01, FR-09).
- **F-02** Matched-update checks in T2 cannot run on the demo dataset (US-02).
- **F-03** The L1 webhook ingest imports L2 and L4 modules at runtime.
- **F-04** The publication gate does not read the L3 ledger status.
- **F-05** No PGlite test for the webhook route or the BMKG CAP parser.
- **F-06** No dedicated test for `freshness-aggregate-policy.ts`.
- **F-07** SDP section 3.1 is stale about the moderator view (sign-in and authenticated moderation exist, ADR-060).
- **F-08** The WSL distribution and the CI Node version are stated inconsistently.
- **F-09** Copied reports are not flagged in the source count (FR-06).
- **F-10** Expired-warning wording differs between card and detail (minor copy).
- **F-11** "Unknown time" wording differs between card and detail (minor copy).
- **F-12** No radius or polygon is drawn on the public map (FR-09).

**Confirmed open defects** (with source evidence, in `DEFECTS.md` section D): R-05, live event detail shows demo wording; R-06, the account menu is stale after sign-out.

## 7 Limitations

1. Hosted Cloudflare Workers and Neon Free are not tested. Hosted use remains gated (`CLAUDE.md`; `docs/PLATFORM_COMPATIBILITY.md`).
2. PGlite is not Neon. The database tests run on PGlite (`TEST-PLAN.md` section 6).
3. The live path is not tested end to end in CI. `serve:live` flow wiring is typechecked but not run live (`CLAUDE.md` known gaps; `INTEGRATION-TEST.md` section 7, item 6).
4. The live intelligence path (`apps/intelligence`) bypasses the Worker L2 and L3 modules (`CLAUDE.md` architecture; `INTEGRATION-TEST.md` section 3.2).
5. No real-user sessions. NFR-03 is not evidenced.
6. The held-out casebook evaluation is not done. It needs source rights and human labels (SDP section 10; `TEST-PLAN.md` section 1). The synthetic casebook (`docs/evaluation/fixtures/synthetic-casebook.json`) is not an adjudicated release set (ST-N-01).
7. Android device testing is not done (`TEST-PLAN.md` section 1).
8. No penetration test. No file covers malicious-source, redirect, secret-handling or retention checks (ST-N-07).
9. Password reset is not implemented (`CLAUDE.md` known gaps).
10. No latency has been measured (ST-N-04).
11. Scheduled freshness does not run in deployment: `apps/worker/wrangler.toml` defines no cron trigger (ST-F-14).
12. Statuses rest on file names and CI membership. The assertions have not all been read against each expected result (`SYSTEM-TEST.md` section 7, item 6).
13. Coverage is not measured, and no mutation testing is used (`TEST-PLAN.md` section 3).
14. Reviewer independence is partial: the team has three members (`TEST-PLAN.md` section 7).
15. Browser evidence is local only (BR rows).

## 8 Release-blocking checks (SDP section 10)

SDP section 10 names the first five checks below. It also lists "stale/retracted evidence reinstated as current", which is the sixth row. No check is evidenced as passed for release.

| Check | Linked test IDs | Status | Notes |
| --- | --- | --- | --- |
| Unsupported publication | ST-F-03, ST-F-07, ST-N-01, IT-B3-02, TI-02 | Partial | Gate and policy tests exist. No adjudicated release scenarios (ST-N-01). Audit record not named (ST-F-07). |
| Exposed personal data | ST-N-07, ST-F-06, IT-B2-06 | Partial | Access checks and telemetry allowlists are tested. No retention or secret-handling test is named (ST-N-07). |
| Wrong active warning geometry | ST-F-01, ST-N-01, IT-B1-07 | Partial | Geometry projection tests exist. The public map shows no boundary display (F-01), and ST-F-01 is Blocked in the CSV. |
| Budget bypass | ST-N-02, IT-B1-04, IT-B2-08, IT-B3-01 | Partial | Tests are Worker or local only. The live path bypasses L3. The 5-attempt and 4-turn limits are not named by any file. |
| Unauthorised moderation | ST-F-06, ST-F-07, ST-N-07, IT-B3-08 | Partial | Route and role tests exist (`moderation-api.test.ts`, `l4-moderator-authorization.test.ts`, `pipeline-flow-route.test.ts`). The T4 browser walkthrough has not run. |
| Stale or retracted evidence reinstated (in SDP section 10; not in the brief's list of five) | ST-F-13, ST-F-14, ST-N-05 | Partial | Stale-write conflict is not named by a file. Scheduled expiry does not run in deployment (ST-F-14). |

## 9 Decisions needed from the owner

1. **F-01.** Show warning boundaries on `#peta`, or change the wording of US-01 and FR-09.
2. **F-02.** Run T2 step 7 on live data (under explicit authorisation), or record the US-02 matched-update criterion as not evidenced.
3. **F-03.** Refactor the L1 webhook imports, or record the deviation.
4. **F-04.** Should the publication gate refuse proposals whose investigation is `stopped_for_review`?
5. **F-07.** Update the SDP section 3.1 text (the root planner's document; this summary does not change the SDP).
6. **F-08.** Confirm the WSL distribution for the recorded runs, and the CI Node version stated in `CLAUDE.md`.
7. **R-05.** Remove the hardcoded demo wording from the live event detail, or choose it from the dataset mode.
8. **R-06.** Refresh the account state after sign-out, so that the header updates on the same page.
9. **F-09 to F-12.** Decide the copied-report wording (FR-06), the expired and unknown-time wording (F-10, F-11), and whether to draw boundaries (F-12).
10. **Table 2.3, Week 10.** The report's Table 2.3 lists usability sessions in Week 10. SDP M6 (Weeks 11 to 12) covers usability (`TEST-PLAN.md` section 9). Align the two, or mark the sessions as not held. Table 2.3 is in the Google Docs report and is not in this repository.

F-05 and F-06 are test gaps, not blocking decisions. Decide whether to add the tests before M6 or accept the current evidence (`DEFECTS.md`, section B).

## 10 Next steps

1. Confirm the overall conclusion of run 117086838832 on the GitHub Actions page.
2. Decide R-01, R-04, F-01 and F-02, then record each decision in `DEFECTS.md` and `UAT.md` section 6.6. Re-run T4 once the demo queue has a proposal and the login rate limit has reset, and re-run T5 phone after R-01 is decided. The scripts run one at a time against the demo dataset (`npx tsx tools/e2e/uat/<file>.ts`, from the repository root, as `UAT.md` section 2.1 describes). Do not run them alongside the heavy suites.
3. Results are recorded in `UAT.md` section 9. Failed steps are logged in `DEFECTS.md` section D with an `R-nn` entry.
4. Take the decisions in section 9 above.
5. Read the assertions behind the Partial rows, where a reviewer who did not write them is available (`SYSTEM-TEST.md` section 7, item 6).
