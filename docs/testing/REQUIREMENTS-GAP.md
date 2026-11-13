# Requirements gap report

## Update 14 Nov 2026 (TEST-GAP-02)

Basis: main at abe7bf6. The clause tables below keep the ab862c3 verdicts. This update lists only the clauses whose status changed, with the commit and test file, and the release items and owner decisions that changed. Clauses not named here were not re-assessed. No test was run for this update; the local pass status of each new file is in test-cases.csv (IT-TG-*, UT-TG-*). Three abe7bf6 files have no reported local pass.

Clause changes (ab862c3 verdict to abe7bf6 verdict):

| Requirement and clause | Before | Now | Commit; test file |
| --- | --- | --- | --- |
| FR-03 clauses 13 and 18 (event time not invented) | Contradicted | Covered for the event start: no fallback to publish, retrieval or processing time. Clauses 14 and 15 not re-checked | 588e375 (migration 048); `l4-event-time-unknown.test.ts`, `event-time-unknown.test.ts` (worker, intelligence, web) |
| FR-08 clause 53 (one gate) | Contradicted | Unchanged. Both paths refuse `investigation_stopped_for_review`, but the two check sets still differ | 593f849 |
| FR-08 clause 58 (concurrency) | Not covered | Partly: decisions on one proposal and on one event are serialized; the expiry sweep is not locked | 593f849; 9d107b6; `adr061-gate-db.test.ts` |
| FR-08 clause 64 (conflict response) | Not covered | Unchanged. `decideProposal` returns no conflict | none |
| FR-08 clause 53b (corrections use the gate) | Not covered | Partly: a correction is stored as a proposal and passes the moderator gate and the `time_missing` check | abe7bf6; `event-withdrawal-correction-db.test.ts` |
| FR-09 C2b (record page and sheet say "no geometry") | Contradicted | Covered for mapped records at component level (not in a browser) | de0b77f; `event-detail-geometry.test.tsx` |
| FR-09 C3 and C4 (polygons, segments) | Not covered | Out of scope by owner decision (13 Nov 2026): documented limitation | SDP §4 FR-09 note |
| FR-11 C3 (removing an interest) | Partly | Covered at client and worker level; the browser walkthrough still needs a run | c15383c; `interest-removal.test.ts`, `briefing-interest-removal.test.ts` |
| FR-11 C4 (repeated coverage) | Partly | Covered for proposals and publication (`no_material_change`); updates feed still open (F-ALERT-02) | 9d107b6; `repeated-coverage-alerts.test.ts` |
| FR-12 C3 (source approval) | Not covered | Partly: route, trace and audit, and an admin panel. Revocation also stops collection (see limitations) | 9c0bb13; `source-approval-api.test.ts`, `source-approval-store.test.ts`, `source-approval.test.tsx` |
| FR-12 C4 (corrections) | Not covered | Partly: route, gate and audit. Edits are limited to title, category, event time, location label and claim text | abe7bf6; `moderation-event-actions.test.ts`, `event-withdrawal-correction-db.test.ts` |
| FR-12 C6 (withdrawals) | Not covered | Partly: route, tombstone version, decision and audit. Withdrawn is final; no public tombstone | abe7bf6 |
| FR-12 C7 (audit) | Partly | Partly: withdraw, correct and approve audit rows are read back. The reject audit row is still not read by its test | abe7bf6; 9c0bb13 |
| FR-13 C5 (jobs triggered in a running runtime) | Not covered | Partly: `serve:live` runs the job at start and on a timer. No cron trigger in the Worker | 3df81e9; `tools/live-freshness-job.test.ts` |
| FR-14 C4 (model configuration) | Not covered | Partly: the live path records the factory model configuration in the trace audit | 74c4616; `live-lineage.test.ts` |
| FR-14 C5 (trace links investigation) | Contradicted | Unchanged for live: no investigation row. The L2/L3 path has one trace across seven stages (ingestion to publication decision) | 74c4616; `trace-id-chain.test.ts` |
| FR-14 C7 (one trace across the five links) | Not covered | Partly: one trace id across seven stages on the L2/L3 path; the live path keeps the job trace | `trace-id-chain.test.ts`; `live-lineage.test.ts` |
| NFR-02 live clause (no budget counter) | Not covered | Covered at call level for the live agents (4 steps, 60 s, 4,000 output tokens, 12,000 input-plus-output estimate). No tool loop, so the 5-attempt cap is n/a | bf3cb4e; `nfr02-generation-budget.test.ts` |
| NFR-04 public routes wait for acquisition | Contradicted (demo routes) | Covered for the opt-in routes: `mode=fetch` needs a moderator or admin session (503 fails closed). Public reads never fetch | db8893c; `fetch-mode-moderator-gate.test.ts`, `provider-fetch-access.test.ts` |
| NFR-07 redirects followed by live pollers | Partly | Covered for the three live pollers: a redirect is refused and recorded as a blocked fetch | db8893c; `poller-redirect-guard.test.ts` |
| NFR-08 layer responsibilities (F-03) | Contradicted | Covered: the L1 webhook ingest uses ports. One allowlisted exception (F-03-1) | cffc865; `layer-import-boundary.test.ts` |
| TI-02 (gate ignores `stopped_for_review`) | Partly | Partly: the proposal gate now refuses `stopped_for_review`; the claim-level hold is unchanged | 593f849; `apps/db/test/l3-investigation-publication-gate.test.ts` |
| ADR-061 duplicate-decision check (ADR line 49, unlocked) | Accepted race | Locked (ADR-061 amendment, 13 Nov 2026) | 593f849 |

Release-blocking items (the release-blocking table of this report) whose status changed:

- Class 1, proposal processing time as event time (F-14): closed locally (588e375, migration 048).
- Class 1, gate checks (FR-08 clauses 53 to 55 and 57): still Contradicted. The stopped-for-review refusal is added (593f849).
- Class 3, record page says "no geometry" (F-13): closed locally (de0b77f).
- Class 3, no boundary drawn (FR-09 C3 and C4): narrowed by owner decision. A documented limitation, not closed.
- Class 4, budget bypass on the live path: closed at call level (bf3cb4e). The L3 coordinator still has no runtime caller.
- Class 5, source approval, corrections and withdrawals have no route: routes now exist (9c0bb13; abe7bf6). Merges and the public tombstone are still open.
- Class 6, no scheduled trigger: serve:live timer added (3df81e9). Deployment still has no trigger.
- Other, `?mode=fetch` without a session (NFR-04): closed for the demo routes (db8893c).
- Other, live pollers follow redirects (NFR-07): closed (db8893c).
- Other, layer rule breach (F-03, NFR-08): closed (cffc865), with F-03-1 open.
- Other, ADR-009 missing (model thresholds): unchanged.

SDP section 10 release conditions: no condition changes status. The outage row improves (unknown event times are no longer fabricated, 588e375) and stays Partly. Hosted, backup, rehearsal, thresholds, usability and casebook conditions are the owner's Phase 3 limitations, recorded in SDP section 10.

Owner decisions (13 Nov 2026) recorded in code or docs:

- (b) FR-09 narrowed to points: SDP section 4 note, 13 Nov 2026.
- (c) The L4 gate refuses `stopped_for_review`: 593f849.
- (d) `mode=fetch` requires a moderator or admin session: db8893c.
- (f) Missing event time stays null or unknown: 588e375.
- (e) The V1 test-list fix is an ancestor of main (85b8d57, ab862c3; checked). The owner's acceptance is not recorded separately here.
- (a) and (g) are unchanged.

New findings (not in DEFECTS.md): F-ALERT-02 (updates feed, open); F-03-1 (allowlisted L5 import, open); hosted grants for the L4 publication role and the intelligence lineage writes (owner brief; not re-run); no investigation row on the live path; the auto gate does not read grounding sufficiency; the expiry sweep does not take the decision lock; source revocation conflicts with FR-16; the F-14 `time_missing` queueing effect; the withdrawn public 404 is not asserted at HTTP; `docs/api/openapi.yaml` line 417 lists an unregistered retraction route.

## Basis and how to read the counts

Basis: the same state as TEST-EVALUATION.md, branch work/TEST-GAP-01-evaluation at ab862c3 (main 4f1c344 plus the unmerged TEST-LIST-01 fixes). Static reading and grep only. No tests, builds, model calls, network calls or live runs were made.

Clause level. Each SDP section 4 acceptance sentence is split into clauses. The split and the verdicts come from fr-01-08.md (FR-01 to FR-08, 67 clauses), fr-09-15.md (FR-09 to FR-15, 40 clauses) and nfr-release.md (NFR-01 to NFR-08, 50 clauses). Clause verdicts are Reported unless marked Verified. The verdicts are:

- Covered: a named test asserts the clause on the path it describes.
- Partly: part of the clause is shown.
- Not covered: no test asserts it and the code does not enforce it, or the path is absent.
- Contradicted: the code does the opposite of the clause, or a test asserts the opposite or something weaker.

Register level. These are the rows of docs/testing/test-cases.csv whose requirement column names the requirement. They were counted for this report (Verified). The method: split the requirement column on semicolons and match each FR or NFR identifier as a whole word. The level counts from this method match the level counts in matrix.txt for every requirement. One row can link to several requirements, so the register columns do not sum to 76. The status abbreviations are EE (Evidence exists), P (Partial), B (Blocked), NE (Not evidenced) and PR (Pending run).

V2, the Must-FR wording. nfr-release.md says that none of the 15 Must FRs lacks a Covered clause. That is wrong at clause level. FR-01 (0 of 4 clauses Covered), FR-04 (0 of 10), FR-10 (0 of 6) and FR-14 (0 of 7) have no Covered clause (Verified from the requirement tables). At register level every FR has at least one row marked Evidence exists (Verified). That statement is true, but it measures something else. Both measures are reported below, labelled.

Corrections applied: V1 to V14, as supplied. Where a scratch report disagreed with a correction, the correction was used. The disagreements are listed in the handback.

## Summary

| Requirement | Clauses | Covered | Partly | Not covered | Contradicted | Register EE | Register P | Register B | Register NE | Register PR |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| FR-01 source registry and approval (withdrawn 13 Nov 2026; counts are from the earlier assessment) | 4 | 0 | 3 | 0 | 1 | 4 | 1 | 0 | 0 | 0 |
| FR-02 acquisition and deduplication | 6 | 1 | 3 | 1 | 1 | 6 | 1 | 0 | 0 | 0 |
| FR-03 immutable text and times | 8 | 2 | 2 | 0 | 4 | 4 | 2 | 0 | 0 | 0 |
| FR-04 extraction | 10 | 0 | 6 | 3 | 1 | 3 | 1 | 0 | 0 | 0 |
| FR-05 retrieval | 9 | 2 | 5 | 1 | 1 | 6 | 1 | 0 | 0 | 0 |
| FR-06 matching and origins | 7 | 1 | 3 | 2 | 1 | 1 | 2 | 1 | 0 | 0 |
| FR-07 investigation | 9 | 4 | 4 | 1 | 0 | 4 | 2 | 0 | 0 | 0 |
| FR-08 publication gate | 14 | 2 | 5 | 3 | 4 | 6 | 5 | 0 | 0 | 0 |
| FR-09 geometry display | 6 | 2 | 1 | 2 | 1 | 1 | 1 | 2 | 0 | 0 |
| FR-10 public exposure | 6 | 0 | 6 | 0 | 0 | 1 | 8 | 2 | 0 | 0 |
| FR-11 preferences and updates | 4 | 1 | 3 | 0 | 0 | 3 | 1 | 1 | 0 | 0 |
| FR-12 moderator authorisation and audit | 7 | 2 | 2 | 3 | 0 | 3 | 4 | 0 | 0 | 1 |
| FR-13 expiry, retraction and stale updates | 5 | 1 | 3 | 1 | 0 | 4 | 4 | 2 | 0 | 1 |
| FR-14 trace IDs | 7 | 0 | 4 | 2 | 1 | 1 | 2 | 0 | 0 | 0 |
| FR-15 demo and live labels | 5 | 2 | 2 | 1 | 0 | 1 | 3 | 1 | 0 | 0 |
| FR-16 collection by feed, webhook or scraping (added 13 Nov 2026; not assessed by the clause evaluation) | not assessed | | | | | 0 | 0 | 0 | 0 | 0 |
| FR-01 to FR-08 total | 67 | 12 | 31 | 11 | 13 | | | | | |
| FR-09 to FR-15 total | 40 | 8 | 21 | 9 | 2 | | | | | |
| NFR-01 evidence integrity | 5 | 0 | 3 | 2 | 0 | 2 | 4 | 0 | 0 | 0 |
| NFR-02 resource bounds | 7 | 3 | 3 | 1 | 0 | 3 | 1 | 0 | 0 | 0 |
| NFR-03 usability | 6 | 0 | 4 | 2 | 0 | 2 | 3 | 0 | 1 | 0 |
| NFR-04 responsiveness | 6 | 0 | 2 | 3 | 1 | 0 | 1 | 0 | 0 | 0 |
| NFR-05 reliability | 4 | 3 | 1 | 0 | 0 | 2 | 2 | 0 | 0 | 0 |
| NFR-06 recoverability | 6 | 2 | 1 | 3 | 0 | 0 | 0 | 0 | 1 | 0 |
| NFR-07 privacy and security | 8 | 1 | 6 | 1 | 0 | 3 | 2 | 1 | 0 | 1 |
| NFR-08 maintainability | 8 | 2 | 4 | 1 | 1 | 0 | 1 | 0 | 0 | 0 |
| NFR total | 50 | 11 | 24 | 13 | 2 | | | | | |

Clause counts are from fr-01-08.md Summary, fr-09-15.md Summary and nfr-release.md Summary (Reported). The sums were checked (Verified): 12 + 31 + 11 + 13 = 67; 8 + 21 + 9 + 2 = 40; 11 + 24 + 13 + 2 = 50. Register counts are Verified (method above). Five FRs have one EE row: FR-06, FR-09, FR-10, FR-14 and FR-15 (Verified).

## Release-blocking items

The six classes are those in SDP section 10 (lines 369-385). Items under "Other" are outside the six classes, with the reason.

| Class | Item | Status and evidence | Basis |
| --- | --- | --- | --- |
| 1 unsupported publication | Local live waiver for every source (formerly FR-01 clause 3; FR-01 was withdrawn on 13 Nov 2026, so the rights question now sits with FR-16 and the owner decision) | Proposed, owner to confirm. `tools/serve-live-pipeline.ts` line 298 sets AUTO_PUBLISH_SOURCE_PERMISSION to local_relaxed. Lines 255-262 seed each RSS source as approved with public_display. `apps/worker/test/merge-review-gate.test.ts` lines 157-165 assert that an unpermitted source passes. The auto-publish path was not run. | Verified (V4); test line Reported |
| 1 unsupported publication | Proposal processing time used as public event time, freshness fixed to current (FR-03 clauses 13-15 and 18; FR-08 clause 57) | Proposed, owner to confirm. `apps/worker/src/layers/l4-application-integration/public-read-model.ts` lines 646-648 set eventStart from proposed_at with precision exact. Line 685 sets publishedAt. Lines 728-731 set freshness to current with basis fast_observation_review. Line 739 sets valid_from. A second copy of the same rule is in `rawInputToEventDetail` (lines 806-838, called at line 132): it sets event_time.start and validity.valid_from to published_at, else proposed_at, else the current time, with precision exact and freshness current. Reachability of both paths on the live route was not run. | Verified (V5 lines; rawInputToEventDetail read directly); webhook parts Reported |
| 1 unsupported publication | Gate checks (FR-08 clauses 53, 54, 55 and 57) | Contradicted. The auto and moderator actions use different checks. Neither checks evidence, remit, freshness or concurrency on the runtime path. The model's own support_assessment counts as evidence. The complete gate has no non-test importer. | Reported (fr-01-08.md) |
| 1 unsupported publication | Disputed claim hold (TI-02) | Partly. The hold is for a claim dispute, not the ledger status (F-04). Not in the cec9358 CI log. | Reported (integration.md; nfr-release.md section 3) |
| 2 exposed personal data | Content retention (NFR-07 clause 7) | Not covered. Only session and login-attempt cleanup exists (`apps/db/src/accounts.ts` lines 532-556). No retention job or test. No penetration test. Telemetry allow-lists and password tests are CI-visible for the paths they cover. | Reported (nfr-release.md) |
| 3 wrong active warning geometry | Record page and #peta sheet say "no geometry" for every API record (FR-09 clause C2b) | Contradicted. `apps/web/src/MapPanel.tsx` line 165 sets legacyScreen when the three props are undefined. Lines 252-256 print the "Tidak dipetakan" message for every api-event. `apps/web/src/EventDetail.tsx` line 328 renders MapPanel from ApiEventDetail (line 185), which EventDetail uses for API records (line 349) in both the page and the sheet (line 359). The #peta sheet is at `apps/web/src/MapHome.tsx` lines 404-420. Records with geometry are populated (Reported). Proposed as F-13. | Verified (V3; sheet path by code reading); rest Reported |
| 3 wrong active warning geometry | No boundary drawn; polygons and segments not drawn on any route (FR-09 clauses C3 and C4) | Not covered. Polygon and LineString drawing is in MapPanel, reached only through EventFeed, which no route mounts (Reported, fr-09-15.md). F-01 is open. | Reported |
| 3 wrong active warning geometry | Invented point precision (FR-04 clause 20) | Contradicted. The public point is stamped precision_m 50 at `apps/worker/src/layers/l4-application-integration/public-read-model.ts` line 679. | Reported |
| 4 budget bypass | Live intelligence path has no budget counter (NFR-02 live clause) | Not covered. No maxSteps, maxTokens, max_tokens, budget, stepCount or toolCalls term in `apps/intelligence/src` (grep, this report). No explicit cap was found in the code. Mastra defaults were not inspected. The job cap limits job retries, not tool attempts. | Verified (V8, no explicit cap found in the code); rest Reported |
| 4 budget bypass | L3 coordinator has no runtime caller (FR-05 clause 35; FR-07 clauses 44 and 45) | Not covered on the runtime path. No file outside `apps/worker/src/layers/l3-investigation` in `apps/worker/src` or `apps/intelligence/src` contains the string l3-investigation (grep, this report). Ledger budgets are CI-visible at DB level (Reported). Production default values were not located. | Verified (V9); rest Reported |
| 5 unauthorised moderation | Source approval, corrections and withdrawals have no route (FR-12 clauses C3, C4 and C6; FR-08 clause 53b) | Not covered. `approve_source`, `submit_correction` and `retract_information` appear in the policy only. The manual correction service is imported by no route. | Reported (fr-09-15.md; fr-01-08.md) |
| 5 unauthorised moderation | Conflict response on the runtime (FR-08 clause 64) | Not covered. decideProposal never returns conflict. The conflict test uses a stub publisher. | Reported |
| 5 unauthorised moderation | Audit of reject, triage and role change (FR-12 clause C7) | Partly. Reject writes a row that its test never reads. The triage actor is not asserted. The role-change audit row is not asserted. | Reported |
| 5 unauthorised moderation | T4 browser run | Blocked as stated. R-03 is a login 429 and R-04 an empty queue (DEFECTS.md section D; run conditions, not product defects). Moderation authorisation is CI-visible at server level. | Reported |
| 6 stale or retracted evidence reinstated | Retracted revisions can return as evidence (FR-05 clause 36a) | Not covered. The live query filters embedding_runs status and incident status but not revision status (`apps/intelligence/src/services/semantic-retrieval-service.ts` lines 242-244). No runtime writer sets a retraction. | Reported |
| 6 stale or retracted evidence reinstated | No scheduled trigger in deployment (FR-13 clause C5) | Not covered. `apps/worker/wrangler.toml` has no [triggers] or cron entry (Verified, V13). The freshness job therefore has no trigger in deployment. Local live runs only the proposal TTL sweep (`tools/serve-live-pipeline.ts` lines 617-635, Reported). | Verified (V13); rest Reported |
| 6 stale or retracted evidence reinstated | Writer conflicts (NFR-05 clause, stale write) | Covered at DB level (`apps/db/test/publication-writer.test.ts` lines 582-589). Retraction and expiry have no runtime run. | Reported |
| Other: NFR-04 | Public demo routes wait for source acquisition with no session check (`?mode=fetch`) | Contradicted for the opt-in demo routes. `apps/worker/src/index.ts` line 522 routes `/api/v1/demo/context-sources` before any account check. `apps/worker/src/layers/l4-application-integration/context-sources-api.ts` lines 41-42 check only DATASET_MODE, SOURCE_PREVIEW_ENABLED and the method. Lines 58-59 await runtime.readFetched() for mode=fetch. `apps/worker/wrangler.toml` lines 8-9 set both flags. The source-preview route has the same shape (Reported). Not placed under budget bypass: the route runs no L3 step, so L3 budgets do not apply. The reports show no personal data on this route. Owner decision (d). | Verified (V6); preview route Reported |
| Other: NFR-07 | Redirects followed by live pollers (NFR-07 redirect clause) | Partly. `apps/worker/src/runtime/news-poll-runtime.ts` line 835 passes no redirect option, so fetch follows redirects (Verified, V7). The context and preview adapters use redirect manual (`apps/worker/src/layers/l1-data-knowledge/context-source-adapters.ts` lines 171 and 336; `apps/worker/src/layers/l1-data-knowledge/source-preview-adapters.ts` lines 253 and 307). BMKG and PetaBencana pollers are reported the same way (Reported). | Verified (V7, news); rest Reported |
| Other: NFR-08 | Layer rule breach in the webhook path (F-03) | Contradicted. `apps/worker/src/layers/l1-data-knowledge/webhook-ingest.ts` line 23 imports the L2 correlated proposal engine and line 24 the L4 event broadcaster. CLAUDE.md allows L1 one fixed L2 adapter. | Verified (V11) |
| Other: model thresholds | ADR-009 is missing (release condition, model accuracy thresholds) | Not met. `docs/decisions/README.md` line 21 refers to ADR-009. No ADR-009 file exists in docs/decisions (Verified, grep). | Verified (V12) |

## SDP section 10 release conditions

Source: nfr-release.md section 2 (Reported). Status key: Met, Partly, Not met. The summary is 0 Met, 3 Partly, 7 Not met. The counts were checked against the ten rows (Verified).

| Condition | Status | Evidence | What is missing | Basis |
| --- | --- | --- | --- | --- |
| All Must requirements (FR-02 to FR-16; FR-01 withdrawn 13 Nov 2026) | Not met | FR-16 has no test case, no scraper and no robots.txt check (grep found none in apps/worker, apps/intelligence, apps/db or tools; Verified). Clause level, FR-01 excluded: FR-04, FR-10 and FR-14 have no Covered clause (Verified, V2). Register level: every FR has at least one EE row. Blocked rows: ST-F-01 (FR-09, FR-10, FR-15), WRK-01 (FR-06), WRK-02 and RES-03 (FR-13), RES-01 (FR-10), STU-01 (FR-09, FR-11), T4 (NFR-07) and MOD-00 (FR-12). Open findings F-01, F-02, F-04, F-09 and F-12. | Partial rows to close, including ST-F-03, ST-F-07, ST-F-13, TI-02, ST-F-09 and ST-F-14. | Verified (V2 counts from requirement tables and CSV); rest Reported |
| Four integrated scenarios | Not met | Four labelled fictional demo archetypes (`docs/assignments/INT-01-SYNTHETIC-DEMO-SCENARIO-CORE.md` line 72). The fixture has scenario_tags empty. INT-01 is in progress (`docs/IMPLEMENTATION_BACKLOG.md` line 237). | An integrated run for each scenario through direct and investigated paths, independent claims, the L4 gate, public read, outage and correction. Only per-layer compositions exist. | Reported |
| Held-out evidence | Not met | `docs/evaluation/fixtures/synthetic-casebook.json` has 1 case, 1 report, split development, held_out_freeze not_frozen, no reviews and adjudication null. `docs/evaluation/CASEBOOK.md` says metadata_ready is false. EVAL-01 is planned (`docs/IMPLEMENTATION_BACKLOG.md` line 99). Counts: 0 labelled cases, 0 of 10 labels reconciled, 0 of 4 scenarios, 0 human reviews, no held_out split. | Real rights-cleared labelled casebook of at least 40 reports and 12 cases; two human reviewers; a frozen held-out split; any evaluation run. | Reported |
| Usability evidence | Not met | ST-N-03 is Not evidenced. No human sessions. UAT personas are browser-agent runs (`docs/testing/UAT.md` line 246). | Human sessions with 6 to 8 participants and the 80% target. | Reported |
| Reproducible Free-tier deployment | Not met | No deploy script. No deploy step in `.github/workflows/ci.yml`. `apps/worker/package.json` line 15 is wrangler deploy --dry-run. `apps/worker/wrangler.toml` has no cron trigger (Verified, V13) and no Neon binding. `docs/PLATFORM_COMPATIBILITY.md` line 17 says hosted is not tested. | A deployment run on Cloudflare Workers and Neon Free, including Neon migrations and spatial and vector queries (`docs/PLATFORM_COMPATIBILITY.md` line 111). | Verified (V13 for cron); rest Reported |
| Tested restoration or deterministic rebuild | Partly | Local restore: `tools/live-db-restore.ts` with `tools/live-db-restore.test.ts` (11 cases), in the CI tools step. PGlite copy and swap only. Rebuild inputs: migrations test and fixture pipeline. | No rehearsal artefact with recovery point, recovery time or tombstone behaviour. No Neon-side restore. | Reported |
| Free off-provider backup and deletion-replay test (condition for any live-source launch) | Not met | `docs/PLATFORM_COMPATIBILITY.md` line 17 (not implemented or rehearsed). Line 57 (Neon Free: 6 hours, 1 GB, one manual snapshot, no scheduled backups). `docs/decisions/ADR-010-cloudflare-neon-free.md` line 60 (open). No deletion-replay code. | Backup destination, encryption, rehearsal and deletion replay. Decision (a). If local live mode is a live-source launch, this condition is breached now (Reported). | Reported |
| Model accuracy thresholds set in M1/M3 | Not met | No threshold in code or docs. `docs/decisions/README.md` line 21 refers to ADR-009, and the file does not exist (Verified, V12). `tools/evaluation/casebook.ts` lines 603-624 check counts and coverage only. | Threshold values by category, source and model role, set from a labelled baseline. The ADR-009 file. | Verified (V12); rest Reported |
| Area checks (data and model, retrieval, orchestration, publication, application, operations) | Partly | Publication and orchestration partly tested. Retrieval labels retracted evidence rather than dropping it (`apps/db/test/evidence-retrieval.test.ts` lines 318-326). Operations: no cron (Verified, V13), no connection or disk-limit test, no restore rehearsal. | recall@k and merge and split precision and recall need a labelled set. Operations rehearsal. | Verified (V13 for cron); rest Reported |
| Outage must not fabricate freshness or safety | Partly | ST-F-14 is Partial. RES-03 and WRK-02 are Blocked because no expired live event exists in the feed. | Expiry does not run in deployment. No outage run. | Reported |

## Gaps by requirement

Each subsection gives the clause count, then the Contradicted and Not covered clauses in a table (or "None."), then up to three of the most important Partly gaps. Counts are from the scratch reports. Register statuses are in the Summary.

### FR-01 source registry and approval (withdrawn 13 Nov 2026; SOFTWARE_DEVELOPMENT_PLAN.md line 186)

Withdrawn by owner decision on 13 Nov 2026. The SDP keeps the ID with the note "Withdrawn". The text below is the assessment as it stood before the withdrawal, kept as a record. The rights question it covered is not closed: see FR-16 and the owner decisions list.

Count: 4 clauses. Covered 0, Partly 3, Not covered 0, Contradicted 1.

| Clause | Verdict | Evidence | What is missing | Basis |
| --- | --- | --- | --- | --- |
| 3. Same rule in local_relaxed mode (the mode serve:live runs) | Contradicted | `tools/serve-live-pipeline.ts` line 298; `apps/worker/test/merge-review-gate.test.ts` lines 157-165; ADR-061 amendment at `docs/decisions/ADR-061-agent-driven-publication.md` line 70 | The waiver skips the public-display check for every source. Approval is set by seed code (lines 255-262), not by a recorded review. | Verified (V4); ADR line Reported |

- The real permission check (`apps/worker/src/index.ts` lines 115-150) is never exercised by a test. The permission input is a stub at `apps/worker/test/merge-review-publication.test.ts` line 99. Reported.
- The registry-row-to-decision composition is untested (`apps/worker/src/index.ts` lines 256-294 and 480). Reported.
- Health is written by L1 and read by no gate. Remit is read only by the manual path (publication-policy.ts line 481). Reported.

### FR-02 acquisition and deduplication (SOFTWARE_DEVELOPMENT_PLAN.md line 187)

Count: 6 clauses. Covered 1, Partly 3, Not covered 1, Contradicted 1.

| Clause | Verdict | Evidence | What is missing | Basis |
| --- | --- | --- | --- | --- |
| 6. Moderator-submitted acquisitions enter the same pipeline | Not covered | Only synthetic moderator_submission jobs (`apps/db/test/queue.test.ts` line 137; `apps/worker/test/synthetic-fixture-pipeline.test.ts`). No live moderator submission route exists in `apps/worker/src`. | The live path is not shown. ST-F-11 says manual submissions use the same path, which is not shown for live. | Reported |
| 9. A redelivered identical webhook push creates no duplicate work | Contradicted | `apps/worker/src/layers/l1-data-knowledge/webhook-ingest.ts` line 279 hashes event.timestamp or nowIso, so an event without a timestamp gets a new revision ID on each delivery. | No test sends the same push twice. | Reported |

- The three live pollers are tested per poller only. The composition that runs all three in serve:live is not run (CLAUDE.md; integration.md section 7.6). Reported.
- Identical content from two sources is not deduplicated by hash. The exact normalised title test covers RSS only (`apps/worker/test/news-ai-call-profile.test.ts` line 405). Rewritten copies pass as new work. Reported.
- The webhook path has no PGlite test and no duplicate-delivery test (`apps/worker/test/webhook-ingest.test.ts` lines 173 and 233). Reported.

### FR-03 immutable text and distinct times (SOFTWARE_DEVELOPMENT_PLAN.md line 188)

Count: 8 clauses. Covered 2, Partly 2, Not covered 0, Contradicted 4.

| Clause | Verdict | Evidence | What is missing | Basis |
| --- | --- | --- | --- | --- |
| 13. Event time stays distinct from publication and validity, not replaced | Contradicted | `apps/worker/src/layers/l4-application-integration/public-read-model.ts` lines 646-648: with no event time, eventStart = proposed_at, precision exact. `apps/worker/src/layers/l1-data-knowledge/webhook-ingest.ts` lines 428-429: retrieved_at is used as event time, precision unknown (Reported). | Moderator approval has no time check (`apps/worker/src/layers/l4-application-integration/publication-policy.ts` lines 757-760, Reported). Webhook events without a timestamp are affected. No test covers a missing value. | Verified (V5) for public-read-model; webhook Reported |
| 14. Publication time stays distinct from proposal time | Contradicted | `apps/worker/src/layers/l4-application-integration/public-read-model.ts` line 685 sets publishedAt = proposed_at or now. Line 750 sets published_at. | The public detail's published_at is the proposal time. The stored event_versions.published_at is the decision time (Reported). The two disagree and no test compares them. | Verified (V5) for lines; comparison Reported |
| 15. Validity time distinct and not invented | Contradicted | `apps/worker/src/layers/l4-application-integration/public-read-model.ts` line 739 sets valid_from = eventStart or publishedAt. Line 729 sets freshness evaluated_at = publishedAt. | The CAP times are kept apart at parser level only (`apps/worker/test/bmkg-cap.test.ts` line 217). | Verified (V5) |
| 18. Times are never invented | Contradicted | `apps/intelligence/src/workflows/incident-intelligence-workflow.ts` line 459: firstObservedAt = event time, else publishedAt, else now. The public read model invents the event start at `apps/worker/src/layers/l4-application-integration/public-read-model.ts` lines 646-648 and the validity start at line 739 (Verified, V5). `apps/worker/src/layers/l1-data-knowledge/webhook-ingest.ts` lines 428-429. | `apps/worker/test/webhook-ingest.test.ts` has no event_time assertion. firstObservedAt reaches candidate data (`apps/intelligence/src/services/semantic-retrieval-service.ts` line 291). | Verified (V5) for public-read-model lines; rest Reported |

- The three-time store (observation, publisher-observed and retrieval times) has no runtime writer, so the three-time record never exists in a live run (`apps/db/src/ports.ts`). Reported (clause 16).
- Live claims carry a chunk ID and a quote only. No offset reaches the claim (`apps/intelligence/src/workflows/incident-intelligence-workflow.ts` lines 490-493). Reported (clause 12).

### FR-04 extraction (SOFTWARE_DEVELOPMENT_PLAN.md line 189)

Count: 10 clauses. Covered 0, Partly 6, Not covered 3, Contradicted 1.

| Clause | Verdict | Evidence | What is missing | Basis |
| --- | --- | --- | --- | --- |
| 20. Place extracted with its precision (qualifier) kept | Contradicted | `apps/intelligence/src/workflows/incident-intelligence-workflow.ts` lines 575-590 keep the label and coordinates, not location.precision. `apps/worker/src/layers/l4-application-integration/public-read-model.ts` line 679 publishes each pair as a Point with precision_m 50. | The model's district, corridor or unknown never reaches the public record. Precision is invented. | Reported |
| 21. Audience extracted | Not covered | ReportInterpretationSchema has no audience field (`apps/intelligence/src/agents/report-interpretation-agent.ts` lines 40-70). | Audience exists only in the DB contract, which is not on the live path. | Reported |
| 23. Each evidence quote is verbatim in its chunk | Not covered | `apps/intelligence/src/agents/report-interpretation-agent.ts` lines 167-169 parse only. `apps/intelligence/src/agents/incident-correlation-agent.ts` lines 111-117 check correlation quotes only. | Interpretation quotes are unchecked in code and tests. The mock test shows the mock is verbatim, not that the code enforces it. | Reported |
| 28. Conflicting statements inside one report kept | Not covered | The field exists (`apps/intelligence/src/agents/report-interpretation-agent.ts` line 68). | No reader in the workflow. The field is dropped before the proposal. | Reported |

- A live time range has no end. The proposal keeps precision and value only, while schema 2.0 requires start and end (`apps/db/src/event-proposals.ts` lines 343-366). Reported (clause 22).
- No code sets a revision to quarantined. A malformed result stays unreviewed and retrievable (`apps/intelligence/src/job-runner.ts` lines 62-65). Reported (clause 25).
- The gate reads no uncertainty field, so an uncertain interpretation is not routed (`apps/worker/src/layers/l4-application-integration/publication-policy.ts` lines 767-804). Reported (clause 26).

### FR-05 retrieval (SOFTWARE_DEVELOPMENT_PLAN.md line 190)

Count: 9 clauses. Covered 2, Partly 5, Not covered 1, Contradicted 1.

| Clause | Verdict | Evidence | What is missing | Basis |
| --- | --- | --- | --- | --- |
| 34. Contradictory evidence retrieved | Contradicted | DB: `apps/db/test/evidence-retrieval.test.ts` lines 102-122 and 311-341 (genuine contradicts fixtures). Live: `apps/intelligence/src/services/semantic-retrieval-service.ts` line 330 sets relation "supports" for every candidate. | The live path cannot return contrary evidence. Contradictions come only from model output. | Reported |
| 36a. Retracted or superseded revisions do not return as evidence | Not covered | The live query joins report_revisions and filters on embedding_runs status and incident status (`apps/intelligence/src/services/semantic-retrieval-service.ts` lines 242-244). rev.revision_status is never checked. The DB test at `apps/db/test/evidence-retrieval.test.ts` line 898 is DB only. | No runtime writer sets a retraction. | Reported |

- Live retrieval sends empty identifiers and exactTerms (`apps/intelligence/src/services/semantic-retrieval-service.ts` lines 360-362). Reported (clause 29).
- Spatial and time facets are OR-combined, and the time facet is a flag, not a filter (`apps/db/test/evidence-retrieval.test.ts` lines 473-493, line 480). Live geometryMatches is empty (`apps/intelligence/src/services/semantic-retrieval-service.ts` line 358). Reported (clauses 30 and 31).
- Retrieval runs before reasoning, but no runtime path calls L3 (Verified, V9; clause 35).

### FR-06 matching and origins (SOFTWARE_DEVELOPMENT_PLAN.md line 191)

Count: 7 clauses. Covered 1, Partly 3, Not covered 2, Contradicted 1.

| Clause | Verdict | Evidence | What is missing | Basis |
| --- | --- | --- | --- | --- |
| 38. Live matches checked for spatial and time compatibility | Not covered | Candidates pass a cosine threshold of 0.6 (`apps/intelligence/src/workflows/incident-intelligence-workflow.ts` line 326), then the model decides. `apps/intelligence/src/services/semantic-retrieval-service.ts` lines 357-364 set geometry and event time to unknown. | No deterministic check. No live test for nearby distinct incidents. | Reported |
| 39. Independent origins tracked per claim | Not covered | The live writer inserts claims and evidence only (`apps/db/src/event-proposal-writer.ts` lines 266-320). No proposal_claim_origins insert on the live path. | No live origin rows. DB validators are tested only. | Reported |
| 41. Syndicated copies from different outlets do not add to corroboration | Contradicted | `apps/worker/src/layers/l4-application-integration/proposal-publication.ts` lines 139-146 count distinct source_id or outlet. `apps/worker/src/layers/l4-application-integration/public-read-model.ts` line 596 and `apps/intelligence/src/workflows/incident-intelligence-workflow.ts` lines 566-568 say copies count once, which holds for one outlet only. `apps/worker/test/gated-rss-revision-identity.test.ts` line 360 keeps identical URLs from two sources as distinct revisions. | No live test of an identical copy across outlets. Exact normalised titles across feeds are dropped at Stage A (`apps/worker/test/news-ai-call-profile.test.ts` line 405), which covers one case only. | Reported |

- A same_incident with uncertainty entries auto-publishes, because the gate reads no uncertainty field. Candidates below 0.6 become new incidents without review (`apps/intelligence/test/ai-call-profile.test.ts` line 156). Reported (clause 42).
- Same-outlet copies: the tests use near-duplicate citizen reports, not copies (`apps/worker/test/multisource-correlator.test.ts` lines 219, 239 and 258). The exact-hash branch is in code only. Reported (clause 40).
- Nearby distinct incidents are separated on live only by the model's judgement. Worker tests cover this (`apps/worker/test/multisource-correlator.test.ts` lines 289, 309 and 328). Reported (clause 43).

### FR-07 investigation (SOFTWARE_DEVELOPMENT_PLAN.md line 192)

Count: 9 clauses. Covered 4, Partly 4, Not covered 1, Contradicted 0.

| Clause | Verdict | Evidence | What is missing | Basis |
| --- | --- | --- | --- | --- |
| 49. Escalation reaches a person | Not covered | The coordinator sets awaiting_moderator and stopped_for_review (`apps/worker/src/layers/l3-investigation`). The test "escalates" asserts review_required only (`apps/worker/test/l3-investigation-coordinator.test.ts` line 759). | No code outside L3, the ledger and telemetry reads these states (import side verified, V9). No moderator view. | Reported; V9 |

- Sufficient evidence bypasses investigation at module level only. No runtime path reaches L3 (`apps/worker/test/l3-investigation-coordinator.test.ts` line 59). Reported (clause 44; V9).
- The live intelligence path creates no case. The case test at `apps/db/test/investigation-ledger.test.ts` line 1840 is DB level only. Reported (clause 45; V9).
- The budget stop test uses a stub planner that returns budget_exhausted, not a real ledger refusal (`apps/worker/test/l3-investigation-coordinator.test.ts` lines 415-436). Reported (clause 48).

### FR-08 publication gate (SOFTWARE_DEVELOPMENT_PLAN.md line 193)

Count: 14 clauses. Covered 2, Partly 5, Not covered 3, Contradicted 4.

| Clause | Verdict | Evidence | What is missing | Basis |
| --- | --- | --- | --- | --- |
| 53. One gate for auto and moderator decisions | Contradicted | One entry point, decideProposal (`apps/worker/src/layers/l4-application-integration/proposal-publication.ts` line 177). The auto action runs evaluateAutoPublication (line 225). The moderator action runs assessProposalSourceGate (line 229). The complete gate, assessPublicationPolicy (`apps/worker/src/layers/l4-application-integration/publication-policy.ts` line 191) and createManualPublicationService (`apps/worker/src/layers/l4-application-integration/manual-publication-service.ts` lines 96 and 142), has no non-test importer. | Two check sets. Neither checks evidence, remit, freshness or concurrency on the runtime path. | Reported |
| 54. Each claim supported by a quote from the source | Contradicted | `apps/worker/src/layers/l4-application-integration/publication-policy.ts` lines 737-738 check support_assessment and a non-empty quote_text. `apps/intelligence/src/workflows/incident-intelligence-workflow.ts` line 491 sets support_assessment supported for every model item. The quote is unchecked (`apps/intelligence/src/agents/report-interpretation-agent.ts` lines 167-169). | The model's own output is the proof. CLAUDE.md says L4 must not treat model output as proof. | Reported |
| 55. Scope: remit in scope; location and geometry supported | Contradicted | The auto gate checks only that location text or two coordinates exist (`apps/worker/src/layers/l4-application-integration/publication-policy.ts` line 797). No Jakarta envelope check. The moderator gate checks neither (lines 757-760). Remit is checked only in the unwired policy (lines 481-482). The public point is stamped precision_m 50 (`apps/worker/src/layers/l4-application-integration/public-read-model.ts` line 679). | Invented precision. No scope check on the runtime path. | Reported |
| 57. Freshness checked at publication | Contradicted | No freshness check in the gate (`apps/worker/src/layers/l4-application-integration/publication-policy.ts` lines 767-804). The public detail sets freshness current with evaluated_at = proposal time (`apps/worker/src/layers/l4-application-integration/public-read-model.ts` lines 728-731). | The freshness check in assessPublicationPolicy (lines 484-486) is unwired. | Verified (V5 lines); rest Reported |
| 53b. Moderator corrections use the same gate | Not covered | No correction route in moderation-api.ts, index.ts or apps/web/src. submit_correction appears in the authorisation vocabulary only (`apps/worker/src/layers/l4-application-integration/moderator-authorization.ts` lines 5 and 113). | A correction reaches the gate only as a moderator publish of a new proposal version. | Reported |
| 58. Concurrency: a stale proposal cannot overwrite a newer event; duplicate decisions refused | Not covered | `apps/worker/src/layers/l4-application-integration/proposal-publication.ts` lines 177-239 have no proposed_at or expected-version check. Version = count + 1 (line 239). No lock. ADR-061 (line 49) accepts the race locally and requires an advisory lock for hosted use. | No runtime concurrency or staleness test. | Reported |
| 64. Replay or stale version gets a conflict response | Not covered | `apps/worker/test/moderation-api.test.ts` line 634 uses a stub publisher returning conflict (`apps/worker/src/layers/l4-application-integration/moderation-api.ts` lines 808-815). decideProposal never returns conflict (`apps/worker/src/layers/l4-application-integration/proposal-publication.ts` lines 63-78). | ST-F-03 steps 6 and 7 are not shown for the runtime. | Reported |

- Model output refused at the gate: no negative test where an unsupported quote, missing place or missing time is refused through the gate. The mock tests reach the gate only as queued (`apps/intelligence/test/merge-review.test.ts` lines 104-142). Reported (clause 60).
- Models cannot publish: no DB-role test covers the intelligence connection. The intelligence worker reads DATABASE_URL (`apps/intelligence/src/worker.ts` line 37). Reported (clause 59).
- A queued outcome returns before any decision audit write (`apps/worker/src/layers/l4-application-integration/proposal-publication.ts` lines 225-226). Reported (clause 63).

### FR-09 geometry display (SOFTWARE_DEVELOPMENT_PLAN.md line 194)

Count: 6 clauses. Covered 2, Partly 1, Not covered 2, Contradicted 1.

| Clause | Verdict | Evidence | What is missing | Basis |
| --- | --- | --- | --- | --- |
| C2b. Points and geometry shown on the record page | Contradicted | Verified: `apps/web/src/EventDetail.tsx` line 328 renders MapPanel with only selection and onReturnToList. `apps/web/src/MapPanel.tsx` line 165 sets legacyScreen. Lines 252-256 print "Tidak dipetakan. Record API ini tidak menyertakan geometri" for every api-event. The #peta sheet uses the same body (`apps/web/src/MapHome.tsx` lines 404-420; `apps/web/src/EventDetail.tsx` line 359). `apps/web/test/smoke-local.tsx` line 120 asserts the false sentence. Record geometries are populated (`apps/worker/test/l4-public-geometry-projection.test.ts` lines 217-230, Reported). | A test with a mapped record on #detail/api/ or in the sheet. Then fix the wording or the prop wiring. Proposed as F-13. | Verified (V3; sheet by code reading); rest Reported |
| C3. Source-defined polygons drawn | Not covered | `apps/web/src/published-events.ts` line 143 drops every non-Point feature. Polygon drawing is at `apps/web/src/MapPanel.tsx` lines 109-113, reached only through EventFeed. EventFeed is unmounted: App.tsx imports only constants and types from it. Tests on that path (`apps/web/test/geojson-map.test.tsx` lines 196-221) do not show user behaviour. | Any user-reachable polygon, and any test of one. | Reported |
| C4. Road or service segments drawn | Not covered | The LineString branch (`apps/web/src/MapPanel.tsx` lines 103-104) is on the same unmounted path. | Any segment display on a user route. | Reported |

- Non-geographic notices (clause C5) remain in the list ("Belum dipetakan", `apps/web/src/MapEventList.tsx` line 116). No public test uses an event without a marker. The group-notice fixture is admin-only (`apps/web/test/admin-map.test.tsx` lines 254-264). Reported.

### FR-10 public exposure (SOFTWARE_DEVELOPMENT_PLAN.md line 195)

Count: 6 clauses. Covered 0, Partly 6, Not covered 0, Contradicted 0. None.

- Expired wording differs. The card says "Lewat masa berlaku sumber" (`apps/web/src/published-events.ts` line 240, Verified). The record page says "Lewat batas tinjau" (`apps/web/src/display.ts` line 75, Verified). The record page uses review-deadline wording for expired, while CLAUDE.md says expiry is set only by issuer validity. No test pins either string (clause C4; F-10).
- Record-page time: "Waktu kejadian tidak diketahui" (`apps/web/src/display.ts` line 31, Verified) is untested and differs from the card's "Tidak diketahui" (`apps/web/src/published-events.ts` line 173, Reported) (clause C3; F-11).
- Evidence labels: evidenceLabel (`apps/web/src/display.ts` lines 79-91) is asserted by no web test. The record page renders claim sources (`apps/web/src/EventDetail.tsx` lines 305-312) without a web test (clauses C1 and C2). Reported.

### FR-11 preferences and updates (SOFTWARE_DEVELOPMENT_PLAN.md line 196)

Count: 4 clauses. Covered 1, Partly 3, Not covered 0, Contradicted 0. None.

- Removing an interest (clause C3): no end-to-end test. The unit tests use renderToStaticMarkup, and removal takes effect only when "Simpan" is pressed (`apps/web/src/Preferences.tsx` lines 113-116, and about line 306). Reported.
- Repeated coverage (clause C4): the key is event_id:version (`apps/web/src/UpdatesCenter.tsx` lines 480 and 723), so a second version gives a second card. No test asserts one alert per event across versions. Reported.
- Matched updates (clauses C1 and C2) are not shown on live data. The demo gate is at `apps/web/src/BriefingResults.tsx` lines 164-166 and `apps/web/src/UpdatesCenter.tsx` lines 666-668 (F-02). Reported.

### FR-12 moderator authorisation and audit (SOFTWARE_DEVELOPMENT_PLAN.md line 197)

Count: 7 clauses. Covered 2, Partly 2, Not covered 3, Contradicted 0.

| Clause | Verdict | Evidence | What is missing | Basis |
| --- | --- | --- | --- | --- |
| C3. Source approval | Not covered | No route invokes approve_source (`apps/worker/src/layers/l4-application-integration/moderator-authorization.ts` line 7). The #admin/sumber tab is a read-only demo preview (UAT section 6, T5). The policy test is at `apps/worker/test/l4-moderator-authorization.test.ts` lines 33-58 (moderator denied). | Any runtime source-approval action, its route authorisation and its audit. | Reported |
| C4. Corrections | Not covered | The manual correction service (`apps/worker/src/layers/l4-application-integration/manual-publication-service.ts`) is imported by no route. Its test says it registers no route (`apps/worker/test/l4-manual-publication-service.test.ts` line 341). | Route, authorisation and audit for corrections. | Reported |
| C6. Withdrawals | Not covered | retract_information is in the policy only (`apps/worker/src/layers/l4-application-integration/moderator-authorization.ts` line 6). Withdrawn statuses are written only by source-driven transitions (`apps/worker/src/layers/l4-application-integration/source-revision-freshness-transition.ts`), which have no runtime caller. | Any withdrawal action, its route and its audit. | Reported |

- Audit (clause C7): reject writes a row (`apps/worker/src/layers/l4-application-integration/proposal-publication.ts` lines 202-215), but its test never reads it (`apps/worker/test/merge-review-publication.test.ts` lines 215-237). The triage actor is not asserted (`apps/worker/test/moderation-api.test.ts` lines 736 and 753-760). The role-change audit row is not asserted (`apps/worker/test/accounts-api.test.ts` lines 205-236). Reported.
- Merges (clause C5): no merge-specific authorisation test. The route-to-decideProposal wiring (`apps/worker/src/index.ts` lines 262-300) is untested, because the publisher is a mock (`apps/worker/test/moderation-api.test.ts` line 533). Reported.

### FR-13 expiry, retraction and stale updates (SOFTWARE_DEVELOPMENT_PLAN.md line 198)

Count: 5 clauses. Covered 1, Partly 3, Not covered 1, Contradicted 0.

| Clause | Verdict | Evidence | What is missing | Basis |
| --- | --- | --- | --- | --- |
| C5. Jobs are triggered in a running runtime | Not covered | `apps/worker/wrangler.toml` has no [triggers] or cron entry (Verified, V13), so scheduled() never fires in deployment. The freshness due path also needs FRESHNESS_DUE_SCHEDULER_ENABLED and a FRESHNESS_DUE_HYPERDRIVE binding, and neither is configured (`apps/worker/src/runtime/freshness-due-schedule-trigger.ts` lines 16-30, Reported). Local live runs only expireStaleProposals (`tools/serve-live-pipeline.ts` lines 617-635, Reported). | Any scheduled or triggered run of the freshness job, in deployment or in local live. SDP section 10 lists scheduled expiry as required evidence. | Verified (V13); rest Reported |

- Retraction (clause C2): the source-revision-freshness transition has no runtime caller. Module-level tests only (`apps/worker/test/source-revision-freshness-public-projection.test.ts` line 55). Reported.
- Stale observation or a passed review date (clause C3): the DB composition uses NOT_DUE_AT for review dates (`apps/db/test/freshness-due-evaluator-composition.test.ts` lines 127 and 170). A passed review date reaching the public view is not shown end to end. Reported.
- Expiry (clause C1): the proposal TTL expiry (`apps/worker/src/layers/l4-application-integration/proposal-publication.ts` line 354) changes no public view, because undecided proposals are never public. ST-F-10 and IT-B3-04 and IT-B3-05 cite only that. Reported.

### FR-14 trace IDs (SOFTWARE_DEVELOPMENT_PLAN.md line 199)

Count: 7 clauses. Covered 0, Partly 4, Not covered 2, Contradicted 1.

| Clause | Verdict | Evidence | What is missing | Basis |
| --- | --- | --- | --- | --- |
| C5. Trace links investigation (L3) | Contradicted | L3 ledger rows carry trace_id (`apps/db/migrations/008_l3_investigation_ledger.sql` lines 185-214). The telemetry tests assert that the trace ID is kept out of emitted telemetry (`apps/worker/test/l3-investigation-telemetry.test.ts` lines 198 and 423). No L5 source references trace_id (`apps/worker/src/layers/l5-evaluation-monitoring`). | Monitoring output cannot link a run to its trace. Whether the privacy choice is acceptable is an owner decision, to be recorded in the SDP or an ADR, followed by a test that matches it. | Reported |
| C4. Trace links model configuration | Not covered | embedding_runs stores model_version and trace_id (`apps/db/migrations/001_foundation.sql` lines 204-212), but no test links them. The chat model identity (NINEROUTER_CHAT_MODEL, `apps/intelligence/src/providers/ninerouter-adapter.ts` line 32) appears in no trace, job or proposal row (grep of `apps/intelligence/src`). | Any link from a run's trace to the chat model configuration. | Reported |
| C7. One trace ID across all five links | Not covered | ST-F-16 is Partial in the register, but no file names the end-to-end link. `apps/worker/test/pipeline-flow-route.test.ts` and `apps/worker/test/l5-synthetic-poll-process-telemetry.test.ts` contain no trace references. `tools/local-pipeline/processor.test.ts` lines 202-267 cover trace reuse only. | One test that follows a single trace ID through reports, context, model, investigation and decision. | Reported |

- Synthetic fallback: intelligence jobs use job.traceId, then the revision's trace, then a synthetic trace-<jobId> (`apps/intelligence/src/job-runner.ts` line 275). No test asserts that the fallback is never used (clause C1). Reported.
- Proposal link: `apps/intelligence/test/job-worker.test.ts` lines 256-262 (intelligence job-worker test) assert only the job status in the gate-ok case. Line 168 is negative (clause C2). Reported.
- Decision trace: `publication_decisions.trace_id` is written at `apps/worker/src/layers/l4-application-integration/proposal-publication.ts` lines 259-265. The merge-review publication test reads decisions but never asserts trace_id (clause C6). Reported.

### FR-15 demo and live labels (SOFTWARE_DEVELOPMENT_PLAN.md line 200)

Count: 5 clauses. Covered 2, Partly 2, Not covered 1, Contradicted 0.

| Clause | Verdict | Evidence | What is missing | Basis |
| --- | --- | --- | --- | --- |
| C2b. Live empty coverage reads as "no coverage" | Not covered | Live and demo empty states share one title (`apps/web/src/MapEventList.tsx` line 15). No "no coverage" wording exists in web source for the live empty state. ST-F-15 expects it. | Live-specific empty-coverage copy and its test. | Reported |

- Historical label (clause C1c): "Riwayat fixture sintetis" (`apps/web/src/EventDetail.tsx` line 141) and the note "bukan keadaan terkini" (lines 147-148) are untested. The note shows only while history loads. Reported.
- Empty-coverage note: EMPTY_LIST_NOTE ("Hasil kosong tidak berarti tidak ada kejadian.", `apps/web/src/MapEventList.tsx` line 16) is asserted nowhere. The markers-unavailable notice (`apps/web/src/MapHome.tsx` lines 336-342) has no test (clause C2). Reported.
- Live detail wording: a live record shows fixture wording (`apps/web/src/EventDetail.tsx` lines 235 and 245, hard-coded). No test catches it. It is recorded as R-05 in DEFECTS.md section D (open). Reported.

### FR-16 collection by feed, webhook or scraping (SOFTWARE_DEVELOPMENT_PLAN.md line 201)

Added 13 Nov 2026 by owner decision. The clause evaluation used the earlier text and did not assess FR-16. Status from the code, checked by search:

- Feeds and the webhook intake exist and are tested (see IT-B1-06 and the RSS and BMKG rows), so collection by feed and webhook is partly present. Reported in the earlier assessment.
- Scraping of public pages: not present. No file in apps/worker/src, apps/intelligence/src, apps/db/src or tools contains "scrap". Verified.
- robots.txt and stated-terms check: not present. No file in those folders contains "robots". Verified.
- Per-host rate limit and outbound-host allow-list (NFR-07): the registry field `approved_hosts` exists but no fetch path checks it (Reported in the NFR assessment). Redirects are followed by the live RSS poller (V7).
- Fetch records (URL, retrieval time, HTTP status): not assessed.
- Test cases: none in test-cases.csv. The TEST-PLAN rule (each Must requirement has at least one test case) is not met.

### NFR-01 evidence integrity (SOFTWARE_DEVELOPMENT_PLAN.md line 204)

Count: 5 clauses. Covered 0, Partly 3, Not covered 2, Contradicted 0.

| Clause | Verdict | Evidence | What is missing | Basis |
| --- | --- | --- | --- | --- |
| "In release scenarios" | Not covered | Four labelled fictional archetypes (`docs/assignments/INT-01-SYNTHETIC-DEMO-SCENARIO-CORE.md` line 72). No scenario runs through L1 to L4 to public read. INT-01 is in progress (`docs/IMPLEMENTATION_BACKLOG.md` line 237). | A scenario run. | Reported |
| Adjudicated claim, span and geometry checks | Not covered | `tools/evaluation/casebook.ts` lines 603-624 check counts and coverage only. `docs/evaluation/CASEBOOK.md` says metadata_ready is false for the fixture. There is no human adjudication and no reconciled record. | Human adjudication and labelled ground truth. | Reported |

- Unsupported claims: ST-N-01 is synthetic only. The casebook fixture has one case and one report, with no reviews (`docs/evaluation/fixtures/synthetic-casebook.json`). Reported.
- Geometry: points only, with no boundary (F-01) and no radius (F-12). Reported.
- Disputed cases: TI-02 holds for a claim dispute, not for stopped_for_review (F-04). It is not in the cec9358 CI log. Reported.

### NFR-02 resource bounds (SOFTWARE_DEVELOPMENT_PLAN.md line 205)

Count: 7 clauses. Covered 3, Partly 3, Not covered 1, Contradicted 0.

| Clause | Verdict | Evidence | What is missing | Basis |
| --- | --- | --- | --- | --- |
| Live pipeline bounded by the same limits | Not covered | No maxSteps, maxTokens, max_tokens, budget, stepCount or toolCalls term in `apps/intelligence/src` (grep, Verified, V8). No explicit cap was found in the code. The model calls, agent.generate(prompt) at `apps/intelligence/src/agents/incident-correlation-agent.ts` line 274 and `apps/intelligence/src/agents/report-interpretation-agent.ts` line 167, pass no step or token option (Reported). The job cap in `apps/db/migrations/037_ai_incident_intelligence_pipeline.sql` line 11 limits job retries, not tool attempts. The rate gate (`apps/db/src/ninerouter-rate-gate.ts` lines 24-25) paces requests. | No tool-loop, turn, active-second or token counter on the live path. CLAUDE.md says the live path bypasses L2 and L3. Mastra defaults were not inspected. | Verified (V8); rest Reported |

- The five-attempt cap is tested at create time only (`apps/db/src/investigation-ledger.ts` lines 327-332; `apps/db/test/investigation-ledger.test.ts` lines 2034-2039). No run stops at the fifth attempt. The worker executor validates seconds and tokens only (`apps/worker/src/layers/l3-investigation/reasoning-step-executor.ts` lines 621-622). Reported.
- Token cap: provider-reported token usage is not tested end to end against 12,000 (`apps/db/test/investigation-ledger.test.ts` line 2034). Reported.
- Production values: grep of `apps/worker/src` for toolAttempts: 5 and related terms found nothing, so the production defaults were not located (integration.md, Not verified). Reported.

### NFR-03 usability (SOFTWARE_DEVELOPMENT_PLAN.md line 206)

Count: 6 clauses. Covered 0, Partly 4, Not covered 2, Contradicted 0.

| Clause | Verdict | Evidence | What is missing | Basis |
| --- | --- | --- | --- | --- |
| Understandable labels | Not covered | No label-comprehension check. The wording tests pin strings (`apps/web/test/map-popup.test.tsx` lines 79-82). F-10 and F-11 show that wording differs between the card and the detail. | A user test. | Reported |
| US-01 and US-02 on a real phone and desktop, 80% within one minute | Not covered | ST-N-03 is Not evidenced. There are no human sessions (test-cases.csv). UAT runs are browser-agent personas (`docs/testing/UAT.md` line 246). T1 cannot complete step 6 (F-01). | Human sessions with 6 to 8 participants and the 80% target. | Reported |

- Layout on desktop and phone: screenshots only, local, not in CI, with no run record (BR-03, BR-04). These show layout, not usability. Reported.
- List fallback: the card buttons are keyboard reachable (`apps/web/test/map-home.test.tsx` line 159). No phone-width list check was read, and BR-01 and BR-02 are Partial. Reported.
- Keyboard access: static markup assertions only. No keyboard walk-through is recorded (ST-N-03). Reported.

### NFR-04 responsiveness (SOFTWARE_DEVELOPMENT_PLAN.md line 207)

Count: 6 clauses. Covered 0, Partly 2, Not covered 3, Contradicted 1.

| Clause | Verdict | Evidence | What is missing | Basis |
| --- | --- | --- | --- | --- |
| Public reads never wait for source acquisition or model inference | Contradicted (for the opt-in demo routes) | Verified (V6): `apps/worker/src/index.ts` line 522 routes the demo request before any account check. `apps/worker/src/layers/l4-application-integration/context-sources-api.ts` lines 41-42 check only the two flags and the method. Lines 58-59 await runtime.readFetched() for mode=fetch. `apps/worker/wrangler.toml` lines 8-9 set both flags. The source-preview route has the same shape (`docs/DEMO_DATA_INTEGRATION.md` line 31; `apps/worker/src/runtime/source-preview-runtime.ts` line 56). Live event reads contain no fetch (Reported). | The clause is not met for the fetch mode. No test asserts that a public read returns without acquisition. `apps/worker/test/api.test.ts` line 372 covers only the demo model. Decision (d). | Verified (V6) for the context-sources route; rest Reported |
| Cold-start latency reported separately | Not covered | `docs/testing/PERFORMANCE.md` lines 41-46 say cold start is not in this run. | Not measured. | Reported |
| Neon Free scale-to-zero after five idle minutes | Not covered | `docs/PLATFORM_COMPATIBILITY.md` lists the Neon limits. There is no run. | Not measured on Neon. | Reported |
| Measured target set before release | Not covered | `docs/testing/PERFORMANCE.md` line 3 says no target has been set. | A target. | Reported |

- WSL p50 and p95: `docs/testing/PERFORMANCE.md` lines 5-34 give 200 samples at concurrency 1, 10 and 25, over 4 published events. Dataset growth is not shown, and there is no free-tier run. Reported.
- Cold or failed database response: `/api/v1/updates` returned 503 for every sample at every concurrency, so its latency is not valid read evidence (PERFORMANCE.md table). The 503 comes from `apps/worker/src/layers/l4-application-integration/api.ts` line 226. Reported.

### NFR-05 reliability (SOFTWARE_DEVELOPMENT_PLAN.md line 208)

Count: 4 clauses. Covered 3, Partly 1, Not covered 0, Contradicted 0. None.

- Retries do not duplicate notifications (Partly): the replay and terminal-notice tests exist (`apps/db/test/publication-outbox-delivery.test.ts` lines 54, 173 and 300). No end-user notification channel exists, and the update feed is tested at file level only (ST-F-02). Reported.
- The intelligence notify path has no dedupe test (`apps/intelligence/src/job-runner.ts` line 312). Reported.

### NFR-06 recoverability (SOFTWARE_DEVELOPMENT_PLAN.md line 209)

Count: 6 clauses. Covered 2, Partly 1, Not covered 3, Contradicted 0.

| Clause | Verdict | Evidence | What is missing | Basis |
| --- | --- | --- | --- | --- |
| WSL restore or rebuild rehearsal, with recovery point and time recorded | Not covered | ST-N-06. `docs/PLATFORM_COMPATIBILITY.md` line 17 says it is not implemented or rehearsed. | A rehearsal artefact. | Reported |
| Deletion-tombstone behaviour recorded | Not covered | No deletion or replay code. The "tombstone" at `apps/db/src/evidence-chunks.ts` lines 122-132 is chunk invalidation, not deletion. | Implementation. | Reported |
| Free encrypted off-provider backup selected and rehearsed before live data | Not covered | `docs/PLATFORM_COMPATIBILITY.md` line 17. `docs/decisions/ADR-010-cloudflare-neon-free.md` line 60 (backup mechanism open). No backup creation code. `tools/serve-live-pipeline.ts` lines 111-116 only restore from an existing backup. | Backup destination, encryption and rehearsal. See decision (a). | Reported |

- Demo rebuild: migrations 001 to 047 and the fixtures exist, but there is no single rebuild command and no rebuild run is recorded (ST-N-06; `apps/db/test/synthetic-fixture-pipeline.test.ts`). Reported.
- The migration list is hard-coded at `apps/db/test/migrations.test.ts` line 177, so each migration edits the test (CLAUDE.md). Reported.

### NFR-07 privacy and security (SOFTWARE_DEVELOPMENT_PLAN.md line 210)

Count: 8 clauses. Covered 1, Partly 6, Not covered 1, Contradicted 0.

| Clause | Verdict | Evidence | What is missing | Basis |
| --- | --- | --- | --- | --- |
| Retention checks | Not covered | Only session and login-attempt cleanup (`apps/db/src/accounts.ts` lines 532-556). Source-content retention flags exist (`apps/worker/src/layers/l1-data-knowledge/news-triage.ts` lines 95-97), but there is no retention job or test. | Retention and deletion tests (ST-N-07 names this as missing). | Reported |

- Approved outbound hosts (Partly): the approved_hosts registry (`apps/db/migrations/001_foundation.sql` line 48) is read only into a type (`apps/db/src/ports.ts` lines 36 and 467). No fetch path checks it, and no test refuses an unapproved host. Reported.
- Redirects (Partly): the live news poller follows redirects (`apps/worker/src/runtime/news-poll-runtime.ts` line 835, Verified, V7). The BMKG and PetaBencana pollers do the same (Reported: `apps/worker/src/runtime/bmkg-poll-runtime.ts` lines 178-185 and 202; `apps/worker/src/runtime/petabencana-poll-runtime.ts` lines 240-246). No live redirect test exists.
- Input isolation (Partly): no malicious-source fixture runs through L1 to L4, and there is no penetration test. `apps/worker/test/news-triage.test.ts` line 380 covers hostile instructions yielding an uncertain result. Reported.

### NFR-08 maintainability (SOFTWARE_DEVELOPMENT_PLAN.md line 211)

Count: 8 clauses. Covered 2, Partly 4, Not covered 1, Contradicted 1.

| Clause | Verdict | Evidence | What is missing | Basis |
| --- | --- | --- | --- | --- |
| Layer responsibilities explicit | Contradicted | `apps/worker/src/layers/l1-data-knowledge/webhook-ingest.ts` lines 21-24 import the L2 proposal engines and the L4 broadcaster (Verified, V11, lines 23 and 24). CLAUDE.md allows L1 one fixed L2 adapter. The live intelligence app bypasses L2 and L3 by design (CLAUDE.md). F-03. | No import-boundary test. No lint or dependency-cruiser configuration in apps or tools. | Verified (V11); rest Reported |
| Reviewed contract changes | Not covered | No review record was found for contract changes. | Process evidence. | Reported |

- Versioned interfaces (Partly): `docs/contracts.schema.json` is referenced by one test. `docs/api/openapi.yaml` is referenced by no test, and routes listed there may not be registered (CLAUDE.md). Reported.
- Reproducible builds (Partly): the build is typecheck, Vite and wrangler deploy --dry-run (`apps/worker/package.json` line 15). No artefact has been reproduced on a second machine. Reported.
- WSL run instructions (Partly): CLAUDE.md says Ubuntu-26.04. `DOKUMENTASI_UNIT_TESTING.md` line 268 says Ubuntu 24.04. CI runs ubuntu-24.04 with Node 24 (`.github/workflows/ci.yml` lines 11 and 19), while CLAUDE.md says Node 22 (F-08). Owner to confirm. Reported.

## New defects proposed for DEFECTS.md

DEFECTS.md uses F-01 to F-12 for open findings, D-01 and D-02 for fixed defects, and R-01 to R-08 for run defects. The IDs below are proposed and not assigned. Nothing was written to DEFECTS.md.

- F-13 (proposed): the record page and the #peta sheet say that an API record has no geometry, for every record. Evidence: V3 (Verified by code reading, as in the release table above). Affects ST-F-01 and FR-09 clause C2b, and makes the detail-page message untested. The brief calls this a defect. Under DEFECTS.md section B, an open finding stays open until the owner decides and a fix commit exists, so it is listed as a finding here. Not seen in a browser.
- F-14 (proposed): proposal processing time is used as the public event time, and freshness is set to current by construction. A second copy of the rule is in `rawInputToEventDetail` (public-read-model.ts lines 806-838, called at line 132). Evidence: V5 (Verified, lines 646-648, 685, 728-731, 739 and 750 of public-read-model.ts). It conflicts with two CLAUDE.md invariants: "Keep event, issuer, acquisition and processing times distinct, and never invent a timestamp", and "Expiry, missing reports or an unavailable source never prove resolution or safety". Reachability on the live path was not run. Owner to confirm the time rule before any change (decision (f)).
- F-15 (proposed, CI item, tied to decision (e)): the worker and web test scripts on main join four test paths (V1; `apps/worker/package.json` line 17; `apps/web/package.json` line 10; commit 6e8a59e). The fix is on the branch in 85b8d57 and ab862c3 and is not merged. Once merged, it moves to section A as a D-nn entry, because section A records faults with a fix commit.

Corrections to DEFECTS.md for the owner to apply (not applied here):

- F-01 and F-02 say T1 and T2 are Blocked in the CSV. Both are Partial (Verified, test-cases.csv).
- F-10 cites published-events.ts line 216. The string is at line 240 (Verified).
- The display.ts "Lewat batas tinjau" string is at line 75, not 76 (Verified).
- R-05 and R-06 are labelled "Open, confirmed defect". Section A defines a defect as a fault with a fix commit, so these need a label change or a decision (Verified, DEFECTS.md lines 8-9 and 123-124).

## Decisions for the owner

- (a) Whether local live mode is a live-source launch. This decides whether the free off-provider backup and deletion-replay condition (SDP section 10) is already breached. `serve:live` polls PetaBencana, BMKG and 14 RSS feeds every 60 s (CLAUDE.md).
- (b) F-01: draw a boundary on #peta, or change the US-01 and FR-09 wording (US-01 at SOFTWARE_DEVELOPMENT_PLAN.md lines 143 to 145, Reported; FR-09 at line 194, Verified). Affects FR-09 clauses C3 and C4.
- (c) F-04: should the L4 gate refuse proposals whose investigation is stopped_for_review, with a new reason code? Or is the claim-level hold the intended control? Record the answer in the plan or an ADR. Affects TI-02, IT-B3-01 and NFR-01.
- (d) Whether the demo fetch flag stays on in `apps/worker/wrangler.toml` (lines 8 and 9) (V6). The options are to turn the flags off for the deployed Worker, or to require a session or role for mode=fetch. No specific fix is recommended here. Affects NFR-04 and the source-preview route.
- (e) Whether to accept the V1 fix on main. The fix is on the branch (85b8d57 and ab862c3). Until it is merged, four test files are not run from main, and the CI outcome for 6e8a59e is not confirmed.
- (f) F-14: confirm the time rule before any change. Affects FR-03 clauses 13 to 15 and 18, FR-08 clause 57, and the freshness of every public record.
- (g) The non-gating perf CI job, which is still open. The only workflow file is `.github/workflows/ci.yml`. Grep for perf, performance, latency, p50 and p95 in `.github/workflows/` returned nothing (this report). No design record for the job was found in the inputs.

## Not verified

Items specific to requirement clauses. The full merged list of the five reports' not-verified items is in TEST-EVALUATION.md.

- No test, build, model call, network call or live run was made. Runtime-wiring statements come from grep of non-test importers. serve:live was not run (fr-01-08.md, fr-09-15.md, nfr-release.md).
- Dynamic imports were not searched for. A dynamically loaded L3 or manual-gate module would change FR-05 clause 35, FR-07, and FR-08 clauses 53 and 53a (fr-01-08.md).
- Deployment database roles were not inspected. The least-privilege point in FR-08 clause 59 is open (fr-01-08.md).
- The concurrency verdicts (FR-08 clauses 58 and 64) come from code reading. No race was reproduced (fr-01-08.md; nfr-release.md).
- Copies and repeat coverage: whether an intelligence merge creates a new version of an existing event for each new source was not traced. distinctPublisherCount has no test in apps/intelligence/test (fr-09-15.md).
- Lifecycle on the live path (FR-13 clause C4): the in-memory read model defaults to ongoing (`apps/worker/src/layers/l4-application-integration/public-read-model.ts` line 825), and the source of the live DTO was not traced (fr-09-15.md).
- Decision race: publication_decisions has no unique index on (dataset_kind, proposal_id) (`apps/worker/src/layers/l4-application-integration/proposal-publication.ts` lines 105-106). ADR-061 accepts the race. It was not tested (fr-09-15.md).
- Rendered labels and freshness strings were read from source. No render was run (fr-09-15.md, FR-10).
- Moderator web pages: ModeratorReview.tsx was checked for imports only (fr-09-15.md).
- Audit for reads is treated as not required. The owner should confirm (fr-09-15.md, FR-12).
- The expired label on the admin dashboard (`apps/web/src/AdminDashboard.tsx` line 393) is not separately tested (fr-09-15.md).
- The public "N sumber" and "Dilaporkan oleh N media" wording was checked by grep only (fr-01-08.md).
- Source rights (SOURCE_CLEARANCE_PLAN.md) were not read. CLAUDE.md says BMKG and ANTARA need permission. This was not checked against the seeds (fr-01-08.md).
- Model accuracy: grep found no human-labelled set and no recall or precision result. The targeted search was used because a repository-wide scan timed out (fr-01-08.md).
- Clause verdicts rest on test names, grep and selected reads, not line-by-line reading. Some Covered verdicts may move on a full read (nfr-release.md section 5; fr-01-08.md).
- Mastra default step limits in node_modules were not inspected (nfr-release.md section 5).
- PBKDF2 CPU cost on Workers Free is unmeasured, password reset is absent, and Neon role membership for migration 047 is unverified (nfr-release.md section 5; CLAUDE.md).
- Secrets: .env.local and .dev.vars were not read (fr-01-08.md; nfr-release.md).
- Intelligence tests (job-worker, merge-review, workflow, semantic-retrieval) were checked by title and imports only (integration.md).
