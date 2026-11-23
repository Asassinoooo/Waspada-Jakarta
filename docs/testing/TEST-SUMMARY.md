# Test summary: Waspada Jakarta

Project: Waspada Jakarta (Team 12, RPL course). Status date: 19 November 2026 (TG-DOCS-04; updated the same evening by TG-DOCS-05 and TG-DOCS-07; updated on 20 November 2026 by TG-DOCS-09). Draft for review. Baseline: `main` at `a7ba558`.
Later update: TG-DOCS-09 (20 November 2026): section 7D (TEST-GAP-05 group 1, PERF-01, the NFR-07 gaps, the 20 November deploy and the hosted re-timing), the section 7 table and the section 8 open findings. Earlier update: TG-DOCS-07 (19 November 2026): section 7B, the register counts in section 1, and the open items in sections 4, 8 and 9. Earlier update: TG-DOCS-05 (19 November 2026, evening): section 7A, and the open items in sections 8 and 10. Earlier versions: TG-DOCS-03 (18 November 2026 evening, baseline `2d9d442`), TG-DOCS-02 (18 November 2026 morning, baseline `6fff929`) and the 13 November 2026 summary. Section 3 is as of 13 November 2026.
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

## 7C 19 Nov 2026 (TEST-GAP-04, ST-F-09, NFR-04/06/07, SEC-HEADERS-01)

TG-DOCS-08 updates the register from the evidence in `docs/testing/evidence/2026-11-19/` (index in its README). Single-file test runs were on `main` at `e68aefd`. CI runs: 44498555647 (`e68aefd`, success, 2,917 tests, 2,913 passing, 0 failing, 4 todo) and 44502344276 (`9f6a456`, success, checked with `gh`). No heavy suite was run locally. The hosted checks are read-only, except that the scripted checklist signs in and out with existing test accounts and makes failed login attempts, and writes no content.

Status counts from `test-cases.csv`, the 165 rows that existed before this update (the seven new hosted rows, ST-H-21 to ST-H-27, are not counted here):

| Status | Before | After |
| --- | --- | --- |
| Evidence exists | 84 | 89 |
| Partial | 43 | 39 |
| Pass (local run reported; not re-run in TG-DOCS) | 21 | 21 |
| Blocked | 5 | 5 |
| Pass (CI run 44319579284) | 3 | 3 |
| Points only (owner, 16 Nov 2026) | 3 | 3 |
| Pass (hosted, read-only, 17 Nov 2026) | 2 | 2 |
| Pending run | 2 | 2 |
| Not evidenced | 2 | 1 |
| **Total** | **165** | **165** |

Rows changed (status):

| Row | Was | Now | Why |
| --- | --- | --- | --- |
| ST-F-04 | Partial | Evidence exists | Every clause is named: anonymous reads (hosted ST-H-01, ST-H-12), the filters, the empty and unavailable states, and the demo or live label (`map-home.test.tsx`). The one-filtered-set clause is checked by source text only |
| ST-F-05 | Partial | Evidence exists | The four times are each named from their own field (`event-detail-claim-sources.test.tsx`), and the hosted record page shows them (ST-H-23) |
| ST-F-09 | Partial | Evidence exists | Restrictions and health are named on the admin page (`source-approval.test.tsx`, `source-approval-api.test.ts`); the moderator tab, the demo wording and the role-change audit are named too |
| ST-N-02 | Partial | Evidence exists | Worker ledger limits are named (four reasoning calls, 60 s, 12,000 tokens, five attempts, resume keeps usage); the live caps are named under the reworded expected result |
| ST-N-06 | Not evidenced | Partial | The restore rehearsal is recorded (`nfr06/restore-report.json`), but deletion-tombstone behaviour and the demo rebuild are not recorded |
| ST-N-08 | Partial | Evidence exists | CI run 44498555647: clean checkout, `npm ci`, typecheck and build all succeed; Free-plan deploy is ST-H-01 |

Rows whose notes changed, with status unchanged: ST-F-02, ST-F-03, ST-F-08, ST-F-11, ST-F-12, ST-F-13, ST-F-15, ST-F-16, ST-N-04, ST-N-05 and ST-N-07 stay Partial. ST-N-03 stays Not evidenced (no human sessions).

Reworded expected results (owner decisions, 19 Nov 2026), each marked in its row: ST-F-11 (no quarantine), ST-F-12 and ST-F-16 (the live path does not use the Worker's L2 or L3, a design limit), ST-N-02 (the live path clause), ST-N-04 (the target: p50 under 500 ms, p95 under 1 s), and ST-N-07 (the approach: automated tests, an OWASP ZAP passive baseline and a scripted checklist, no active scan).

Defects: F-33 to F-38 added and fixed (proposed severities: F-33 High; F-34, F-35, F-36 and F-38 Medium; F-37 Low). Open items F-39 to F-45. F-45 (refused webhook items are not recorded or counted) is added by this update from the ST-F-11 review.

Still Partial after this update, and why: ST-F-02 (the hosted matched update in Pembaruan was not observed, ST-H-27); ST-F-03 (origin on screen and the draft's visibility after a stale write are not named); ST-F-08 (no-body/no-prompt text is not asserted; no 390 px check); ST-F-11 (refused items are not recorded or counted, F-45; no same-path test); ST-F-12 (nearby distinct incidents are not named on the live path); ST-F-13 and ST-N-05 (the HTTP stale-write tests mirror the Worker mapping, and the proposal decision route's stale path is only stubbed); ST-F-15 (no 'no coverage' wording is asserted); ST-F-16 (no test names the automatic decision's trace id); ST-N-04 (warm and cold start not separated; briefings not timed); ST-N-06 (deletion-tombstone behaviour not recorded; the rehearsal restored live data into PGlite); ST-N-07 (approved hosts not enforced, F-42; retention, F-39 and F-40; correlation prompt, F-43; no penetration test).

## 7D 20 Nov 2026 (TEST-GAP-05 group 1, PERF-01, NFR-07 gaps, deploy)

TG-DOCS-09 updates the register from the evidence in `docs/testing/evidence/2026-11-20/` (index in its README). Four commits on `main`, all dated 19 Nov 2026, merged as `5d4dc3c`: `5589a05` (an older undecided proposal cannot replace a newer published version; real-route stale-write tests for ST-F-03, ST-F-13 and NFR-05; F-46), `a43ced9` (PERF-01: a public event page is read in 4 queries instead of 61, with the same output; F-47), `9e6c30e` (ST-F-12 live-path correlation tests; the claim origin label on the moderator screen; F-48) and `8ce1e1f` (NFR-07: approved hosts checked at fetch, correlation-prompt source-text isolation, ADR-005 retention purge in the hosted ingest; F-39 to F-43).

Deploy, 20 Nov 2026 (`evidence/2026-11-20/deploy/`): `deploy:prod` built the web app and deployed the Worker, version `007fbaa5-12d0-40e0-a999-db3af53eb11b`, with the schedule `7,37 * * * *`. The hosted bootstrap (main `5d4dc3c`) applied migration 062 (1 applied, 61 already present, 62 files), found 16 of 16 sources ready and the purge function present.

CI. Run 44539519014 on `5d4dc3c` (push to main) concluded success: job 135613780034, 16 steps, all success, no failing line in the job log. `evidence/2026-11-20/ci/ci-44539519014-cited-tests.txt` lists the passing lines for the 130 cited test titles in 23 files. No heavy suite was run locally.

Hosted ingest (`evidence/2026-11-20/nfr07/`). 44651206557 ran before the bootstrap: `Retention purge: failed.` (migration 062 not yet applied) and three sources failed (feeds_ok=13 feeds_failed=3; petabencana and source-bmkg-gempa `poll_error`, source-detik-utama `fetch_error`). 44692616661 ran after it: feeds_ok=16 feeds_failed=0, purge counts all 0. No ST-H row records the 20 Nov ingest.

NFR-04 re-timing after the PERF-01 deploy (`evidence/2026-11-20/nfr04/`):
- Run 3 (started 07:25 UTC, `timing-run3-after-perf01.txt`). Warm, 30 requests per route: `GET /api/v1/events` p50 152 ms and p95 255 ms (run 2 on 19 Nov: p50 451 ms, p95 1,362 ms). Every GET route met p50 under 500 ms and p95 under 1 s. `POST /api/v1/briefings` did not meet p50 (869 ms); 17 of 30 OK, 13 failed with 503.
- Concurrent, 5 clients x 20 requests per route: `GET /api/v1/events` 60 of 100 OK, 40 failed with 503. `POST /api/v1/briefings` 98 of 100 OK, 2 failed with 503, p50 1,068 ms and p95 1,328 ms (not met).
- Cold, first request after 5 minutes idle: `POST /api/v1/briefings` 792 to 1,012 ms; the file's own check (all cold requests under 1,000 ms) fails by one request.
- A second run started 01:26 UTC (`timing-run3-interrupted-network.txt`) stopped after cold round 1 with a network timeout (ETIMEDOUT). It is kept for the record and is not a result.
- CPU (`cpu-tail-after-perf01.txt`, wrangler tail, 20 Nov 2026): 16 sampled `GET /api/v1/events` on `007fbaa5`, all ok, CPU p50 35 ms and max 52 ms. The file records 37 to 113 ms before the fix (19 Nov). A separate burst of 6 clients x 8 requests gave 43 x 200 and 5 x 503 with the body `error code: 1102` (the file's own gloss: Worker exceeded resource limits).

The 503 failures are not explained by any file in the record. ST-N-04 stays Partial. They are recorded as F-50 (open), together with the CPU finding (see the open items below).

ZAP active scan on a local copy (20 Nov 2026, `evidence/2026-11-20/nfr07/`, ZAP 2.17.0, `plan-active.yaml`, reports `zap-active-local-report.html` and `.json`). The Worker API on 127.0.0.1:8787 had no High, Medium or Low alert; its two informational alerts are an authentication request and a user agent fuzzer. The Vite dev server on 127.0.0.1:5173, which is not deployed, had Medium alerts for CSP not set (4 instances) and a missing anti-clickjacking header (4), and a Low for a missing X-Content-Type-Options header (5). The record for the deployed headers is the hosted after-scan of 19 Nov 2026 (0 Medium after SEC-HEADERS-01). Production was not actively scanned.

Row changes, Partial to Evidence exists unless stated (all reworded rows are marked in SYSTEM-TEST.md and test-cases.csv):

| Row | Was | Now | Why |
| --- | --- | --- | --- |
| ST-F-02 | Partial | Evidence exists | Reworded (owner decision 19 Nov 2026): proven by tests; the briefing place match is checked on hosted. The matched update in Pembaruan on live data (ST-H-27) was not observed; F-02 stays open for it |
| ST-F-03 | Partial | Evidence exists | Reworded (owner decision 19 Nov 2026): origin per claim (F-48 fix), one version and audit record for the first correction, a replay refused with 409 (the route has no idempotency key), a publication decision record, the stale draft kept in the queue |
| ST-F-08 | Partial | Evidence exists | Reworded under the owner rule of 19 Nov 2026 (a clause that cannot be proven is reworded): no body or prompt text, 401 or 403 for a non-moderator, 390 px empty state shown in the screenshots; page-level horizontal scroll is not measured |
| ST-F-12 | Partial | Evidence exists | Reworded (owner decision 19 Nov 2026, design limit): the live-path clauses are named by `st-f-12-live-correlation.test.ts` (10 tests) |
| ST-F-13 | Partial | Evidence exists | A stale correction through the real route answers 409 and writes nothing; every public view shows the current version; the decision race tests (F-CONC-01) pass |
| ST-F-15 | Partial | Evidence exists | Reworded (owner decision 19 Nov 2026, option a): an empty live list says that no report is published yet and is not an all-clear; demo and live labels are tested |
| ST-F-16 | Partial | Evidence exists | Reworded (owner decision 19 Nov 2026, design limit): the automatic decision carries the trace id; the live path persists no investigation case |
| ST-N-05 | Partial | Evidence exists | Reworded under the owner rule of 19 Nov 2026 (a clause that cannot be proven is reworded): notices are counted through the updates feed; repeated delivery and stale-route tests |
| ST-N-06 | Partial | Evidence exists | Reworded under the owner rule of 19 Nov 2026 (a clause that cannot be proven is reworded): logical restore rehearsal (19 Nov v2 report) and demo rebuild test; not point-in-time recovery |
| ST-N-07 | Partial | Evidence exists | Approved hosts, correlation-prompt isolation and the retention purge are tested, deployed and clean on the hosted ingest; ZAP active scan on a local copy recorded above |
| ST-F-11 | Partial | Evidence exists | Reworded under the owner rule of 19 Nov 2026: the unchanged-content and malformed-item clauses are named by two tests each; the source-text, offset, unknown-field and same-path clauses are removed. F-45 is closed as out of scope |
| ST-N-04 | Partial | Partial | Re-timed (run 3): warm GET reads within target; the briefing route and concurrent list requests are not (503s, above) |

Status counts for all 172 rows of `test-cases.csv` (including ST-H-21 to ST-H-27), before this update (HEAD of the TG-DOCS-09 worktree) and after:

| Status | Before | After |
| --- | --- | --- |
| Evidence exists | 95 | 106 |
| Partial | 40 | 29 |
| Pass | 26 | 26 |
| Blocked | 5 | 5 |
| Points only | 3 | 3 |
| Pending run | 2 | 2 |
| Not evidenced | 1 | 1 |
| **Total** | **172** | **172** |

Defects. F-39 to F-43 fixed in `8ce1e1f` and deployed on 20 Nov 2026 (Worker `007fbaa5`, migration 062); each entry in `DEFECTS.md` names its test. F-45 closed as out of scope after the ST-F-11 rewording (owner decision 19 Nov 2026). New: F-46 (High; stale proposal could overwrite a newer version; fixed in `5589a05`, on `main`), F-47 (Medium; per-event queries; fixed in `a43ced9`, deployed; the 503 failures above are not closed), F-48 (Low; claim origin on the review screen; fixed in `9e6c30e`, on `main`), F-49 (Low; open; ADR-061 says the automatic publication writes an audit record, it writes a publication decision record). F-50 (Medium; open; CPU above the nominal Free allowance and 503 responses under concurrency; next step PERF-02, not started, needs an owner decision). F-02 and F-44 are unchanged.

Open items for the orchestrator (not decided in this update):
- F-50 (open, Medium): hosted 503 responses under concurrency, the briefing route's p50, and CPU above the Free plan's nominal allowance. Next step PERF-02, not started; needs an owner decision.

- ST-F-02's hosted step (ST-H-27) and F-02.
- The 20 Nov hosted ingest has no ST-H row.
- `evidence/2026-11-19/README.md`: a superseded line now sits at its nfr06 entry, pointing to the v2 files; the v1 text is kept.
- The 390 px screenshots show the empty state; they do not measure page-level horizontal scroll.

## 7 Partial rows: what moved and what did not

The question for this update was whether rows that were Partial are now fully proven. Moving a row needs new evidence for the part that was missing.

| Row | Was | Now | Why |
| --- | --- | --- | --- |
| AT-03 | Blocked | Partial | Hosted T4 ran; no decision made |
| T5 | Partial | Pass (hosted, read-only) | Hosted T5 passed on both viewports (ST-H-07) |
| ST-F-11 | Partial | Evidence exists | Reworded under the owner rule of 19 Nov 2026: the unchanged-content and malformed-item clauses are named by tests (20 Nov 2026, section 7D) |
| ST-F-02, ST-F-03, ST-F-08, ST-F-12, ST-F-13, ST-F-15, ST-F-16 | Partial | Evidence exists | Reworded rows with named tests on 20 Nov 2026 (section 7D) |
| ST-N-05, ST-N-06, ST-N-07 | Partial | Evidence exists | Reworded rows (ST-N-05 and ST-N-06 reworded under the owner rule of 19 Nov 2026: a clause that cannot be proven is reworded); deploy and CI on 20 Nov 2026 (section 7D) |
| ST-N-04 | Partial | Partial | Re-timed after PERF-01 (run 3): warm GET reads within target; the briefing route and concurrent list requests are not (section 7D) |
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
- **Fixed on 20 November 2026 (TG-DOCS-09):** F-39 to F-43 (`8ce1e1f`; deployed 20 Nov 2026 with Worker `007fbaa5` and migration 062); F-46 (`5589a05`, on `main`); F-47 (`a43ced9`, deployed; its 503 failures are not closed); F-48 (`9e6c30e`, on `main`). F-45 closed as out of scope (owner decision, 19 Nov 2026).
- **Open, new on 20 November 2026:** F-49 (ADR-061 wording: the automatic publication writes a publication decision record, not an audit row; documentation fix needed). F-46 to F-48 carry proposed severities that the owner has not reviewed. F-50 (open, Medium): hosted 503 responses under concurrency and CPU above the nominal Free allowance; next step PERF-02, not started, needs an owner decision.

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
