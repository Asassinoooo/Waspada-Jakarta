# Integration test plan and report: Waspada Jakarta

| Field | Value |
| --- | --- |
| Identifier | TEST-DOC-01 (report Chapter 5, section 5.3) |
| Status date | 18 Nov 2026 |
| Baseline | `main` at 6fff929 (18 Nov 2026). The earlier baseline was `main` at ae75527 (13 Nov 2026) |
| Method | Static checks of file existence, test titles, imports, package scripts and workflow files. CI results come from GitHub Actions run 44211263890 (`gh run view`, job log), matched to files by test title or by the database `PASS` line. No test, build or server was run locally for this update. |
| Structure | IEEE 829 test-plan sections, with the integration approach of Braude, Ch 27 (build order, facades, state tests, acyclic dependencies) |
| Update | 18 Nov 2026 (TG-DOCS-02). Header table and sections 1, 3.2 to 3.5, 4, 6, 7, 8, 9, 10.3 and 11 changed. Section 9 cites run 44211263890 at 6fff929 and keeps the earlier cec9358 run (43238566925). Previous update: 14 Nov 2026 (TEST-GAP-02), rows changed by commits 588e375 to abe7bf6 |

## 1 Scope and levels

Integration here means a test that crosses a layer boundary (L1 to L2, L2 to L3, L3 to L4), a persistence boundary (a real PGlite database with PostGIS and pgvector) or the Worker HTTP or runtime boundary. Routine tests use mocks, fixtures and PGlite, with no external network. The header of `apps/worker/test/news-triage-rate-limit.test.ts` reads "Fake clock, fake fetch and PGlite only. No network, no credentials."

Levels used:

- **Composition (database):** one layer or a pair of layers run against PGlite through the SQL stores in `apps/db/test/`. The harness `apps/db/test/harness.ts` creates PGlite with PostGIS and pgvector.
- **Composition (Worker runtime):** Worker modules that open the same harness (`apps/worker/test/gated-rss-revision-identity.test.ts`, for example) or run with injected ports.
- **Facade:** the Worker HTTP surface, tested through its handlers (section 4).
- **State:** the freshness machine (section 5).
- **Local composition:** the mocked private pipeline in `tools/local-pipeline/`, run by `npm run pipeline:test` (`package.json`, line 23).

Out of scope:

- Unit tests of one pure function. The CAP parser cases in `apps/worker/test/bmkg-cap.test.ts` appear in section 3.1 only because they are the sole BMKG tests, and they open no database.
- The web UI (`apps/web`). CI runs no browser checks (`.github/workflows/ci.yml` has no browser step). Browser walkthroughs are in `UAT.md`.
- Live network, model and source calls. `npm run serve:live` (LIVE-LOCAL-01 in `docs/IMPLEMENTATION_BACKLOG.md`) is not part of the test evidence in section 9.
- Hosted Cloudflare and Neon behaviour. The Worker is deployed (HOSTED-23, 17 Nov 2026), but no automated test calls it. Hosted walkthroughs are in `UAT.md` section 9.2. These tests do not clear source rights, and they do not test hosted behaviour (`SOFTWARE_DEVELOPMENT_PLAN.md`, section 8, closing paragraph).

Status terms in section 3 and section 4:

- **In CI step N** means the file sits in the suite that `ci.yml` runs at that step. The step order is unchanged since cec9358. Only the file list of step 12 changed (3df81e9). Section 9 records the per-file check against run 44211263890. That check is the source for the pass results in sections 3.4 and 3.5.
- **TEST-INT-01** is on `main` (commit `71022ee`), so its rows are marked Written. Cases TI-01 and TI-02 ran in CI run 44211263890 (db 399/399), so their register status is Evidence exists.

## 2 Build order

The plan builds bottom-up along the five-layer ownership baseline in `docs/ARCHITECTURE_ALIGNMENT.md` (line 47): L1 data-knowledge, L2 model-grounding, L3 investigation, L4 application-integration, with L5 evaluation-monitoring alongside. Each build adds one layer and tests it only against the layer below, which is already verified.

| Build | Layers added | Depends on | Milestone (SOFTWARE_DEVELOPMENT_PLAN.md, section 8) |
| --- | --- | --- | --- |
| 1 | L1 with the database | PGlite schema and stores (`apps/db/src`) | M2 Data foundation, weeks 3–4 |
| 2 | L2 retrieval and grounding | Build 1 persisted evidence | M3 Grounded direct path, weeks 5–6 |
| 3 | L3 ledger, then the L4 publication gate | Build 2 proposals and grounding context | M4 Bounded investigation, weeks 7–8; M5 gate, weeks 9–10 |

The order is incremental for a reason. If a Build 2 test fails on data that Build 1 persisted, the fault lies in the newest layer, because Build 1 is already tested. Build 3 follows the same logic.

Two cautions:

- This is a verification order, not the live data path. The live pipeline in the LIVE-LOCAL-01 row (`docs/IMPLEMENTATION_BACKLOG.md`) runs feeds, triage, durable AI jobs, Mastra intelligence, the moderator queue and the public read model. That row names no Worker L2 or L3 module, and the import search in section 3.2 found no runtime caller of the retrieval modules.
- The mapping of builds to the incremental delivery in Chapter II is in the report. It was not checked in this worktree.

## 3 Build tables

Paths are relative to the repository root. "DB" means a PGlite database. "W" means a Worker test that does not open PGlite.

### 3.1 Build 1: L1 and database

| File | Layers | What it proves (from test titles) | Status |
| --- | --- | --- | --- |
| `apps/db/test/petabencana-ingest-pglite.test.ts` | L1, DB | ING-01: PetaBencana reports, chunks, evidence and geometries persist in PGlite. | In CI step 6 |
| `apps/db/test/synthetic-source-poll-process-runtime.test.ts` | L1, DB | JOB-01: L1 role set and reset; exact-source fixture data persists before acknowledgement; replay runs without another extraction. | In CI step 6 |
| `apps/worker/test/gated-rss-revision-identity.test.ts` | L1, DB | Revision identity across edits and sources; no fetch, prompt, revision or job when rights are denied; one model call and one job for stable content; concurrent polls persist one evaluation. | In CI step 8 |
| `apps/worker/test/news-triage-rate-limit.test.ts` | L1, DB | A rate-limited Stage B call is a distinct outcome, not a provider error; cooldown holds items without a model call; rate-limited attempts do not use the provider-error retry budget. | In CI step 8 |
| `apps/worker/test/synthetic-source-poll-process-runtime.test.ts` | L1 runtime, W | The runtime stays closed unless its gates, SQL, catalogue and extractor are present; failures expose fixed, redacted errors; role reset runs on failure. | In CI step 8 |
| `apps/worker/test/webhook-ingest.test.ts` | L1, L2 proposal engine, L4 SSE, W | Route matching; Jakarta envelope validation; single and batch pushes produce proposals and SSE broadcasts; spatial and temporal correlation with reports. | In CI step 8. Gap: no PGlite test (section 7) |
| `apps/worker/test/bmkg-cap.test.ts` | L1, W (parser) | CAP namespaces; Alert, Update and Cancel linkage; sent, effective, onset and expires times kept apart; polygon mapping; DOCTYPE, external entities and malformed XML rejected. | In CI step 8. Gap: no PGlite test (section 7) |

### 3.2 Build 2: L2 and retrieval

| File | Layers | What it proves (from test titles) | Status |
| --- | --- | --- | --- |
| `apps/db/test/evidence-retrieval.test.ts` | L2, DB | Deterministic retrieval keeps contrary evidence, isolates datasets, bounds results, runs under the least-privilege L2 reader, and rejects non-CRS84 geometry before PostGIS. | In CI step 6 |
| `apps/db/test/rag-grounded-proposal-roundtrip.test.ts` | L2, DB | Persisted evidence grounds reasoning before any proposal; one private draft is written and replayed exactly; insufficient context stops before reasoning; source invalidation blocks the proposal path without changing public state. | In CI step 6 |
| `apps/db/test/l2-context-resumption-composition.test.ts` | L2, DB | Saved refs-only grounding context resolves once under the L2 reader; an invalidated span returns no request; context rows stay private to their writer. | In CI step 6 |
| `apps/db/test/embedding-generation-composition.test.ts` | L1, L2, DB | The embedding adapter runs before the L1 transaction; exact lineage persists and replays; failed or invalid results persist nothing; a changed vector on a stable retry is rejected. | In CI step 6 |
| `apps/worker/test/embedding-generation.test.ts` | L1, L2 contracts, W | One exact L2 chunk is projected; the adapter runs before L1 persistence; repository and adapter errors map to closed results. | In CI step 8 |
| `apps/worker/test/l2-evidence-retrieval.test.ts` | L2, L5, W | A bounded query reaches an injected read-only repository; the exact repository error is kept; telemetry allowlists hold. | In CI step 8 |
| `tools/local-pipeline/pipeline.test.ts` | L1, L2, L4 queue, DB (local tooling) | Canonical local composition with unchanged polling, changed provenance and private proposals; invalid model output exhausts bounded retries while L1 evidence stays recoverable; a restart after proposal commit reuses every model stage. | In CI step 10 |
| `tools/local-pipeline/processor.test.ts` | L1, L2 (local tooling) | Mock capabilities pass through the validating adapter with fixture lineage; a model timeout becomes a bounded, retryable failure. | In CI step 10 |

Caller check. The retrieval and grounding modules (`retrieval.ts`, `direct-reasoning.ts`, `context-resumption.ts`, `grounding-context.ts`, `context-persistence.ts`, `reasoning-proposal-bridge.ts`) have no importer outside L2, L3, the tests and two local tools: `tools/local-pipeline/processor.ts` and `tools/ai/ninerouter-smoke.ts`. The Worker does call L2 proposal generation at runtime. `apps/worker/src/layers/l1-data-knowledge/webhook-ingest.ts` no longer imports the L2 builders or the L4 broadcaster. Since F-03 (`cffc865`) it takes them as ports, and `apps/worker/src/index.ts` injects `generateProposalFromReport`, `generateCorrelatedProposal` and `eventBroadcaster` when it creates the handler (checked 18 Nov 2026). The handler is mounted in `index.ts`. So the database tests in this build are the only evidence for retrieval-before-reasoning, and the composition evidence for the webhook proposal path is `webhook-ingest.test.ts` in section 3.1.

### 3.3 Build 3: L3 and the L4 gate

| File | Layers | What it proves (from test titles) | Status |
| --- | --- | --- | --- |
| `apps/db/test/investigation-ledger.test.ts` | L3, L2 grounding, DB | Durable ledger with budgets and checkpoints; an open review marker blocks replayable work; started actions reconcile after restart; a bounded synthetic investigation persists one exact-context private proposal and replays it; the coordinator role cannot write publication or history. The file imports no L4 publication module. | In CI step 6 |
| `apps/db/test/manual-publication-gate-composition.test.ts` | L4, DB | The manual gate with the real SQL writer handles approval, replay and a changed-label conflict; a stale evidence assessment is denied before publication writes. | In CI step 6 |
| `apps/worker/test/merge-review-publication.test.ts` | L4 decision writer, DB | MERGE-REVIEW-01: a proposal without discrepancy auto-publishes under the agent actor; a discrepancy is queued for a moderator; `independent_corroboration` is never auto-published; the ADR-061 `local_relaxed` waiver is recorded; moderator rights checks are unchanged. | In CI step 8 |
| `apps/worker/test/review-expiry.test.ts` | L4, DB | REVIEW-EXPIRY-01: a 49-hour undecided proposal expires and a 47-hour one stays pending; a published proposal is never expired; a moderator's earlier reject is not overridden; the scheduled sweep does nothing in demo mode. | In CI step 8 |
| `apps/db/test/proposal-expiry.test.ts` | L4, DB | Expiry candidates are undecided proposals older than the cutoff only; batches are bounded; an expire decision reads as expired in the flow view, not as a publication or gate decision. | In CI step 6 |
| `apps/db/test/manual-publication-public-read-chain.test.ts` | L2, L4, DB | Both versions publish through the gate; the correction reads back through public handlers, history and updates; a stale evidence assessment is denied before writes. | In CI step 6 |
| `apps/db/test/synthetic-publication-isolation-composition.test.ts` | L1, L2, L4, DB | A synthetic L1/L2 draft stays outside the manual gate and the public detail view. | In CI step 6 |
| `apps/worker/test/pipeline-flow-route.test.ts` | L4 route, DB | FLOW-VIS-01: 401 for an anonymous caller, 403 for a registered user, 200 for a moderator and an admin; runtime status attaches only when the local server provides it. | In CI step 8 |
| `apps/worker/test/briefing-interest-removal.test.ts` | L4 read model, DB | FR-11: the candidate store selects an event only while one of its interests is in the request; the projection gives the matched reason only for the interests still saved. | Added for FR-11 |
| `apps/worker/test/repeated-coverage-alerts.test.ts` | L4 decision writer, DB | FR-11: a re-delivered proposal writes no second decision or version. F-ALERT-01 (closed by 9d107b6): a repeated report of the same facts from another outlet adds no version (`no_material_change`), and a material change publishes the next version. F-ALERT-02 (closed by 1a11d3c, HOSTED-02): a newly published version appears in the public views and the updates feed. The test is active. | Added for FR-11 (c15383c); F-ALERT-01 closed; F-ALERT-02 closed by 1a11d3c; in CI run 44211263890 |
| `apps/worker/test/trace-id-chain.test.ts` | L1 to L4, DB | FR-14: one trace id is recorded at ingestion, candidate, embedding run (provider and model version), grounding context, investigation, proposal and publication decision on the L2/L3 path. F-TRACE-01 (74c4616): a live workflow proposal keeps the report's trace, candidate and context ids. F-TRACE-02 (74c4616): a proposal without lineage ids writes no placeholder provenance. | Added for FR-14 (c15383c); F-TRACE-01 and F-TRACE-02 closed locally |
| `apps/web/test/interest-removal.test.ts` | Web client (preferences, briefing request, updates) | FR-11: removing an interest removes it from the saved store, the next briefing request and the update matches; removing every interest closes the gate; one change delivered twice is one card. | Added for FR-11 |
| TEST-INT-01 | L3 output into L4 gate | `apps/db/test/l3-investigation-publication-gate.test.ts` takes an L3 ledger context through the reasoning bridge and the manual gate. Case TI-02 holds on claims. Since 593f849 the gate also refuses a proposal whose investigation is `stopped_for_review` (F-04, closed locally). | Written (`71022ee` on `main`); F-04 refusal added 593f849; PASS in CI run 44211263890 (database step) |

### 3.4 Files added since 364f3fd (TEST-GAP-02, 14 Nov 2026)

These files were not in the cec9358 CI log. All of them are in run 44211263890 (6fff929) and passed (section 9). Each row is in `docs/testing/test-cases.csv` (IT-TG-01 to IT-TG-11).

| File | Layers | What it proves (from test titles) | Status |
| --- | --- | --- | --- |
| `apps/db/test/source-approval-store.test.ts` | L4 approval store, DB | FR-12: approval writes only the approval status plus a trace and an audit row; revoke turns collection and issuer-notice auto-publication off; re-approval of an active source restores collection, and the auto-publication policy stays `never`; no-op and unknown-source requests write nothing. | Added 9c0bb13; re-approval restore added in a96e9b5 (HOSTED-07); in CI run 44211263890 |
| `apps/intelligence/test/event-time-unknown.test.ts` | Intelligence, DB | F-14: no incident start and no proposal event time when the report gives no event time; the control keeps a source event time. | Added 588e375 |
| `apps/intelligence/test/live-lineage.test.ts` | Intelligence, DB | FR-14: job trace, candidate and context kept on the live path; factory model configuration recorded; a live report without a revision writes no placeholder lineage. | Added 74c4616 |
| `apps/worker/test/adr061-gate-db.test.ts` | L4 gate and writer, DB | ADR-061 checks 1 to 4, 8 and 9 at database level; the control publishes as `agent_auto`; overlapping decisions on one proposal leave one decision and one version (F-CONC-01). HOSTED-21 (f8463b6): a proposal with no event time publishes with the time kept unknown and the waiver `event_time_unknown` recorded. A malformed time is queued as `time_missing`. | Added e8aa73d; extended 593f849, 74c4616 and f8463b6; in CI run 44211263890 |
| `apps/worker/test/source-approval-api.test.ts` | L4 route, DB | FR-12: 401, 403, Origin and CSRF refusals; approval and revocation with trace and audit; 409 for a repeated status; 404 for an unknown source; 400 for a malformed body; 503 on a storage failure. Re-approval through the route restores collection. | Added 9c0bb13; re-approval test added in a96e9b5 (HOSTED-07); in CI run 44211263890 |
| `apps/worker/test/event-withdrawal-correction-db.test.ts` | L4 writer, DB | FR-12: withdrawal writes a tombstone version, a decision and an audit record, and the event leaves public reads; a withdrawn event is final; a correction passes the gate and is refused as `time_missing` when it removes the event time (corrections still need a time; `assessCorrectionGate`). | Added abe7bf6; in CI run 44211263890 |
| `tools/live-freshness-job.test.ts` | serve:live composition, DB | FR-13: a passed review date gives `needs_update`; a missed timer runs once at the current time; an overlapping tick is skipped; each pass runs in one transaction; the read model is refreshed after each pass. | Added 3df81e9; in CI step 12 (`ci.yml`) |

Files added by the same commits that already have rows in section 3.3 (`briefing-interest-removal.test.ts`, added by c15383c) or section 4 (`internal-proposals-route.test.ts`, c15383c) keep those rows. The `repeated-coverage-alerts.test.ts` and `trace-id-chain.test.ts` rows in section 3.3 are updated in place.

### 3.5 Integration tests added after 14 Nov 2026 (hosted work)

Each file below is in run 44211263890 (6fff929). "Pass" means the suite passed in that run and at least one title from the file printed as passed (section 9). The "What it proves" column comes from the file header or the test titles.

| File | HOSTED ID | What it proves | CI result |
| --- | --- | --- | --- |
| `apps/worker/test/agent-origin-writer.test.ts` | HOSTED-15, HOSTED-18 | A publication writes one evidence origin per registered source of each claim, and links it to the cited evidence. The publication role may only insert these rows. A labelled event with no place or geometry is listed as a whole view. | Pass |
| `apps/worker/test/hosted22-public-attribution.test.ts` | HOSTED-22 | An approved source writes one attribution row (registry name, article link, the source's own publish time). A revoked source publishes with no attribution, and the public list skips it. | Pass |
| `apps/worker/test/agent-point-geometry.test.ts` | HOSTED-10 | An in-box agent coordinate gives one Point labelled `model_approximate`, recorded as `pending_geometry_writer`. An event with no usable coordinate is a whole view with no geometry row. | Pass |
| `apps/worker/test/hosted14-no-invent.test.ts` | HOSTED-14 | A label or coordinate is kept only when the report text states the place. The deterministic path has no default region. Pure, no database. | Pass |
| `apps/worker/test/hosted17-petabencana-label.test.ts` | HOSTED-17 | A PetaBencana event with the fixed label and no coordinate is a whole view, not `INVALID_EVENT`. An event with no label and no coordinate is still refused. Pure. | Pass |
| `apps/worker/test/hosted22-rss-published-at.test.ts` | HOSTED-22 | A gated RSS revision stores the item's own time as `published_at`, or NULL when the time is missing or unparseable. It never stores the retrieval time. The BMKG fallback stores NULL. | Pass |
| `apps/worker/test/ingest-dispatch.test.ts` | HOSTED-25 (module header) | Dispatch mode is on only for the exact value. A missing token or repo sends nothing. A 204 dispatches `ingest.yml` on `main`. Error statuses map to fixed codes. Fetch fake. | Pass |
| `tools/accounts/hosted-ingest.test.ts` | HOSTED-03, 09, 13, 19, 22, 24B, 24C | Headless ingest: the 16-source coverage guard, the per-cycle fetch decision, source-health writes and the attribution backfill (in-process PGlite for the writes), and Neon role-attribute checks. | Pass |
| `tools/accounts/hosted-once-publication.test.ts` | HOSTED-20 | The `--once` publication sweep: newest first, budget limits, stop after consecutive failures, fixed output codes, and the run order (poll, drain, sweep, freshness). Fakes only. | Pass |
| `apps/intelligence/test/google-ai-adapter.test.ts` | HOSTED-14 | Google AI Studio provider config. A primary 429 retries once on the fallback model. A 400 or 403 is never retried. Embeddings must be 768 finite values. Keys and response bodies are never logged. | Pass |
| `apps/intelligence/test/google-ai-run-budget.test.ts` | HOSTED-14 | The free-tier caps in code: 10 chat sends per 30-minute window and 20 embeddings per run. The eleventh chat call is refused before any send. Primary and fallback budgets are separate. Fake clock and transport. | Pass |
| `apps/intelligence/test/location-grounding.test.ts` | HOSTED-14 | The intelligence path keeps a model place and coordinate only when the report text states the place. It never invents a region. Pure. | Pass |
| `apps/intelligence/test/agent-output-leak.test.ts` | HOSTED-20 | Agent errors carry fixed codes only. A fabricated quote, a model revision ID, or JSON and schema error text never reaches the message. No network, no database. | Pass |
| `apps/intelligence/test/hosted17-petabencana-label.test.ts` | HOSTED-17 | A PetaBencana report gets the fixed label. The label is not grounded against the text, and it does not make a report without a coordinate name a location. Pure. | Pass |
| `apps/intelligence/test/hosted22-published-at.test.ts` | HOSTED-22 | The interpreter's "Published At" is the revision's own publish time. A revision with no publish time gives null, never its retrieval time. Real job runner over PGlite, with a capturing mock model. | Pass |

## 4 Interface tests (facade)

The facade is the public `/api/v1` HTTP surface. Its contract is `apps/worker/src/contracts/public-api.ts`. Read routes are dispatched in `apps/worker/src/layers/l4-application-integration/api.ts`. Internal, webhook and moderation routes are dispatched in `apps/worker/src/index.ts`. The flow route is handled in `apps/worker/src/layers/l4-application-integration/pipeline-flow-api.ts`. This table follows the runtime dispatch rather than `docs/api/openapi.yaml`.

Among the read routes dispatched in `api.ts`, every route is GET except `POST /api/v1/briefings`, and other methods are refused there (lines 194–200). The internal proposals, webhook and moderation routes are dispatched in `index.ts`, as the table shows.

| Route | Handler | Handler tests | Status |
| --- | --- | --- | --- |
| GET `/api/v1/events` | `api.ts` | `public-event-list-runtime.test.ts`, `api.test.ts` | In CI step 8 |
| GET `/api/v1/events/:id` | `api.ts` (detail) | `public-event-detail-runtime.test.ts` | In CI step 8 |
| GET `/api/v1/events/:id/history` | `api.ts` (history) | `public-event-history-runtime.test.ts` | In CI step 8 |
| GET `/api/v1/events.geojson` | `api.ts` | `public-event-geojson-runtime.test.ts`, `api.test.ts` | In CI step 8 |
| GET `/api/v1/updates` | `api.ts` | `api.test.ts`, `l4-public-event-updates-service.test.ts` | In CI step 8 |
| POST `/api/v1/briefings` | `api.ts` | `public-briefing-runtime.test.ts` | In CI step 8 |
| POST `/api/v1/internal/proposals` (service key) | `index.ts` | `service-auth-routes.test.ts`, `internal-proposals-route.test.ts` | In CI step 8 |
| `/api/v1/ingestion/events` (webhook) | `index.ts`, then `webhook-ingest.ts` | `webhook-ingest.test.ts`, `service-auth-routes.test.ts` | In CI step 8 |
| `/api/v1/moderation/*` | `index.ts`, then `moderation-api.ts` | `moderation-api.test.ts`, `service-auth-routes.test.ts` | In CI step 8 |
| GET `/api/v1/pipeline/flow` | `pipeline-flow-api.ts` | `pipeline-flow-route.test.ts` | In CI step 8 |
| GET `/api/v1/admin/sources`; POST `/api/v1/admin/sources/:sourceId/approval` | `source-approval-api.ts`, then `source-approval-store.ts` | `source-approval-api.test.ts`, `source-approval-store.test.ts` (9c0bb13) | Added 14 Nov 2026; in CI run 44211263890 |
| POST `/api/v1/moderation/events/:eventId/withdraw`; POST `/api/v1/moderation/events/:eventId/corrections` | `moderation-api.ts`, then `proposal-publication.ts` | `moderation-event-actions.test.ts`, `event-withdrawal-correction-db.test.ts` (abe7bf6) | Added abe7bf6; in CI run 44211263890 |
| `?mode=fetch` on `/api/v1/context-sources` and the source-preview route | `context-sources-api.ts`, `source-preview-api.ts` | `fetch-mode-moderator-gate.test.ts`, `poller-redirect-guard.test.ts` (db8893c) | Moderator or admin session only (NFR-04); added db8893c |

What the handler tests prove, from their titles:

- **Contract allowlists.** `l4-public-projection.test.ts` projects "the exact OpenAPI EventView allowlist". `l4-public-event-updates-service.test.ts` projects change labels "through the exact HistoryEntry allowlist".
- **Mode gating.** The live read path is selected only by exact `DATASET_MODE=live` (`api.ts`, lines 168–190). `public-event-list-runtime.test.ts` keeps unset and demo modes on the synthetic list. `api.test.ts` keeps updates unavailable in demo and unset modes "without synthetic fallback".
- **Auth gating, internal proposals.** `service-auth-routes.test.ts` ("internal proposals route: 503 without a configured key, 401 on mismatch, 503 with a key but no database") proves 503 without a configured key, 401 on a missing or wrong key, and 503 with a correct key when no database is configured. `internal-proposals-route.test.ts` ("answers 200 with the service key and a database, and publishes a permitted proposal") proves 200 with the correct key and a PGlite database, with a `published` body and one agent decision. Its titles "answers 200 already_decided when the same proposal is delivered again, with no second version" and "answers 200 queued with reasons when a proposal carries a discrepancy, and publishes nothing" cover the other 200 outcomes. Moderation is "never open access", and the moderation stream requires a moderator session.
- **Error envelopes.** `public-event-detail-runtime.test.ts` keeps database and projection failures generic and redacted. `api.test.ts` preserves the UpdatePage and error envelopes.

Limits. These tests call handlers with injected runtimes (for example, "only the exact live GeoJSON route uses its injected runtime", `api.test.ts`). None of them does a deployed Worker call, and none runs through `serve:live` (section 7).

## 5 State tests: freshness machine

States, from `apps/worker/src/layers/l4-application-integration/freshness-transition-policy.ts` (`FRESHNESS_STATUSES`): `current`, `needs_update`, `expired`.

Transitions, in the order that `evaluateFreshnessTransition` applies them:

1. Issuer validity has ended (now at or after `validUntil`): `expired`, whatever the prior state.
2. New applicable evidence has been evaluated by L4: `current`. This is the only route from a stale state back to `current`.
3. The prior state is not `current`: the prior state is kept (sticky).
4. The review deadline has passed (now at or after `reviewDueAt`): `needs_update`.
5. Otherwise: `current`.

The rules match the accepted design in `SOFTWARE_DEVELOPMENT_PLAN.md` (line 53): issuer `valid_until` ends freshness at the inclusive boundary, a missed `review_due_at` produces `needs_update`, and stale states recover only after newer applicable evidence is evaluated by Layer 4. The policy returns "only freshness and reason without mutating a record or changing lifecycle/publication fields" (`l4-freshness-transition-policy.test.ts`).

The event aggregate in `freshness-aggregate-policy.ts` (lines 31–35) gives `needs_update` if any impact is `needs_update`, or if `current` and `expired` are mixed. It gives `expired` if only `expired` is present, and `current` otherwise. ADR-032 (`docs/decisions/ADR-032-review-deadline-freshness.md`) records this conservative aggregate.

The report's Fig 3.6 shows this machine. That figure was not checked in this worktree, so the rules above come from the code.

| File | Layer or store | What it proves (from test titles) | Status |
| --- | --- | --- | --- |
| `apps/worker/test/l4-freshness-transition-policy.test.ts` | L4 policy (pure) | Deadline equality gives `needs_update` and the instant before stays `current`; issuer expiry at equality beats a due deadline and new evidence; `needs_update` and `expired` are sticky without new evidence; new evidence restores stale states while validity holds; invalid input fails with one redacted error. | In CI step 8 |
| `apps/worker/test/l4-freshness-transition-recorder.test.ts` | L4 recorder | Issuer-expiry and due-review transitions persist through the shared policy; stale-to-current recovery requires exact evidence IDs; current, stale and already-expired no-ops persist nothing. | In CI step 8 |
| `apps/worker/test/source-revision-freshness-transition.test.ts` | L4 coordinator | Explicit RFC3339 times and page bounds are validated before reads; targets deduplicate and expire at equality; withdrawn assertions apply to exact targets; a stale conflict stops appends; a failed port does not advance the page. | In CI step 8 |
| `apps/db/test/freshness-transition-ledger.test.ts` | DB, append-only ledger | Sequence and prior-state checks; idempotent replay, with changed payloads rejected on a reused key; competing appends serialise; recovery evidence is enforced at commit; update and delete are denied on history. | In CI step 6 |
| `apps/db/test/source-revision-freshness-transition-composition.test.ts` | DB composition | Withdrawn freshness is written for exact, directly supported targets without changing immutable publications. | In CI step 6 |
| `apps/db/test/freshness-due-evaluator-composition.test.ts` | DB composition | An exact impact expiry persists, and conservative current-public status is projected without rewriting publication data. | In CI step 6 |
| `apps/worker/test/l4-public-projection.test.ts` | L4 projection | Aggregate cases: each status combination, order independence, rejection of invalid inputs. | In CI step 8 |

Gap: `freshness-aggregate-policy.ts` has no dedicated test file. Its importers are `public-projection.ts`, `public-read-model.ts` and `l4-public-projection.test.ts`, and its cases sit inside the last of these.

## 6 Acyclic dependency check

No dependency-graph or cycle tool was run for this document. The statements below come from a text search of import lines in `apps/worker/src`, `apps/db/src`, `apps/intelligence/src` and `tools`. They are observations for review. They neither establish nor refute acyclicity.

The layer rule (the layer table in the project's local instructions file, which is gitignored and not in this repository): L1 may call one fixed L2 extraction adapter and must not investigate or publish. L2 must not approve sources or publish. L3 must not do ETL or retry without limit. L4 must not treat model confidence as proof. L5 must not silently change evidence policy. The build order in section 2 runs L1, L2, L3, L4.

Observations from the import search:

- `apps/worker/src/layers/l1-data-knowledge/webhook-ingest.ts` no longer imports L2 or L4 modules. Its imports are L1 helpers and types only. The L2 builders and the L4 broadcaster are injected by `apps/worker/src/index.ts` through the ports in `webhook-ingest.ts` (F-03, `cffc865`). Closed on 18 Nov 2026 by reading the import lines. The 13 Nov flag is closed.
- `apps/worker/src/layers/l1-data-knowledge/embedding-generation.ts` imports `apps/worker/src/layers/l2-model-grounding/contracts.ts` as types only.
- `apps/worker/src/layers/l4-application-integration/publication-policy.ts` and `manual-publication-service.ts` import the L2 `contracts.ts` (same directory) as types only.
- The L2 retrieval and grounding modules are imported outside L2 and L3 only by `tools/local-pipeline/processor.ts` and `tools/ai/ninerouter-smoke.ts`.

Acyclicity is not checked. A dependency-graph run over these four trees would be the next step. It is a proposed step, not a result.

## 7 Gaps and limitations

1. **No PGlite test for the webhook path.** `apps/worker/test/webhook-ingest.test.ts` does not import PGlite or `createTestDatabase`.
2. **No PGlite test for BMKG CAP.** `apps/worker/test/bmkg-cap.test.ts` is parser-level and does not import PGlite.
3. **No dedicated test for `freshness-aggregate-policy.ts`** (section 5).
4. **TEST-INT-01 on `main`.** `apps/db/test/l3-investigation-publication-gate.test.ts` covers the L3 to L4 path. Since 593f849 the gate refuses a `stopped_for_review` investigation (F-04, closed locally; the claim-level hold is unchanged). `apps/db/test/investigation-ledger.test.ts` imports no L4 publication module.
5. **No runtime caller for retrieval-before-reasoning.** Its evidence is database-level and local tooling only (section 3.2).
6. **No live-path test in CI.** No step in `ci.yml` runs `serve:live` (LIVE-LOCAL-01) or the live Worker with `apps/intelligence`. The hosted one-cycle path (`serve:hosted-ingest:once`) has fake and PGlite tests only: `tools/accounts/hosted-ingest.test.ts` and `tools/accounts/hosted-once-publication.test.ts`, both run by `accounts:test`.
7. **No browser or responsive checks.** The CI log states "Browser checks. None run in CI."
8. **Hosted behaviour not tested automatically.** The Worker and Neon are deployed (HOSTED-23), but no automated test calls them. Hosted walkthroughs are in `UAT.md` section 9.2 (section 1).
9. **No local test run.** This update rests on the run 44211263890 log (read with `gh`), static checks and file reads. No local test run was made for it.
10. **Preferences are covered by FR-11 tests in part.** M5 names preferences (section 8). The FR-11 files in section 3.3 test interest removal and client-side repeat handling. F-ALERT-01 (repeated coverage publishing a new version) is closed locally by 9d107b6. F-ALERT-02 (a published version is not listed in the updates feed) is closed by 1a11d3c (HOSTED-02), and its test is active.
11. **FR-14 holds on the L2/L3 path and, since 74c4616, on the live intelligence path for the job trace, report lineage and model configuration** (`live-lineage.test.ts`; F-TRACE-01 and F-TRACE-02 are closed locally). The live path still writes no investigation row, so the investigation link is absent for live.
12. **Withdrawal and correction** (abe7bf6) have database and handler tests. The public detail route's 404 for a withdrawn event is not asserted at HTTP, and no public tombstone exists (SDP section 10, recorded limitations).
13. **`scheduled()` in `github_dispatch` mode.** `apps/worker/src/index.ts` returns after `dispatchIngestWorkflow` in this mode. Only `dispatchIngestWorkflow` is unit-tested (`ingest-dispatch.test.ts`, with a fetch fake). No test calls `worker.scheduled()` with `SCHEDULED_MODE=github_dispatch`. The three tests that call `worker.scheduled()` run in demo mode: `l4-freshness-due-schedule-runtime.test.ts`, `l5-freshness-due-schedule-telemetry.test.ts` and `synthetic-poll-schedule-runtime.test.ts`.
14. **The ingest workflow itself.** `.github/workflows/ingest.yml` has no automated test. Its evidence is the run history: 44056409413 and 44071702304 (manual dispatch), 44151179665 (GitHub schedule, which HOSTED-25 removed) and 44217189260 (Worker cron dispatch, 18 Nov 2026). All four show `success` (checked with `gh`).
15. **Production deploy.** `npm run deploy:prod` has no automated test. Its check is the manual smoke list in `docs/DEPLOYMENT.md` section 6.
16. **HOSTED-16 whole-view display on the web.** Unit tests only, in `apps/web/test` (for example `map-home.test.tsx` and `geojson-map.test.tsx`). CI runs no browser check, so CI does not check the rendered page. The walkthrough of the hosted site, including the phone public check, is in `UAT.md` section 9.2.

## 8 Integration gate and status against M5

The gate, from `SOFTWARE_DEVELOPMENT_PLAN.md`, section 8: "M5 Complete application | Weeks 9–10 | One publication gate, moderation, responsive map/feed/details/preferences/briefing and consistent correction updates." The same section adds: "M5 is the integration gate, not the start of that work."

| Criterion | Evidence in this plan | Status |
| --- | --- | --- |
| One publication gate | `manual-publication-gate-composition.test.ts`, `merge-review-publication.test.ts`, `review-expiry.test.ts` | Evidenced at database and Worker level. The `local_relaxed` waiver is an ADR-061 amendment (`merge-review-publication.test.ts`, title "ADR-061 amendment: local live source-permission waiver"); the required default queues an unpermitted source in the same file. |
| Moderation | `moderation-api.test.ts`, `service-auth-routes.test.ts` | Evidenced at route and auth level. |
| Responsive map, feed, details, preferences, briefing | `public-briefing-runtime.test.ts` and the `public-event-*-runtime.test.ts` files cover the API side only | Not evidenced. No browser or responsive check runs in CI (section 7, item 7). |
| Consistent correction updates | `manual-publication-public-read-chain.test.ts`, `l4-public-event-updates-service.test.ts` | Evidenced at database and handler level. |
| Live path | `serve:live`: none in CI. Hosted one-cycle path: fake and PGlite tests only | Not evidenced for `serve:live` (section 7, item 6). The hosted one-cycle path has fake tests only. |

Overall status: partially evidenced. This document does not claim that M5 is complete.

## 9 Test run evidence

Latest run: CI run 44211263890 on commit 6fff929 (`main`, push event, 18 Nov 2026 00:51Z). The conclusion is `success`, confirmed with `gh run view 44211263890` on 18 Nov 2026. The job runs on `ubuntu-24.04` with Node 24.

| CI step | Command | Result in run 44211263890 |
| --- | --- | --- |
| 5 Typecheck | `npm run typecheck` | Pass |
| 6 Database tests | `npm run db:test` | 58 files, 399 tests, 399 pass, 0 fail (one `PASS` line per file) |
| 7 Web tests | `npm run test --workspace=@waspada/web` | 443 pass, 0 fail |
| 8 Worker tests | `npm run test --workspace=@waspada/worker` | 1,311 pass, 0 fail |
| 9 Intelligence tests | `npm run test:intelligence` | 189 pass, 0 fail |
| 10 Pipeline tests | `npm run pipeline:test` | 58 of 58 cases pass |
| 11 Accounts tests | `npm run accounts:test` | 81 pass, 0 fail |
| 12 Evaluation and AI tool tests | `npx tsx --test` (eight files, see `ci.yml`) | 74 pass, 0 fail |
| 13 Build | `npm run build` | Pass (Wrangler dry run) |

Steps 6 to 12 total 2,555 passing tests and 0 failing.

File check for run 44211263890. The job log was read with `gh run view 44211263890 --log`. Each of the 42 test files cited in this document is in the log. The 16 database files print a `PASS` line. The other 26 files each have at least one test title that printed as passed in their step. The other steps print test titles, not file names, so this is a title match. It is not a per-file runner result.

Earlier run for commit cec9358: run 43238566925 (conclusion `success`, confirmed with `gh run view 43238566925`, 12 Nov 2026). The figures below come from the local summary `/mnt/d/Projects/RPL/.codex-build/ci-logs/cec9358/SUMMARY.md`, a gitignored scratch file in the main checkout. That summary names run 117086838832 as its source. `gh run view 117086838832` returns HTTP 404, so that ID is wrong and should not be used. `gh run view 43238566925 --log` returned no log text, so these figures are not re-checked against run 43238566925.

| CI step | Command | Result in log (cec9358) |
| --- | --- | --- |
| 5 Typecheck | `npm run typecheck` | No error lines |
| 6 Database tests | `npm run db:test` | 56 files, 381 tests, 381 pass, 0 fail (per-file runner) |
| 8 Worker tests | `npm run test --workspace=@waspada/worker` | 1,089 tests, 1,089 pass, 0 fail |
| 10 Pipeline tests | `npm run pipeline:test` | Local composition in section 3.2; no failure recorded |

Points on the evidence:

- The overall conclusion is now confirmed with `gh`: `success` for run 44211263890 and for run 43238566925.
- The counts are aggregate. The file check above matches each cited file by title or PASS line. It is not a runner result per file.
- The database file count is now 58: 58 `*.test.ts` files in `apps/db/test`, and 58 `PASS` lines in run 44211263890. At cec9358 it was 56.
- The cec9358 commit is an ancestor of `main` (checked with git).
- No test, build or server was run locally to write this update.

## 10 Detail for the report

Each build below states what its tests check, using the test titles in the repository. The statuses follow section 3 and the gaps in section 7.

### 10.1 Build 1: data and storage

Build 1 covers ingestion from the sources into the database. The PetaBencana test runs ingestion against PGlite and checks that reports, chunks, evidence and geometries are persisted (`petabencana-ingest-pglite.test.ts`). The RSS test checks the identity of revisions through triage and ingest, and the synthetic runtime test runs one poll cycle with a synthetic source (`gated-rss-revision-identity.test.ts` and `synthetic-source-poll-process-runtime.test.ts`). The news triage tests check that a rate-limited model call is a separate outcome from a provider error, and that a 429 response becomes one rate-limited error with no retry inside the call (`news-triage-rate-limit.test.ts`). Two gaps remain: the webhook route (`webhook-ingest.test.ts`) and the BMKG CAP parser are unit-tested, but neither has a database-level test.

### 10.2 Build 2: grounding and retrieval

Build 2 covers evidence retrieval and grounded proposals. The retrieval tests (`evidence-retrieval.test.ts`, 19 tests) check that contrary evidence, revision states and source times are kept, that audience matching is bounded and dataset-scoped, and that malformed audience scope fails closed. The grounding round trip (`rag-grounded-proposal-roundtrip.test.ts`) grounds persisted evidence before reasoning and writes one private draft that replays exactly. When the context is insufficient, it stops before reasoning and writes no proposal. Two further composition tests cover context resumption and embedding generation against the database (`l2-context-resumption-composition.test.ts` and `embedding-generation-composition.test.ts`). The retrieval and grounding modules have no runtime caller outside the tests and the local tools, so these tests are the only integration evidence for Build 2.

### 10.3 Build 3: investigation and the publication gate

Build 3 covers the bounded investigation and the publication gate. The investigation ledger tests (`investigation-ledger.test.ts`, 21 tests) check the progress baseline and its replay, an append-only review marker that blocks progress, and the exact reconciliation that a started action needs. The gate composition test (`manual-publication-gate-composition.test.ts`) runs the gate with the real SQL writer. It checks approval and replay, a conflict when a label changes, and the refusal of a stale evidence assessment before any write. The merge-review test (`merge-review-publication.test.ts`) checks that a proposal without a discrepancy is published by the agent, and that a proposal with a discrepancy waits for a moderator while the earlier public version stays. The expiry test (`review-expiry.test.ts`) checks that an undecided proposal expires after 48 hours.

The composition test TEST-INT-01 (`l3-investigation-publication-gate.test.ts`) runs two cases: a supported claim is published and read publicly, and a stopped investigation with a disputed claim is held before any write. It passed locally when it was first written. Run 44211263890 printed a `PASS` line for the file in the database step (section 9). The gate now refuses a `stopped_for_review` investigation (F-04, fixed in `593f849`).

## 11 Approval

Prepared by: Team 12 (TG-DOCS-02, 18 Nov 2026)

Reviewed by: ____

Approved by: ____

Date: ____
