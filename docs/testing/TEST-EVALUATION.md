# Test evaluation: integration and system

## Basis and status key

Basis: branch work/TEST-GAP-01-evaluation at ab862c3. That is main (4f1c344) plus the TEST-LIST-01 fixes in 85b8d57 and ab862c3, which are not merged. The evaluation is static reading and grep only. No tests, typechecks, builds, browser runs, CI runs, serve:live runs, smoke or e2e runs, model calls or network calls were run.

Inputs are five scratch reports in the scratch gap folder, cited below as plain text: integration.md (integration rows and SDP section 10 coverage), system.md (system and acceptance rows and UAT claims), and fr-01-08.md, fr-09-15.md and nfr-release.md (requirement clauses, used in REQUIREMENTS-GAP.md).

Basis column: "Verified" means the item is one of the corrections V1 to V14 supplied for this report, or a file read or grep made for this report. "Reported" means the item is taken from a scratch report and was not re-checked. A Reported item is never upgraded.

Status key:

- Supported: a named test asserts the expected result on the path the row describes.
- Partly supported: part of the expected result is asserted. The "not asserted" column says what is missing.
- Not supported: the expected result is contradicted, or no test asserts it.
- Stale: a register row or document statement is out of date against the repository.
- Blocked as stated: the register or a run record marks the row Blocked. This report does not change that.
- "as Not evidenced" marks rows whose mandatory evidence does not exist. Their "Supported" does not mean the requirement is met.

The verdict counts below are the reports' counts. They are not register status counts. test-cases.csv has 76 rows (Verified, counted for this report; see Register and document errors, item 14).

## Summary

- Integration: 25 rows, 19 Supported and 6 Partly supported, 0 Not supported (integration.md, Summary). Reported.
- System and acceptance: 51 rows, 4 Supported (2 of them as Not evidenced), 33 Partly supported, 9 Blocked as stated, 5 Stale, 0 Not supported (system.md, Summary). Reported.
- Top findings:
  1. The worker and web test scripts on main drop four test files from the run (V1). Verified. Not run, and the CI outcome on main is not confirmed. Fixed on the branch, not merged.
  2. The record page and the #peta sheet print a "this API record has no geometry" message for every API record, including records that have geometry (V3). Verified by code reading, not in a browser. Proposed as F-13.
  3. Proposal processing time is used as the public event time, and freshness is set to current by construction (V5). Verified by code reading. Proposed as F-14, owner to confirm.
  4. The public demo routes with ?mode=fetch wait for source acquisition and have no session check (V6). Verified by code reading. The flags are set in apps/worker/wrangler.toml lines 8 and 9.
  5. INTEGRATION-TEST.md says the internal proposals route returns 200 with the key. The test asserts 503 (V10). Verified.
  6. UAT section 9 totals are counts across viewports, T4 is labelled Blocked while its JSON records 10 fatal failures, and ACC-02 is marked Pass where the persona JSON records failures. Reported (system.md).
- The register overstates in several places. "Evidence exists" is used for presence only, and some rows cite no test file (Register and document errors).

## Integration rows

| ID | Verdict | What is not asserted | Basis |
| --- | --- | --- | --- |
| TI-01 | Partly supported | "Public handlers" are database repositories under the public role, not Worker handlers. Not in the cec9358 CI log. | Reported (integration.md, row TI-01) |
| TI-02 | Partly supported | The hold does not depend on the L3 ledger status (F-04). "Ledger stopped" is set up but does not cause the hold. Not in the cec9358 CI log. | Reported (integration.md, row TI-02) |
| IT-B1-01 | Supported | Persistence is checked only for dataset_kind synthetic. The live dataset is not asserted. | Reported |
| IT-B1-02 | Supported | The extractor is a fixed double. Unknown fields are supplied but not asserted after persistence. | Reported |
| IT-B1-03 | Partly supported | "No fetch" appears only in the title. fetchFn is never counted. | Reported |
| IT-B1-04 | Supported | The budget test writes attempt rows directly, not through the live transport. | Reported |
| IT-B1-05 | Supported, with caveat | Fake SQL executors, no PGlite. Role reset is checked as statement text, not database state. The CSV cites step 6; the file runs in step 8. | Reported |
| IT-B1-06 | Partly supported | No database, so stored reports are in-memory objects. Batch SSE is not asserted. No negative correlation case. | Reported |
| IT-B1-07 | Supported, mis-levelled | Pure parser with no database or composition. Its level is unit, not integration. | Reported |
| IT-B2-01 | Supported | None material. | Reported |
| IT-B2-02 | Supported | None material. | Reported |
| IT-B2-03 | Partly supported | The privacy loop checks grounding_contexts for the L2 reader only. The public and L3 roles are not checked against it. | Reported |
| IT-B2-04 | Supported | None material. | Reported |
| IT-B2-05 | Supported, with doubles | The repository is a double. Database behaviour is covered by IT-B2-04. | Reported |
| IT-B2-06 | Partly supported | "Bounded" and "read-only" are not asserted here, because the repository is a fake. Bounding is asserted at apps/db/test/evidence-retrieval.test.ts:740. | Reported |
| IT-B2-07 | Supported | Local mock model in tools/local-pipeline. Not a Worker or intelligence composition. | Reported |
| IT-B2-08 | Supported | The attempt bound is not asserted here. It is asserted in tools/local-pipeline/pipeline.test.ts:168 (cited under IT-B2-07). | Reported |
| IT-B3-01 | Supported | No L4 import. The coordinator has no runtime caller (V9). | Reported; V9 applies |
| IT-B3-02 | Supported | Manual (L2) gate only. The agent auto gate is not covered here. | Reported |
| IT-B3-03 | Supported | Only 4 of the 9 ADR-061 checks have database-level tests. Row 21 of the SDP table names four checks that are pure-function tests only. | Reported |
| IT-B3-04 | Supported | A race between the expiry sweep and a moderator decision is not tested. | Reported |
| IT-B3-05 | Supported | None material. | Reported |
| IT-B3-06 | Supported | None material. The strongest integration row. | Reported |
| IT-B3-07 | Supported | The denial comes from a live-scoped reader that does not see the synthetic row. The policy never judges the draft. | Reported |
| IT-B3-08 | Supported | Runs through worker.fetch on PGlite with real sessions. INTEGRATION-TEST section 4 does not say so. | Reported |

## Integration coverage against SDP section 10

Status vocabulary from integration.md: Missing, Partly, Covered. "Covered, unregistered" means a CI-run test exists but is not in the integration register. All rows are Reported unless marked.

| # | Element (SDP section 10) | Status | Nearest file | What is missing | Basis |
| --- | --- | --- | --- | --- | --- |
| 1 | Contract and parser checks | Partly | apps/worker/test/bmkg-cap.test.ts:183-343; apps/worker/test/petabencana-geojson.test.ts | Parsers are pure. No composition test writes parsed output and reads it back. | Reported |
| 2 | Explicit unknowns preserved | Partly | apps/db/test/synthetic-source-poll-process-runtime.test.ts:137, :147; tools/local-pipeline/processor.test.ts:36 | Unknown fields are supplied but never asserted after persistence. | Reported |
| 3 | Source offsets survive normalisation | Covered, unregistered | apps/db/test/evidence-chunks.test.ts:110-148; apps/db/test/evidence-retrieval.test.ts:771, :835 | None material. Add to the register. | Reported |
| 4 | Model failures enter review or quarantine | Covered, unregistered | apps/intelligence/test/job-worker.test.ts:109; apps/intelligence/test/ai-rate-limit-job-runner.test.ts:184 | Not in the register. | Reported |
| 5 | Supporting and contrary evidence recall@k | Missing | apps/db/test/evidence-retrieval.test.ts:311, :740 | No recall@k is computed anywhere (grep for recall@ is empty). The RSS prefilter precision and recall test (det-filter-shadow-eval.test.ts:493) is not retrieval. The benchmark runner test is not run in CI. | Reported |
| 6 | Merge and split precision and recall | Missing | apps/intelligence/test/merge-review.test.ts:83-168 (PGlite); apps/worker/test/multisource-correlator.test.ts:121-289 (unit) | No labelled set and no measured precision or recall. No split case in integration. | Reported |
| 7 | Non-geographic notices | Missing | apps/worker/test/l4-public-projection.test.ts; apps/worker/test/l4-public-geometry-projection.test.ts (unit) | No composition test that a notice without geometry passes through retrieval and publication. | Reported |
| 8 | Nearby distinct incidents stay separate | Partly | apps/worker/test/multisource-correlator.test.ts:289 (unit); apps/worker/test/webhook-ingest.test.ts:379-391 | Positive case only. No integration negative case. | Reported |
| 9 | Retracted vectors | Covered, unregistered | apps/db/test/evidence-retrieval.test.ts:494-512; apps/db/test/embedding-generation-composition.test.ts:324-372 | None material. | Reported |
| 10 | Sufficient-context bypass | Partly | apps/db/test/rag-grounded-proposal-roundtrip.test.ts:88; apps/db/test/investigation-ledger.test.ts:1840 | No test shows the live runtime skipping investigation. The L3 coordinator has no runtime caller (V9). | Reported; V9 |
| 11 | Typed tools | Partly | apps/db/test/investigation-ledger.test.ts:1760 | Tool typing is unit-level. No integration run of typed tool calls through the ledger. | Reported |
| 12 | Retries counted | Covered, unregistered | apps/db/test/investigation-ledger.test.ts:3463, :3738; apps/worker/test/gated-rss-revision-identity.test.ts:436; apps/worker/test/news-triage-rate-limit.test.ts:251 | Not in any IT-B row. | Reported |
| 13 | Durable budgets | Covered, unregistered; values unverified | apps/db/test/investigation-ledger.test.ts:94, :1687, :2034-2037, :3837 | Production default values were not found by grep in apps/worker/src. | Reported |
| 14 | No-progress stopping | Covered, unregistered | apps/db/test/investigation-ledger.test.ts:94 (no_progress at :150) | None material. | Reported |
| 15 | Escalation | Partly | apps/db/test/investigation-ledger.test.ts:228-258 (review marker); TI-02 | No test shows an escalated case or held claim reaching the moderator queue. | Reported |
| 16 | Unsupported or disputed claims held | Covered (TI-02), with caveat | apps/db/test/l3-investigation-publication-gate.test.ts:195; apps/db/test/manual-publication-gate-composition.test.ts | The gate does not read ledger status (F-04). | Reported |
| 17 | Approved-source scope | Covered, unregistered | apps/worker/test/merge-review-publication.test.ts:252, :275; apps/db/test/evidence-retrieval.test.ts:898 | None material. | Reported |
| 18 | No invented geometry | Partly | apps/db/test/petabencana-ingest-pglite.test.ts:150-152; apps/worker/test/l4-publication-policy.test.ts:504 (unit) | No publication-level test that a notice or point-only event publishes no polygon. | Reported |
| 19 | Idempotency | Covered | apps/db/test/manual-publication-gate-composition.test.ts:161-171; apps/worker/test/gated-rss-revision-identity.test.ts:254; apps/db/test/freshness-transition-ledger.test.ts:65 | None material. | Reported |
| 20 | Concurrency | Partly | apps/db/test/publication-writer.test.ts:620-623; apps/worker/test/gated-rss-revision-identity.test.ts:397 | No test runs concurrent decisions on one proposal. ADR-061 (docs/decisions/ADR-061-agent-driven-publication.md, line 49) records the duplicate-decision check as unlocked, scoped to hosted use. | Reported |
| 21 | Agent auto-publication only when every ADR-061 check passes | Partly | apps/worker/test/merge-review-publication.test.ts:145, :199, :252, :346 (4 of 9 at database level); apps/worker/test/merge-review-gate.test.ts:90-124 (pure) | No database-level check that a queued proposal stays queued. | Reported |
| 22 | Correction propagation | Covered | apps/db/test/manual-publication-public-read-chain.test.ts:129-400 | None material. | Reported |
| 23 | Rejection never publishes | Covered, unregistered | apps/worker/test/merge-review-publication.test.ts:215; apps/worker/test/merge-review-gate.test.ts:217 | None material. | Reported |
| 24 | US-01/02/03 browser flows; mobile and list fallback | Missing | None (INTEGRATION-TEST section 7, item 7) | All of it. No browser or responsive check runs in CI. | Reported |
| 25 | Filtering, empty and error states | Partly | apps/worker/test/public-event-list-runtime.test.ts:102, :197 | Web filtering is unit-level. No filter-to-API integration. | Reported |
| 26 | Moderator access | Covered | apps/worker/test/pipeline-flow-route.test.ts:65-80; apps/worker/test/moderation-api.test.ts; apps/worker/test/service-auth-routes.test.ts:78-98 | None material. | Reported |
| 27 | Preferences (FR-11): removing an interest; repeat suppression | Missing | apps/worker/test/public-briefing-runtime.test.ts:340-457 (projection and gating only) | No test removes an interest or checks repeat-alert suppression. | Reported |
| 28 | Provider or source outage | Partly | apps/worker/test/news-poll-runtime.test.ts:209, :273, :296, :389 (fake fetch, unregistered); apps/worker/test/source-revision-freshness-transition.test.ts:285 | No database-level test that an outage leaves public freshness and coverage unchanged end to end. | Reported |
| 29 | Worker crash | Partly | apps/db/test/investigation-ledger.test.ts:881, :1687; tools/local-pipeline/pipeline.test.ts:284; apps/db/test/synthetic-source-poll-process-runtime.test.ts:199-214 | No crash test for the Worker publication path or the intelligence job runner. | Reported |
| 30 | Connection and disk limits | Missing | None (grep for pool, max_connections, ENOSPC and disk full returned nothing) | All of it. | Reported |
| 31 | Scheduled expiry | Covered | apps/worker/test/review-expiry.test.ts:258-290; apps/db/test/proposal-expiry.test.ts:68-147 | apps/worker/wrangler.toml has no trigger or cron (V13), so no scheduled run happens in deployment. | Reported; V13 |
| 32 | Database migration | Partly | apps/db/test/migrations.test.ts:389 (hard-coded count 47) | Checks the migration list and count. No apply-and-read rehearsal. | Reported |
| 33 | Restore rehearsal (NFR-06) | Missing (selection logic only) | tools/live-db-restore.test.ts:43-141 | No restore-then-read rehearsal, and no recorded recovery point or time. | Reported |

## System and acceptance rows

| ID | Verdict | What is not asserted | Basis |
| --- | --- | --- | --- |
| ST-F-01 | Blocked as stated (confirmed) | No public route draws a polygon from API data. No point or boundary distinction on #peta. The "no geometry" message on the record page is asserted nowhere, and it is wrong for mapped records (V3). | Verified (V3); rest Reported |
| ST-F-02 | Partly supported (register says Evidence exists) | Removal of an interest has no automated title (persona COM-01 only). Correction shown once is not tested in the UI. The live match is F-02. public-briefing-runtime.test.ts is not run on main (V1). | Verified (V1); rest Reported |
| ST-F-03 | Partly supported | Per-claim origin display is static markup. The real stale-version 409 is not tested at HTTP. Draft visibility after a stale write is not checked. The note "no file names replay or stale-version conflict" is wrong. | Reported |
| ST-F-04 | Partly supported | No browser interaction. Empty and unavailable wording is not separated for live. The note "filter and empty copy not named" is wrong. | Reported |
| ST-F-05 | Partly supported | Four-time display and source links on the detail page are not asserted. map-severity tests only the severity chip. The note "no web test for the detail page" is wrong. | Reported |
| ST-F-06 | Partly supported (dropped file) | onboarding-intro.test.tsx is not run on main (V1). No browser register, logout or login test except persona ACC-01. Password reset is absent. | Verified (V1); rest Reported |
| ST-F-07 | Partly supported | No audit row is asserted for reject. The reject test checks that the writer was called, not the publisher. | Reported |
| ST-F-08 | Partly supported | No test of the empty state below 900 px. No negative assertion for body, claim, prompt or checkpoint text. FLOW-VIS-01 live is not run. | Reported |
| ST-F-09 | Partly supported | The accounts-api.test.ts:205 title says "audited reason", but its body asserts no audit row. Approval and health display are not named by an assertion. | Reported |
| ST-F-10 | Supported | The audit row for the expiry decision is asserted for reason and actor only. The intelligence-side expiry is not checked here. | Reported |
| ST-F-11 | Partly supported | No quarantine state is asserted. The webhook path versus the manual path is not asserted. No live feed run. | Reported |
| ST-F-12 | Partly supported | Intelligence tests cover schema and mocks only. The live path bypasses L3 (V9). | Reported; V9 |
| ST-F-13 | Partly supported (status note stale) | Database level only. No browser view of the corrected version. | Reported |
| ST-F-14 | Partly supported | No title covers "missing update never resolved". No scheduled run in deployment (V13). | Verified (V13); rest Reported |
| ST-F-15 | Partly supported | No live-specific "no coverage" wording. R-05 (the live detail shows synthetic-record wording) is not caught by any test. | Reported |
| ST-F-16 | Partly supported | No test links the five stages under one trace ID. Per-stage telemetry only. | Reported |
| ST-N-01 | Partly supported | Synthetic only. No adjudication record. | Reported |
| ST-N-02 | Partly supported | No test shows that a sixth attempt or fifth turn is refused. The live path bypasses L3 (V9). The coordinator test file is not cited in SYSTEM-TEST. | Reported; V9 |
| ST-N-03 | Supported (as Not evidenced) | No human session exists (UAT.md section 2.2, not scheduled). Automated T1 timings are not NFR-03 evidence. | Reported |
| ST-N-04 | Stale | Cold start, first web load, larger datasets and a target are not measured. The /api/v1/updates rows returned 503 on all 200 samples at every concurrency. SYSTEM-TEST section 4 and the CSV say no measurement exists, but PERFORMANCE.md exists. | Verified (file exists); values Reported |
| ST-N-05 | Partly supported | User-facing notification deduplication is not tested. | Reported |
| ST-N-06 | Supported (as Not evidenced) | No rebuild or restore rehearsal. | Reported |
| ST-N-07 | Partly supported | No redirect, malicious-source or personal-data retention test. Secret handling covers password hashing only. No penetration test. | Reported |
| ST-N-08 | Partly supported | Dry-run only. The script typo means the worker list is not fully run on main (V1). | Verified (V1); rest Reported |
| BR-01 | Stale | Under a 13 Oct 2026 heading in DELIVERY_LOG.md. Predates seven later web commits. No screenshot or run artefact kept. | Reported |
| BR-02 | Stale | As BR-01. The manual check in UAT section 7 was not run. | Reported |
| BR-03 | Stale (probable) | Screenshots only, no run record and no test. Predates commits 7e85caa and a0df0ec, which changed the map home. Not checked against the current build. | Reported |
| BR-04 | Stale (probable) | As BR-03. The viewed image shows the older top bar, not the floating island from 7e85caa and a0df0ec. | Reported |
| AT-01 | Partly supported | "Why it may apply" and list-equals-map are not checked by T1. Demo only, automated, local, not in CI. | Reported |
| AT-02 | Partly supported | Matched-update checks are absent on demo (F-02). No deduplication evidence. | Reported |
| AT-03 | Blocked as stated | T4 has no version, key or public-projection check. T3 is not mapped. | Reported |
| T1 | Partly supported | Point or boundary check (step 6) is skipped per viewport (F-01). "20 steps passed" is a total across both viewports including setup. | Reported |
| T2 | Partly supported | Step 7 needs live data. "17 steps passed" is a total (desktop 8, phone 8, setup 1). | Reported |
| T3 | Partly supported | The claim-source label and the "not current state" note are both skipped. "16 steps passed" is a total. | Reported |
| T4 | Partly supported (the Blocked label is the register's) | The JSON records 10 fatal failures, not a block. Desktop sign-in and moderator tabs passed. The phone role-boundary pass is probably vacuous (inferred from step order, not checked against the screenshot). No decision was made. | Reported |
| T5 | Partly supported | The desktop Pass skips the demo-only and no-provider checks. "No provider request" is undetermined, because the external host tile.openstreetmap.org is listed as neither pass nor fail. | Reported |
| RES-01 | Blocked as stated | No live flood or weather item. Not a defect. | Reported |
| RES-02 | Partly supported | The scan covers safety wording only. The same live detail shows fixture wording (R-05 type). | Reported |
| RES-03 | Blocked as stated | No live expired item. | Reported |
| WRK-01 | Blocked as stated | No copy wording in the UI (F-09). published-events.ts counts outlets. | Reported |
| WRK-02 | Blocked as stated | No live expired item. | Reported |
| VIS-01 | Partly supported | The phone map step is weak (CSV). Not in CI. Scripts untracked. | Reported |
| VIS-02 | Partly supported | The radius step is skipped (F-12). | Reported |
| VIS-03 | Partly supported (UAT Pass not supported) | The R-05 finding fail sits beside the pass. The live record shows fixture wording, which breaks FR-15. | Reported |
| COM-01 | Supported (browser walkthrough) | Browser-local only. The register says Evidence exists, but no test file exists. Not repeatable from main. | Reported |
| COM-02 | Partly supported | Impact text not verified (CSV). UAT says Pass, CSV says Partial. | Reported |
| STU-01 | Blocked as stated | No group notice in the live feed. | Reported |
| ACC-01 | Partly supported (register overstated) | Later attempts skip the registration step. Evidence exists with no test file. The student phone sign-in was refused by rate limit (R-07). | Reported |
| ACC-02 | Partly supported (UAT Pass not supported) | Student attempt 2 fails on desktop and phone. Student attempt 3 fails on desktop. Worker attempt 2 fails on phone, and this is not in the R-06 log. | Reported |
| MOD-00 | Blocked as stated (not run) | Browser run not done, skipped by decision (UAT section 6.0). Server analogue at apps/worker/test/moderation-api.test.ts:265-277. | Reported |
| MOD-02 | Blocked as stated (not run) | Browser run not done. The UAT section 6.0 "T3 pass" mapping is unsupported. | Reported |

## UAT and document claims

| Claim (where stated) | Evidence found | Verdict | Basis |
| --- | --- | --- | --- |
| T1, T2, T3 "20, 17, 16 steps passed" per viewport (UAT section 9) | JSON and logs total 20, 17 and 16 across both viewports including setup. Per viewport it is 8 to 10. | Not supported (miscount) | Reported |
| T4 "Blocked" (UAT section 9; AT-03; R-04) | t4.out reads "10 fatal failed". JSON status fail with fatal true. | Partly (the register's label) | Reported |
| T4 desktop "decision steps not reached" (UAT section 9) | Four desktop decision steps ran and failed. | Partly (minor) | Reported |
| T5 desktop "Pass, after a script correction, 22 steps passed" | Run 02 total 22 ok. Desktop 11 ok, with two skip groups. No desktop fail. | Partly (hides skipped demo-only checks) | Reported |
| T5 phone "Fail, 1 step (R-01)" | Run 02 phone: 1 fatal. | Supported | Reported |
| T5 run 01 "failed 8 steps" (R-02) | Run 01: 4 fatal desktop, 4 fatal phone. | Supported | Reported |
| T1 "1 check skipped", T2 "3", T3 "2" per viewport | Skips per viewport match. | Supported | Reported |
| Persona walkthroughs "automated (browser subagent)" (UAT section 9.1) | Commuter JSON says real-user GUI walkthrough. Worker JSON says GUI walkthrough as a real user; automated. | Partly (labels inconsistent; not human sessions) | Reported |
| Persona runs are reproducible (UAT section 2.1) | tools/e2e/uat has t1 to t5 only. The persona scripts are untracked in work/UAT-PERSONAS-01. | Not supported (from main) | Reported |
| Visitor "43 pass, 0 hard fail, 2 skipped, 2 finding fails" | Visitor JSON matches. | Supported | Reported |
| Resident "40 pass, 0 fail, 3 skipped, 4 blocked" | Resident JSON matches. | Supported | Reported |
| Commuter "ACC-01, COM-01, COM-02, ACC-02 pass on both viewports (attempt 2)" | Attempt 2 JSON: 33 pass, 0 fail, 5 skipped. | Supported (attempt 2 only) | Reported |
| Student "ACC-02 pass, with a stale menu" (UAT sections 6.0 and 9.1) | Attempt 2: ACC-02 fails on both viewports. | Not supported (a fail labelled pass) | Reported |
| Worker "ACC-01 pass on desktop (phone skipped: not applicable)" | Attempt 1 phone ACC-01 steps pass. Only the registration step is skipped. | Partly (reason wrong) | Reported |
| "ACC-02 Pass" (UAT section 6.0) | Student attempts 2 and 3 fail. Worker attempt 2 phone fails. | Not supported | Reported |
| "MOD-02 demo: T3 pass" (UAT section 6.0) | T3 is an anonymous visitor run. The CSV says Pending. | Not supported | Reported |
| "VIS-03 Pass", "RES-02 Pass", "COM-02 Pass" (UAT section 6.0) | The CSV says Partial for all three. VIS-03 coexists with an R-05 fail. | Partly (overstated) | Reported |
| "DEFECTS.md is not created in this phase" (UAT section 10) | docs/testing/DEFECTS.md exists. | Stale | Verified (file exists) |
| "UAT.md (being written; not yet in the repository)" (SYSTEM-TEST line 5) | docs/testing/UAT.md exists. | Stale | Verified (file exists) |
| BR-01 and BR-02 "headless QA at 320 px and 200%" (SYSTEM-TEST section 5; TEST-SUMMARY section 3; DELIVERY_LOG line 31) | QA is under a 13 Oct heading. No artefact. Predates later web commits. | Stale | Reported |
| "main is 13 commits ahead of cec9358" (SYSTEM-TEST section 7, item 5) | git rev-list --count cec9358..4f1c344 gives 31. | Stale | Reported |
| "ten commits ahead" (TEST-SUMMARY section 2, line 38) | SYSTEM-TEST says 13. The count is 31. | Not supported (misquote) | Reported |
| "61 rows; 28 Evidence exists, 21 Partial, 3 Not evidenced, 3 Blocked, 6 Pending" (TEST-SUMMARY section 1, line 13) | test-cases.csv has 76 rows: 30 Evidence exists, 34 Partial, 2 Not evidenced, 8 Blocked, 2 Pending run. | Not supported | Verified (CSV count) |
| "No UAT walkthrough has run" (TEST-SUMMARY section 1, line 14) | Section 5 records runs 01 and 02. | Not supported (self-contradiction) | Reported |
| "Flutter analysis and 41 tests" (TEST-SUMMARY section 3, line 45) | SDP line 7 reads "Android analyze41tests/debug APK", where formatting joins the words and count. | Supported (format only) | Reported |
| ST-N-04 "No p50 or p95 value is recorded" (SYSTEM-TEST section 4) | docs/testing/PERFORMANCE.md has p50 and p95 values. | Not supported (stale) | Verified (file present); values Reported |
| ST-N-04 "No measurement file exists" (CSV row) | PERFORMANCE.md exists. | Not supported | Verified (file exists) |
| Worker and web "all test files listed" (SYSTEM-TEST section 2) | On main, 100 worker and 32 web test files exist. Four are not run (V1). | Not supported | Verified (V1, V14) |
| "All cited test files exist" (SYSTEM-TEST section 2) | All 93 cited files exist. | Supported | Reported |
| F-01 "polygons appear only in fixture presentation and admin views" (DEFECTS F-01; UAT section 6 T1) | Polygon code exists in MapPanel, but no public route supplies data. The record page prints "no geometry" for every record (V3). F-01 does not mention that message. | Partly (understates the gap) | Verified (V3) |
| F-01 and F-02 "T1 and T2 Blocked in the CSV" (DEFECTS lines 38, 44) | The CSV has T1 and T2 as Partial. | Not supported | Verified (CSV) |
| F-04 "no L4 file references case_status or stopped_for_review" (DEFECTS line 55) | Grep of the L4 folder and event-proposals.ts gives no matches. | Supported | Reported |
| F-10 "published-events.ts line 216" (DEFECTS line 91) | The string "Lewat masa berlaku sumber" is at line 240. | Not supported (line reference) | Verified (grep) |
| F-03 imports at webhook-ingest.ts lines 13 to 24 (DEFECTS line 49) | Lines 20 to 24 re-read. Line 23 imports the L2 correlated proposal engine and line 24 the L4 broadcaster (V11). Lines 13 to 19 were not re-read; system.md reports them as confirmed. | Supported | Verified (V11); lines 13 to 19 Reported |
| D-01 "no test asserts suffix stripping" (DEFECTS line 20) | No /v1 normalisation assertion in the intelligence tests. | Supported | Reported |
| R-05 "live event detail shows demo wording" (DEFECTS line 123) | EventDetail.tsx:235 and :245 hard-coded. Wording differs by run. | Supported | Reported |
| R-05 and R-06 "confirmed defects" (DEFECTS section D; TEST-SUMMARY section 6) | DEFECTS section A rules say a defect needs a fix commit. Both rows say "Open, confirmed defect". Both are open. | Not supported (terminology) | Verified (DEFECTS.md lines 8 and 9) |
| R-06 "student-run-01 (attempts 2 and 3)" (DEFECTS line 124) | Worker attempt 2 phone ACC-02 also fails. | Partly (incomplete) | Reported |
| BR-03 and BR-04 "Evidence exists (local)" (CSV; SYSTEM-TEST section 5) | No test file. Figures predate later UI commits. | Not supported (status key) | Reported |
| CI-VISIBILITY "six files not in the run" (TEST-SUMMARY section 2; CI-VISIBILITY lines 246-250) | Six are listed. The typo on main drops four more, which the file does not mention. | Supported but incomplete | Verified (V1); rest Reported |

## Build and CI test lists

Verified (V1, commit 6e8a59e, "feat(SEV-01)", dated 13 Nov 2026 15:27 +0700, checked with git show):

- apps/worker/package.json line 17 joins test/public-briefing-runtime.test.ts and test/petabencana-geojson.test.ts with no space.
- apps/web/package.json line 10 joins test/map-severity.test.tsx and test/onboarding-intro.test.tsx with no space.
- Before 6e8a59e the lines had the space (git show 6e8a59e^).
- Four files are therefore not run as listed on main. Whether tsx fails the step or skips the joined entries is not confirmed. Not run, by policy.
- No CI run for 6e8a59e is in the repository, so the CI outcome on main is not confirmed. The first GitHub Actions run on main after 6e8a59e will show which.
- Two of the four back ST-F-02 and ST-F-06, which are marked Evidence exists (Reported, system.md).
- Two earlier reports (integration.md and fr-01-08.md) saw only the worker pair, because the matrix regex reads both halves of the joined token. The four-file count is the verified one.
- Fixed on the branch in 85b8d57 (worker) and ab862c3 (web). Each path in both lists now exists on disk. Not run. Not merged to main.
- The cec9358 CI log shows the spaced form (Reported, integration.md).
- CLAUDE.md states that all 90 worker and 20 web test files are listed. The count is stale. The worker suite has 100 files on disk, and all 100 are listed after V1. The web suite has 32 (V14, Verified).

## Register and document errors

Numbered once each. Duplicates from the integration and system reports are merged.

1. Broken test lists on main: four test paths are joined in two package scripts (V1). Verified. See Build and CI test lists.
2. INTEGRATION-TEST.md:120 says the internal proposals route "returns 200 with the key". apps/worker/test/service-auth-routes.test.ts:75 asserts 503 when no database is configured, and no test asserts 200 (V10). Verified. The test title at :53 also says 200 (Reported).
3. CSV row IT-B1-05 cites "step 6 (Run Database Tests)". The file is a worker file and runs in step 8 (the cec9358 log, 8_Run Worker Tests). Reported (integration.md item 3).
4. CSV rows TI-01 and TI-02 say "not in this branch". Both files exist on main and in this worktree. Commit 71022ee is an ancestor of main 4f1c344 (Reported, integration.md item 4; fr-01-08.md row 53a and its summary note agree).
5. "Evidence exists" is applied to presence only, on all 17 IT rows. IT-B1-03, IT-B1-06, IT-B2-03 and IT-B2-06 should read Partly (Reported, integration.md item 5).
6. The status key is misapplied to rows with no test file: BR-03, BR-04, COM-01 and ACC-01 read Evidence exists in the CSV (Verified, CSV), and no test file backs them (Reported, system.md item 6).
7. IT-B1-07 is a pure parser test filed as integration (Reported, integration.md item 6).
8. INTEGRATION-TEST section 4 says the tests "call handlers with injected runtimes". pipeline-flow-route.test.ts runs worker.fetch on PGlite with real sessions (Reported, integration.md item 7).
9. INTEGRATION-TEST section 5 says needs_update applies "if any impact is needs_update". freshness-aggregate-policy.ts:31-35 also includes the claim-set status (Reported, integration.md item 8).
10. INTEGRATION-TEST section 1 cites "SUMMARY.md, section 9" for "no browser checks". SUMMARY.md has no numbered sections (Reported, integration.md item 9).
11. INTEGRATION-TEST omits 10 apps/intelligence test files that use the database harness. Of the 56 database files in the CI log, 42 are not in sections 3 or 4. Worker files in the same areas are also unregistered (Reported, integration.md item 10).
12. INTEGRATION-TEST section 9 pins all CI evidence to cec9358. The 56-file count matches apps/db/test at ae75527, and the count at main 4f1c344 is 57. No CI evidence for 4f1c344 is in the repository (Reported, integration.md item 11).
13. The CLAUDE.md count of 90 worker files is stale (V14, Verified). CLAUDE.md is at the repository root of the main checkout and is Git-ignored, so it is not in this worktree.
14. TEST-SUMMARY section 1 gives 61 rows and 28, 21, 3, 3 and 6. The CSV has 76 rows and 30, 34, 2, 8 and 2 (Verified, CSV count). Its "31 system and acceptance rows" does not match the CSV's 28 system and 23 acceptance rows (Reported, system.md item 7).
15. TEST-SUMMARY section 2: the "ten commits ahead" quote is wrong, and the §8 phrase "the brief's list of five" is a drafting note that should be removed (Reported, system.md item 8).
16. SYSTEM-TEST section 8 says the overall status is the weakest linked test, but does not apply it. FR-10 and FR-15 include Blocked ST-F-01 but are Partial. FR-11 is Evidence exists but includes ST-F-02. NFR-03 omits BR-01 and BR-02 (Reported, system.md item 2).
17. ST-F-02 is Evidence exists in the CSV, but its file-level note and the blocked matched-update step contradict it (Reported: CSV note, fr-09-15.md). ST-F-06 depends on onboarding-intro.test.tsx, which is not run on main (V1).
18. Notes saying "not named by any file" are wrong for ST-F-03, ST-F-04, ST-F-05, ST-F-07, ST-F-13, ST-N-02, ST-N-05 and ST-N-07. Replay, stale-version conflict, the detail-page test, the publication audit and CSRF tests all exist (Reported, system.md item 4).
19. SYSTEM-TEST section 4 says no p50 or p95 is recorded. Section 8 says the figures were measured over HTTP. PERFORMANCE.md exists (Verified). Its /api/v1/updates rows are non-200 responses (Reported, system.md item 5).
20. DEFECTS.md errors. F-01 and F-02 say T1 and T2 are Blocked in the CSV; both are Partial (Verified). F-10 cites published-events.ts line 216; the string is at 240 (Verified). The display.ts "Lewat batas tinjau" string is at line 75, not 76 (Verified). The line 71 reference that system.md item 9 gives for display.ts was not checked (Reported).
21. DEFECTS.md section D and TEST-SUMMARY section 6 call R-05 and R-06 "confirmed defects". Section A defines a defect as a fault with a fix commit, and both rows are open (Verified). R-06 cites student-run-01 only, but worker attempt 2 also fails on phone (Reported).
22. UAT section 9 gives step totals across both viewports as if per viewport. T4 is labelled Blocked while the JSON records fatal failures. The T5 desktop Pass hides skipped demo-only checks. Section 6.0 and 9.1 give ACC-02 Pass where the JSON fails, and map MOD-02 to T3. VIS-03, RES-02 and COM-02 are Pass in UAT but Partial in the CSV. The worker ACC-01 phone reason is wrong (Reported, system.md item 10).
23. Persona provenance: commuter JSON says "real-user GUI walkthrough", but UAT labels all runs automated. The persona scripts are untracked in work/UAT-PERSONAS-01, and CSV and DEFECTS cite artefacts under the uat-personas worktree, so the runs cannot be reproduced from main (Reported, system.md item 11).
24. UAT section 10 says DEFECTS.md "is not created in this phase", and SYSTEM-TEST line 5 says UAT.md is not yet in the repository. Both files exist (Verified).
25. CSV row errors: AT-01 expects "why the event may apply", which T1 does not check. AT-03 expects "public projection verified", which T4 does not check. MOD-02 is Pending while UAT section 6.0 says demo pass. BR-01 and BR-02 cite a 13 Oct record as current (Reported, system.md item 13).
26. CI-VISIBILITY lists six files not in the run. The typo on main drops four more, which the file does not mention (Reported, system.md CI-VISIBILITY row).
27. CSV TI-01 expects "read back through public handlers", but the evidence uses database repositories (Reported, integration.md item 14).
28. matrix.txt: all 51 UNLISTED lines are apps/db or apps/intelligence entries, and none are worker or web (Verified, grep). They are false positives, as the brief said. The worker and web checks pass the joined pairs (Reported, integration.md item 13).
29. Documentation contradicts the code on the detail page: F-01 says nothing about the "no geometry" message, which is printed for every API record (V3, Verified).

## Not verified

Merged from the not-verified lists of all five scratch reports. The brief refers to four lists; five reports carry one, so all five are merged.

- No test, typecheck, build, npm command, browser run, CI run, serve:live run, smoke or e2e run, perf run, model call or network call was run in any report or in this one.
- Whether tsx skips or fails the step for the four joined test paths. The claim rests on the package scripts and on git show.
- The overall CI result for run 117086838832 (commit cec9358). No CI log for 4f1c344 or for 6e8a59e is in the repository.
- TI-01 and TI-02 pass status. The CSV records a local pass that was not re-run.
- The record-page "no geometry" message in a browser (V3 is code reading only). No persona run recorded it.
- Current UI against the BR-03 and BR-04 figures. No dev server or browser was used.
- Assertion bodies. About 90 files were checked by title (titles.txt in the scratch folder), grep and selected reads. The large files (investigation-ledger.test.ts, 4,773 lines; evidence-retrieval.test.ts, 1,439; manual-publication-public-read-chain.test.ts, 1,568) were checked by title, grep and selected bodies only.
- Intelligence tests (job-worker, merge-review, workflow, semantic-retrieval) were checked by title and imports only.
- Not read in depth: publication-outbox-delivery.test.ts; public-event-geometries.test.ts (no-geometry assertions); freshness-due-schedule-runtime-composition.test.ts; migrations.test.ts beyond the count; tools/live-db-restore.test.ts bodies; public-briefing-runtime.test.ts bodies beyond titles.
- Acyclicity (INTEGRATION-TEST section 6). No cycle tool exists, and no dependency graph was built. The import observations were checked by grep only.
- Mastra default step limits in node_modules were not inspected, so live tool and turn behaviour is inferred from call sites. Production default budget values were not compared with the test values (apps/db/test/investigation-ledger.test.ts:2034-2037 and apps/db/test/l3-investigation-publication-gate.test.ts:418).
- Dynamic imports were not searched for. A dynamically loaded L3 or manual gate module would change the L3 and gate findings.
- Deployment database roles were not inspected. apps/intelligence/src/worker.ts:37 uses DATABASE_URL. Neon role membership for migration 047 is unverified (CLAUDE.md, known gaps).
- Concurrency verdicts come from code reading. No race was reproduced.
- Rendered labels and freshness strings were read from source, not rendered.
- Moderator web pages: ModeratorReview.tsx was checked for imports only.
- Audit for reads is treated as not required. The owner should confirm.
- Repository-wide scan for label or results files timed out. A targeted search found no human-labelled set and no recall or precision result.
- Source rights (SOURCE_CLEARANCE_PLAN.md) were not read. Public "N sumber" wording was checked by grep only.
- The R-02 script correction on work/UAT-RUN-01 was not inspected. The "two or three published reports" claim in UAT section 9.1 was not checked.
- ST-N-01 adjudication and ST-N-06 rehearsal: no record exists in the repository, and none was searched for further.
- SDP section 3.1 wording (F-07) and "two human reviewers" were not re-read beyond the lines cited.
- Mobile tests (apps/mobile), the mobile lock file and Flutter counts were not reviewed. Web, Flutter and browser flows were outside the integration scope.
- The perf harness was read only through PERFORMANCE.md.
- Secrets: .env.local, .dev.vars and .codex-build/uat/accounts were not opened.
- PBKDF2 CPU cost on Workers Free is unmeasured, and password reset is absent (CLAUDE.md, known gaps).
- The DB runner globs *.test.ts, so TEST-INT-01 runs on main. It was not run.
