# API-01-LIFE-01-PUBLIC-READ-PGLITE-CORE — Verify freshness through exact-live public reads

- **Status:** Assigned for local synthetic test implementation
- **Depends on:** LIFE-01-SOURCE-REVISION-PUBLIC-PROJECTION-CORE, LIFE-01-FRESHNESS-READ-PROJECTION-CORE, API-PUBLIC-EVENT-LIST-RUNTIME-CORE, API-PUBLIC-DETAIL-RUNTIME-CORE, API-PUBLIC-GEOJSON-RUNTIME-CORE, OBS-01-API-TELEMETRY-CORE, DB-TEST-RUNNER-ISOLATION
- **Requirements:** FR-09/10/11/13; NFR-01/05/07
- **Architecture:** Test-only Layer 4/API composition
- **Branch/worktree:** work/API-01-LIFE-01-PUBLIC-READ-PGLITE-CORE; .codex-build/worktrees/api-01-life-01-public-read-pglite-core
- **Contracts:** Existing public API/OpenAPI and Event schema 2.0 remain unchanged
- **Owner:** GPT-6 Luna Max implementation agent; root plans and reviews

## Objective

Add one PGlite composition test that applies the existing explicit source-withdrawal freshness transition and then reads the same event through the public exact-live list, detail, and GeoJSON API routes. Verify that the accepted database projections and API boundary agree without changing production code or public contracts.

## Read first

- AGENTS.md
- SOFTWARE_DEVELOPMENT_PLAN.md
- docs/IMPLEMENTATION_BACKLOG.md
- docs/decisions/ADR-028-read-only-moderator-demo.md
- docs/decisions/ADR-032-review-deadline-freshness.md
- docs/assignments/LIFE-01-SOURCE-REVISION-PUBLIC-PROJECTION-CORE.md
- docs/assignments/API-PUBLIC-EVENT-LIST-RUNTIME-CORE.md
- docs/assignments/API-PUBLIC-DETAIL-RUNTIME-CORE.md
- docs/assignments/API-PUBLIC-GEOJSON-RUNTIME-CORE.md
- docs/assignments/OBS-01-API-TELEMETRY-CORE.md
- apps/db/test/source-revision-freshness-transition-composition.test.ts
- apps/worker/src/layers/l4-application-integration/api.ts
- apps/worker/src/runtime/public-event-list-runtime.ts
- apps/worker/src/runtime/public-event-detail-runtime.ts
- apps/worker/src/runtime/public-event-geojson-runtime.ts

## Scope and behavior

- Use an isolated in-memory PGlite database and authored synthetic fixture records only. A fixture may carry the live dataset tag only inside this temporary database so the exact-live route predicate can be exercised; it must contain no externally sourced or persistent live data.
- Reuse the existing source-withdrawal transition composition and fixture policy. Apply the transition, then invoke handlePublicApiRequest through the accepted live list, detail, and GeoJSON runtimes backed by the in-memory SQL executor.
- Verify event freshness is needs_update in list/detail, only the directly affected impact version is needs_update, the unrelated impact remains current, and published content and lifecycle are unchanged.
- Verify GeoJSON returns only source-supported geometry. If the fixture has no supported geometry, assert an empty collection and do not interpret it as safety.
- Verify API telemetry contains only the existing approved bounded route/status/duration fields and never exposes source observation IDs, private report content, or source metadata.
- This is test-only composition. Do not change production code, migrations, public API/OpenAPI, UI, package dependencies, runtime configuration, source/provider wiring, or deployment.

## Allowed paths

- apps/db/test/source-revision-freshness-transition-composition.test.ts
- This assignment's implementation handoff section only

Root owns other architecture, assignment, backlog, and checkpoint documents.

## Acceptance and checks

- The test exercises the real existing Layer 4 freshness coordinator, public SQL readers, API handler, and allowed route telemetry against one isolated PGlite database.
- List, detail, and GeoJSON assertions preserve distinct freshness, incident lifecycle, published-version, geometry and private-source boundaries.
- Demo behavior and production files remain unchanged.
- In WSL Ubuntu-26.04 run the focused composition test, npm run db:test, npm test, npm run typecheck, npm run build, and git diff --check <assigned-base>..HEAD.
- Commit all assigned test and handoff changes on the task branch in coherent descriptive commits. Do not push or merge.

## Stop conditions

Stop and report to root if the existing accepted runtime seams cannot exercise these routes with the isolated SQL executor or if production/API/schema changes are necessary. Do not use a real source, hosted service, credentials, new dependency, or externally sourced/persistent live data. Do not escalate models unless a Luna/max attempt reaches a substantive technical impasse.

## Implementation handoff

The implementation agent appends branch/worktree, exact base, commit SHAs and messages, changed paths, behavior, checks actually run, limitations, configuration impact, and remaining decisions. Root independently reviews and accepts the branch.
