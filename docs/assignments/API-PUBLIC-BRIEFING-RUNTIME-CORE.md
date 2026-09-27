# API-PUBLIC-BRIEFING-RUNTIME-CORE — wire the exact-live briefing route

- **Backlog ID:** `API-PUBLIC-BRIEFING-RUNTIME-CORE`
- **Objective:** Implement the existing transient `POST /api/v1/briefings` contract by composing exact public candidates, strict event projections, and the pure exact-interest briefing projection in an exact-live Worker runtime.
- **Dependencies:** `API-PUBLIC-BRIEFING-CANDIDATE-READER-CORE`, `API-BRIEFING-PROJECTION-CORE`, `API-PUBLIC-SNAPSHOT-CORE`, `API-PUBLIC-LOOKUPS-CORE`, `API-PUBLIC-EVENT-LIST-RUNTIME-CORE`, `SPEC-03`, `ADR-020`, `ADR-024`, `ADR-025`.
- **Branch/worktree:** `work/API-PUBLIC-BRIEFING-RUNTIME-CORE` in a free managed worktree based on pushed `main`; root will prepare the checkout before implementation. Do not edit through the root checkout.
- **Contract baseline:** Existing `BriefingRequest`, `BriefingResponse`, and `BriefingItem` in `docs/api/openapi.yaml`; exact matching in [API-BRIEFING-PROJECTION-CORE](API-BRIEFING-PROJECTION-CORE.md); candidate selection in [API-PUBLIC-BRIEFING-CANDIDATE-READER-CORE](API-PUBLIC-BRIEFING-CANDIDATE-READER-CORE.md); route snapshot policy in [ADR-025](../decisions/ADR-025-exact-live-briefing-runtime.md). Do not alter the DTO, OpenAPI, or preference-store behavior.
- **Allowed paths:** `apps/worker/src/layers/l4-application-integration/api.ts`, `apps/worker/src/index.ts`, `apps/worker/src/runtime/public-briefing-runtime.ts`, `apps/worker/test/api.test.ts`, `apps/worker/test/public-briefing-runtime.test.ts`, `apps/worker/package.json` only if needed to register a focused test, and this assignment's handoff section.
- **Prohibited scope:** OpenAPI/DTO changes, browser UI, update feed, preference persistence or account identity, model/provider/source access, publication/moderation writes, migrations/indexes/grants/roles, new dependencies, deployment/bindings, live data, external service calls, or changes to the candidate reader/projector semantics.

## Required behavior

1. Add only `POST /api/v1/briefings` using the existing request and response shapes. It is available only for exact server-selected `DATASET_MODE=live` with the configured runtime. The checked-in demo mode must never return synthetic relevance. GET and unsupported methods do not invoke the runtime.
2. Accept `application/json` only. Bound actual streamed request bytes to 256 KiB, reject an advertised oversized `Content-Length` early, use fatal UTF-8 decoding, and return a stable generic 400 for malformed JSON, wrong media type, transport overflow, or invalid closed `BriefingRequest`. Do not echo or log request values.
3. Keep interests transient in memory for the request. Do not write user preference, request, or event records. Empty interests return the existing empty response through the pure projector without reading snapshots.
4. Build the live runtime only for exact `live` mode and a valid Hyperdrive connection string; initialize no database client until the route is called. Reuse the injected `SqlExecutor` runner seam and existing DB repositories. Add no environment binding or config change.
5. In one request-scoped connection, start a `REPEATABLE READ READ ONLY` transaction. Select candidates with the accepted DB reader, read each exact current snapshot and its approved scope/source lookups through existing strict Layer 4 services, and finish the transaction only after building the complete response. Commit on success; attempt rollback on any failure while preserving only bounded public errors.
6. Project no more than 100 candidates. Preserve candidate order when concurrent projections complete. Validate event identity and exact version against each candidate; a missing/latest-withdrawn event, version mismatch, invalid projection, 101st candidate, query failure, or incomplete result fails the whole response. Never truncate or return a partial briefing. Reapply `projectPublicBriefing` with exact `live` mode and one UTC `generated_at` value.
7. Map malformed requests to `400 INVALID_REQUEST`. For overflow, unavailable runtime, transaction failure, or invalid/stale public results, return the existing generic unavailable error/status without exposing database details or event/interest content. Use `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and privacy-safe telemetry with route/status/duration only.
8. Preserve the user's public-history rule: withdrawn versions and all history for an event whose latest version is withdrawn stay hidden. The route returns only current projected `EventView`s; the reader may use version 1's timestamp solely for candidate ordering. Do not query the history endpoint or serialize old versions.
9. Tests use injected fake runners/executors and authored fictional PGlite values. Cover exact live/demo/config gates, method/path behavior, JSON/media type/UTF-8/byte limit, validation before SQL, empty interests, transaction begin/read-only/commit and rollback, request-scoped single-runner behavior, ordered exact-version projection, latest withdrawal/mismatch/overflow fail-closed behavior, stable errors, no partial output, privacy-safe telemetry, and absence of writes/model/source calls.

## Verification (WSL Ubuntu-26.04 only)

Record runtime/package versions. Reuse installed dependencies. Run focused API and runtime tests, Worker suite, full `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`. Do not install dependencies or run any live/paid provider. Report actual results; no local fixture test establishes hosted Neon collation, latency, or physical query cost.

## Stop conditions

Stop if the required exact request/response shape cannot be implemented without changing OpenAPI, if a read-only repeatable-read transaction cannot run through the existing adapter, if current candidate/version checks cannot preserve all-or-nothing behavior, or if configuration/schema/grant/provider changes are needed. Report the precise gap; do not add persistence, synthetic relevance, or fallback scans. Escalate to GPT-6 Astra xhigh only after a GPT-6 Luna Max attempt encounters a substantive technical difficulty it cannot resolve; usage or scheduling delays do not qualify.

## Implementation handoff

Append branch/worktree, exact commit SHA(s) and messages, changed paths, behavior, actual checks/results, runtime versions, limitations, configuration impact, and remaining decisions. Commit on the assigned branch; do not merge or push. Root independently reviews, accepts, and integrates.

### Completed implementation handoff

- **Branch/worktree:** work/API-PUBLIC-BRIEFING-RUNTIME-CORE; Windows C:\Users\perry\.codex\worktrees\api-geojson-route-core\RPL; WSL /mnt/c/Users/perry/.codex/worktrees/api-geojson-route-core/RPL.
- **Implementation commit:** 4153b5d8cf0cd649b32698f2f0866a8d10944905 — feat(api): add exact-live public briefing runtime.
- **Changed paths:** apps/worker/package.json; apps/worker/src/index.ts; apps/worker/src/layers/l4-application-integration/api.ts; apps/worker/src/runtime/public-briefing-runtime.ts; apps/worker/test/public-briefing-runtime.test.ts; this assignment handoff section.
- **Behavior:** Added the transient exact-live POST /api/v1/briefings route with a 256 KiB streamed request bound, strict JSON/UTF-8 and closed-request validation, empty-interest projection without SQL, and one read-only repeatable-read request snapshot. The runtime composes the accepted candidate reader, strict current public event projections, and pure briefing projector; checks candidate order and exact versions, preserves order across bounded concurrent projections, waits for all siblings before rollback, and returns only complete responses. Failures are generic and telemetry contains only the existing fixed route bucket, status, and duration. Withdrawn events and their history remain hidden.
- **Checks:** Focused API/runtime tests 43/43 passed; Worker suite 251/251 passed; full npm test exited 0 (web 33 tests, Worker 251 tests, DB suite 19/19 files, evaluation 12 tests); full npm run typecheck passed; npm run build passed including Wrangler dry run; git diff --check passed. All checks ran in WSL Ubuntu-26.04.
- **Runtime/package versions:** Node v24.21.0; npm 11.19.0; tsx 4.23.15; TypeScript 7.0.2; Wrangler 4.137.0.
- **Limitations:** Tests use fake executors and authored fictional fixtures. Hosted Neon behavior, collation, latency, and physical query cost were not measured. Briefing telemetry remains in the existing coarse other route bucket because the telemetry route-label implementation is outside the task allowed paths.
- **Configuration/migration impact:** None. No migration, schema, grant, index, binding, deployment, or dependency changes. Existing exact DATASET_MODE=live and valid Hyperdrive configuration are required; demo remains unavailable for briefing relevance.
- **Remaining decisions:** None for this implementation. Independent root review and integration remain pending.
