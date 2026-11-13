# System test specification

Document: SYSTEM-TEST. Status: draft for review, 13 November 2026. Backs report Chapter 5, section 5.4 (system testing, Braude ch. 28).

Sources: requirements in `SOFTWARE_DEVELOPMENT_PLAN.md` (SDP) §2, §4 and §10; use cases in `docs/report/diagrams/fig-3-2-use-case.puml`; task flows in `docs/UX_API_SPEC.md` §5; master plan in `docs/testing/TEST-PLAN.md`; acceptance walkthroughs in `docs/testing/UAT.md` (being written; not yet in the repository).

This document specifies tests. It records no run results. The Status column states whether evidence exists now, not whether a test has passed. Run results go to `docs/testing/test-cases.csv` (TEST-PLAN §13).

Status key:
- **Evidence exists**: a test file with a matching name exists under `apps/*/test` and is listed in its package test script, so CI runs it.
- **Partial**: some expected results have no matching file, the evidence is local only, or a limit in the design is not covered.
- **Not evidenced**: no test file, run record or measurement was found.

## 1. Scope

- **In scope.** Local live mode (`npm run serve:live`; LIVE-LOCAL-01, accepted as local live mode on 8 Nov 2026, `docs/IMPLEMENTATION_BACKLOG.md`). The synthetic demo (`DATASET_MODE=demo`), labelled as demo in every view. Through these modes: the public web app (`apps/web`), the Worker API (`apps/worker`), the database (`apps/db`) and the intelligence poller (`apps/intelligence`).
- **Out of scope, marked not tested.** Hosted Cloudflare Workers and Neon Free. Hosted use remains gated (CLAUDE.md; `docs/PLATFORM_COMPATIBILITY.md`). The Android reader (`apps/mobile`) is out of scope for device tests; its Flutter analysis and test results are local evidence only (`.codex-build/ci-logs/cec9358/SUMMARY.md`).
- **Requirement baseline.** SDP §4: FR-01 to FR-15 and NFR-01 to NFR-08. User stories come from SDP §2 and verification areas from SDP §10.
- **Documentation conflict.** SDP §3.1 describes the first prototype's moderator view as read-only, with no sign-in, and defers correction and publication to a later authenticated release. The implemented system has password accounts (ADR-060, `docs/decisions/ADR-060-password-accounts.md`) and authenticated moderation (`apps/worker/test/moderation-api.test.ts`). This specification tests the implemented behaviour against the SDP §4 requirements. The root planner should reconcile SDP §3.1. This document does not change the SDP.

## 2. Test environment and who runs the tests

| Item | Setting | Source |
| --- | --- | --- |
| Platform | WSL Ubuntu-26.04, repository at `/mnt/d/Projects/RPL` | CLAUDE.md, Environment |
| Toolchain | Node v24.21.0 and npm 11.19.0 locally; CI uses Node 24 | CLAUDE.md; `.github/workflows/ci.yml` line 19 |
| Automated runs | Typecheck and changed test files locally; full suites on GitHub Actions | CLAUDE.md, local test policy (12 Nov 2026) |
| Browser checks | Headless Chromium in WSL, at the viewports in §5 | `docs/assignments/UX-WEB-02-SIMPLIFY-HANDOFF.md` |
| Demo data | Synthetic fixtures with `DATASET_MODE=demo` | `docs/testing/TEST-PLAN.md` §5 |
| Live data | `serve:live` with persistent PGlite at `.data/live-db`. Real feeds and model calls run only under explicit, bounded authorisation | CLAUDE.md, Commands |

**Who runs the tests.** The implementer of a component writes and runs its unit and integration tests. A reviewer who did not implement the component under test runs the system tests in this document and signs the run record (`docs/testing/TEST-PLAN.md` §7). No reviewer is named in the repository yet. The team has three members, so independence is partial. §7 records this.

**Automated baseline.** The CI log for commit `cec9358` (run 117086838832) records: typecheck with no error lines; database 381 of 381 tests passing across 56 files; web 335 of 335; worker 1,089 of 1,089; intelligence 104 of 104; pipeline 58 of 58 cases; accounts 3 of 3; evaluation and AI tools 64 of 64; Wrangler dry-run build completed (`.codex-build/ci-logs/cec9358/SUMMARY.md`). These counts are a baseline. They are not evidence for any test in §3 to §6.

**Evidence rule.** Test evidence is cited by file name. Each cited file exists on 13 Nov 2026. Every worker and web test file is listed in its package `test` script (`apps/worker/package.json`, `apps/web/package.json`; TEST-LIST-01). The assertions have not yet been read against each expected result, so the statuses are provisional (§7).

## 3. Functional tests

Mapping from Fig 3.2 use cases: UC1 to ST-F-04; UC2 to ST-F-05; UC3 to ST-F-06; UC4 to ST-F-07; UC5 to ST-F-08; UC6 to ST-F-09; UC7 to ST-F-10; UC8 to ST-F-11 and ST-F-12. Acceptance scenarios from SDP §2: US-01 to ST-F-01; US-02 to ST-F-02; US-03 to ST-F-03. Preconditions assume the demo dataset unless "live" is stated.

| ID | Requirement | Preconditions | Steps | Expected result | Automated evidence | Status |
| --- | --- | --- | --- | --- | --- | --- |
| ST-F-01 | US-01; FR-09, FR-10, FR-15 | Demo dataset; anonymous visitor; one point event and one warning-boundary event | 1. Open `#peta`. 2. Select an event in the linked list. 3. Read event time, evidence links and freshness. 4. Compare the point and the boundary on the map. | Event time, evidence and freshness appear as separate labels. A point and a boundary are drawn differently. The demo label is visible. No safety statement appears. | worker: `l4-public-geometry-projection.test.ts`, `l4-public-event-list-page-service.test.ts`; web: `map-home.test.tsx`, `geojson-map.test.tsx` | Blocked (F-01): component tests exist, but the public map has no boundary display |
| ST-F-02 | US-02; FR-11, FR-13, NFR-05 | Browser, no account; demo dataset with one published update | 1. Open "Ringkasan saya". 2. Add a place, service, group or category and save. 3. Open "Pembaruan" and open a matched item. 4. Read "Mengapa muncul". 5. Remove the interest. 6. Reopen "Pembaruan". | Interests are stored locally. They are sent only on an explicit briefing request. The matched item shows its reason. Removing an interest removes its personalisation. A correction appears once, with no repeated alert. | web: `preferences.test.tsx`, `updates-center.test.tsx`; worker: `public-briefing-runtime.test.ts`, `l4-public-briefing-projection.test.ts`, `l4-public-event-updates-service.test.ts`; db: `public-event-updates.test.ts`, `public-briefing-candidates.test.ts`; `publication-outbox-delivery-runtime.test.ts` (duplicate delivery) | Evidence exists |
| ST-F-03 | US-03; FR-06, FR-08, FR-10, FR-12 | Moderator account (operator-provisioned); queued proposal with `has_discrepancy`; public detail already shows the earlier version | 1. Sign in. 2. Open `#admin/tinjau`. 3. Open the item; compare supporting and contrary evidence; check each claim's origin. 4. Correct only the supported field, or hold the claim. 5. Enter a reason; submit with the current version and an idempotency key. 6. Submit the same request again. 7. Submit a stale version. 8. Open public detail and history. | Origins appear per claim. The first write commits one new version with an audit record. The repeat returns the original result and creates no second version. The stale version gets a conflict response and the draft stays visible (UX_API_SPEC §4). The corrected version appears in public detail, history and list. Drafts stay private. | web: `moderator-review.test.tsx`; worker: `moderation-api.test.ts`, `l4-moderator-authorization.test.ts`, `l4-manual-publication-service.test.ts`; db: `manual-publication-public-read-chain.test.ts`, `public-event-history.test.ts` | Partial: no file name covers idempotent replay, stale-version conflict or per-claim origin display |
| ST-F-04 | UC1; FR-10, FR-15 | Anonymous visitor; demo or live dataset | 1. Open `#peta` without signing in. 2. Apply category, time and status filters. 3. Switch to the list at 390 px. 4. Clear the filters. 5. Trigger an empty result and an unavailable source. | Public reads need no account. Filters narrow the same set on the map and in the list. Empty and unavailable states differ, and neither reads as "no incidents". The demo or live label is visible. | web: `map-home.test.tsx`, `public-published-feed.test.tsx`; db: `public-event-list.test.ts` | Partial: filter and empty-state copy are not named by file |
| ST-F-05 | UC2; FR-03, FR-10, FR-13 | Demo dataset; event with evidence and a passed `review_due_at` (fixture) | 1. Open `#detail/api/<id>` from the list. 2. Read the event, issuer, acquisition and publication times. 3. Follow each source link. 4. Read the freshness label. | The four times are shown distinctly. Source links and evidence labels appear. A passed review date shows "needs update", never "resolved". | worker: `l4-public-event-history-projection-service.test.ts`, `l4-freshness-transition-policy.test.ts`; db: `public-event-history-disclosure.test.ts`, `public-event-snapshot.test.ts`; web: `api-client.test.ts` (client only) | Partial: no web test named for the detail page |
| ST-F-06 | UC3; FR-11, FR-12, NFR-07 | Demo dataset; self-registration enabled | 1. Register a new account. 2. Log out. 3. Log in with the new account. 4. Attempt a moderation write with this account. 5. Try a wrong password. 6. Open the preferences page. | Self-registered accounts get role `user` only. A wrong password is refused. The moderation write is refused. Browser writes need an exact Origin and `X-CSRF-Token`. Interests stay local. | worker: `accounts-password.test.ts`, `accounts-api.test.ts`, `service-auth-routes.test.ts`, `l4-moderator-authorization.test.ts`; db: `password-accounts.test.ts`; web: `accounts.test.tsx`, `onboarding-intro.test.tsx`, `preferences.test.tsx` | Evidence exists (password reset is not implemented, §7) |
| ST-F-07 | UC4; FR-08, FR-12 | Moderator; proposal with `has_discrepancy` in the queue | 1. Open the review queue. 2. Publish one proposal through the gate. 3. Reject another. 4. Call a moderation route as role `user`. | Publication goes through the gate (`decideProposal`). Rejection never publishes. The `user` call is refused. Each decision writes an audit record. | worker: `moderation-api.test.ts`, `l4-manual-publication-service.test.ts`, `l4-publication-policy.test.ts`; db: `manual-publication-gate-composition.test.ts`; web: `moderator-review.test.tsx` | Partial: audit record not named by file |
| ST-F-08 | UC5; FR-14 | Moderator or admin; live or demo; 900 px or wider for the flow and 3D tabs | 1. Open `#admin/alur`. 2. Read stage counts, health and drill-down. 3. Open `#admin/embedding`. 4. Repeat at 390 px. 5. Sign in as a non-moderator and request the flow. | The flow shows the L1 to L5 stages as read-only counts. Below 900 px the tabs show an empty state (`docs/report/SCREENSHOTS.md`). A non-moderator gets 401 or 403. No body, claim, prompt or checkpoint text is returned (FLOW-VIS-01, `docs/IMPLEMENTATION_BACKLOG.md`). | worker: `pipeline-flow-api.test.ts`, `pipeline-flow-route.test.ts`, `embedding-visualization-api.test.ts`; web: `pipeline-flow.test.tsx`, `pipeline-flow-model.test.ts`, `embedding-visualization.test.tsx` | Partial: no live session with real feeds has been run (FLOW-VIS-01: "Not verified") |
| ST-F-09 | UC6; FR-01, FR-12, FR-15 | Administrator; demo data for `#admin/sumber` | 1. Sign in as administrator and open `#admin/sumber`. 2. Read the approval, restrictions and health of a source. 3. Sign in as moderator and check the tab is absent. 4. Change a role with a reason. | The registry shows approval, restrictions and health, labelled as demo. Moderators do not see the tab. The role change needs a reason and is audited and versioned. | web: `admin-workspace.test.tsx`, `admin-dashboard.test.tsx`, `unified-source-explorer.test.tsx`, `source-preview.test.tsx`; worker: `source-preview-route.test.ts`, `accounts-api.test.ts` | Partial: role-change audit and approval gating are not named by file |
| ST-F-10 | UC7; FR-01, FR-08, FR-13 | Demo or live; three proposals: one with no discrepancy from an approved source with rights, one with a discrepancy, one unreviewed past the TTL | 1. Let the gate evaluate each proposal. 2. Check each decision and its actor. 3. Let the unreviewed proposal pass the configured TTL. | Only proposals passing every ADR-061 check are auto-published (actor `agent:auto-publisher`). Discrepancies, unresolved correlations and missing source rights go to a moderator. Rejection never publishes. An unreviewed proposal expires after the configured TTL. The Fig 3.2 label and ADR-062 drawer text say 48 hours, but ADR-062 makes the TTL configurable (`PROPOSAL_REVIEW_TTL_HOURS`), so the test uses the configured value. | worker: `merge-review-gate.test.ts`, `merge-review-publication.test.ts`, `review-expiry.test.ts`, `gated-rss-permissions.test.ts`; db: `proposal-expiry.test.ts`; intelligence: `merge-review.test.ts` | Evidence exists |
| ST-F-11 | UC8; FR-02, FR-03, FR-04 | Live stack with fixture feeds or synthetic sources; malformed and duplicate items included | 1. Run one poll of each source. 2. Run the same poll again with unchanged content. 3. Submit a malformed item. | Unchanged content creates no new processing job (ID, URL or content hash). Source text and offsets are stored. Unknown fields stay unknown. Malformed or ambiguous output is quarantined. Webhook and manual submissions use the same path. | worker: `rss-news-ingest.test.ts`, `gated-rss-revision-identity.test.ts`, `gated-rss-persistence-parity.test.ts`, `petabencana-ingest.test.ts`, `bmkg-cap.test.ts`, `webhook-ingest.test.ts`, `l2-model-grounding.test.ts`; db: `report-revision-source-observations.test.ts`; intelligence: `report-interpreter.test.ts` | Partial: no live feed run; quarantine not named by file (CLAUDE.md: `serve:live` flow wiring not run live) |
| ST-F-12 | UC8; FR-05, FR-06, FR-07 | Reports covering one event, including copies and a nearby distinct incident; one case with missing evidence | 1. Correlate the reports. 2. Check independent origins per claim. 3. Run a case with sufficient evidence. 4. Run a case with missing evidence. | Copies do not raise corroboration. Nearby distinct incidents stay separate. Sufficient evidence bypasses investigation. Missing evidence creates a persisted, bounded case with counters and a stop reason. | worker: `multisource-correlator.test.ts`, `l2-evidence-retrieval.test.ts`, `l3-insufficient-context-entry.test.ts`, `l3-single-step-executor.test.ts`, `l3-progress-fingerprint.test.ts`; intelligence: `incident-correlator.test.ts`, `correlation-validation.test.ts`, `semantic-retrieval.test.ts` | Partial: the live intelligence path bypasses the Worker L2/L3 modules (CLAUDE.md, Architecture); L3 files test the Worker only |
| ST-F-13 | FR-08, NFR-05 (correction propagation) | Published event with a correction proposal; one duplicate delivery of its publication event | 1. Publish the correction. 2. Redeliver the same publication event. 3. Attempt a write against an older event version. 4. Read every public view: list, detail, history and updates. | One public version is created. The stale write does not overwrite the newer event. Every public view shows the corrected version. | worker: `publication-outbox-delivery-runtime.test.ts`, `l4-manual-publication-service.test.ts`; db: `publication-outbox-delivery.test.ts`, `publication-writer.test.ts`, `public-event-list.test.ts`, `public-event-updates.test.ts`, `manual-publication-public-read-chain.test.ts` | Partial: stale-write conflict not named by file |
| ST-F-14 | FR-13 | Fixture events: one with a passed `review_due_at`, one with an issuer validity window that has ended, one with a missing update feed; one source revision withdrawn | 1. Run one bounded page of due evaluation. 2. Read the public status. 3. Withdraw the source revision. | A passed review date gives `needs_update`. Only the issuer's validity window gives `expired`. A missing update never gives "resolved". Withdrawal updates dependent public views. | worker: `l4-freshness-due-evaluator.test.ts`, `l4-freshness-due-schedule-runtime.test.ts`, `l4-freshness-transition-recorder.test.ts`, `source-revision-freshness-transition.test.ts`, `source-revision-freshness-public-projection.test.ts`; db: `freshness-transition-ledger.test.ts`, `freshness-due-schedule-runtime-composition.test.ts` | Partial: `apps/worker/wrangler.toml` defines no cron trigger (CLAUDE.md), so scheduled expiry does not run in deployment |
| ST-F-15 | FR-15 (SDP §10 empty and error states) | Demo and live datasets; a live view with no published events | 1. Open a demo view and check its label. 2. Open a live view with no published events. 3. Check that demo records are not shown as live warnings. | Demo and historical records carry their label. Empty live coverage shows as "no coverage", never as an all-clear. Demo records never appear as live active warnings. | db: `synthetic-publication-isolation-composition.test.ts`, `synthetic-fixture-pipeline.test.ts`; web: `map-home.test.tsx` | Partial: empty-state wording for live coverage is not named by file |
| ST-F-16 | FR-14 | Live or demo run; one synthetic poll | 1. Run one synthetic poll (`npm run pipeline:local -- --enable --once --state <name>`). 2. Trace the run ID across reports, context, model configuration, investigation and publication decision. | Each run has one trace ID that links reports, context, model configuration, investigation and decision. | worker: `l5-synthetic-poll-process-telemetry.test.ts`, `l3-investigation-telemetry.test.ts`, `l3-coordinator-telemetry.test.ts`, `pipeline-runtime-status.test.ts`; db: `freshness-due-run-traces.test.ts` | Partial: no file name covers the end-to-end trace link |

## 4. Non-functional tests

The metric column quotes SDP §4 as written. The method column gives the SDP acceptance evidence.

| ID | Requirement | Metric (SDP §4) | Measurement method | Evidence now | Status |
| --- | --- | --- | --- | --- | --- |
| ST-N-01 | NFR-01 | "No known unsupported factual claim or geometry is published in release scenarios." | Adjudicated claim, span and geometry checks; disputed cases held. Two human reviewers reconcile expected results (SDP §10). | Policy and geometry tests: `l4-publication-policy.test.ts`, `l4-public-geometry-projection.test.ts`, `geometry-writer.test.ts`, `public-event-geometries.test.ts`. A synthetic casebook exists (`docs/evaluation/fixtures/synthetic-casebook.json`); `docs/evaluation/` holds no adjudication record. | Partial: no adjudicated release scenarios |
| ST-N-02 | NFR-02 | "L3 stops at 5 tool attempts, 4 reasoning turns, 60 active seconds or 12,000 model input/output tokens, whichever comes first." | Failure, retry and resume cases; preflight reservations and persisted counters; no budget reset. | Worker: `l3-single-step-executor.test.ts`, `l3-reasoning-step-executor.test.ts`, `l3-progress-fingerprint.test.ts`, `l3-insufficient-context-entry.test.ts`. The executor validates active seconds 1 to 60 and model tokens up to 12,000 (`apps/worker/src/layers/l3-investigation/reasoning-step-executor.ts`, line 622). Intelligence: `ai-rate-limit-job-runner.test.ts`, `ninerouter-rate-gate.test.ts`; db: `ai-job-rate-limit.test.ts`. | Partial: Worker only; the live path bypasses L3 (ST-F-12); the 5-attempt and 4-turn limits are not named by file |
| ST-N-03 | NFR-03 | "Mobile and desktop discovery remain usable with a list fallback; keyboard access and understandable labels." SDP §2: at least 80% of participants complete the discovery task within one minute. | US-01 and US-02 tasks on a real phone and desktop; 80% target; documented issues (SDP §4). Interview sample of 6 to 8 (SDP §2). | No human sessions. Headless 390 px and 1440 px checks only (§5, BR-03, BR-04). No keyboard walk-through is recorded (`docs/IMPLEMENTATION_BACKLOG.md`, UI-V2-A row). | Not evidenced: no human sessions are planned |
| ST-N-04 | NFR-04 | "Public reads never wait for source acquisition or model inference. Report warm and cold-start latency separately; Neon Free may scale to zero after five idle minutes." | "WSL workload and a free-tier compatibility run report p50/p95, dataset size and concurrent reads. Set a measured target before release" (SDP §4). | No p50 or p95 value is recorded. PLATFORM-01 is accepted with provider compatibility unverified (`docs/IMPLEMENTATION_BACKLOG.md`). The "p50 1ms" in the REAL-AI-MULTISOURCE row measures the AI proposal benchmark, not public reads, and is not used here. No target is set in this specification. | Partial: first HTTP baseline measured on the local live app (`docs/testing/PERFORMANCE.md`); no target set; larger datasets not measured |
| ST-N-05 | NFR-05 | "Duplicate delivery/retries do not duplicate public versions or notifications; stale proposals cannot overwrite a newer event." | Transaction, retry and optimistic concurrency cases (SDP §4). | db: `publication-outbox-delivery.test.ts`, `publication-writer.test.ts`, `freshness-transition-ledger.test.ts`; worker: `publication-outbox-delivery-runtime.test.ts`, `l4-freshness-transition-recorder.test.ts`. No file name covers the stale-write conflict or notification deduplication. | Partial |
| ST-N-06 | NFR-06 | "The demo dataset must be rebuildable from versioned synthetic fixtures and migrations." | WSL restore or rebuild rehearsal, recording the tested recovery point, recovery time and deletion-tombstone behaviour (SDP §4). | Rebuild inputs exist: 47 migrations (`apps/db/migrations`, 001 to 047); `apps/db/test/migrations.test.ts`; `apps/db/test/synthetic-fixture-pipeline.test.ts`; `docs/evaluation/fixtures/`. No rehearsal is recorded. `docs/PLATFORM_COMPATIBILITY.md` states that no backup, restore or deletion replay was tested. | Not evidenced: no rehearsal |
| ST-N-07 | NFR-07 | "Least-privilege roles, approved outbound hosts, input isolation, minimal personal data and protected moderator access." | "Access-control, malicious-source, redirect, secret-handling and retention checks" (SDP §4). | Access control: `l4-moderator-authorization.test.ts`, `moderation-api.test.ts`, `service-auth-routes.test.ts`, `accounts-password.test.ts`, `password-accounts.test.ts`, `gated-rss-ledger-grants.test.ts`. No file name covers malicious-source, redirect, secret-handling or retention checks. No file name covers CSRF or Origin; a content search matched `apps/worker/test/accounts-api.test.ts` and `apps/worker/test/api.test.ts`, to be confirmed. | Partial |
| ST-N-08 | NFR-08 | "Layer responsibilities, versioned interfaces and reproducible builds remain explicit; local development and checks run in WSL Ubuntu-26.04." | "Locked dependencies, migrations, WSL run instructions, reviewed contract changes and a free-tier-compatible build" (SDP §4). | `package-lock.json`; 47 migrations and `apps/db/test/migrations.test.ts` (hard-coded list and count); `docs/contracts.schema.json`; CI build step completed as a Wrangler dry-run (`.codex-build/ci-logs/cec9358/SUMMARY.md`); run commands in CLAUDE.md. | Partial: dry-run only; no free-tier deployment (§7) |

## 5. Browser-level checks

These checks are reported in Chapter 4. The Chapter 4 text is in the Google Docs report, which is not in this repository, so the evidence cited here is the repository record. The browser checks are local and are not run in CI ("Browser checks. None run in CI", `.codex-build/ci-logs/cec9358/SUMMARY.md`).

| ID | Setting | Pages | Local evidence | Status | UAT link |
| --- | --- | --- | --- | --- | --- |
| BR-01 | 320 px viewport | Public routes and account shell | `docs/DELIVERY_LOG.md` line 31 records headless QA at desktop, mobile and 320 px with 200% text, with zero browser errors and no document overflow. `docs/assignments/AUTH-01-ACCOUNTS-ONBOARDING-HANDOFF.md` records 320 px reflow fixes. Screenshots are not kept in the repository. | Partial | T2 |
| BR-02 | 200% text enlargement | Map, feed, detail, account and moderator screens | Same QA runs as BR-01 (`docs/assignments/UX-WEB-02-SIMPLIFY-HANDOFF.md`). Screenshots are not kept in the repository. | Partial | T2 |
| BR-03 | Desktop 1440 × 900 | `#peta`; `#detail/api/<id>`; `#admin/tinjau` | `docs/report/SCREENSHOTS.md` (figure specifications); `docs/report/screenshots/fig-3-9-desktop-map.png` and `fig-3-11-incident-detail.png`; `docs/assignments/UX-WEB-02-SIMPLIFY-HANDOFF.md`. | Evidence exists (local) | T1, T4 |
| BR-04 | Phone 390 × 844 | `#peta` with list sheet; moderator tabs below 900 px | `docs/report/screenshots/fig-3-10-phone-map-sheet.png`; `docs/report/SCREENSHOTS.md` lines 50 to 56 and 82; `docs/assignments/UX-WEB-02-SIMPLIFY-HANDOFF.md`. | Evidence exists (local) | T1, T2 |

## 6. Acceptance testing

Acceptance uses the three task flows in `docs/UX_API_SPEC.md` §5 (lines 199 to 203). It is the team's walkthrough acceptance. Acceptance by real users is pending.

| ID | Story and task | Checks | Linked tests | Walkthrough | Status |
| --- | --- | --- | --- | --- | --- |
| AT-01 | US-01: "Find an applicable report" | Identify event time, evidence kind, freshness and why the event may apply; list gives the same result as the map | ST-F-01, ST-F-04, ST-F-05 | `docs/testing/UAT.md` (T1) | Partial (run 01) |
| AT-02 | US-02: "Follow an update" | Save an interest; matched item with reason; one deduplicated change; remove the interest | ST-F-02, ST-F-13 | `docs/testing/UAT.md` (T2) | Partial (run 01) |
| AT-03 | US-03: "Review a disputed claim" | Compare evidence; submit with version and key; verify the public projection | ST-F-03, ST-F-07, ST-F-13 | `docs/testing/UAT.md` (T4) | Blocked (run 02, T4) |

Per TEST-PLAN §3 and §8, a walkthrough records pass or fail per step and seconds per task. No seconds are recorded yet. No human sessions are planned (ST-N-03), so user acceptance is pending. SDP §10 requires, for release completion, held-out and usability evidence, a reproducible Free-tier deployment, and tested restoration or deterministic rebuild. None of these is met on the current evidence.

## 7. Limitations

1. Hosted Cloudflare Workers and Neon Free are not tested. No backup, restore or deletion replay has been run (`docs/PLATFORM_COMPATIBILITY.md`).
2. The Android reader has no device or emulator tests.
3. No human usability sessions exist, so NFR-03 is not evidenced by decision. No keyboard walk-through is recorded.
4. No latency has been measured (NFR-04).
5. The CI evidence is for commit `cec9358`. On 13 November 2026, `main` was 13 commits ahead of `cec9358`. The CI log does not show the overall run result; confirm it on the GitHub Actions page before stating that CI passed.
6. Statuses rest on file names. The assertions have not been read against each expected result. A content review may change the statuses.
7. The live intelligence path (`apps/intelligence`) bypasses the Worker L2 and L3 modules (CLAUDE.md, Architecture). The L3 evidence covers the Worker only.
8. `serve:live` flow wiring is typechecked but has not been run live (CLAUDE.md, known gaps). The FLOW-VIS-01 live session is not verified.
9. There is no model accuracy or held-out evaluation. SDP §10 requires at least 40 reports across 12 cases with two reviewers. This specification does not cover that evaluation.
10. There is no penetration test. No file name covers malicious-source, redirect, secret-handling or retention checks (NFR-07).
11. Password reset is not implemented (CLAUDE.md, known gaps), so no test covers it.
12. Scheduled freshness does not run in deployment: no cron trigger is defined (CLAUDE.md).
13. Reviewer independence is partial: the team has three members (`docs/testing/TEST-PLAN.md` §7).
14. This is a specification only. No system test run has been executed for it. Local runs follow the owner's policy, and the heavy suites run on CI.
15. The browser evidence is local. Screenshots for 320 px and 200% text are not kept in the repository.
16. The SDP §3.1 wording conflicts with the implementation (§1). The root planner must resolve it.

## 8. Traceability summary

Each requirement appears once. Test IDs are ST-F (functional), ST-N (non-functional) and BR (browser). Overall status is the weakest status among the linked tests.

| Requirement | Test IDs | Status |
| --- | --- | --- |
| FR-01 | ST-F-09, ST-F-10 | Partial |
| FR-02 | ST-F-11 | Partial |
| FR-03 | ST-F-05, ST-F-11 | Partial |
| FR-04 | ST-F-11 | Partial |
| FR-05 | ST-F-12 | Partial |
| FR-06 | ST-F-03, ST-F-12 | Partial |
| FR-07 | ST-F-12, ST-N-02 | Partial |
| FR-08 | ST-F-03, ST-F-07, ST-F-10, ST-F-13 | Partial |
| FR-09 | ST-F-01 | Blocked (F-01) |
| FR-10 | ST-F-01, ST-F-04, ST-F-05 | Partial |
| FR-11 | ST-F-02, ST-F-06 | Evidence exists |
| FR-12 | ST-F-03, ST-F-06, ST-F-07, ST-F-09, ST-N-07 | Partial |
| FR-13 | ST-F-05, ST-F-10, ST-F-14 | Partial |
| FR-14 | ST-F-08, ST-F-16 | Partial |
| FR-15 | ST-F-01, ST-F-04, ST-F-15 | Partial |
| NFR-01 | ST-N-01 | Partial |
| NFR-02 | ST-N-02 | Partial |
| NFR-03 | ST-N-03; BR-03, BR-04 (local) | Not evidenced |
| NFR-04 | ST-N-04 | Partial: measured over HTTP on the local live app (4 events); no target set |
| NFR-05 | ST-N-05, ST-F-13 | Partial |
| NFR-06 | ST-N-06 | Not evidenced |
| NFR-07 | ST-N-07, ST-F-06 | Partial |
| NFR-08 | ST-N-08 | Partial |
