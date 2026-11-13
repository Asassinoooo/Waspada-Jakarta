# Defect and finding log

Project: Waspada Jakarta (Team 12, RPL course). Status date: 13 November 2026. Branch: `work/TEST-DOC-01-chapter5`.
Related: `docs/testing/test-cases.csv`, `docs/testing/TEST-SUMMARY.md`, `DOKUMENTASI_UNIT_TESTING.md` section 2.a (corrected text on this branch).

## Purpose and rules

- A **defect** is a confirmed fault with a commit that fixes it. Section A lists defects.
- An **open finding** is an observation that needs a decision and is not yet a confirmed fault. Section B lists findings. A finding becomes a defect only after the owner decides it is a fault and a fix commit exists.
- Commit SHAs in this file were checked with `git -C <worktree> show -s --format='%h %s' <sha>` on 13 November 2026. All six resolve.
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

## Section B: Open findings (need a decision)

Each finding is open. None is a confirmed defect.

### F-01: the public map shows no warning-boundary display

- **Observation:** US-01 asks the user to tell a point from a warning boundary (SDP US-01; FR-09). The public popup captions every mapped marker as a point. Polygons appear only in the fixture presentation (`#detail/presentation`) and in the admin views.
- **Evidence:** `docs/testing/UAT.md` section 6, T1 open item and section 6.6; `apps/web/src/MapPopup.tsx` lines 56-57 (`locationNote`). Affects ST-F-01 and AT-01. T1 is Blocked in `test-cases.csv`.
- **Decision needed:** implement a boundary display on `#peta`, or change the wording of US-01 and FR-09 in the SDP.

### F-02: matched-update checks cannot run on the demo dataset

- **Observation:** T2 step 7 ("Mengapa muncul" and the duplicate-alert check) needs live data. On the demo dataset the page shows a gate message instead (`apps/web/src/BriefingResults.tsx` lines 164-166; `apps/web/src/UpdatesCenter.tsx` line 668).
- **Evidence:** `docs/testing/UAT.md` section 6, T2 step 7 and open item; section 6.6. Affects ST-F-02 and AT-02. T2 is Blocked in `test-cases.csv`.
- **Decision needed:** either run T2 step 7 on a live dataset (this needs `serve:live`, real feeds and model quota, under explicit authorisation), or record the US-02 matched-update criterion as not evidenced.

### F-03: L1 webhook ingest imports L2 and L4 modules at runtime

- **Observation:** `apps/worker/src/layers/l1-data-knowledge/webhook-ingest.ts` imports the L2 proposal engines (`apps/worker/src/layers/l2-model-grounding/proposal-engine.ts`, `apps/worker/src/layers/l2-model-grounding/correlated-proposal-engine.ts`) and the L4 `apps/worker/src/layers/l4-application-integration/event-broadcaster.ts`. The import block is at lines 13 to 24. `CLAUDE.md` allows L1 one fixed L2 extraction adapter and says L1 must not investigate or publish.
- **Evidence:** `docs/testing/INTEGRATION-TEST.md` section 6 (that section gives lines 15 to 25; the block is at 13 to 24 in this file). `CLAUDE.md`, layer table (repository root). Affects IT-B1-06.
- **Decision needed:** refactor (move proposal generation behind one L2 adapter, and the broadcast behind a port), or record the deviation as documented.

### F-04: the publication gate does not read the L3 ledger status

- **Observation:** the proposal writer checks only that the investigation lineage rows exist (`apps/db/src/event-proposals.ts`, `requireInvestigationLineage`, line 566). On the code read, no L4 gate file or proposal file references `case_status` or `stopped_for_review`. The grep was run on 13 Nov 2026 in the main checkout over `apps/worker/src` and `apps/db/src`; the only matches were in L3, L5 and the ledger. TI-02 is held because of a disputed claim and an unresolved field, not because of the ledger status. So a proposal from a `stopped_for_review` case is not refused on that status alone.
- **Evidence:** TEST-INT-01 case TI-02 (`apps/db/test/l3-investigation-publication-gate.test.ts` on main, commit `71022ee`). Affects TI-02 and IT-B3-01.
- **Decision needed:** should the gate refuse proposals whose investigation is `stopped_for_review` (a new reason code)? Or is the claim-level hold the intended control? Record the answer in the plan or an ADR.

### F-05: no PGlite test for the webhook route or the BMKG CAP parser

- **Observation:** `apps/worker/test/webhook-ingest.test.ts` and `apps/worker/test/bmkg-cap.test.ts` do not import PGlite or `createTestDatabase`. The CAP tests are parser-level.
- **Evidence:** `docs/testing/INTEGRATION-TEST.md` section 7, items 1 and 2. Affects IT-B1-06 and IT-B1-07.
- **Decision needed:** add PGlite composition tests for both, or accept the handler and parser tests for the course release and record that decision.

### F-06: no dedicated test for `freshness-aggregate-policy.ts`

- **Observation:** the aggregate rules are tested only as cases inside `apps/worker/test/l4-public-projection.test.ts`.
- **Evidence:** `docs/testing/INTEGRATION-TEST.md` section 5 (gap paragraph) and section 7, item 3. File: `apps/worker/src/layers/l4-application-integration/freshness-aggregate-policy.ts`.
- **Decision needed:** add a dedicated test file and list it in `apps/worker/package.json`, or accept the current cases as sufficient.

### F-07: SDP section 3.1 describes a read-only moderator view with no sign-in

- **Observation:** `SOFTWARE_DEVELOPMENT_PLAN.md` line 155 says the moderator evidence review is read-only, with no sign-in and no review mutations, and defers those to a later authenticated release. This is stale. Password accounts exist (ADR-060), and moderation is authenticated (`apps/worker/test/moderation-api.test.ts`).
- **Evidence:** `docs/testing/SYSTEM-TEST.md` section 1 (documentation conflict); `docs/decisions/ADR-060-password-accounts.md`.
- **Decision needed:** the owner or root planner updates the SDP section 3.1 text. The test documents do not change the SDP.

### F-08: WSL distribution and CI Node version are stated inconsistently

- **Observation:** `DOKUMENTASI_UNIT_TESTING.md` section 4.b (line 268) says WSL2 Ubuntu 24.04 LTS. `CLAUDE.md` says the local environment is WSL Ubuntu-26.04. A related point: `CLAUDE.md` says CI uses Node 22, but `.github/workflows/ci.yml` line 19 sets `node-version: 24` (runner `ubuntu-24.04`, line 11). This summary uses `ci.yml`.
- **Evidence:** `DOKUMENTASI_UNIT_TESTING.md` line 268; `CLAUDE.md` (Environment and Commands; repository root); `docs/testing/TEST-PLAN.md` section 6; `.github/workflows/ci.yml` lines 11 and 19.
- **Decision needed:** the owner confirms which distribution the recorded local runs used, corrects the document that is wrong, and confirms the CI Node version to state in `CLAUDE.md`.

## Section C: Removed from the defect list (not fixes)

These commits were in an earlier draft of the defect list. The corrected unit report removes them (`DOKUMENTASI_UNIT_TESTING.md` section 2.a, around line 100).

- **`bd49c57`** (`frontend cleanup unit testing`): not a `fix` commit. It changes `apps/web/src/Landing.tsx` and `apps/web/test/landing.test.tsx`. The React import line is not changed in the diff. Both files were deleted in `b0a18c5` (`git log --diff-filter=D`), so the defect is no longer recorded.
- **`e1e50f0`** (`Created new frontend demo pages`): a feature commit. Its 15 ms `setTimeout` in `apps/db/test/news-triage-decisions.test.ts` is a test pause, not a fix. The commit also adds demo pages, changes `tools/serve-live-pipeline.ts` and adds the unit report's documentation file.
- **`e8c35d6`** (`feat(VIS-01): 3D embedding chunk visualization`): a feature commit. The earlier claims about a `NaN` in PCA, an epsilon guard and a 30 cm threshold cannot be traced to its diff. It adds `apps/web/src/embedding-pca.ts`.
- **`6217fd0`** (`feat(CORR-01): multi-source incident corroboration`): a feature commit. The same claims cannot be traced to its diff. Neither `e8c35d6` nor `6217fd0` changes `apps/worker/src/layers/l2-model-grounding/correlated-proposal-engine.ts`, where `detectIncidentDiscrepancies` lives.

## Section D: Test run defects

None recorded yet. UAT walkthrough runs are pending (`docs/testing/UAT.md` section 9). No CI failure is recorded for `cec9358`.

Entry format for later use. Run defects use `R-nn`, so they stay separate from `D-nn` (fixed) and `F-nn` (open):

| ID | Date | Run ID | Step | Symptom | Evidence path | Status |
| --- | --- | --- | --- | --- | --- | --- |
| R-nn | dd Mon 2026 | UAT_RUN_ID or CI run ID | task and step, for example T4 step 4 | what was observed | `.codex-build/uat/<run-id>/<script>.json` or CI log summary | Open, Fixed (commit SHA) or Not a defect (reason) |
