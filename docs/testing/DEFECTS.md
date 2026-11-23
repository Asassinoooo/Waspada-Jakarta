# Defect and finding log

Project: Waspada Jakarta (Team 12, RPL course). Status date: 20 November 2026. Branch: `work/TEST-DOC-01-chapter5`.
Updated 16 November 2026 (HOSTED-01 documentation decisions): status lines on F-01, F-03, F-04, F-12, F-13 and F-14; F-13 and F-14 added to section B.
Updated 18 November 2026 (TG-DOCS-02): status for R-01, R-05, R-06, R-09 and R-10; CI status on F-03, F-04, F-13 and F-14; the F-14 residual; new entries D-03, F-16, F-17, F-18 and F-ALERT-02.
Updated 19 November 2026 (TG-DOCS-04): F-20 to F-28 and the EXPLORE-18 open items (section B); R-11 to R-13 (section D).
Updated 19 November 2026 (TG-DOCS-05): status line on F-02, and new F-29 (section B).
Updated 19 November 2026 (TG-DOCS-07): F-05 (partly closed), F-06 (closed by test), F-29 and F-32 (fixed, hosted re-check pending), new F-30 and F-31 (fixed, TEST-GAP-03), and the two EXPLORE-18 open items fixed by POLISH-02 and POLISH-03 (section B).
Updated 23 November 2026 (TG-DOCS-10): F-50 fixed by PERF-03/04 and retested (run 4, `docs/testing/evidence/2026-11-23/`). Earlier update 20 November 2026 (TG-DOCS-09): F-39 to F-43 fixed and deployed on 20 November 2026 (section B); F-45 closed as out of scope; new F-46 to F-50 (section B). The evidence is in `docs/testing/evidence/2026-11-20/`.
Related: `docs/testing/test-cases.csv`, `docs/testing/TEST-SUMMARY.md`, `DOKUMENTASI_UNIT_TESTING.md` section 2.a (corrected text on this branch).

## Purpose and rules

- A **defect** is a confirmed fault with a commit that fixes it. Section A lists defects.
- A **finding** is an observation that needs a decision. Section B lists findings, and each entry has a status line: open, fixed (with the commit SHA), mitigated (with the commit SHA, where the cause is outside the repository) or decided (with the owner's decision). A finding keeps its F-nn ID after a fix, so that the backlog and the gap reports still resolve. Findings are not moved to section A and are not renumbered.
- Commit SHAs in this file were checked with `git -C <worktree> show -s --format='%h %s' <sha>` on 13 November 2026. SHAs checked on 13 November 2026 (the six in sections A and C) all resolved. The fix SHAs for F-03, F-04, F-13 and F-14 (section B) were checked on 16 November 2026 with `git show -s` and `git branch -r --contains`; each is on `origin/main`.
- SHAs and run IDs added on 18 November 2026 were checked with `git show -s`, `git merge-base --is-ancestor` and `gh run view` on that date.
- SHAs added on 19 November 2026 (F-20 to F-28, R-11 to R-13) were read from `git log` at `a7ba558` (`git show --stat` for the files each fix changed). The CI run IDs and the hosted check results were not re-read with `gh` in this update.
- Fix commits cited for F-29 to F-32 (`b4a0d0f`, `ab4533a`, `f3373c0`, `b3ca26d`) and the test commit `f155822` are on `main` (checked with `git merge-base --is-ancestor` on 19 November 2026). None is in CI baseline `a7ba558`, so no CI run covers them yet; `test-cases.csv` holds `44484348615` until a run is read.
- SHAs and run IDs added on 19 November 2026 for F-33 to F-38 were checked with `git show -s` and `git merge-base --is-ancestor` on that date, and CI run 44502344276 with `gh run view`. `ea955b9f` is a Cloudflare Worker version id, not a git SHA. Open items F-39 to F-45 have no fix commit.
- The fix SHAs (`5589a05`, `a43ced9`, `9e6c30e`, `8ce1e1f`) were checked on 20 November 2026 with `git show -s` and `git merge-base --is-ancestor`: each is an ancestor of the TG-DOCS-09 worktree HEAD. The CI run and job (44539519014, job 135613780034) were read with `gh api`, because `gh run view --log` returned no output. The ingest runs 44651206557 and 44692616661 are in `evidence/2026-11-20/nfr07/`. `007fbaa5` is a Cloudflare Worker version id, not a git SHA; it comes from the deploy record in `evidence/2026-11-20/deploy/`.
- Blocked and pending UAT results are not defects (`docs/testing/UAT.md` section 10).

## Section A: Verified defects (fixed)

### D-01: duplicate `/v1` suffix in the Mastra model URL

- **Symptom:** the unit report records an HTTP 404 in an intelligence integration test and in the AI gateway probe. The report states that this symptom is not in the commit and was not re-verified (`DOKUMENTASI_UNIT_TESTING.md` section 2.a, item 1).
- **Cause:** `NINEROUTER_URL` was set to `http://127.0.0.1:9090/v1`. The SDK client appends `/v1` again, so the request went to `/v1/v1/chat/completions` (same source, lines 78 to 86).
- **Fix commit:** `66d8e94` (`fix(intelligence): normalize baseUrl to avoid duplicate /v1 suffix in Mastra model URL`, 4 Nov 2026). The fix strips a trailing `/` and `/v1` in `getNineRouterConfig()` in `apps/intelligence/src/providers/ninerouter-adapter.ts`.
- **Covered by:** no test found that asserts the suffix stripping. `apps/intelligence/test/ninerouter-rate-gate.test.ts` (line 36) uses a `/v1` URL in its mock; it does not test the fix. Regression coverage is a gap.
- **Source:** `DOKUMENTASI_UNIT_TESTING.md` section 2.a; `git show 66d8e94`.

### D-02: live RSS seed used a `source_kind` the database rejects

- **Symptom:** seeding the RSS sources in `tools/serve-live-pipeline.ts` was rejected by the database. The full error text is not recorded in the commit (`DOKUMENTASI_UNIT_TESTING.md` section 2.a, item 2).
- **Cause:** migration `apps/db/migrations/001_foundation.sql` (line 44) allows `source_kind` values `authority`, `operator`, `newsroom`, `institution`, `crowdsourced_platform` and `other`. The seed used `media`.
- **Fix commit:** `973f70a` (`fix(LIVE-TEST): use newsroom source_kind to satisfy check constraint`, 4 Nov 2026). The seed now writes `newsroom` at `tools/serve-live-pipeline.ts` line 253.
- **Covered by:** no test found that seeds through `tools/serve-live-pipeline.ts` or asserts that `media` is refused. Other database tests use `newsroom` (for example `apps/db/test/pipeline-flow-store.test.ts` line 89). Regression coverage is a gap.
- **Source:** `DOKUMENTASI_UNIT_TESTING.md` section 2.a; `git show 973f70a`.

### D-03: CI red on `main` on 16 and 17 Nov 2026, fixed forward

- **Symptom:** the CI `test` job failed on three pushes to `main`: `8324c11` (run 43883966354, 16 Nov 2026), `5717d37` (run 43890955604, 16 Nov) and `181d331` (run 44003526985, 17 Nov).
- **Fix:** the first green run after the 16 Nov failures was `c985712` (run 43897403670, 16 Nov). The commit messages of `5717d37` (CI-FIX-01) and `c985712` (CI-FIX-02) name the same area: the detail snapshot and its fixtures, which involve `locationLabelPresent`. The cause of the 17 Nov failure is not recorded in the repository. The next push, `330b20d` (run 44009413390), passed. That commit changes only `.github/workflows/ingest.yml`.
- **Status (18 Nov 2026): closed.** The current head, `6fff929`, passed (run 44211263890).

### D-04: PGlite WebAssembly crash on the CI runner (flaky)

- **Symptom:** CI run 44220257264 (commit `a9ddcc7`, documentation only, 18 Nov 2026) failed in `Run Database Tests`. Node 24.22.2 stopped with `V8_Fatal ... UnregisterWasmAllocation` in `l3-investigation-publication-gate.test.ts` after its first case passed.
- **Cause:** a V8 crash during repeated PGlite (WebAssembly) instantiation, the same class the per-file DB runner was built to contain (`CLAUDE.md`, test runner notes). It is not a test assertion failure and is not counted as a pass.
- **Action:** the failed job was re-run and passed (399 of 399 DB tests; 2,555 in total).
- **Status (18 Nov 2026): mitigated.** CI and the hosted ingest pin Node 24.21.0 (`e41e11d`). No crash has repeated in later runs, including 44314452973. Re-open if it returns.

### D-05: CI red on `main` on 18 Nov 2026 after the HOSTED-26 to HOSTED-30 merges, fixed forward

- **Symptom:** runs 44248122378 (`7f1c0ac`), 44250372908 (`0eaf0f7`) and 44250662007 (`34b831f`) failed. The worker step failed six cases in `public-briefing-runtime`, `public-event-detail-runtime` and `public-event-geojson-runtime`. The database step failed one case in `persistence.test.ts` ("Missing expected rejection").
- **Cause:** test fixtures, not product code. The three runtime fixtures lacked the `location_label` column that the snapshot reader selects since migration 055. `persistence.test.ts` still expected a pending source to be refused collection, which migration 056 (HOSTED-28, owner decision: revoke stops publication only) no longer does.
- **Fix:** `e64d281`. Its message reuses the ID CI-FIX-02, which `c985712` already used on 16 Nov (D-03); the two are different fixes. Each file was run locally and passed. Run 44314452973 (`062aac6`) passed every step (2,650 tests and cases, 0 failed).
- **Status (18 Nov 2026): closed.**

## Section B: Findings and their status

Each entry carries a status line. An entry without a fixed, mitigated or decided status is open. F-15 is not used here, because `REQUIREMENTS-GAP.md` uses it for a proposed CI item. The status lines of F-01 to F-19 and F-ALERT-02 are as of 18 November 2026; those of F-20 to F-32 and the open items are as of 19 November 2026.

F-20 to F-28 were found by EXPLORE-18 (18 November 2026): five read and write walkthroughs of the hosted site (an anonymous visitor at 1440, 390 and 320 px and at 200% zoom; two self-registered residents; the moderator; the administrator) and an API data audit of the 21 published events. Each entry says what was seen. Evidence is under `.codex-build/explore/` (gitignored, not committed). The open items from EXPLORE-18 are listed at the end of this section.

### F-01: the public map shows no warning-boundary display

- **Observation:** US-01 asks the user to tell a point from a warning boundary (SDP US-01; FR-09). The public popup captions every mapped marker as a point. Polygons appear only in the fixture presentation (`#detail/presentation`) and in the admin views.
- **Evidence:** `docs/testing/UAT.md` section 6, T1 open item and section 6.6; `apps/web/src/MapPopup.tsx` lines 56-57 (`locationNote`). Affects ST-F-01 and AT-01. T1 is Blocked in `test-cases.csv`.
- **Status (16 Nov 2026): decided, points only (owner).** US-01 and FR-09 are narrowed to points. Warning boundaries and polygons are out of scope, and the map shows points. This closes F-01 as a scope decision, not as a fix: no boundary display is built, and none is claimed. Recorded in SDP §4 (FR-09 note, 13 Nov 2026; US-01 wording, 16 Nov 2026).

### F-02: matched-update checks cannot run on the demo dataset

- **Observation:** T2 step 7 ("Mengapa muncul" and the duplicate-alert check) needs live data. On the demo dataset the page shows a gate message instead (`apps/web/src/BriefingResults.tsx` lines 164-166; `apps/web/src/UpdatesCenter.tsx` line 668).
- **Evidence:** `docs/testing/UAT.md` section 6, T2 step 7 and open item; section 6.6. Affects ST-F-02 and AT-02. T2 is Partial in `test-cases.csv`.
- **Decision needed:** either run T2 step 7 on a live dataset (this needs `serve:live`, real feeds and model quota, under explicit authorisation), or record the US-02 matched-update criterion as not evidenced.
- **Status (19 Nov 2026): open for one part.** The briefing part is fixed and checked on the hosted site: a place interest matches, and its reason is returned (ST-H-13, ST-H-14; F-20 and F-21). The updates-feed step (a matched update in Pembaruan, read on live data) is still open. It has tests (`updates-center.test.tsx`, `public-event-updates.test.ts`, `publication-outbox-delivery-runtime.test.ts`) but no live browser run, so T2 step 7 has not run.

- **Update (19 Nov 2026, TG-DOCS-08):** the once-only correction in Pembaruan is now named by a test (`apps/web/test/updates-center.test.tsx`, 'ST-F-02: a correction re-polled in a later cycle is shown once'). The hosted matched update in Pembaruan on live data was not observed (SYSTEM-TEST ST-H-27: the updates feed lists only changes made after a browser's first visit, and no matching change happened in the window). This finding stays open for that part.

### F-03: L1 webhook ingest imports L2 and L4 modules at runtime

- **Observation:** `apps/worker/src/layers/l1-data-knowledge/webhook-ingest.ts` imports the L2 proposal engines (`apps/worker/src/layers/l2-model-grounding/proposal-engine.ts`, `apps/worker/src/layers/l2-model-grounding/correlated-proposal-engine.ts`) and the L4 `apps/worker/src/layers/l4-application-integration/event-broadcaster.ts`. The import block is at lines 13 to 24. `CLAUDE.md` allows L1 one fixed L2 extraction adapter and says L1 must not investigate or publish.
- **Evidence:** `docs/testing/INTEGRATION-TEST.md` section 6 (that section gives lines 15 to 25; the block is at 13 to 24 in this file). `CLAUDE.md`, layer table (repository root). Affects IT-B1-06.
- **Status (16 Nov 2026): fixed in `cffc865`** (`fix(TG-F03)`, 13 Nov 2026; on `origin/main`; CI for `6fff929` (run 44211263890, 18 Nov 2026) is green and includes it). L1 webhook ingest now depends on ports (`DirectProposalPort`, `CorrelatedProposalPort`, `ModerationNotificationPort`) wired in `index.ts`. The import-boundary test `layer-import-boundary.test.ts` scans layer imports. **Residual:** F-03-1, an allowlisted L5 telemetry import in `synthetic-fixture-runner`, is not fixed (SDP §10).

### F-04: the publication gate does not read the L3 ledger status

- **Observation:** the proposal writer checks only that the investigation lineage rows exist (`apps/db/src/event-proposals.ts`, `requireInvestigationLineage`, line 566). On the code read, no L4 gate file or proposal file references `case_status` or `stopped_for_review`. The grep was run on 13 Nov 2026 in the main checkout over `apps/worker/src` and `apps/db/src`; the only matches were in L3, L5 and the ledger. TI-02 is held because of a disputed claim and an unresolved field, not because of the ledger status. So a proposal from a `stopped_for_review` case is not refused on that status alone.
- **Evidence:** TEST-INT-01 case TI-02 (`apps/db/test/l3-investigation-publication-gate.test.ts` on main, commit `71022ee`). Affects TI-02 and IT-B3-01.
- **Status (16 Nov 2026): fixed in `593f849`** (`fix(TG-F04)`, 13 Nov 2026; on `origin/main`; CI for `6fff929` (run 44211263890, 18 Nov 2026) is green and includes it). Owner decision (c), 13 Nov 2026: the gate refuses a proposal whose investigation's latest checkpoint is `stopped_for_review`. On the agent path it is queued with `investigation_stopped_for_review`; on the moderator path it is denied (API 409). Reject is still allowed. Recorded in the ADR-061 amendment of 13 Nov 2026. **Residuals:** the expiry sweep takes no lock and may write a second decision row for the same proposal (code reading, not reproduced); `assessAutoPublication` reads the investigation's latest status only, not grounding sufficiency; the L4 publication role cannot read `investigation_id` or `case_status` on hosted Neon, so the check fails closed there (SDP §10); the locks are not exercised under concurrent load or on hosted Neon.

### F-05: no PGlite test for the webhook route or the BMKG CAP parser

- **Observation:** `apps/worker/test/webhook-ingest.test.ts` and `apps/worker/test/bmkg-cap.test.ts` do not import PGlite or `createTestDatabase`. The CAP tests are parser-level.
- **Evidence:** `docs/testing/INTEGRATION-TEST.md` section 7, items 1 and 2. Affects IT-B1-06 and IT-B1-07.
- **Decision needed:** add PGlite composition tests for both, or accept the handler and parser tests for the course release and record that decision.
- **Status (19 Nov 2026): partly closed.** The webhook route has a PGlite test now (`apps/worker/test/webhook-ingest-db.test.ts`, TEST-GAP-03). The BMKG CAP parser still has none, and it has no production caller either: its only importer is `apps/worker/test/bmkg-cap.test.ts`, and BMKG polling is JSON inside the scheduled handler, so no production path would be covered by such a test. The BMKG gap is explained here, not closed: no owner decision to accept it is recorded.

### F-06: no dedicated test for `freshness-aggregate-policy.ts`

- **Observation:** the aggregate rules are tested only as cases inside `apps/worker/test/l4-public-projection.test.ts`.
- **Evidence:** `docs/testing/INTEGRATION-TEST.md` section 5 (gap paragraph) and section 7, item 3. File: `apps/worker/src/layers/l4-application-integration/freshness-aggregate-policy.ts`.
- **Decision needed:** add a dedicated test file and list it in `apps/worker/package.json`, or accept the current cases as sufficient.
- **Status (19 Nov 2026): closed by test.** `apps/worker/test/freshness-aggregate-policy.test.ts` (7 tests, listed in `apps/worker/package.json`) checks the four written rules, that the order of impact statuses does not matter, and every claim status with every impact list of up to three statuses (120 cases). Impact lists longer than three are not enumerated.

### F-07: SDP section 3.1 describes a read-only moderator view with no sign-in

- **Observation:** `SOFTWARE_DEVELOPMENT_PLAN.md` line 155 says the moderator evidence review is read-only, with no sign-in and no review mutations, and defers those to a later authenticated release. This is stale. Password accounts exist (ADR-060), and moderation is authenticated (`apps/worker/test/moderation-api.test.ts`).
- **Evidence:** `docs/testing/SYSTEM-TEST.md` section 1 (documentation conflict); `docs/decisions/ADR-060-password-accounts.md`.
- **Decision needed:** the owner or root planner updates the SDP section 3.1 text. The test documents do not change the SDP.
- **Status (18 Nov 2026): fixed in docs (owner decision).** SDP section 3.1 now describes the signed-in moderator review that the app implements.

### F-08: WSL distribution and CI Node version are stated inconsistently

- **Observation:** `DOKUMENTASI_UNIT_TESTING.md` section 4.b (line 268) says WSL2 Ubuntu 24.04 LTS. `CLAUDE.md` says the local environment is WSL Ubuntu-26.04. A related point: `CLAUDE.md` says CI uses Node 22, but `.github/workflows/ci.yml` line 19 sets `node-version: 24` (runner `ubuntu-24.04`, line 11). This summary uses `ci.yml`.
- **Evidence:** `DOKUMENTASI_UNIT_TESTING.md` line 268; `CLAUDE.md` (Environment and Commands; repository root); `docs/testing/TEST-PLAN.md` section 6; `.github/workflows/ci.yml` lines 11 and 19.
- **Decision needed:** the owner confirms which distribution the recorded local runs used, corrects the document that is wrong, and confirms the CI Node version to state in `CLAUDE.md`.

### F-09: Copied reports are not flagged in the source count

- **Observation:** the card reads "N sumber" from the number of distinct outlet names (`apps/web/src/published-events.ts` lines 123 to 136). A code comment says this is "a count of outlets, not corroboration". The interface shows no copy or duplicate marker, so a syndicated copy counts as an extra source. The worker run found no copy wording in `apps/web/src`.
- **Evidence:** `worker-run-01` (WRK-01 blocked: no copied report in the live feed); `published-events.ts`.
- **Decision needed:** flag copies in the source count, or relabel the count so that it does not read as corroboration (FR-06).
- **Status (18 Nov 2026): fixed (owner decision).** Copies of the same article count once: the detail counts outlets, not copies (HOSTED-27, `f0d81ed`), and the publication `source_count` ignores copies (HOSTED-28, `731ec5b`, test `apps/worker/test/hosted28-source-count.test.ts`). The source count still is not corroboration. WRK-01 stays Blocked until a copied report is live.

### F-10: Expired-warning wording differs between card and detail

- **Observation:** the card and popup say "Lewat masa berlaku sumber" (`published-events.ts` line 216). The detail says "Lewat batas tinjau" (`display.ts` line 76). No expired event was in the live feed, so this is read from source only.
- **Decision needed:** choose one wording for the expired state (minor copy).
- **Status (18 Nov 2026): fixed in `f0d81ed` (HOSTED-27).** Card, popup and detail all say "Lewat masa berlaku sumber" (`apps/web/src/display.ts`). Test: `apps/web/test/event-time-day-precision.test.tsx` (UT-HOST-12).

### F-11: "Unknown time" wording differs between card and detail

- **Observation:** the card says "Tidak diketahui". The detail says "Waktu kejadian tidak diketahui" (`display.ts` line 31). Seen in `visitor-run-01` and `resident-run-01`.
- **Decision needed:** choose one wording (minor copy).
- **Status (18 Nov 2026): fixed in `f0d81ed` (HOSTED-27).** Card and detail both say "Waktu kejadian tidak disebutkan". A date-only time is shown with day precision ("17 Nov 2026, jam tidak disebutkan", owner decision 18 Nov 2026; HOSTED-29 `f625c81`). Test: UT-HOST-12.

### F-12: No radius or polygon is drawn on the public map

- **Observation:** the map draws OSM tiles and marker circles only (`EventMapCanvas.tsx`). An event with no point is not shown on the map, and no radius is drawn for it. The radius check in VIS-02 is skipped.
- **Status (16 Nov 2026): decided, points only (owner).** The map draws points only. No radius or polygon is drawn or claimed, and the radius check in VIS-02 is out of scope. Same scope decision as F-01. Not a fix.

### F-13: the record page and the #peta sheet print "this API record has no geometry" for every record

- **Observation:** the record page and the `#peta` sheet say that an API record has no geometry, for every record, including records that have geometry (`TEST-EVALUATION.md`, top finding 2; `REQUIREMENTS-GAP.md`, "New defects proposed"). Found by code reading, not in a browser. Affects ST-F-01 and the FR-09 clause C2b.
- **Status (16 Nov 2026): fixed in `de0b77f`** (`fix(TG-F13)`, 13 Nov 2026; on `origin/main`; CI for `6fff929` (run 44211263890, 18 Nov 2026) is green and includes it). Mapped records are drawn. A missing field shows a neutral notice. Geometries outside the Jakarta view are counted, not drawn.
- **Residual:** covered at component level (`event-detail-geometry.test.tsx`), not checked in a browser. ST-F-01 is points-only scope (F-01).

### F-14: proposal processing time was used as the public event time

- **Observation:** proposal processing time was used as the public event time, and freshness was set to `current` by construction (`TEST-EVALUATION.md`, top finding 3). This conflicts with two CLAUDE.md invariants: keep event, issuer, acquisition and processing times distinct, and never invent a timestamp; and expiry, missing reports or an unavailable source never prove resolution or safety.
- **Status (16 Nov 2026): fixed in `588e375`** (`fix(TG-F14)`, 13 Nov 2026; on `origin/main`; CI for `6fff929` (run 44211263890, 18 Nov 2026) is green and includes it). With no explicit source event time, the start stays null with precision unknown, with no fallback to publish, retrieval or processing time. Freshness is `needs_update` with basis unknown, not `current`. Migration 048 drops NOT NULL on `incidents.first_observed_at`. Owner decision (f), 13 Nov 2026.
- **Residuals:** Since HOSTED-21 (`f8463b6`, 17 Nov 2026), a missing event time is waived for auto-publish. The check is recorded as the waiver `event_time_unknown`, and the public detail shows "Waktu kejadian tidak disebutkan". Only a malformed time holds an item (`time_missing`). A correction still needs an event time (`assessCorrectionGate`; ADR-061 amendment of 17 Nov 2026). Rows published earlier keep processing-time starts until they are republished. FR-03 clauses 14 and 15 are not re-checked (`REQUIREMENTS-GAP.md`, 14 Nov 2026 update).

### F-16: GitHub's scheduled ingest ran too rarely

- **Observation:** the hosted ingest's `schedule:` trigger fired once in about 18 hours. The only scheduled run recorded on 17 and 18 Nov 2026 was run 44151179665 (17 Nov, 18:44 UTC). The site is only as current as its last ingest run (`docs/DEPLOYMENT.md`, known limitations).
- **Evidence:** GitHub Actions run 44151179665 (event `schedule`, `gh run view`); ADR-065, 18 Nov 2026 amendment.
- **Status (18 Nov 2026): mitigated (`a83b2c0`, HOSTED-25).** The `schedule:` trigger was removed from `ingest.yml`. The production Worker cron (`7,37 * * * *`) now sends one `workflow_dispatch` per slot. The first run it started, 44217189260, completed with success (ST-H-10). The cause is GitHub's scheduler, which is outside the repository. The cron needs the `GITHUB_DISPATCH_TOKEN` secret. Without it the cron logs `outcome=not_configured`, and an expired token shows as `rejected_auth` (`docs/DEPLOYMENT.md` §7).

### F-17: `*.workers.dev` is blocked by some ISP DNS resolvers

- **Observation:** a resolver on one Indonesian mobile network (XL Axiata) answers `*.workers.dev` with a block page. The browser then shows a TLS "certificate name does not match" error. The site itself is fine.
- **Evidence:** `docs/DEPLOYMENT.md` (note at the top); `docs/testing/UAT.md` section 9.2, network note.
- **Status (18 Nov 2026): accepted limitation (owner decision: no custom domain).** Another resolver reaches the site, such as Cloudflare WARP or 1.1.1.1. The limitation is recorded in ADR-065 (18 Nov amendment).

### F-18: ANTARA feeds failed from one PC network

- **Observation:** a local ingest run on 17 Nov 2026 from one PC network failed to fetch three ANTARA feeds. GitHub run 44071702304, on the same day, fetched all 16 sources (`ok=16 failed=0`). The local log is not cited in the repository.
- **Evidence:** GitHub Actions run 44071702304 (`gh run view`); ADR-065, 18 Nov 2026 amendment.
- **Status (18 Nov 2026): mitigated; not a product fault.** The failure is on one network path. Since HOSTED-24B and HOSTED-25 (`25d5d6a`, `a83b2c0`), only GitHub runs write hosted source health. A PC run logs `skipped`, so a local network problem cannot mark a source degraded (`docs/DEPLOYMENT.md`, known limitations).

### F-19: the hosted public list and map answered 500 because of merged events (High)

- **Observation (18 Nov 2026, about 14:00 UTC):** `/api/v1/events` and `/api/v1/events.geojson` on the hosted site answered 500 (`TEMPORARILY_UNAVAILABLE`); `/api/v1/context` answered 200. The public site showed no events. The list still answered at about 06:30 UTC (ST-H-11). The first merged version with unsupported claims was decided at 07:48:36 UTC (`publication_decisions.decided_at`), so the outage most likely lasted from 07:48 to 14:07 UTC, about six hours. No check alerted; it was found by a manual read.
- **Cause:** four published events were merged from several reports (proposal ids of the form `prop-<event>-<report>`). The publication gave claim support only to a one-revision proposal, so every claim of these versions had empty support. The public reader refuses such a snapshot (`SNAPSHOT_INVALID`), and the list fails closed, so one refused version failed the whole page. Found by a read-only probe of each published event against Neon (event ids and error codes only).
- **Severity:** High on the working rule in `SYSTEM-TEST.md` §9: it made the public site unavailable to all users.
- **Fix:** `5b64a29` (HOSTED-31). Each claim of a merged proposal gets the persisted reference that exactly matches the chunk it cites, from the proposal's own revisions only. A merged version with an unsupported claim is refused before any write. The location backfill also selects a version with an unsupported claim and re-writes it. Test: `apps/worker/test/hosted31-merged-claim-support.test.ts` (IT-HOST-12). The old case (a4) in `agent-point-geometry.test.ts`, which pinned the empty-support version, now expects the refusal.
- **Verification (18 Nov 2026, 14:07 UTC):** ingest run 44319612423 (code at `2d9d442`) logged `Location backfill: candidates=4 refreshed=4 skipped=0 failed=0`. Afterwards `/api/v1/events` answered 200 with 21 events over two pages (12 with a point, 9 whole view, 21 with a location label), `/api/v1/events.geojson` answered 200 with 12 features, and the detail of a repaired event answered 200 (ST-H-12).
- **Status (18 Nov 2026): fixed and verified on the hosted site.** Residual: no automated check reads the hosted public API, so a similar fault would again be found only by a manual read (`SYSTEM-TEST.md` §7, item 17). The Worker was redeployed from `f9cb7a0` on 18 Nov 2026 (version `bddb82f4`, owner approval), so the moderator publish path has the fix too. After the deploy, `/`, `/api/v1/events`, `/api/v1/events.geojson`, `/api/v1/context`, `/api/v1/updates` and one event detail answered 200, and a register request without `Origin` answered 403.

### F-20: the hosted briefing answered 503 for interest sets that reach whole-view events (High)

- **Observation:** on the hosted site, `POST /api/v1/briefings` answered 503 for interest sets whose matches include an event shown on the whole view (no point).
- **Found by:** EXPLORE-18 (18 Nov 2026).
- **Where:** `apps/worker/src/layers/l4-application-integration/public-briefing-projection.ts`; `apps/db/src/public-briefing-candidates.ts`.
- **Cause:** the response validator refused the `location_display` value of a whole-view event, so the whole briefing failed with 503.
- **Severity:** High.
- **Fix:** `d1e2be1` (`fix(HOSTED-32)`, 19 Nov 2026). Tests: `apps/worker/test/l4-public-briefing-projection.test.ts` (+7), `apps/worker/test/public-briefing-runtime.test.ts` (+2), `apps/db/test/public-briefing-candidates.test.ts`.
- **Verification (hosted, 19 Nov 2026):** three category interests gave 200 with 19 items (ST-H-13).
- **Status (19 Nov 2026): fixed and verified on the hosted site.**

### F-21: place interests never matched the briefing (Medium)

- **Observation:** a saved place interest matched no event, so a briefing never returned an item for it (observed in EXPLORE-18).
- **Found by:** EXPLORE-18 (18 Nov 2026).
- **Where:** `apps/db/src/public-briefing-candidates.ts`; `apps/worker/src/layers/l4-application-integration/public-briefing-projection.ts`.
- **Cause:** the scope lists of the events were empty, and the place was not compared with the report's location label.
- **Severity:** Medium.
- **Fix:** `d1e2be1` (`fix(HOSTED-32)`). A place interest now matches the report's location label, either the whole label or one comma segment of it. The reason reads "Nama tempat ini disebut di laporan (perkiraan, bukan konfirmasi)", meaning the place is named in the report and the match is an estimate, not a confirmation. Owner decision, 18 Nov 2026.
- **Verification (hosted):** the place interest "Jakarta Timur" gave 3 items (ST-H-14).
- **Status (19 Nov 2026): fixed and verified on the hosted site.**

### F-22: the web showed only the first page of published events (High)

- **Observation:** the web list showed 20 of the 21 published events. A deep link to the 21st event said it was not published.
- **Found by:** EXPLORE-18 (18 Nov 2026).
- **Where:** `apps/web/src/api-client.ts` (`listAllEvents`); `apps/web/src/App.tsx`; `apps/web/src/MapPanel.tsx`.
- **Cause:** the web read only the first page of `/api/v1/events` and did not follow `next_cursor` to the later pages.
- **Severity:** High.
- **Fix:** `f26de6e` (`fix(HOSTED-33)`, 19 Nov 2026). Test: `apps/web/test/event-list-pages.test.ts` (6).
- **Verification (hosted):** the list and the API both showed 18 events after the withdrawals (ST-H-15).
- **Status (19 Nov 2026): fixed and verified on the hosted site.**

### F-23: the detail-page map pin was about 18 km off (High)

- **Observation:** the map pin on an event's detail page was about 18 km from the event's own point.
- **Found by:** EXPLORE-18 (18 Nov 2026).
- **Where:** `apps/web/src/SourcePointMap.tsx` (`coordinateToWorldPixels`, `getVisibleMapTiles`); `apps/web/src/MapPanel.tsx`.
- **Cause:** the projection was equirectangular over hard-coded tiles, so the pin was placed about 18 km away.
- **Severity:** High.
- **Fix:** `f26de6e` (`fix(HOSTED-33)`). The pin uses Web Mercator over the tiles, with OpenStreetMap attribution. Test: `apps/web/test/record-map-layout.test.tsx` (10).
- **Verification (hosted):** pin error 0.00 km on `inc-rep-source-antara-terkini-0beb1790308ab5dc` (ST-H-16).
- **Status (19 Nov 2026): fixed and verified on the hosted site.**

### F-24: the moderator queue and the admin source list were stale after writes (Medium)

- **Observation:** after a write, the moderator queue and the admin source list showed the old state for up to about 1 minute.
- **Found by:** EXPLORE-18 (18 Nov 2026).
- **Where:** `apps/worker/src/index.ts` (Hyperdrive binding per route); `apps/worker/wrangler.toml`.
- **Cause:** the moderation, admin and write paths read through the same Hyperdrive configuration as public reads, and that configuration caches query results.
- **Severity:** Medium.
- **Fix:** `2c75643` (`fix(HOSTED-37)`, 19 Nov 2026). A second Hyperdrive configuration with caching disabled is bound as `FRESH_HYPERDRIVE` and `AUTH_HYPERDRIVE`. Moderation, admin, account and auth, pipeline flow and all writes read through it. Public GET reads keep the cached `HYPERDRIVE` (owner decision, 18 Nov 2026). Test: `apps/worker/test/hosted37-fresh-hyperdrive.test.ts` (10).
- **Verification (hosted):** revoke then an immediate read showed revoked; approve then an immediate read showed approved (ST-H-17). The moderator queue was not read as a separate check.
- **Status (19 Nov 2026): fixed and verified for the admin source list. The moderator queue is not separately verified.**

### F-25: the public history route took 13 to 41 s on the first call (Medium)

- **Observation:** the public history route took 13 to 41 s on the first call, and sometimes answered 500 or 1101.
- **Found by:** EXPLORE-18 (18 Nov 2026).
- **Where:** the public history review metadata view (migration 014, rewritten by migration 059).
- **Cause:** measured read-only on Neon. The disclosure query took 39.7 s, because the review metadata view was re-evaluated for each decision row.
- **Severity:** Medium.
- **Fix:** `ecdbf13` (`fix(HOSTED-38)`, 19 Nov 2026). Migration 059 (`apps/db/migrations/059_public_history_review_metadata_speed.sql`) rewrites the view history-first with a LATERAL join; 0.83 s in EXPLAIN. Test: `apps/db/test/hosted38-history-review-metadata.test.ts` (3).
- **Verification (hosted):** first calls took 0.17 to 0.58 s (ST-H-18). Migrations 058 and 059 were applied to Neon on 19 Nov 2026 with `npm run hosted:bootstrap` (2 applied, 57 already applied; 59 files).
- **Status (19 Nov 2026): fixed and verified on the hosted site.**

### F-26: BMKG earthquakes outside Jakarta were published, with placeholder text (Medium)

- **Observation:** earthquakes outside Jakarta were published (NTT, Papua and Lampung). Their claim text was the placeholder `Teks gempa BMKG.`, the outlet was shown as `source-bmkg-gempa`, and the source link answered 404.
- **Found by:** EXPLORE-18 (18 Nov 2026).
- **Where:** `apps/worker/src/runtime/bmkg-poll-runtime.ts`; `apps/worker/src/runtime/structured-source-display.ts`; `apps/db/migrations/058_source_display_names.sql`; `apps/intelligence/src/structured-interpretation.ts`.
- **Cause:** the poll kept quakes without a Jakarta check. The claim text was the placeholder, the registry row showed the raw source id, and the source link pointed to a page that answered 404.
- **Severity:** Medium.
- **Fix:** `5d5c938` (`fix(HOSTED-36)`, 19 Nov 2026). A quake is kept only when its `Dirasakan` or `Wilayah` names Jakarta, or its epicentre is in the Jakarta envelope (owner decision, 18 Nov 2026). The claim is the quake's own sentence. Migration 058 gives the BMKG and PetaBencana rows their display names. The source link goes to BMKG's felt-earthquake page. The test order was fixed in `d5da34e` (R-11). Tests: `apps/worker/test/bmkg-poll-runtime.test.ts` (14 in total), `apps/worker/test/hosted36-source-display-names.test.ts` (2), `apps/intelligence/test/hosted36-structured-claim-text.test.ts` (3), `apps/db/test/source-display-names.test.ts` (3).
- **Verification (hosted, 19 Nov 2026):** the moderator withdrew the three published quakes (category `other`). Their detail now answers 404 (ST-H-19). No test asserts that 404 at HTTP (`INTEGRATION-TEST.md` section 7, item 12).
- **Status (19 Nov 2026): fixed in code. The three published quakes were withdrawn on the hosted site.**

### F-27: public text was in English, joined with "..", cut mid-word, with invented times and repeated source lines (Medium)

- **Observation:** on the published events, claims were in English; summaries joined claim texts with `..`; titles were cut mid-word at 120 characters; event times were invented (an exact time, or the publication date); and the same outlet appeared on one source line for each evidence item.
- **Found by:** EXPLORE-18 (18 Nov 2026).
- **Where:** `apps/intelligence/src/agents/report-interpretation-agent.ts`; `apps/intelligence/src/agents/incident-correlation-agent.ts`; `apps/intelligence/src/structured-interpretation.ts`; `apps/intelligence/src/text-limits.ts`; `apps/intelligence/src/workflows/incident-intelligence-workflow.ts`; `apps/worker/src/layers/l4-application-integration/public-projection.ts`; `apps/worker/src/layers/l4-application-integration/public-read-model.ts`; `apps/worker/src/layers/l4-application-integration/publication-policy.ts`.
- **Cause:** the agent prompts did not ask for Bahasa Indonesia; event times were not checked against the report text; titles were cut at a fixed length; the summary joined claim texts with `..`; source lines were not deduplicated per claim; and the automatic gate did not hold non-Indonesian text.
- **Severity:** Medium.
- **Fix:** `fc64d3b` (`fix(HOSTED-35)`, intelligence: Indonesian prompts, event times grounded in the report text, titles cut at a word boundary) and `6c93b8e` (`fix(HOSTED-35)`, L4: summary join, one source per claim, `language_review` holds non-Indonesian text for a moderator, read-time repair of legacy text). The test fixture fixes `a5744ba` and `307ac31` are recorded as R-12 and R-13. Tests: `apps/intelligence/test/hosted35a-title-truncation.test.ts` (8), `apps/intelligence/test/hosted35a-event-time-grounding.test.ts` (21), `apps/intelligence/test/hosted35a-claim-text.test.ts` (9), `apps/worker/test/hosted35-public-text.test.ts` (13).
- **Verification:** tests only. No hosted check of F-27 is recorded in this update.
- **Status (19 Nov 2026): fixed for new proposals (tests). Legacy English claims and times on published events are not rewritten; moderators may correct them.**

### F-28: UI wording and labels on public pages (Low)

- **Observation:** the revoke dialog said that collection stops, but HOSTED-28 made revoke stop publication only. Internal terms (`CRS84`, `equirectangular`, "record") appeared on public pages. Labels were English ("Username", "Email"). The tab title read "demo sintetis" on the live site. Moderator screens showed raw codes. `#alur-agen` had no last cycle time, and its legend was clipped.
- **Found by:** EXPLORE-18 (18 Nov 2026).
- **Where:** `apps/web/src/SourceApprovalPanel.tsx`; `apps/web/src/EventDetail.tsx`; `apps/web/src/ModeratorReview.tsx`; `apps/web/src/PipelineFlow.tsx`; `apps/web/src/display.ts`; `apps/web/src/moderation-labels.ts`.
- **Cause:** the revoke dialog text was not updated when HOSTED-28 changed revoke to stop publication only. The other items are copy and labels; no separate cause is recorded.
- **Severity:** Low.
- **Fix:** `c68cdcc` (`fix(HOSTED-34)`): Indonesian wording and labels in the live UI. Test: `apps/web/test/hosted34-ui-copy.test.tsx` (9).
- **Verification (hosted, 19 Nov 2026):** the four event detail pages and `#masuk`, at 1440 px and 390 px, had no banned term. The tab title was "Waspada Jakarta", and the username label read "Nama pengguna" (ST-H-20).
- **Status (19 Nov 2026): fixed. Verified on four detail pages and `#masuk` at 1440 and 390 px.**

### F-29: the detail page always shows the acquisition time as "Tidak disebutkan" (Low)

- **Observation:** on the API-backed event detail, the "Waktu pengambilan sumber" row always reads "Tidak disebutkan", whatever the record holds. So the acquisition time, one of the four times in SYSTEM-TEST ST-F-05, never comes from the data.
- **Found by:** code review of the record page, 19 November 2026 (TG-DOCS-05). Found in code review; not yet checked on the hosted site.
- **Where:** `apps/web/src/EventDetail.tsx`, API branch (the fixed row near line 296).
- **Cause:** the row text is a fixed string, not read from the record. The fixture branch shows a retrieval time (`source.retrievedAt`, the same file, about line 76); the API branch shows only the fixed row.
- **Severity:** Low.
- **Status (19 Nov 2026): fixed in `b4a0d0f` (POLISH-02); tests in `f155822`. Hosted re-check pending.** The record page now shows the source's collection time (`retrieved_at`, migration 060) when a source gives one, and 'Tidak disebutkan' when none does. The decision question above is answered by this fix; no separate owner decision is recorded for it.

### F-30: a moderator reject wrote no audit record (Medium)

- **Observation:** a moderator reject of a proposal recorded its decision but no audit record. A publish did write one. SYSTEM-TEST ST-F-07 expects each decision to write an audit record.
- **Found by:** TEST-GAP-03 (19 November 2026), the "ST-F-07" block of `apps/worker/test/adr061-gate-db.test.ts`.
- **Where:** `apps/worker/src/layers/l4-application-integration/proposal-publication.ts`, the reject branch of `decideProposal`.
- **Cause:** the reject branch wrote the decision row and nothing else. The publish branch writes an audit record.
- **Severity:** Medium, set by TG-DOCS-07 (an audit gap with no public effect; a reject never publishes). Not yet reviewed by the owner.
- **Fix:** `f3373c0` (`fix(TEST-GAP-03)`, 19 November 2026). The reject writes one audit record, action `proposal_rejected`, with the actor and the reason, and the decision id and outcome in its details. Test: `apps/worker/test/adr061-gate-db.test.ts` (2 tests).
- **Status (19 Nov 2026): fixed (`f3373c0`).** The reject of 18 November 2026 on the hosted site came before the fix, so it has no audit row. Whether the hosted Worker runs this fix is not recorded here.

### F-31: the webhook AI job was queued with no trace id (Medium)

- **Observation:** an AI job queued from a webhook report had a NULL trace id, so it could not be linked to its report revision's trace (FR-14).
- **Found by:** TEST-GAP-03 (19 November 2026), `apps/worker/test/webhook-ingest-db.test.ts`, the case "the webhook AI job carries the same trace id as its revision".
- **Where:** `apps/worker/src/index.ts`, the webhook enqueue block (`traceId`, line 569).
- **Cause:** the enqueue read `trace_id` from the in-memory revision that `onRevisionCreated` stores. The webhook handler does not set trace_id on that object, so the job got no trace id. The chunk write in the same block already falls back to `trace-<report_revision_id>`.
- **Severity:** Medium, set by TG-DOCS-07 (a traceability gap under FR-14, with no public effect). Not yet reviewed by the owner.
- **Fix:** `f3373c0` (`fix(TEST-GAP-03)`, 19 November 2026). The job takes the revision's trace id, or `trace-<report_revision_id>` when none is present, the same id the chunks use. Test: `apps/worker/test/webhook-ingest-db.test.ts`.
- **Status (19 Nov 2026): fixed (`f3373c0`), tested at PGlite level.** Not checked on the hosted site.

### F-32: the header nav sat under the dataset badge at 601 to 900 px, 200% zoom (severity not recorded)

- **Observation:** at 200% text enlargement, a viewport of 601 to 900 px (a 1440 px screen at 200% is 720 px wide) drew header nav items under the dataset badge.
- **Found by:** not recorded in the repository. The fix commit names the case.
- **Where:** `apps/web/src/app-shell.css`, the header rules at 601 to 900 px.
- **Cause:** at tablet width the nav, the dataset badge and "Akun" share one row, and the header kept its wide-layout gaps and padding.
- **Severity:** not recorded.
- **Fix:** `b3ca26d` (`fix(POLISH-01)`, 19 November 2026). At 601 to 900 px the header gaps and padding tighten, and the nav scrolls inside itself as the last fallback. Below 768 px the brand name is hidden and the brand mark keeps its link and accessible name. Test: `apps/web/test/header-reflow.test.tsx` (2 tests). The test checks the CSS rules and the header markup, not a rendered layout.
- **Verification:** a local browser check at 375 to 1440 px (its record is not in the repository). Deployed on 19 November 2026. The hosted re-check is pending.
- **Status (19 Nov 2026): fixed locally and deployed; hosted re-check pending.** BR-02 stays Partial: the account and moderator screens at 200% are not recorded.

### F-33: a moderator publish or correction accepted a claim labelled under_review (High, proposed)

- **Observation:** a moderator publish or correction could publish a claim whose label was still under_review. The automatic gate refuses that label; the moderator path did not.
- **Found by:** TEST-GAP-04 tests, 19 November 2026 (the commit that carries the fix).
- **Where:** `apps/worker/src/layers/l4-application-integration/publication-policy.ts`.
- **Cause:** the moderator gate did not refuse a non-public claim label, which the automatic gate does.
- **Severity:** High, proposed by TG-DOCS-08 (publishes unreviewed content, the rule in SYSTEM-TEST section 9). Not yet reviewed by the owner.
- **Fix:** `01a61ec` (`test(TEST-GAP-04)`, 19 November 2026): the moderator gate refuses non-public claim labels. Test: `apps/worker/test/draft-privacy-public-routes-db.test.ts`, 'a moderator publish refuses a claim still labelled under_review'.
- **Status (19 Nov 2026): fixed (`01a61ec`), on `main`; covered by CI run 44498555647 (`e68aefd`), which includes it.**

### F-34: RSS intake stored javascript: and credential links (Medium, proposed)

- **Observation:** RSS intake kept source links with a non-web scheme (javascript:) or with user information (credentials).
- **Found by:** NFR-07 malicious-source tests at `e68aefd`, where three were todo (TG-DOCS-08, 19 November 2026).
- **Where:** `apps/worker/src/layers/l1-data-knowledge/rss-news-ingest.ts`; `apps/worker/src/security/source-link.ts`.
- **Cause:** no single public source-link rule applied at intake and at the gates.
- **Severity:** Medium, proposed by TG-DOCS-08 (a public source link with a script scheme; the public page escapes text and CSP applies). Not yet reviewed by the owner.
- **Fix:** `9f6a456` (`fix(NFR-07)`, 19 November 2026): one public source-link rule for RSS intake and the gates. Tests: `apps/worker/test/nfr07-malicious-source-gate.test.ts` (11 of 11).
- **Status (19 Nov 2026): fixed (`9f6a456`); CI run 44502344276 (`9f6a456`) concluded success (checked with `gh`).**

### F-35: the gate accepted http and user-info claim links that attribution dropped (Medium, proposed)

- **Observation:** the automatic gate accepted a claim whose link was http or carried user information; the attribution step then dropped the link, so the claim went out with less source than the gate had checked.
- **Found by:** NFR-07 malicious-source tests (TG-DOCS-08, 19 November 2026).
- **Where:** `apps/worker/src/layers/l4-application-integration/publication-policy.ts`; `proposal-publication.ts`.
- **Cause:** the gate and the attribution step applied different link rules.
- **Severity:** Medium, proposed by TG-DOCS-08 (the claim kept its source record; only the link was lost). Not yet reviewed by the owner.
- **Fix:** `9f6a456` (same commit as F-34). Test: `apps/worker/test/nfr07-malicious-source-gate.test.ts` (the non-web scheme refusal and the link tests).
- **Status (19 Nov 2026): fixed (`9f6a456`); CI run 44502344276 concluded success.**

### F-36: source text could forge prompt section headers in report interpretation (Medium, proposed)

- **Observation:** source text could contain lines that look like prompt section headers, which the model could read as its own instructions.
- **Found by:** NFR-07 source-text isolation tests (TG-DOCS-08, 19 November 2026).
- **Where:** `apps/intelligence/src/agents/report-interpretation-agent.ts` (the report interpretation prompt).
- **Cause:** section headers in the prompt were not neutralised in source text.
- **Severity:** Medium, proposed by TG-DOCS-08 (input isolation under NFR-07). Not yet reviewed by the owner.
- **Fix:** `9f6a456` (`fix(NFR-07)`, 19 November 2026). Test: `apps/intelligence/test/nfr07-source-text-isolation.test.ts` (6 of 6). The incident-correlation prompt is not changed by this fix; see F-43.
- **Status (19 Nov 2026): fixed for report interpretation (`9f6a456`).**

### F-37: a briefing repeated an event, and a null source publish time read "Tidak tersedia" (Low, proposed)

- **Observation:** a briefing could list one event twice. A source with no publish time read "Tidak tersedia", which reads as a checked gap.
- **Found by:** TEST-GAP-04 web tests (19 November 2026).
- **Where:** `apps/web/src/BriefingResults.tsx`; `apps/web/src/EventDetail.tsx`; `apps/web/src/api-client.ts`.
- **Cause:** the briefing did not collapse repeated events; an unstated source publish time used the availability wording.
- **Severity:** Low, proposed by TG-DOCS-08 (display only; no unsupported claim). Not yet reviewed by the owner.
- **Fix:** `35ab16e` (`test(TEST-GAP-04)`, 19 November 2026): a briefing event shows once, at its first position, and an unstated source publish time reads "Tidak disebutkan". Tests: `apps/web/test/preferences.test.tsx` ('ST-F-02: a briefing that repeats one event ...'); `apps/web/test/event-detail-claim-sources.test.tsx` ('ST-F-05: a null source publish time reads Tidak disebutkan ...').
- **Status (19 Nov 2026): fixed (`35ab16e`), covered by CI run 44498555647 (`e68aefd`), which includes it.**

### F-38: security headers missing and plain-HTTP API requests served (Medium, proposed)

- **Observation:** pages and API responses lacked Content-Security-Policy, Strict-Transport-Security, anti-clickjacking, X-Content-Type-Options, Referrer-Policy and Permissions-Policy, and plain-HTTP API requests were served rather than redirected.
- **Found by:** the OWASP ZAP passive baseline (2 Medium, 3 Low) and the scripted checklist (24 of 36), both run on 19 November 2026 before the fix (`nfr07/zap-before`, `nfr07/checklist-before`).
- **Where:** `apps/worker/src/security/security-headers.ts`; `apps/worker/src/index.ts`; `apps/web/public/_headers`.
- **Cause:** no security headers were set on pages or API responses, and no redirect applied to the API over HTTP.
- **Severity:** Medium, proposed by TG-DOCS-08 (two Medium ZAP alerts on the public site). Not yet reviewed by the owner.
- **Fix:** `db5bf13` (`fix(SEC-HEADERS-01)`, 19 November 2026), deployed as Worker version `ea955b9f` (a Cloudflare version id, not a git SHA). Tests: `apps/worker/test/security-headers.test.ts` (11); `apps/web/test/public-headers.test.ts` (7).
- **Status (19 Nov 2026): fixed (`db5bf13`) and deployed. Hosted: ZAP after the fix 0 High and 0 Medium; checklist 34 of 36, with two recorded exceptions (ST-H-25, ST-H-26). Plain-HTTP static pages are still not redirected (a Cloudflare zone setting is unavailable on workers.dev; HSTS limits exposure).**

### F-39: source-text and embedding purge (ADR-005) is not implemented (Medium, proposed; fixed 20 Nov 2026)

- **Observation:** ADR-005 calls for purging source text and embeddings. No purge of source text or embeddings was found in the repository during the TG-DOCS-08 review. The only purge tested is for sessions and login state (`apps/worker/test/nfr07-session-retention.test.ts`).
- **Found by:** TG-DOCS-08 review of NFR-07 (19 November 2026).
- **Fix:** `8ce1e1f` (`fix(TG-GAP-05)`, 19 November 2026). The ADR-005 retention purge runs once per hosted ingest run, after the backfills and before the freshness pass. It purges source text at the 365-day cap, and text cited only by a superseded version 90 days after that version stops being current; embeddings are purged with their text. A failed purge logs one fixed line and does not fail the run. Tests: `apps/db/test/nfr07-retention-purge.test.ts` (11 tests); `tools/hosted/nfr07-retention-purge.test.ts` (7 tests).
- **Status (20 Nov 2026): fixed in `8ce1e1f`, deployed 20 November 2026 (Worker `007fbaa5`, migration 062).** The first ingest after the bootstrap reported all purge counts as 0 (`evidence/2026-11-20/nfr07/ingest-44692616661.txt`). The periods used are the ones in the tests above. No owner sign-off on these periods is recorded in this register.

### F-40: 24-month audit retention is not implemented (Medium, proposed; fixed 20 Nov 2026)

- **Observation:** the 24-month audit retention in the requirements has no purge job in the repository.
- **Found by:** TG-DOCS-08 review of NFR-07 (19 November 2026).
- **Fix:** `8ce1e1f` (19 November 2026). Audit rows older than 24 months are purged; younger rows are kept. Test: `apps/db/test/nfr07-retention-purge.test.ts` ('audit rows older than 24 months are purged, and younger audit rows are kept').
- **Status (20 Nov 2026): fixed in `8ce1e1f`, deployed 20 November 2026 (Worker `007fbaa5`, migration 062).**
- **Status before (19 Nov 2026): open.**

### F-41: news_triage_decisions.expires_at is never purged (Low, proposed; fixed 20 Nov 2026)

- **Observation:** the expiry column on `news_triage_decisions` is written but no job purges rows past it.
- **Found by:** TG-DOCS-08 review (19 November 2026).
- **Fix:** `8ce1e1f` (19 November 2026). Triage decisions are purged 30 days after their `expires_at`. The 30-day grace keeps a decision while its item can still appear in a feed, so the item is not triaged again (migration 062 header comment). Test: `apps/db/test/nfr07-retention-purge.test.ts` ('triage decisions expired over 30 days ago are purged; recently expired and unexpired decisions are kept').
- **Status (20 Nov 2026): fixed in `8ce1e1f`, deployed 20 November 2026 (Worker `007fbaa5`, migration 062).**

### F-42: the approved-host list is not enforced at fetch (Medium, proposed; fixed 20 Nov 2026)

- **Observation:** the approved outbound host list is recorded for sources, but the fetch path does not check each request against it.
- **Found by:** TG-DOCS-08 review of NFR-07 (19 November 2026); the redirect guard and the moderator-only provider fetch are tested, the host list is not.
- **Fix:** `8ce1e1f` (19 November 2026). Each fetch is checked against the approved host list. A source whose registry row declares no host is refused without a request. A redirect is never followed, even to a host the registry approves. The host is read from the parsed URL, so credential-style, look-alike and case-variant URLs are judged on that host. Test: `apps/worker/test/nfr07-approved-host-fetch.test.ts` (12 tests).
- **Status (20 Nov 2026): fixed in `8ce1e1f`, deployed 20 November 2026 (Worker `007fbaa5`, migration 062).**
- **Status before (19 Nov 2026): open.**

### F-43: the incident-correlation prompt has unescaped section headers (Medium, proposed; fixed 20 Nov 2026)

- **Observation:** the incident-correlation prompt does not neutralise section headers in source text, so a forged header could appear as a prompt section. F-36 fixed only report interpretation (`9f6a456`).
- **Found by:** TG-DOCS-08 review of NFR-07 (19 November 2026). `apps/intelligence/test/nfr07-source-text-isolation.test.ts` passes for the correlation prompt, but it does not test header forgery.
- **Fix:** `8ce1e1f` (19 November 2026). The incident-correlation prompt neutralises every source-derived field, so a forged section header in source text is marked and each section appears once. Tests: `apps/intelligence/test/nfr07-source-text-isolation.test.ts` ('a forged section header or template line in any source field is marked, and the prompt keeps one section of each'; 'a quote copied from a marked line passes the provenance check').
- **Status (20 Nov 2026): fixed in `8ce1e1f`, deployed 20 November 2026 (Worker `007fbaa5`, migration 062).**
- **Status before (19 Nov 2026): open.**

### F-44: the register reveals taken usernames, by design (Low, proposed; open)

- **Observation:** the registration response says whether a username is taken, so anyone can test which usernames exist.
- **Found by:** TG-DOCS-08 review (19 November 2026).
- **Status (19 Nov 2026): open, recorded as a design choice. No owner decision on it is recorded in this file.**

### F-45: refused webhook items are neither recorded nor counted (Medium, proposed; closed 20 Nov 2026, out of scope; added by TG-DOCS-08)

- **Observation:** the reworded ST-F-11 expected result (owner, 19 November 2026) says a malformed item is "refused and recorded (counted)". A malformed webhook item is refused with 400 and writes nothing. The batch success response counts accepted items only. No record or count of a refused item exists.
- **Found by:** TG-DOCS-08 review of ST-F-11 against the code (19 November 2026).
- **Where:** `apps/worker/src/layers/l1-data-knowledge/webhook-ingest.ts`.
- **Severity:** Medium, proposed (a traceability and operations gap with no public effect). Not yet reviewed by the owner.
- **Status (20 Nov 2026): closed as out of scope after the ST-F-11 rewording (owner decision 19 Nov 2026); refused webhook items are still not recorded.** The reworded expected result is 'a malformed item is refused', which removes the record and count clause.

### F-46: a pending proposal older than the current published version could overwrite it through the moderation route (High)

- **Observation:** a publish or auto-publish of an undecided proposal made before the proposal behind the event's current published version could apply over that newer version, through the moderation route.
- **Found by:** TG-GAP-05 (19 November 2026), the real-route stale-write tests in `apps/worker/test/moderation-stale-route-db.test.ts`.
- **Where:** `apps/worker/src/layers/l4-application-integration/proposal-publication.ts`, `publishInTransaction`.
- **Cause:** the publish path checked the base version for corrections only. A publish or auto-publish of an older proposal had no check against the current version.
- **Severity:** High (set by the TG-DOCS-09 brief). Not yet reviewed by the owner.
- **Fix:** `5589a05` (`fix(TG-GAP-05)`, 19 November 2026). An undecided proposal made before the one behind the current version is superseded. It writes one decision (`stale_reason` `older_than_current_version`) and publishes nothing, and the call answers 409 `already_decided`. Test: `apps/worker/test/moderation-stale-route-db.test.ts` (the 'NFR-05 / ST-F-13' tests).
- **Status (20 Nov 2026): fixed (`5589a05`), on `main`, and deployed on 20 November 2026 (Worker `007fbaa5`; the bootstrap record names main at `5d4dc3c`).** No hosted check of this path is recorded.

### F-47: the public event list issued one query set per event (Medium)

- **Observation:** the public event list read each event in a page with its own query set: 61 SQL statements for a 20-event page. Before the fix the Worker used 37 to 113 ms of CPU per request, as recorded on 19 Nov 2026 in `evidence/2026-11-20/nfr04/cpu-tail-after-perf01.txt`, against the nominal 10 ms Workers Free CPU allowance (`PERFORMANCE.md`). Run 2 timings were slow, and some requests failed.
- **Found by:** the NFR-04 timing script, run 2 on 19 November 2026, before the fix (`evidence/2026-11-19/nfr04/timing-run2-before-perf-fix.txt`). Warm sequential requests to `GET /api/v1/events`: 24 of 30 OK, p50 451 ms, p95 1,362 ms. The run 2 file does not name the host; the 19 November README records the script as run against the hosted public routes.
- **Where:** `apps/worker/src/layers/l4-application-integration/public-event-list-projection-service.ts`; `public-event-projection-service.ts`; `public-projection.ts`; `apps/worker/src/runtime/public-event-list-runtime.ts`; `apps/db/src/public-projection-lookups.ts`.
- **Cause:** the list projection read each event's rows separately.
- **Severity:** Medium (set by the TG-DOCS-09 brief). Not yet reviewed by the owner.
- **Fix:** `a43ced9` (`perf(PERF-01)`, 19 November 2026). A page is read in a constant number of queries (4 for 20 events, from 61), and the output is byte for byte the same as the per-event path. Tests: `apps/worker/test/perf01-public-event-list.test.ts` (3 tests); PERF-01 cases in `apps/worker/test/l4-public-event-list-projection-service.test.ts` and `l4-public-event-projection-service.test.ts`; `apps/db/test/public-projection-lookups.test.ts`.
- **Status (20 Nov 2026): fixed (`a43ced9`) and deployed on 20 November 2026 (Worker `007fbaa5`).** Re-timed after the deploy (run 3, 20 Nov 2026, `evidence/2026-11-20/nfr04/timing-run3-after-perf01.txt`): warm GET reads meet the target (`GET /api/v1/events` p50 152 ms, p95 255 ms); `POST /api/v1/briefings` does not (p50 869 ms; 13 of 30 warm requests failed with 503), and under five concurrent clients 40 of 100 list requests failed with 503. Those 503s are not closed by this fix and are recorded as F-50 (open). The updates feed was also slow in run 2 (`GET /api/v1/updates` p95 1,791 ms, 30 of 30 OK); this commit does not change that route, and no backlog row for it is recorded in this update.

### F-48: the moderator review screen did not show each claim's origin outlet (Low)

- **Observation:** on the moderator review screen, a claim showed no origin outlet, so a moderator could not see where each claim came from.
- **Found by:** TG-GAP-05 (19 November 2026), the ST-F-03 review. `apps/web/test/moderator-review.test.tsx` had no origin assertion.
- **Where:** `apps/web/src/ModeratorReview.tsx`; `apps/web/src/moderator-review.css`.
- **Severity:** Low (set by the TG-DOCS-09 brief). Not yet reviewed by the owner.
- **Fix:** `9e6c30e` (19 November 2026). Each claim shows its origin on the review screen as 'Asal: ' followed by its outlet, or its registry source id when there is no outlet. Test: `apps/web/test/moderator-review.test.tsx` ('ST-F-03: each claim shows its origin on the review screen').
- **Status (20 Nov 2026): fixed (`9e6c30e`) on `main`.** `deploy:prod` builds the web app before it deploys the Worker, so the fix is in the build deployed with `007fbaa5`. It is not checked on the hosted site.

### F-49: ADR-061 says the automatic publication writes an audit record; it writes a publication decision record (Low, documentation mismatch)

- **Observation:** `docs/decisions/ADR-061-agent-driven-publication.md`, decision 7, says each publish writes an audit row that records the actor, the publication mode and the gate reasons. The automatic publication writes a `publication_decisions` row that carries the proposal's trace id, and no `audit_records` row.
- **Found by:** TG-GAP-05 (19 November 2026), the ST-F-16 test in `apps/worker/test/adr061-gate-db.test.ts`.
- **Where:** `docs/decisions/ADR-061-agent-driven-publication.md`, decision 7.
- **Cause:** not confirmed. The ADR text does not separate the automatic path from the moderator path. The moderator publish does write an audit record (`apps/db/test/manual-publication-gate-composition.test.ts`).
- **Severity:** Low (set by the TG-DOCS-09 brief); documentation only, publication behaviour is unchanged.
- **Fix:** none yet. The ADR text needs correcting; no code change is planned for this finding.
- **Status (20 Nov 2026): open.**

### F-50: hosted public reads still use CPU above the Free plan's nominal allowance, and some requests fail with 503 under load (Medium, fixed 23 Nov 2026)

- **Observation:** after PERF-01 (Worker `007fbaa5`), `GET /api/v1/events` still used 22 to 52 ms of CPU per request on the hosted Worker (p50 35 ms; wrangler tail sample of 16 requests, 20 Nov 2026). The Workers Free plan's nominal CPU allowance is 10 ms (`PERFORMANCE.md`). Under 5 concurrent clients, 40 of 100 list requests and 2 of 100 briefing requests returned 503. Warm sequential `POST /api/v1/briefings` failed 13 of 30 with 503 and had p50 869 ms. A separate burst of 6 clients x 8 requests returned 5 requests with 503 and the body `error code: 1102` (the file's gloss: Worker exceeded resource limits).
- **Found by:** TG-DOCS-09 (20 November 2026): the PERF-01 re-timing run 3 and the wrangler tail sample.
- **Where:** the hosted Worker's public read path: `GET /api/v1/events` and `POST /api/v1/briefings`. The code location was not analysed in this update.
- **Cause:** not determined. Error 1102 means the Worker exceeded a resource limit; the record does not say which one. The 503 bodies in run 3 were not captured; only the burst's bodies were.
- **Severity:** Medium (set in the TG-DOCS-09 follow-up, 20 Nov 2026). Not yet reviewed by the owner.
- **Fix (23 Nov 2026):** PERF-03 and PERF-04 (owner decision 23 Nov 2026: published lists may be up to 60 s stale).
  - PERF-03 (`38dee01`, fixed forward in `1e50384`) serves the list, detail and GeoJSON reads from a snapshot of the published projections kept in Workers KV.
    - A one-statement fingerprint decides when to rebuild it.
    - A moderator publish, withdraw or correction forces a rebuild.
    - Responses carry a weak ETag (a match returns 304) and `cache-control: public, max-age=15, stale-while-revalidate=30`.
    - A rebuild costs 13 SQL statements whatever the number of events; an unchanged check costs one.
  - PERF-04 (`71226d0`) batches the briefing to a constant 7 statements, and keeps briefing and history results in a 30 s in-isolate memo.
  - Deployed on 23 November 2026 (Worker version `356df500`, KV namespace `PUBLIC_SNAPSHOT`).
- **Retest (23 Nov 2026), run 4** (`tools/perf/nfr04-run.ts`, `evidence/2026-11-23/nfr04/timing-run4-after-perf03.txt`): same warm and 5-client shapes as run 3, plus the GeoJSON route.
  - Every request returned 200: 240 of 240 warm and 800 of 800 at 5 concurrent clients. There were no 503 or 1102 responses.
  - Warm p50 was 43 to 101 ms on every route, and the warm p95 was at most 220 ms.
  - At 5 clients, p50 was 40 to 158 ms and p95 at most 525 ms. The highest single response was the briefing, at 1,100 ms.
  - Compared with run 3:
    - The briefing went from 17/30 OK with p50 869 ms to 30/30 OK with p50 81 ms.
    - The list at 5 clients went from 60/100 OK to 100/100 OK.
  - Header check: `evidence/2026-11-23/nfr04/headers-after-perf03.txt` (public caching, ETag, 304, and year-long immutable static assets).
  - Not re-measured: per-request CPU (no new wrangler tail sample) and the cold rounds.
- **Status (23 Nov 2026): fixed and deployed; retested by run 4.** Earlier status (20 Nov 2026): open. Evidence: `evidence/2026-11-20/nfr04/timing-run3-after-perf01.txt` and `evidence/2026-11-20/nfr04/cpu-tail-after-perf01.txt`. Linked from NFR-04 and ST-N-04 (both stay Partial) and from `TEST-SUMMARY.md` section 8.

### F-ALERT-02: a published version did not reach `/api/v1/updates`

- **Observation:** a published version was not listed in `/api/v1/updates`. The test for it was a todo in `apps/worker/test/repeated-coverage-alerts.test.ts`. The local `serve:live` answered 503 for updates (`docs/testing/PERFORMANCE.md`). This ID is the one used in `SOFTWARE_DEVELOPMENT_PLAN.md`, `docs/testing/TEST-EVALUATION.md` and `docs/IMPLEMENTATION_BACKLOG.md`. It is kept so that those references still resolve.
- **Evidence:** the test "a newly published version appears in the public views and the updates feed (F-ALERT-02, HOSTED-02)" in `apps/worker/test/repeated-coverage-alerts.test.ts` is active, with no todo left. CI run 44211263890 is green at `6fff929`. The hosted `/api/v1/updates` returned 200 on 17 Nov 2026 (`docs/DEPLOYMENT.md` section 6).
- **Status (18 Nov 2026): fixed in `1a11d3c`** (`feat(HOSTED-02)`, 16 Nov 2026): a publish writes a v2.0 event record and review row.

### EXPLORE-18 open items (19 Nov 2026)

These came from EXPLORE-18. Two were fixed on 19 November 2026 (POLISH-02 and POLISH-03) and are marked below; the others are open. They have no F-nn ID yet.

- **Duplicate events:** Kampung Melayu and the Jl. Tanah Rendah fire; Menteng and Dukuh Atas. Status: open. Left to moderators (owner decision 4).
- **Machine refresh in history:** a machine refresh is labelled "Versi dikoreksi" in the event history. Status: fixed on 19 Nov 2026 (POLISH-02, `b4a0d0f`). An automatic refresh by `agent:auto-publisher` is marked `automatic` (migration 061) and reads "Diperbarui otomatis" on the web and in the Android reader; a moderator correction keeps "Versi dikoreksi". Hosted re-check pending.
- **#peta list map:** the list-map component (`EventFeed`) cannot be reached on the live site. Status: open.
- **Phone layout at 390 px:** the admin tabs and the 44 px touch targets. Status: open.
- **Sign-in heading:** the wording of "Masuk dengan username" is open. Status: open.
- **Superseded proposals:** a superseded proposal stays pending in the moderator queue. Status: fixed on 19 Nov 2026 (POLISH-03, `ab4533a`, ADR-062 amendment). A newer proposal of the same incident supersedes an older undecided one. The superseded proposal leaves the moderator queue and the expiry sweep, and no decision publishes it (`apps/worker/test/proposal-supersede.test.ts`, `apps/db/test/proposal-supersede.test.ts`). The flow reads it as "digantikan versi baru". No hosted check is recorded.
- **Updates feed:** the updates-feed view (migration 016) may have the same slow shape as F-25. It is not measured. Status: open.

## Section C: Removed from the defect list (not fixes)

These commits were in an earlier draft of the defect list. The corrected unit report removes them (`DOKUMENTASI_UNIT_TESTING.md` section 2.a, around line 100).

- **`bd49c57`** (`frontend cleanup unit testing`): not a `fix` commit. It changes `apps/web/src/Landing.tsx` and `apps/web/test/landing.test.tsx`. The React import line is not changed in the diff. Both files were deleted in `b0a18c5` (`git log --diff-filter=D`), so the defect is no longer recorded.
- **`e1e50f0`** (`Created new frontend demo pages`): a feature commit. Its 15 ms `setTimeout` in `apps/db/test/news-triage-decisions.test.ts` is a test pause, not a fix. The commit also adds demo pages, changes `tools/serve-live-pipeline.ts` and adds the unit report's documentation file.
- **`e8c35d6`** (`feat(VIS-01): 3D embedding chunk visualization`): a feature commit. The earlier claims about a `NaN` in PCA, an epsilon guard and a 30 cm threshold cannot be traced to its diff. It adds `apps/web/src/embedding-pca.ts`.
- **`6217fd0`** (`feat(CORR-01): multi-source incident corroboration`): a feature commit. The same claims cannot be traced to its diff. Neither `e8c35d6` nor `6217fd0` changes `apps/worker/src/layers/l2-model-grounding/correlated-proposal-engine.ts`, where `detectIncidentDiscrepancies` lives.

## Section D: Test run defects

Runs on 13 November 2026: T1 to T5 on the demo dataset (`docs/testing/UAT.md` section 9), and persona walkthroughs on the local live app (section 9.1). No CI failure is recorded for `cec9358`. Hosted run on 17 November 2026: R-09 and R-10 (`docs/testing/UAT.md` section 9.2). CI runs that failed on test code (R-11 to R-13) were fixed forward on 19 November 2026, each with a test-only commit.

| ID | Date | Run ID | Step | Symptom | Evidence path | Status |
| --- | --- | --- | --- | --- | --- | --- |
| R-01 | 13 Nov 2026 | run-02 | T5, phone, 'workspace header marks the page as demo' | At 390 px the admin header shows no demo label. 'Pratinjau sumber (demo)' is hidden (`admin-workspace.css:77-80`), and 'Data contoh' shrinks to a dot. The drawer note 'Mode demo terisolasi' still shows. | `.codex-build/uat/run-02/t5-admin-sources.json`; `run-02/phone-19-fail.png` | Open. Fix proposed in `7cf6c0f` (compact Demo chip in the admin header at 480 px or less, demo dataset only). Not confirmed: needs a T5 phone re-run. |
| R-02 | 13 Nov 2026 | run-01 | T5, steps 4 to 7, desktop and phone | The script checked source copy from `UnifiedSourceExplorer.tsx`. That copy is `display: none` on the map view by design (`unified-source-explorer.css:802-807`, commit `f0395b0`). Test-script defect, not a product defect. | `.codex-build/uat/run-01/t5-admin-sources.json` | Not a defect. Script corrected on `work/UAT-RUN-01` to check the notice the Sumber panel shows. The four source-copy checks are reported as skipped. |
| R-03 | 13 Nov 2026 | run-02 | T4, phone, 'sign in as demo.moderator' | Login returned HTTP 429. Repeated demo logins in one session tripped the rate limit. The window length is not measured. | `.codex-build/uat/run-02/t4-moderator.json` | Not a product defect (test-run condition). Re-run after a pause, with fewer logins per run. |
| R-04 | 13 Nov 2026 | run-02 | T4, desktop, 'at least one proposal is in the queue' | The demo moderation queue is empty, so the decision steps cannot run. | `.codex-build/uat/run-02/t4-moderator.json` | Blocked, not a defect. Needs a demo proposal fixture (decision). |
| R-05 | 13 Nov 2026 | commuter-run-01, visitor-run-01, resident-run-01 | Event detail sheet for a live event, both viewports | The sheet for a live event shows "Detail dari API lokal · record sintetis" and "Record ini berasal dari fixture demo sintetis. Nilai ini bukan laporan, peringatan langsung, atau gambaran kondisi Jakarta." The lifecycle reads "Berlangsung (nilai fixture)" and the freshness reads "... saat evaluasi fixture". The text is hardcoded in the event-detail branch with no dataset check (`apps/web/src/EventDetail.tsx` lines 233 to 243; `display.ts` lines 58 and 70). Live records are labelled as synthetic. | `.codex-build/worktrees/uat-personas/.codex-build/uat/persona-{commuter,visitor,resident}-run-01/` | Fixed in `7cf6c0f` (16 Nov 2026, HOSTED-05): live and unknown dataset modes no longer show fixture wording. Persona re-run pending. |
| R-06 | 13 Nov 2026 | student-run-01 (attempts 2 and 3) | ACC-02, desktop and phone | After "Keluar" on the same page, the header menu still lists "Akun saya" until the page changes. The account state is re-read only on hash navigation (`apps/web/src/AppShell.tsx` line 149). Sign-out refreshes it only on success (`AccountPages.tsx` lines 764 to 772). | `.codex-build/worktrees/uat-personas/.codex-build/uat/persona-student-run-01/` | Fixed in `7cf6c0f` (16 Nov 2026, HOSTED-05): the header re-reads the session after sign-out, on success or error. Persona re-run pending. |
| R-07 | 13 Nov 2026 | student-run-01 (attempt 3) | Sign-in on phone | "Terlalu banyak percobaan masuk. Tunggu beberapa menit..." after repeated sign-ins during the walkthroughs. A test-run condition, not a defect. The window length is not measured. | `.codex-build/worktrees/uat-personas/.codex-build/uat/persona-student-run-01/` | Not a defect (run condition). Space the sign-ins. |
| R-08 | 13 Nov 2026 | commuter-run-01 (attempt 1) | COM-02, both viewports | The script waited for `#detail/api/`, which was a wrong route assumption. Results from attempt 2 stand. | `.codex-build/worktrees/uat-personas/.codex-build/uat/persona-commuter-run-01/` | Not a defect (script). Corrected in attempt 2. |
| R-09 | 17 Nov 2026 | hosted23-u3 (UAT §9.2, PUB-01 public phone check) | Event detail, phone 390 px, hosted site | The detail header reads "Detail dari API lokal" on the hosted site, which holds live records. | `.codex-build/uat/hosted23-u3/02-detail-phone.png` | Closed. Fixed in `88bcf69` (HOSTED-24A, 17 Nov 2026); verified on the live site (ADR-065, 18 Nov 2026 amendment). |
| R-10 | 17 Nov 2026 | hosted23-u3 (UAT §9.2, PUB-01 public phone check) | Event detail, phone 390 px, source lines per claim | Each claim lists the same outlet (DETIK UTAMA) twice, one attribution line per evidence item from that source. | `.codex-build/uat/hosted23-u3/02-detail-phone.png` | Closed. Fixed in `88bcf69` (HOSTED-24A, 17 Nov 2026); verified on the live site (ADR-065, 18 Nov 2026 amendment). |
| R-11 | Nov 2026 (fixed 19 Nov 2026) | GitHub Actions runs 44362671695 and 44363328129 | Database step (step 6), `apps/db/test/source-display-names.test.ts` | The test applied migration 058 after 059. The migration order guard refuses a lower number after a higher one (`CLAUDE.md`), so the step failed. | CI runs 44362671695 and 44363328129 | Fixed (`d5da34e`, `test(HOSTED-36)`, 19 Nov 2026). Test order only. |
| R-12 | Nov 2026 (fixed 19 Nov 2026) | GitHub Actions run 44366440688 | Database step (step 6), `apps/db/test/l3-investigation-publication-gate.test.ts` | The fixture's English title was held by the language review, which holds non-Indonesian text for a moderator. | CI run 44366440688 | Fixed (`a5744ba`, `test(HOSTED-35)`, 19 Nov 2026). Fixture only. |
| R-13 | Nov 2026 (fixed 19 Nov 2026) | GitHub Actions run 44369506277 | Intelligence step (step 9), `apps/intelligence/test/ai-call-profile.test.ts` | The test expected PetaBencana's creation time as the event time. HOSTED-35 no longer treats it as an event time. | CI run 44369506277 | Fixed (`307ac31`, `test(HOSTED-35)`, 19 Nov 2026). Expectation only. |

Entry format for later use:

Entry format for later use. Run defects use `R-nn`, so they stay separate from `D-nn` (fixed) and `F-nn` (open):

| ID | Date | Run ID | Step | Symptom | Evidence path | Status |
| --- | --- | --- | --- | --- | --- | --- |
| R-nn | dd Mon 2026 | UAT_RUN_ID or CI run ID | task and step, for example T4 step 4 | what was observed | `.codex-build/uat/<run-id>/<script>.json` or CI log summary | Open, Fixed (commit SHA) or Not a defect (reason) |
