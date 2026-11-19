# Test summary: Waspada Jakarta

Project: Waspada Jakarta (Team 12, RPL course). Status date: 19 November 2026 (TG-DOCS-04; updated the same evening by TG-DOCS-05 and TG-DOCS-07). Draft for review. Baseline: `main` at `a7ba558`.
Later update: TG-DOCS-07 (19 November 2026): section 7B, the register counts in section 1, and the open items in sections 4, 8 and 9. Earlier update: TG-DOCS-05 (19 November 2026, evening): section 7A, and the open items in sections 8 and 10. Earlier versions: TG-DOCS-03 (18 November 2026 evening, baseline `2d9d442`), TG-DOCS-02 (18 November 2026 morning, baseline `6fff929`) and the 13 November 2026 summary. Section 3 is as of 13 November 2026.
Related: `docs/testing/TEST-PLAN.md`, `docs/testing/SYSTEM-TEST.md`, `docs/testing/INTEGRATION-TEST.md`, `docs/testing/UAT.md`, `docs/testing/test-cases.csv`, `docs/testing/DEFECTS.md`.

This summary compiles records that exist, and each figure is cited to its source. For TG-DOCS-03 the CI logs were read with `gh`, the hosted public API was read without signing in, and the hosted database was read (read-only) to find the cause of F-19. Only the changed test files of the 18 November fixes were run locally (owner test policy, 12 November 2026).

## 1 Scope and status

- **What was tested.** The local live mode (`npm run serve:live`, LIVE-LOCAL-01), the synthetic demo (`DATASET_MODE=demo`) and, since 17 November 2026, the hosted site on Cloudflare Workers Free and Neon Free (`DATASET_MODE=live`). The scope covers `apps/web`, `apps/worker`, `apps/db` and `apps/intelligence` (`TEST-PLAN.md` sections 1 and 2; `SYSTEM-TEST.md` sections 1, 2 and 6A).
- **Against which requirements.** FR-02 to FR-16 (FR-01 withdrawn on 13 Nov 2026), NFR-01 to NFR-08 (`SOFTWARE_DEVELOPMENT_PLAN.md` section 4), and user stories US-01 to US-03 (SDP section 2).
- **Register.** `docs/testing/test-cases.csv` has 165 rows (every row has 15 fields). TG-DOCS-04 (19 November 2026) added 20: ST-H-13 to ST-H-20, IT-HOST-13 to IT-HOST-15 and UT-HOST-13 to UT-HOST-21. TG-DOCS-03 had added 9: IT-HOST-07 to IT-HOST-12, UT-HOST-12, ST-H-11 and ST-H-12. By status after TG-DOCS-07 (section 7B; exact `status` values in test-cases.csv): Evidence exists 84, Partial 43 (after TG-DOCS-05: 82 and 45), Pass (local run reported; not re-run in TG-DOCS) 21, Blocked 5, Points only (owner, 16 Nov 2026) 3, Pass (CI run 44319579284) 3, Not evidenced 2, Pass (hosted, read-only, 17 Nov 2026) 2, Pending run 2. By actual_result (unchanged by TG-DOCS-07): Pass 137, Partial 15, Not run 8, Blocked 5.
- **Result columns.** `actual_result` is Pass when every automated file cited in the row is in a suite that passed in the cited run. Since TG-DOCS-03 the automated rows cite run 44319579284, a green run, which contains all their files. The later green run 44372632858 also passed all 61 database files; nothing was removed from the suites. The 20 rows added on 19 November 2026 cite run 44372632858 (`a7ba558`). Manual rows show Partial, Blocked or Not run. Fourteen rows changed by TG-DOCS-07 cite CI run `44484348615`, which has not been read. Their actual_result stays Pass and holds only if that run is green. IT-B1-07 cites no new run, and BR-02 names the placeholder in its CI-visibility cell only. The fixes these rows cite are on `main` but not in commit `a7ba558` (run 44372632858).
- **Not complete.** No human session is planned. No automated test reads the hosted site. The release checks in SDP section 10 are not met (section 8).

## 2 What changed on 18 November 2026 (evening)

| Item | Before | Now | Evidence |
| --- | --- | --- | --- |
| CI on `main` | Red on three pushes (`7f1c0ac`, `0eaf0f7`, `34b831f`) | Green at `062aac6` (run 44314452973). Latest: `2d9d442` (run 44319579284, HOSTED-31), green | D-05; section 3 |
| Hosted public list and map | 500 on `/api/v1/events` and `/api/v1/events.geojson` (about 14:00 UTC) | 200; 21 events, 12 points, 12 GeoJSON features, all 21 labelled (14:07 UTC) | F-19; ST-H-12 |
| Map points and labels (HOSTED-26) | No geometry row written; "Lokasi tidak tercatat" | One Point per located event, written at publication; the report's place shown as the location label | IT-HOST-03, IT-HOST-07, ST-H-11 |
| Date-only times (HOSTED-29), wording (HOSTED-27) | Shown as unknown; card and detail wording differed | Day precision ("jam tidak disebutkan"); one wording | IT-HOST-09, UT-HOST-12; F-10, F-11 closed |
| Source revoke (HOSTED-28) | Revoke also stopped collection; copies counted as sources | Revoke stops publication only; copies count once | IT-HOST-08; F-09 closed |
| `#alur-agen` on hosted (HOSTED-30) | No pipeline data on hosted | Reads the last ingest run and source check times from the database | IT-HOST-10, IT-HOST-11 |
| SDP section 3.1 | Described a read-only moderator view | Describes the signed-in moderator review | F-07 closed |

## 2A EXPLORE-18 and fixes (19 November 2026)

EXPLORE-18 (18 November 2026) walked the hosted site read and write: an anonymous visitor at 1440, 390 and 320 px and at 200% zoom, two self-registered residents, the moderator and the administrator, and an API audit of all 21 published events. It found nine defects, F-20 to F-28 (`DEFECTS.md` section B). All nine have fixes in HOSTED-32 to HOSTED-38 (19 November 2026). Eight are checked on the hosted site (ST-H-13 to ST-H-20), and F-27 is covered by tests only. Migrations 058 and 059 were applied to Neon on 19 November, and the Worker was deployed as version `8015835b`. CI runs 44362671695, 44363328129, 44366440688 and 44369506277 failed on test code and were fixed forward (R-11 to R-13). Run 44372632858 on `a7ba558` passed every step. The open items and the MOD-00 partial result are in `DEFECTS.md` section B and `UAT.md` section 9.2. On 19 November 2026 the administrator also deactivated the three EXPLORE-18 test accounts (PATCH with `expected_version` and a reason; 200 each), and the moderator withdrew three published BMKG events (ST-H-19). Neither is a new test row. Their effect on ST-F-07, ST-F-09 and ST-F-14 is in `SYSTEM-TEST.md` section 3.

## 3 Automated evidence from CI

**Latest run: 44372632858** (commit `a7ba558`, 19 November 2026, conclusion success). Every step passed. Per-step counts, summed from the job log (read with `gh api` on 19 November 2026): database 418 tests in 61 files; web 482; Worker 1,407; intelligence 233; pipeline 58 cases; accounts 100; evaluation and AI tools 74. **Total: 2,772 tests and cases** (2,772 pass, 0 fail). The docs-only head `b318254` also concluded success (run 44382241512). The table below holds the counts of the earlier green run 44314452973.

**Green run with recorded counts: 44314452973** (commit `062aac6`, 18 November 2026, conclusion success). Ubuntu 24.04 runner, Node 24.21.0 (pinned, D-04). Counts are summed from the `ℹ tests`, `ℹ pass` and `ℹ fail` lines of each step in the job log, read with `gh api` on 18 November 2026.

| CI step | Count in log | Result in log |
| --- | --- | --- |
| 5 Typecheck | no count | pass |
| 6 Database | 59 files, 411 tests | 411 pass, 0 fail |
| 7 Web | 457 tests | 457 pass, 0 fail |
| 8 Worker | 1,360 tests | 1,360 pass, 0 fail |
| 9 Intelligence | 190 tests | 190 pass, 0 fail |
| 10 Pipeline | 58 cases | 58 pass, 0 fail |
| 11 Accounts | 100 tests | 100 pass, 0 fail |
| 12 Evaluation and AI | 74 tests | 74 pass, 0 fail |
| 13 Build | no count | pass |

**Total: 2,650 tests and cases** (2,650 pass, 0 fail).

**Run 44319579284** (commit `2d9d442`, HOSTED-31, 18 November 2026, conclusion success). Same counts as above, except worker 1,364 (four new HOSTED-31 tests). **Total: 2,654 tests and cases** (2,654 pass, 0 fail). The four HOSTED-31 titles and the changed (a4) title printed as passed.

**Earlier green runs.** 44211263890 (`6fff929`, 18 November 2026): 2,555 pass, 0 fail. 43238566925 (`cec9358`, 12 November 2026): 2,034 pass, 0 fail (from the local log summary `.codex-build/ci-logs/cec9358/SUMMARY.md`).

**CI failures on `main` (fixed forward).** 16 and 17 November: runs 43882651216, 43883966354, 43890955604 and 44003526985 (D-03). 18 November: run 44220257264, a PGlite WebAssembly crash on Node 24.22.2 that passed on re-run (D-04); runs 44248122378, 44250372908 and 44250662007, on test fixtures that predated migrations 055 and 056 (D-05). 19 November: runs 44362671695, 44363328129, 44366440688 and 44369506277 failed on test code (R-11 to R-13), each fixed forward with a test-only commit.

Points on this evidence:
- **Where each test appears.** `CI-VISIBILITY.md` lists every test file and its step. On disk there are 285 test files at `a7ba558` (273 at `2d9d442`). One, `tools/evaluation/benchmark-runner.test.ts`, is run by no script.
- **Aggregate counts only.** A passing step does not show a pass for each file. The per-file statuses rest on file membership in a step and on title matches in the log.
- **Node version.** `ci.yml` pins Node 24.21.0. `CLAUDE.md` still says CI uses Node 22 (F-08).

## 4 Local-only evidence (not in CI)

- **Flutter analysis and 41 tests (apps/mobile).** Recorded on 15 October 2026 (SDP line 7). Not in CI, not re-run.
- **Browser checks at 320 px and 200% text.** `docs/DELIVERY_LOG.md` line 31. Screenshots not kept (BR-01, BR-02).
- **Changed-file runs on 18 November 2026.** For the CI fixture fix (`e64d281`): `apps/db/test/persistence.test.ts` 9 of 9, `public-briefing-runtime` 17 of 17, `public-event-detail-runtime` 5 of 5, `public-event-geojson-runtime` 6 of 6. For HOSTED-31 (`5b64a29`): `hosted31-merged-claim-support` 4 of 4, `agent-point-geometry` 19 of 19, `hosted26-location-label` 12 of 12, `tools/accounts/hosted-ingest` 83 of 83, `adr061-gate-db` 15 of 15, `event-withdrawal-correction-db` 12 of 12, `merge-review-publication` 13 of 13, `agent-origin-writer` 7 of 7, `hosted22-public-attribution` 7 of 7. `npm run typecheck` passed.

- **Flutter, POLISH-02 (19 Nov 2026, reported with `b4a0d0f`).** `apps/mobile/test/public_models_test.dart`: 22 of 22 for the new source collection time key. Local only; not in CI, and not re-run for this update.

## 5 Hosted results

`SYSTEM-TEST.md` section 6A has 20 rows (ST-H-01 to ST-H-20):
- Smoke routes, Origin refusal, self-registration as `user`, and moderator and admin logins passed on 17 November (ST-H-01 to ST-H-04). Login CPU is above the nominal Free allowance with no failure (ST-H-05).
- T4 and T5 passed read-only on desktop and phone; no decision, approve or revoke was made (ST-H-06, ST-H-07). The public phone check found R-09 and R-10, both fixed (ST-H-08).
- Ingest: 16 of 16 sources in a manual run (ST-H-09), and the Worker cron starts the run (ST-H-10). Cron-started runs on 18 November include 44300890829 (12:07 UTC) to 44315558618 (13:37 UTC), all with success. Run 44319612423 (14:00 UTC, started by hand to apply HOSTED-31) exited 0.
- Map points and labels after the HOSTED-26 backfill (ST-H-11).
- The public list outage and its repair (ST-H-12, F-19).
- EXPLORE-18 and the 19 November fix checks (ST-H-13 to ST-H-20): briefing 200 and place match (ST-H-13, ST-H-14); list equal to the API (ST-H-15); pin error 0.00 km (ST-H-16); fresh reads after a write (ST-H-17); history first calls 0.17 to 0.58 s (ST-H-18); the detail of each withdrawn BMKG quake answers 404 (ST-H-19); wording at 1440 and 390 px (ST-H-20).

## 6 UAT (acceptance)

- **Local runs (13 November 2026, demo dataset).** T1 to T3 pass with skipped checks (F-01, F-02, `UAT.md` section 6.6). T5 fails one phone step (R-01). T4 was blocked by an empty demo queue (R-04).
- **Hosted runs (17 November 2026, read-only).** T4 and T5 passed. From TG-DOCS-03 the register records T5 as Pass (hosted, read-only) and AT-03 as Partial instead of Blocked. AT-03 stays Partial. The moderator's decisions on hosted (18 and 19 November) do not cover the version and key steps (`SYSTEM-TEST.md` AT-03).
- **EXPLORE-18 (18 November 2026, recorded 19 November).** Anonymous visitor, two self-registered residents, moderator and administrator walkthroughs, plus an API audit. The moderator rejected one stale duplicate proposal and published nothing. The administrator's revoke and re-approve of ANTARA HUKUM ended approved. MOD-00 is partial (the look-only check was not done). See `UAT.md` section 9.2.
- **Persona walkthroughs (13 November 2026, local live app).** Blocked cases need data that the live feed did not have at run time (flood or weather, stale, copied, expired, group notice). R-05 and R-06 are fixed (`7cf6c0f`), but the persona re-run has not been done, so VIS-03 and ACC-02 stay Partial. MOD-00 and MOD-02 were skipped by decision and are not run anywhere.
- **Human acceptance is not planned** (decision of 13 November 2026). NFR-03 is not evidenced.

## 7A Changes on 19 November 2026 (TG-DOCS-05)

| Row | Was | Now | Why |
| --- | --- | --- | --- |
| ST-F-02 | Partial | Partial (19 Nov 2026) | The place match and its reason were returned on hosted (ST-H-13, ST-H-14). No test names the once-only display of a correction in Pembaruan, and T2 step 7 has not run |
| FR-11 | Partial | Partial | Follows ST-F-02 |
| AT-01 | points-only scope (register) | Partial | Aligned with `SYSTEM-TEST.md` section 6. Hosted list and pin checks added (ST-H-15, ST-H-16); the T1 script has not run on hosted |
| ST-F-01, VIS-02, T1 | points-only scope | Points only | Label only. The owner decision is unchanged |

Still Partial, with new evidence recorded in the row: ST-F-02, ST-F-03, ST-F-04, ST-F-05, ST-F-07, ST-F-08, ST-F-09, ST-F-11, ST-F-13, ST-F-14, ST-F-15, ST-N-02, ST-N-04, ST-N-05, ST-N-07, AT-02 and AT-03. Each row now names only what is still missing. ST-N-02 and ST-N-05 had wrong wording, which is corrected (ST-N-02: the 5-attempt and 4-turn limits are set in two files; ST-N-05: the stale-write conflict is named in `publication-writer.test.ts`).

## 7B 19 Nov 2026 (TEST-GAP-03, POLISH-01 to POLISH-03)

TG-DOCS-07 records the evidence from TEST-GAP-03 and POLISH-01 to POLISH-03 in the register. No test was run and no hosted site was read for this update.

| Row | Was | Now | Why |
| --- | --- | --- | --- |
| ST-F-07 | Partial | Evidence exists | A reject records its decision and writes no version or public event. The reject audit record (F-30, `f3373c0`) is tested in `adr061-gate-db.test.ts` |
| ST-F-14 | Partial | Evidence exists | Each expected result now has a file: `freshness-missing-update-feed.test.ts` (4 tests) and `freshness-aggregate-policy.test.ts` (7 tests). F-06 closed by test |

Still Partial, with new evidence in the row (status unchanged): ST-F-03, ST-F-04, ST-F-05, ST-F-08, ST-F-09, ST-F-11, ST-F-13, ST-F-16, ST-N-02, ST-N-05, BR-02 and IT-B1-06. ST-F-10 gained POLISH-03 supersede tests and stays Evidence exists. IT-B1-07 changed its notes only (the BMKG CAP gap is explained, not closed) and stays Evidence exists.

Register status counts (`test-cases.csv`), before and after: Evidence exists 82 to 84; Partial 45 to 43; the other seven statuses unchanged; 165 rows in both. The actual_result counts are unchanged. The fixes cited are on `main` (`f155822`) but not in CI baseline `a7ba558` (run 44372632858), so no CI run yet covers F-29 to F-32.

Defects: F-30 (a moderator reject wrote no audit record; fixed in `f3373c0`), F-31 (the webhook AI job had no trace id; fixed in `f3373c0`) and F-32 (header nav under the dataset badge at 601 to 900 px, 200% zoom; fixed in `b3ca26d`; severity not recorded). F-29 is fixed in `b4a0d0f`. F-05 is partly closed and F-06 is closed by test. Hosted re-checks for F-29, F-32 and the reject audit row (F-30) are pending.

## 7 Partial rows: what moved and what did not

The question for this update was whether rows that were Partial are now fully proven. Moving a row needs new evidence for the part that was missing.

| Row | Was | Now | Why |
| --- | --- | --- | --- |
| AT-03 | Blocked | Partial | Hosted T4 ran; no decision made |
| T5 | Partial | Pass (hosted, read-only) | Hosted T5 passed on both viewports (ST-H-07) |
| ST-F-11 | Partial | Partial | Live feeds now run every 30 minutes on the hosted site; quarantine of a malformed item is still not named by a file |
| ST-F-14 | Partial | Partial | The freshness pass runs in deployment; no file tests that pass |
| ST-N-08 | Partial | Partial | Deployed on the Free plans; no rebuild from a clean clone is recorded |
| FR-16 (traceability) | Not covered | Partial | Revoke-keeps-collection is tested (IT-HOST-08) |
| WRK-01, VIS-03, ACC-02 | Blocked or Partial | unchanged | Their fixes are in, but the persona re-run or the live data is missing |

The other Partial rows have the same gap as before: no live data for the case, a check that is not named by any file, an assertion not yet read against its expected result (`SYSTEM-TEST.md` section 7, item 6), or a manual run that has not been done.

## 8 Open findings

Details in [DEFECTS.md](DEFECTS.md).

- **Fixed or decided on 18 November 2026:** F-07 (SDP section 3.1), F-09 (copies), F-10 and F-11 (wording), F-16 (scheduler, mitigated), F-17 (accepted limitation), F-18 (mitigated), F-19 (outage, verified), D-04 (mitigated), D-05 (closed).
- **Fixed on 19 November 2026:** F-20 to F-26 and F-28 (checked on the hosted site in ST-H-13 to ST-H-20); F-27 (tests only). R-11 to R-13 (CI test-code failures, fixed forward). On 19 November 2026 (TG-DOCS-07): F-06 closed by test; F-29 (`b4a0d0f`), F-30 and F-31 (`f3373c0`) and F-32 (`b3ca26d`) fixed, with no CI run and no hosted re-check yet (section 7B).
- **Still open:** F-02 (open for the matched-update step on live data in the browser; the briefing part is fixed and checked on hosted, ST-H-13 and ST-H-14), F-05 (partly closed on 19 November 2026: the webhook route has a PGlite test; the BMKG CAP parser has none, and no production caller), F-08 (Node and WSL statements), R-01 (phone demo label), R-04 (demo queue for T4). F-01 and F-12 are closed by the points-only scope decision. The EXPLORE-18 items still open are duplicate events, the #peta list map on the live site, the phone layout of the admin tabs and the sign-in heading (`DEFECTS.md` section B). The "Versi dikoreksi" label and superseded proposals were fixed on 19 November 2026 (POLISH-02 and POLISH-03).
- **Re-run pending:** R-05 and R-06 (fixed in `7cf6c0f`).

## 9 Release-blocking checks (SDP section 10)

No check is evidenced as passed for release.

| Check | Linked test IDs | Status | Notes |
| --- | --- | --- | --- |
| Unsupported publication | ST-F-03, ST-F-07, ST-N-01, IT-B3-02, TI-02, IT-HOST-12 | Partial | Gate and policy tests exist. F-19 showed one path that published claims with empty support (merged proposals); HOSTED-31 closes it and adds a test. No adjudicated release scenarios (ST-N-01). |
| Exposed personal data | ST-N-07, ST-F-06, IT-B2-06 | Partial | No retention test is named. Log output of two model adapters is tested for secrets; nothing else is (ST-N-07). |
| Wrong active warning geometry | ST-F-01, ST-N-01, IT-B1-07, IT-HOST-03, ST-H-11 | Partial | Points only, by decision. Points are now written on hosted and match the GeoJSON feed (ST-H-11, ST-H-12). |
| Budget bypass | ST-N-02, IT-B1-04, IT-B2-08, IT-B3-01 | Partial | Worker or local only. The live path bypasses L3. The ledger refuses a sixth tool attempt (`l3-tool-attempt-budget.test.ts`, 19 Nov 2026). |
| Unauthorised moderation | ST-F-06, ST-F-07, ST-N-07, IT-B3-08 | Partial | Route and role tests exist. Hosted: a moderator rejected one proposal (18 Nov) and withdrew three events (19 Nov). No publish through the gate has run on hosted. The reject audit row is tested (F-30, `f3373c0`, 19 Nov 2026); the 18 Nov hosted reject predates the fix and has no audit row. |
| Stale or retracted evidence reinstated | ST-F-13, ST-F-14, ST-N-05 | Partial | F-14 fixed. The stale-write conflict is asserted at database level (`publication-writer.test.ts`). Over HTTP, a stale correction answers 409 (`moderation-stale-version-http.test.ts`, 19 Nov 2026); the publish route's stale path is only stubbed. The hosted withdrawals (ST-H-19) are event withdrawals, not source-revision withdrawals. |

## 10 Decisions and actions still open

1. **Team names for the sign-off blocks** (`SYSTEM-TEST.md` section 9, `INTEGRATION-TEST.md` section 11, `TEST-PLAN.md`). Owner decision 10 of 18 November 2026; the names have not been supplied.
2. **Worker redeploy for HOSTED-31: done** (18 Nov 2026, version `bddb82f4` from `f9cb7a0`; public smoke routes 200, Origin refusal 403).
3. **Persona re-run** to close R-01, R-05 and R-06 (owner to decide).
4. **F-02.** The briefing part is fixed and checked on hosted (ST-H-13, ST-H-14). Still open: run T2 step 7 in the browser on live data, or record the matched-update criterion as not evidenced.
5. **F-08.** Correct the CI Node statement in `CLAUDE.md`.
6. **A hosted API check.** No automated check reads the hosted public routes (`SYSTEM-TEST.md` section 7, item 17).
7. **Hosted re-check of the 19 November fixes.** F-29 (acquisition time on the record page), F-32 (header at 200% zoom), the "Diperbarui otomatis" label and the reject audit row (F-30) are not checked on hosted. Whether the hosted Worker runs `f3373c0` is not recorded.
