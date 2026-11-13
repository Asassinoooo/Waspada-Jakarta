# CI visibility of the test files

Source: the GitHub Actions run 117086838832 on commit `cec9358` (`.github/workflows/ci.yml`), kept locally at `.codex-build/ci-logs/cec9358/`. A file is "visible" when its test names (or, for the database and pipeline steps, its `PASS` line) appear in that step's log. The run conclusion is not in the log: confirm it on the GitHub Actions page.

## Steps of the run

| Step | Name in the run | What the log prints |
| --- | --- | --- |
| 5 | Typecheck | tsc output; no error lines |
| 6 | Run Database Tests | one `PASS` line per file, and each test name with a tick |
| 7 | Run Web Tests | each test name with a tick, and totals |
| 8 | Run Worker Tests | each test name with a tick, and totals |
| 9 | Run Intelligence Tests | each test name with a tick, and totals |
| 10 | Run Pipeline Tests | one `PASS` line per case |
| 11 | Run Accounts Tests | each test name with a tick, and totals |
| 12 | Run Evaluation and AI Tool Tests | each test name with a tick, and totals |
| 13 | Build Web and Worker Bundles | Wrangler dry-run output |

Steps 1 to 4 (job setup, checkout, Node.js, install) and the post steps print no test results.

## Test files

| Suite | Test file | Step | Visible in the run |
| --- | --- | --- | --- |
| accounts | `composition.test.ts` | 11 | yes |
| accounts | `local-accounts.test.ts` | 11 | yes |
| db | `accounts.test.ts` | 6 | yes |
| db | `ai-job-rate-limit.test.ts` | 6 | yes |
| db | `embedding-generation-composition.test.ts` | 6 | yes |
| db | `embedding-runs.test.ts` | 6 | yes |
| db | `event-proposal-reader.test.ts` | 6 | yes |
| db | `event-proposal-writer.test.ts` | 6 | yes |
| db | `event-proposals.test.ts` | 6 | yes |
| db | `evidence-chunks.test.ts` | 6 | yes |
| db | `evidence-retrieval.test.ts` | 6 | yes |
| db | `extraction-results.test.ts` | 6 | yes |
| db | `facility-repository.test.ts` | 6 | yes |
| db | `freshness-due-evaluator-composition.test.ts` | 6 | yes |
| db | `freshness-due-run-traces.test.ts` | 6 | yes |
| db | `freshness-due-schedule-runtime-composition.test.ts` | 6 | yes |
| db | `freshness-due-target-reader.test.ts` | 6 | yes |
| db | `freshness-transition-ledger.test.ts` | 6 | yes |
| db | `geometry-writer.test.ts` | 6 | yes |
| db | `grounding-contexts.test.ts` | 6 | yes |
| db | `incident-repository.test.ts` | 6 | yes |
| db | `investigation-ledger.test.ts` | 6 | yes |
| db | `l2-context-resumption-composition.test.ts` | 6 | yes |
| db | `l3-investigation-publication-gate.test.ts` | 6 | no |
| db | `manual-publication-gate-composition.test.ts` | 6 | yes |
| db | `manual-publication-public-read-chain.test.ts` | 6 | yes |
| db | `migrations.test.ts` | 6 | yes |
| db | `news-triage-decisions.test.ts` | 6 | yes |
| db | `password-accounts.test.ts` | 6 | yes |
| db | `persistence.test.ts` | 6 | yes |
| db | `petabencana-ingest-pglite.test.ts` | 6 | yes |
| db | `pipeline-flow-store.test.ts` | 6 | yes |
| db | `postgres-sql-executor.test.ts` | 6 | yes |
| db | `proposal-expiry.test.ts` | 6 | yes |
| db | `public-briefing-candidates.test.ts` | 6 | yes |
| db | `public-event-geojson-candidates.test.ts` | 6 | yes |
| db | `public-event-geometries.test.ts` | 6 | yes |
| db | `public-event-history-disclosure.test.ts` | 6 | yes |
| db | `public-event-history.test.ts` | 6 | yes |
| db | `public-event-list.test.ts` | 6 | yes |
| db | `public-event-snapshot.test.ts` | 6 | yes |
| db | `public-event-updates.test.ts` | 6 | yes |
| db | `public-projection-lookups.test.ts` | 6 | yes |
| db | `publication-outbox-delivery.test.ts` | 6 | yes |
| db | `publication-writer.test.ts` | 6 | yes |
| db | `queue.test.ts` | 6 | yes |
| db | `rag-grounded-proposal-roundtrip.test.ts` | 6 | yes |
| db | `report-revision-impact-reader.test.ts` | 6 | yes |
| db | `report-revision-source-observations.test.ts` | 6 | yes |
| db | `retrieval-limits.test.ts` | 6 | yes |
| db | `source-revision-freshness-run-state.test.ts` | 6 | yes |
| db | `source-revision-freshness-target-reader.test.ts` | 6 | yes |
| db | `source-revision-freshness-transition-composition.test.ts` | 6 | yes |
| db | `source-revision-review-candidate-reader.test.ts` | 6 | yes |
| db | `synthetic-fixture-pipeline.test.ts` | 6 | yes |
| db | `synthetic-poll-schedule-runtime.test.ts` | 6 | yes |
| db | `synthetic-publication-isolation-composition.test.ts` | 6 | yes |
| db | `synthetic-schedule-process-runtime-composition.test.ts` | 6 | yes |
| db | `synthetic-source-poll-process-runtime.test.ts` | 6 | yes |
| eval | `benchmark-runner.test.ts` | 12 | no |
| eval | `casebook-cli.test.ts` | 12 | yes |
| eval | `casebook.test.ts` | 12 | yes |
| eval | `extraction-probe.test.ts` | 12 | yes |
| eval | `ninerouter-cli.test.ts` | 12 | yes |
| eval | `ninerouter-smoke.test.ts` | 12 | yes |
| intel | `ai-call-profile.test.ts` | 9 | yes |
| intel | `ai-rate-limit-job-runner.test.ts` | 9 | yes |
| intel | `classification-fallback.test.ts` | 9 | yes |
| intel | `correlation-validation.test.ts` | 9 | yes |
| intel | `dataset-kind.test.ts` | 9 | yes |
| intel | `incident-correlator.test.ts` | 9 | yes |
| intel | `job-worker.test.ts` | 9 | yes |
| intel | `merge-review.test.ts` | 9 | yes |
| intel | `mock-chat-mode.test.ts` | 9 | yes |
| intel | `ninerouter-adapter.test.ts` | 9 | yes |
| intel | `ninerouter-mastra-rate-limit.test.ts` | 9 | yes |
| intel | `ninerouter-rate-gate.test.ts` | 9 | yes |
| intel | `proposal-id-integrity.test.ts` | 9 | yes |
| intel | `report-interpreter.test.ts` | 9 | yes |
| intel | `retrieval-caps.test.ts` | 9 | yes |
| intel | `semantic-retrieval.test.ts` | 9 | yes |
| intel | `workflow.test.ts` | 9 | yes |
| pipeline | `app-composition.test.ts` | 10 | yes |
| pipeline | `cli.test.ts` | 10 | yes |
| pipeline | `models.test.ts` | 10 | yes |
| pipeline | `pipeline.test.ts` | 10 | yes |
| pipeline | `preview.test.ts` | 10 | yes |
| pipeline | `processor.test.ts` | 10 | yes |
| pipeline | `scheduler.test.ts` | 10 | yes |
| pipeline | `server.test.ts` | 10 | yes |
| pipeline | `store.test.ts` | 10 | yes |
| web | `account-messages.test.ts` | 7 | yes |
| web | `accounts.test.tsx` | 7 | yes |
| web | `admin-dashboard.test.tsx` | 7 | yes |
| web | `admin-map.test.tsx` | 7 | yes |
| web | `admin-monitoring.test.ts` | 7 | yes |
| web | `admin-workspace.test.tsx` | 7 | yes |
| web | `api-client.test.ts` | 7 | yes |
| web | `context-source-composition.test.ts` | 7 | yes |
| web | `context-sources.test.tsx` | 7 | yes |
| web | `embedding-pca.test.ts` | 7 | yes |
| web | `embedding-visualization.test.tsx` | 7 | yes |
| web | `experience.test.tsx` | 7 | yes |
| web | `geojson-map.test.tsx` | 7 | yes |
| web | `local-pipeline-preview.test.tsx` | 7 | yes |
| web | `map-home.test.tsx` | 7 | yes |
| web | `map-motion.test.ts` | 7 | no |
| web | `map-popup.test.tsx` | 7 | yes |
| web | `map-severity.test.tsx` | 7 | no |
| web | `moderator-review.test.tsx` | 7 | yes |
| web | `onboarding-intro.test.tsx` | 7 | yes |
| web | `page-header.test.tsx` | 7 | yes |
| web | `pipeline-flow-client.test.ts` | 7 | no |
| web | `pipeline-flow-model.test.ts` | 7 | yes |
| web | `pipeline-flow.test.tsx` | 7 | yes |
| web | `preferences.test.tsx` | 7 | yes |
| web | `public-published-feed.test.tsx` | 7 | yes |
| web | `source-point-map.test.tsx` | 7 | yes |
| web | `source-preview.test.tsx` | 7 | yes |
| web | `ui-primitives.test.tsx` | 7 | yes |
| web | `ui.test.tsx` | 7 | yes |
| web | `unified-source-explorer.test.tsx` | 7 | yes |
| web | `updates-center.test.tsx` | 7 | yes |
| worker | `accounts-api.test.ts` | 8 | yes |
| worker | `accounts-password.test.ts` | 8 | yes |
| worker | `accounts-runtime.test.ts` | 8 | yes |
| worker | `api.test.ts` | 8 | yes |
| worker | `bmkg-cap.test.ts` | 8 | yes |
| worker | `bmkg-poll-runtime.test.ts` | 8 | yes |
| worker | `context-sources.test.ts` | 8 | yes |
| worker | `det-filter-shadow-eval.test.ts` | 8 | yes |
| worker | `deterministic-filter-integration.test.ts` | 8 | yes |
| worker | `deterministic-relevance.test.ts` | 8 | yes |
| worker | `discrepancy-detector.test.ts` | 8 | yes |
| worker | `embedding-generation.test.ts` | 8 | yes |
| worker | `embedding-visualization-api.test.ts` | 8 | yes |
| worker | `event-broadcaster.test.ts` | 8 | yes |
| worker | `gated-rss-ledger-grants.test.ts` | 8 | yes |
| worker | `gated-rss-permissions.test.ts` | 8 | yes |
| worker | `gated-rss-persistence-parity.test.ts` | 8 | yes |
| worker | `gated-rss-revision-identity.test.ts` | 8 | yes |
| worker | `l1-fixture-runner-telemetry.test.ts` | 8 | yes |
| worker | `l1-text-preparation.test.ts` | 8 | yes |
| worker | `l2-context-persistence.test.ts` | 8 | yes |
| worker | `l2-direct-reasoning.test.ts` | 8 | yes |
| worker | `l2-evidence-retrieval.test.ts` | 8 | yes |
| worker | `l2-grounding-context-resumption.test.ts` | 8 | yes |
| worker | `l2-grounding-context.test.ts` | 8 | yes |
| worker | `l2-investigation-planner.test.ts` | 8 | yes |
| worker | `l2-model-grounding.test.ts` | 8 | yes |
| worker | `l2-reasoning-proposal-bridge.test.ts` | 8 | yes |
| worker | `l3-coordinator-telemetry.test.ts` | 8 | yes |
| worker | `l3-insufficient-context-entry.test.ts` | 8 | yes |
| worker | `l3-investigation-coordinator.test.ts` | 8 | yes |
| worker | `l3-investigation-telemetry.test.ts` | 8 | yes |
| worker | `l3-progress-fingerprint.test.ts` | 8 | yes |
| worker | `l3-reasoning-step-executor.test.ts` | 8 | yes |
| worker | `l3-single-step-executor.test.ts` | 8 | yes |
| worker | `l4-freshness-due-evaluator.test.ts` | 8 | yes |
| worker | `l4-freshness-due-schedule-runtime.test.ts` | 8 | yes |
| worker | `l4-freshness-transition-policy.test.ts` | 8 | yes |
| worker | `l4-freshness-transition-recorder.test.ts` | 8 | yes |
| worker | `l4-manual-publication-service.test.ts` | 8 | yes |
| worker | `l4-moderator-authorization.test.ts` | 8 | yes |
| worker | `l4-proposal-category-projection.test.ts` | 8 | yes |
| worker | `l4-public-briefing-projection.test.ts` | 8 | yes |
| worker | `l4-public-event-detail-projection-service.test.ts` | 8 | yes |
| worker | `l4-public-event-history-projection-service.test.ts` | 8 | yes |
| worker | `l4-public-event-list-cursor.test.ts` | 8 | yes |
| worker | `l4-public-event-list-page-service.test.ts` | 8 | yes |
| worker | `l4-public-event-list-projection-service.test.ts` | 8 | yes |
| worker | `l4-public-event-list-query.test.ts` | 8 | yes |
| worker | `l4-public-event-projection-service.test.ts` | 8 | yes |
| worker | `l4-public-event-updates-cursor.test.ts` | 8 | yes |
| worker | `l4-public-event-updates-service.test.ts` | 8 | yes |
| worker | `l4-public-geojson-candidate-projection.test.ts` | 8 | yes |
| worker | `l4-public-geometry-projection.test.ts` | 8 | yes |
| worker | `l4-public-projection.test.ts` | 8 | yes |
| worker | `l4-publication-policy.test.ts` | 8 | yes |
| worker | `l5-freshness-due-schedule-telemetry.test.ts` | 8 | yes |
| worker | `l5-synthetic-poll-process-telemetry.test.ts` | 8 | yes |
| worker | `location-candidates.test.ts` | 8 | yes |
| worker | `merge-review-gate.test.ts` | 8 | yes |
| worker | `merge-review-publication.test.ts` | 8 | yes |
| worker | `moderation-api.test.ts` | 8 | yes |
| worker | `multisource-correlator.test.ts` | 8 | yes |
| worker | `news-ai-call-profile.test.ts` | 8 | yes |
| worker | `news-poll-runtime.test.ts` | 8 | yes |
| worker | `news-triage-rate-limit.test.ts` | 8 | yes |
| worker | `news-triage-transport.test.ts` | 8 | yes |
| worker | `news-triage.test.ts` | 8 | yes |
| worker | `ninerouter-provider.test.ts` | 8 | yes |
| worker | `petabencana-geojson.test.ts` | 8 | yes |
| worker | `petabencana-ingest.test.ts` | 8 | yes |
| worker | `petabencana-poll-runtime.test.ts` | 8 | yes |
| worker | `pipeline-flow-api.test.ts` | 8 | yes |
| worker | `pipeline-flow-route.test.ts` | 8 | yes |
| worker | `pipeline-runtime-status.test.ts` | 8 | yes |
| worker | `proposal-engine.test.ts` | 8 | yes |
| worker | `public-briefing-runtime.test.ts` | 8 | yes |
| worker | `public-event-detail-runtime.test.ts` | 8 | yes |
| worker | `public-event-geojson-runtime.test.ts` | 8 | yes |
| worker | `public-event-history-runtime.test.ts` | 8 | yes |
| worker | `public-event-list-runtime.test.ts` | 8 | yes |
| worker | `public-event-updates-runtime.test.ts` | 8 | yes |
| worker | `public-severity.test.ts` | 8 | no |
| worker | `publication-outbox-delivery-runtime.test.ts` | 8 | yes |
| worker | `review-expiry.test.ts` | 8 | yes |
| worker | `rss-discovery.test.ts` | 8 | yes |
| worker | `rss-news-ingest.test.ts` | 8 | yes |
| worker | `semantic-retriever.test.ts` | 8 | yes |
| worker | `service-auth-routes.test.ts` | 8 | yes |
| worker | `source-preview-route.test.ts` | 8 | yes |
| worker | `source-preview.test.ts` | 8 | yes |
| worker | `source-revision-freshness-public-projection.test.ts` | 8 | yes |
| worker | `source-revision-freshness-transition.test.ts` | 8 | yes |
| worker | `synthetic-fixture-runner.test.ts` | 8 | yes |
| worker | `synthetic-source-poll-runner.test.ts` | 8 | yes |
| worker | `traffic-gazetteer.test.ts` | 8 | yes |
| worker | `webhook-ingest.test.ts` | 8 | yes |

## Files not in the run

- `benchmark-runner.test.ts` (tools/evaluation): not in any test script, so no CI step runs it.
- `l3-investigation-publication-gate.test.ts` (TEST-INT-01): merged after the run. It sits in the database directory scan, so it runs in step 6 of the next run.
- `map-motion.test.ts`, `map-severity.test.tsx`, `pipeline-flow-client.test.ts` (web) and `public-severity.test.ts` (worker): added after the run and listed in their package test scripts, so they run in the next run.
