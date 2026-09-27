# API-PUBLIC-GEOJSON-RUNTIME-CORE — wire the bounded live GeoJSON read

- **Backlog ID:** `API-PUBLIC-GEOJSON-RUNTIME-CORE`
- **Objective:** Enable the existing GeoJSON GET in exact live mode by composing the accepted bbox candidate reader, bounded current snapshots/impacts, reviewed public lookup reader, strict L4 feature projector, and request-scoped PostgreSQL adapter.
- **Dependencies:** `API-PUBLIC-GEOJSON-CANDIDATE-READER-CORE`, `API-PUBLIC-GEOJSON-PROJECTION-CORE`, `API-PUBLIC-SNAPSHOT-CORE`, `API-PUBLIC-LOOKUPS-CORE`, `DB-HYPERDRIVE-SQL-EXECUTOR-CORE`, `API-GEOJSON-ROUTE-CORE`, [ADR-012](../decisions/ADR-012-public-projection-boundary.md), [ADR-018](../decisions/ADR-018-jakarta-geojson-query-envelope.md), [ADR-023](../decisions/ADR-023-public-geojson-candidate-selection.md).
- **Requirements:** `FR-09/10`; `NFR-01/07`.
- **Layer:** L4 runtime composition over L1 candidate/snapshot/lookup readers; database access remains through existing least-privilege views.
- **Contract boundary:** Preserve the current OpenAPI `PublicFeatureCollection`, bbox/category/lifecycle/freshness query vocabulary, content type, and generic error envelope. No DTO or OpenAPI edits.
- **Branch/worktree:** `work/API-PUBLIC-GEOJSON-RUNTIME-CORE` in the reusable managed checkout `C:\Users\perry\.codex\worktrees\api-geojson-route-core\RPL` (WSL: `/mnt/c/Users/perry/.codex/worktrees/api-geojson-route-core/RPL`), based on the root's pushed assignment commit. Do not edit through the root checkout.
- **Owner:** GPT-6 Luna Max implementation agent. Root plans, independently reviews, integrates, and pushes.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md` (first repository document), then `docs/IMPLEMENTATION_BACKLOG.md` and this assignment
- [ADR-012](../decisions/ADR-012-public-projection-boundary.md), [ADR-018](../decisions/ADR-018-jakarta-geojson-query-envelope.md), [ADR-023](../decisions/ADR-023-public-geojson-candidate-selection.md), [GeoJSON OpenAPI operation](../api/openapi.yaml)
- [Candidate reader](API-PUBLIC-GEOJSON-CANDIDATE-READER-CORE.md), [accepted strict projector](API-PUBLIC-GEOJSON-PROJECTION-CORE.md), [snapshot repository](../../apps/db/src/public-event-snapshot.ts), [lookup repository](../../apps/db/src/public-projection-lookups.ts), [history/detail runtimes](API-PUBLIC-HISTORY-RUNTIME-CORE.md)
- `apps/db/src/public-event-geojson-candidates.ts`, `apps/db/src/public-event-snapshot.ts`, `apps/db/src/public-projection-lookups.ts`, `apps/db/src/postgres-sql-executor.ts`
- `apps/worker/src/layers/l4-application-integration/public-geojson-query.ts`, `public-geometry-projection.ts`, `api.ts`, `index.ts` and existing API/runtime tests

## Required behavior

1. Add an injected live GeoJSON runtime for exact `DATASET_MODE=live` `GET /api/v1/events.geojson` only. Keep the default/unset and explicit demo paths backed by the existing synthetic reader. Enable no other live route.
2. Reuse `readPublicGeoJSONQuery` and its existing validation/envelope. Convert its optional filters to the candidate reader input without changing query semantics. Invalid, repeated, unknown, oversized, or out-of-envelope query values must fail before any SQL executor operation. A malformed/missing Hyperdrive connection must also leave SQL unopened.
3. For each valid request, use exactly one invocation of `withPostgresSqlExecutor`. Construct the candidate reader, snapshot repository, and approved lookup repository inside that request-scoped callback. Do not create per-feature database connections or perform an N+1 snapshot/impact query.
4. Extend the existing snapshot repository with a bounded bulk-read operation for distinct candidate event IDs. It must use only the existing safe public views, return the exact current live Event version and its current impacts, validate closed row shapes/identities, enforce the existing 100-impact-per-event limit plus a 10,000-impact request-wide cap with an overflow probe, detect overflows rather than truncate, and sort deterministically. Preserve the current single-event `read` behavior. Add focused DB tests; do not add a migration or query base tables.
5. Group candidates by exact `eventId`/`eventVersion`. Each group must resolve to exactly one found current snapshot with identical ID/version. Missing snapshots, version drift, inconsistent duplicates, withdrawal, or malformed records fail the whole request; never use an older version or silently drop a candidate.
6. Derive the exact scope-name and supporting-attribution keys needed by each candidate event from the accepted strict projector's preparation boundary. Deduplicate exact keys across the request and resolve them using the existing public lookup reader in deterministic batches of at most 100 scope keys and 100 support references per call. Keep calls sequential within the one SQL operation. Enforce the projector's aggregate work limits before creating unbounded arrays. Partition only validated resolved values into exact event/version lookup batches; missing or unapproved required values must fail closed through the accepted projection.
7. Pass the bounded candidate set and matching snapshot/lookup inputs to `projectPublicGeoJSONCandidateCollection`. Return its entire unchanged `PublicFeatureCollection`. An empty candidate set returns the exact empty collection and triggers no snapshot or lookup reads; it never states or implies that an area is safe or has no reports.
8. Any candidate overflow, snapshot/lookup/projector failure, or current-version mismatch returns the existing fixed generic unavailable response with no partial features, IDs, bounds, evidence, SQL, source text, or internal errors. A current latest-withdrawn event remains absent. The user has decided that withdrawn versions and all history after a latest withdrawal stay hidden; do not fall back to an earlier version or expose a retraction feature.
9. Preserve exact source-supported geometry and coordinates without clipping, buffering, or inventing danger radii. Preserve the existing `application/geo+json` response and cache/security headers. Keep telemetry allowlisted and free of query contents or identifiers.

## Allowed paths

- `apps/db/src/public-event-snapshot.ts`
- `apps/db/test/public-event-snapshot.test.ts`
- New `apps/worker/src/runtime/public-event-geojson-runtime.ts`
- `apps/worker/src/index.ts`
- `apps/worker/src/layers/l4-application-integration/api.ts`
- New `apps/worker/test/public-event-geojson-runtime.test.ts`
- `apps/worker/test/api.test.ts`
- `apps/worker/package.json` — focused test registration only
- This assignment's implementation handoff only

Do not edit contracts, OpenAPI, migrations, database views/schema, lookup/candidate-reader implementations, candidate projection, public query parser, Wrangler/deployment configuration, lockfiles, source/provider settings, or any other task. No new dependency, binding ID, secret, provider resource, paid API, live source, or hosted connection is authorized. Ask root if the accepted port/DTO cannot express the required behavior.

## Acceptance criteria

- Exact-live valid GET composes the accepted candidate reader, bulk current snapshots and impacts, deduplicated reviewed lookups, and strict projector within one SQL executor operation.
- Query validation and configuration validation occur before that operation; a request with no selected candidates performs only the candidate read and returns the exact empty allowlisted collection.
- The snapshot reader performs bounded set reads rather than per-event N+1 work, returns exact current versions, detects missing/duplicate/over-limit result rows, and preserves the existing single snapshot tests.
- Lookup work is deduplicated and chunked at the reader's limits. Every candidate has exact current Event/version and complete approved projection inputs; stale or withdrawn data never falls back to an earlier version.
- Candidate overflow and all inconsistent/incomplete inputs fail the whole response with the existing generic redacted error; no partial geometry is returned.
- Existing demo behavior, query contract, DTO, response headers, list/detail/history routes, and all unrelated live-route gates remain unchanged.
- Fake SQL executor and authored fictional fixtures only. PGlite tests may use the existing local migration harness; do not connect to Neon or use real event/source material.
- In WSL Ubuntu-26.04, run focused DB snapshot tests, focused runtime tests, focused API tests, full `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`. Record actual runtime versions and dry-run output; do not install dependencies.

## Verification and handoff

Use the checked-in dependency lock and WSL Ubuntu-26.04. Record Node.js, npm, Git, TypeScript, pg, @types/pg, PGlite, and Wrangler versions. Run the new focused runtime test separately because the Worker aggregate enumerates tests; run the snapshot and API tests separately as well. Do not report any unrun check as passing.

Implement only on the assigned task branch/worktree. Commit code/tests and the handoff in coherent descriptive commits, leave the checkout clean, and do not merge or push. Report exact branch/worktree, commit SHAs and messages, changed paths, behavior, commands and results, limits, configuration/migration impact, and remaining decisions. Root reviews and integrates.

## Stop conditions

Stop and report the precise gap if the existing public views cannot return exact current snapshots in a bounded set read, if strict projection cannot be supplied all its reviewed inputs without changing a contract/schema, or if route activation requires an unauthorized provider/deployment change. Do not weaken L4 validation, return partial output, or create older-version fallback. Escalate to GPT-6 Astra xhigh only after a GPT-6 Luna Max attempt fails on a substantive technical difficulty.

## Implementation handoff

Append the branch/worktree, commit SHAs/messages, changed paths, behavior, actual WSL checks/results, limitations, configuration impact, and remaining decisions here.


- Branch/worktree: work/API-PUBLIC-GEOJSON-RUNTIME-CORE at C:/Users/perry/.codex/worktrees/api-geojson-route-core/RPL (WSL: /mnt/c/Users/perry/.codex/worktrees/api-geojson-route-core/RPL). The branch started at accepted checkpoint e544037 and is now ahead by the implementation and handoff commits.
- Implementation commit: 702dafbbbc101f1c574debf5017c786ad63be386 - feat(api): wire bounded live GeoJSON runtime.
- Handoff commit message: docs(API-PUBLIC-GEOJSON-RUNTIME-CORE): record implementation handoff.
- Changed paths: apps/db/src/public-event-snapshot.ts, apps/db/test/public-event-snapshot.test.ts, apps/worker/package.json, apps/worker/src/index.ts, apps/worker/src/layers/l4-application-integration/api.ts, apps/worker/src/runtime/public-event-geojson-runtime.ts, apps/worker/test/api.test.ts, apps/worker/test/public-event-geojson-runtime.test.ts, and this assignment handoff.
- Behavior: exact-live GET /api/v1/events.geojson now uses one request-scoped PostgreSQL executor operation to read bounded candidates, exact current snapshots and impacts, deduplicated reviewed lookups in sequential batches, and the accepted strict projector. Query validation precedes SQL. Empty candidate sets perform no snapshot or lookup reads. Version mismatch, withdrawal, overflow, or invalid/missing projection input fails the whole response with the existing generic error. Latest withdrawals do not fall back or expose history. Demo behavior and response headers remain unchanged. Geometry and coordinates pass through the accepted projector without clipping or inference.
- Limits: candidate and snapshot ID sets are bounded to 500; the candidate reader retains its 501-row overflow probe; snapshots enforce 100 impacts per event and 10,000 impacts per request with a 10,001-row overflow probe; exact lookup keys are deduplicated and sent in sequential batches of at most 100 scope keys and 100 support references. Fake SQL and fictional fixtures only.
- WSL Ubuntu-26.04 versions: Node.js v24.21.0, npm 11.19.0, Git 2.53.0, TypeScript 7.0.2, pg 8.16.3, @types/pg 8.23.1, PGlite 0.5.8, @electric-sql/pglite-postgis 0.2.8, @electric-sql/pglite-pgvector 0.0.9, Wrangler 4.137.0.
- Checks: npm exec --workspace=@waspada/db -- tsx --test test/public-event-snapshot.test.ts passed 9/9; npm exec --workspace=@waspada/worker -- tsx --test test/public-event-geojson-runtime.test.ts passed 6/6; npm exec --workspace=@waspada/worker -- tsx --test test/api.test.ts passed 25/25. Full npm test passed: Web 22/22, Worker 223/223, all 18 DB test files, and evaluation casebook 12/12. npm run typecheck passed. npm run build passed: Vite 8.3.0 built 25 modules, and Wrangler 4.137.0 dry-run uploaded 443.74 KiB (87.13 KiB gzip); the dry run reported only existing env.DATASET_MODE with value demo. git diff --check passed in WSL.
- Configuration and migration impact: none. No contract, OpenAPI, migration, view/schema, Wrangler/deployment, dependency, binding, secret, provider, source, or lockfile changes. Runtime activation uses existing exact DATASET_MODE=live and the injected existing Hyperdrive connection string.
- Limitations and remaining decisions: no unresolved contract or implementation decision within the assignment. Root review and acceptance remain pending; no merge or push was performed.

### Root review and acceptance — 27 September 2026

Root independently reviewed implementation `702dafbbbc101f1c574debf5017c786ad63be386` and handoff `a83f7e63dd0feadc173a7097c2537e92e98fc625` on the assigned branch, then cherry-picked them to `main` as `d985957` and `15d04fb`. The exact-live GeoJSON GET composes the bounded candidate reader, exact current snapshots and impacts, deduplicated reviewed lookups, and strict L4 projection inside one request-scoped SQL operation. Query validation precedes SQL; empty results skip snapshot and lookup reads; overflow, mismatched versions, withdrawal, and incomplete projection fail closed without partial output. The latest-withdrawn rule keeps the event and its full public history hidden. Demo behavior and the existing response contract/headers remain unchanged.

Root independently verified in WSL Ubuntu-26.04 with Node `v24.21.0` and npm `11.19.0`: focused snapshot tests 9/9, runtime tests 6/6, API tests 25/25; full `npm test` (web 22/22, Worker 223/223, DB 18/18 files, evaluation 12/12); `npm run typecheck`; `npm run build`; and `git diff --check`. Wrangler `4.137.0` dry-run reported 443.74 KiB upload / 87.13 KiB gzip and only the existing `DATASET_MODE="demo"` variable. No migration, schema/view, contract, dependency, binding, secret, provider resource, source, hosted database, or live record was added. Actual Hyperdrive/Neon connectivity remains unverified. See the [implementation handoff](API-PUBLIC-GEOJSON-RUNTIME-CORE.md#implementation-handoff).
