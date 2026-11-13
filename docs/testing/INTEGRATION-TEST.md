# Integration test plan and report: Waspada Jakarta

| Field | Value |
| --- | --- |
| Identifier | TEST-DOC-01 (report Chapter 5, section 5.3) |
| Status date | 13 Nov 2026 |
| Baseline | Branch `work/TEST-DOC-01-chapter5`, based on `main` at ae75527 |
| Method | Static check of file existence, test titles and import lines. No test, build or server was run to write this document. |
| Structure | IEEE 829 test-plan sections, with the integration approach of Braude, Ch 27 (build order, facades, state tests, acyclic dependencies) |

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
- The web UI (`apps/web`). CI runs no browser checks (`/mnt/d/Projects/RPL/.codex-build/ci-logs/cec9358/SUMMARY.md`, section 9).
- Live network, model and source calls. `npm run serve:live` (LIVE-LOCAL-01 in `docs/IMPLEMENTATION_BACKLOG.md`) is not part of the test evidence in section 9.
- Hosted Cloudflare and Neon behaviour. These tests do not clear source rights or establish hosted behaviour (`SOFTWARE_DEVELOPMENT_PLAN.md`, section 8, closing paragraph).

Status terms in section 3 and section 4:

- **In CI step N** means the file sits in a suite that CI ran at commit cec9358. The step numbers come from the CI log. The log records aggregate results only, so the status does not claim a pass for any single file.
- **TEST-INT-01** is on `main` (commit `71022ee`), so its rows are marked Written.

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

Caller check. The retrieval and grounding modules (`retrieval.ts`, `direct-reasoning.ts`, `context-resumption.ts`, `grounding-context.ts`, `context-persistence.ts`, `reasoning-proposal-bridge.ts`) have no importer outside L2, L3, the tests and two local tools: `tools/local-pipeline/processor.ts` and `tools/ai/ninerouter-smoke.ts`. The Worker does call L2 proposal generation at runtime. `apps/worker/src/layers/l1-data-knowledge/webhook-ingest.ts` imports `proposal-engine.ts` and `correlated-proposal-engine.ts`, and the handler is mounted in `apps/worker/src/index.ts`. So the database tests in this build are the only evidence for retrieval-before-reasoning, and the composition evidence for the webhook proposal path is `webhook-ingest.test.ts` in section 3.1.

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
| TEST-INT-01 | L3 output into L4 gate | `apps/db/test/l3-investigation-publication-gate.test.ts` takes an L3 ledger context through the reasoning bridge and the manual gate. Case TI-02 holds on claims, not on ledger status (F-04). | Written (`71022ee` on `main`) |

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
| POST `/api/v1/internal/proposals` (service key) | `index.ts` | `service-auth-routes.test.ts` | In CI step 8 |
| `/api/v1/ingestion/events` (webhook) | `index.ts`, then `webhook-ingest.ts` | `webhook-ingest.test.ts`, `service-auth-routes.test.ts` | In CI step 8 |
| `/api/v1/moderation/*` | `index.ts`, then `moderation-api.ts` | `moderation-api.test.ts`, `service-auth-routes.test.ts` | In CI step 8 |
| GET `/api/v1/pipeline/flow` | `pipeline-flow-api.ts` | `pipeline-flow-route.test.ts` | In CI step 8 |

What the handler tests prove, from their titles:

- **Contract allowlists.** `l4-public-projection.test.ts` projects "the exact OpenAPI EventView allowlist". `l4-public-event-updates-service.test.ts` projects change labels "through the exact HistoryEntry allowlist".
- **Mode gating.** The live read path is selected only by exact `DATASET_MODE=live` (`api.ts`, lines 168–190). `public-event-list-runtime.test.ts` keeps unset and demo modes on the synthetic list. `api.test.ts` keeps updates unavailable in demo and unset modes "without synthetic fallback".
- **Auth gating.** `service-auth-routes.test.ts` answers 503 without a configured key, 401 on mismatch and 200 with the key, for internal proposals. Moderation is "never open access", and the moderation stream requires a moderator session.
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

- `apps/worker/src/layers/l1-data-knowledge/webhook-ingest.ts` imports, at runtime, `generateProposalFromReport` and related types from L2 `proposal-engine.ts`, and `generateCorrelatedProposal` from L2 `correlated-proposal-engine.ts`. It also imports `eventBroadcaster` from L4 `event-broadcaster.ts` (import block, lines 13–24). This is more than the single L2 adapter the L1 rule allows, and the L4 import points upward. Flag for review.
- `apps/worker/src/layers/l1-data-knowledge/embedding-generation.ts` imports `apps/worker/src/layers/l2-model-grounding/contracts.ts` as types only.
- `apps/worker/src/layers/l4-application-integration/publication-policy.ts` and `manual-publication-service.ts` import the L2 `contracts.ts` (same directory) as types only.
- The L2 retrieval and grounding modules are imported outside L2 and L3 only by `tools/local-pipeline/processor.ts` and `tools/ai/ninerouter-smoke.ts`.

Acyclicity is not checked. A dependency-graph run over these four trees would be the next step. It is a proposed step, not a result.

## 7 Gaps and limitations

1. **No PGlite test for the webhook path.** `apps/worker/test/webhook-ingest.test.ts` does not import PGlite or `createTestDatabase`.
2. **No PGlite test for BMKG CAP.** `apps/worker/test/bmkg-cap.test.ts` is parser-level and does not import PGlite.
3. **No dedicated test for `freshness-aggregate-policy.ts`** (section 5).
4. **TEST-INT-01 on `main`.** `apps/db/test/l3-investigation-publication-gate.test.ts` covers the L3 to L4 path, but the gate does not read the ledger status (F-04). `apps/db/test/investigation-ledger.test.ts` imports no L4 publication module.
5. **No runtime caller for retrieval-before-reasoning.** Its evidence is database-level and local tooling only (section 3.2).
6. **No live-path test.** No step in the CI log (section 9) runs `serve:live` (LIVE-LOCAL-01) or the live Worker with `apps/intelligence`.
7. **No browser or responsive checks.** The CI log states "Browser checks. None run in CI."
8. **Hosted behaviour untested.** Cloudflare and Neon behaviour is outside this plan (section 1).
9. **No local run.** This document rests on CI aggregates and static checks. No local test run was made for it.
10. **Preferences are not covered here.** M5 names preferences (section 8), but no file in sections 3 or 4 tests them. Web tests are outside this plan.

## 8 Integration gate and status against M5

The gate, from `SOFTWARE_DEVELOPMENT_PLAN.md`, section 8: "M5 Complete application | Weeks 9–10 | One publication gate, moderation, responsive map/feed/details/preferences/briefing and consistent correction updates." The same section adds: "M5 is the integration gate, not the start of that work."

| Criterion | Evidence in this plan | Status |
| --- | --- | --- |
| One publication gate | `manual-publication-gate-composition.test.ts`, `merge-review-publication.test.ts`, `review-expiry.test.ts` | Evidenced at database and Worker level. The `local_relaxed` waiver is an ADR-061 amendment (`merge-review-publication.test.ts`, title "ADR-061 amendment: local live source-permission waiver"); the required default queues an unpermitted source in the same file. |
| Moderation | `moderation-api.test.ts`, `service-auth-routes.test.ts` | Evidenced at route and auth level. |
| Responsive map, feed, details, preferences, briefing | `public-briefing-runtime.test.ts` and the `public-event-*-runtime.test.ts` files cover the API side only | Not evidenced. No browser or responsive check runs in CI (section 7, item 7). |
| Consistent correction updates | `manual-publication-public-read-chain.test.ts`, `l4-public-event-updates-service.test.ts` | Evidenced at database and handler level. |
| Live path | None | Not evidenced (section 7, item 6). |

Overall status: partially evidenced. This document does not claim that M5 is complete.

## 9 Test run evidence

Source: CI run 117086838832 on commit cec9358 (12 Nov 2026). The log summary is `/mnt/d/Projects/RPL/.codex-build/ci-logs/cec9358/SUMMARY.md`, a gitignored scratch file in the main checkout.

| CI step | Command | Result in log |
| --- | --- | --- |
| 5 Typecheck | `npm run typecheck` | No error lines |
| 6 Database tests | `npm run db:test` | 56 files, 381 tests, 381 pass, 0 fail (per-file runner) |
| 8 Worker tests | `npm run test --workspace=@waspada/worker` | 1,089 tests, 1,089 pass, 0 fail |
| 10 Pipeline tests | `npm run pipeline:test` | Local composition in section 3.2; no failure recorded |

Points on the evidence:

- The log does not record the overall run conclusion. The summary says to confirm it on the Actions page before stating that CI passed. This document does not state it.
- The log is for cec9358. That commit is an ancestor of `main` (checked with git). This worktree is based on `main` at ae75527, and no CI log for ae75527 is cited here.
- The counts are aggregate. Section 3 does not claim a pass for any single file.
- The 56 database files in the log match the 56 `*.test.ts` files in `apps/db/test` at ae75527.
- No test, build or server was run to write this document.
