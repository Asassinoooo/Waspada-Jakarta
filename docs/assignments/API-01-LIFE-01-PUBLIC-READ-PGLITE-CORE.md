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

### Handoff record

- **Branch:** `work/API-01-LIFE-01-PUBLIC-READ-PGLITE-CORE`
- **Worktree:** `D:\Projects\RPL\.codex-build\worktrees\api-01-life-01-public-read-pglite-core` (`/mnt/d/Projects/RPL/.codex-build/worktrees/api-01-life-01-public-read-pglite-core`)
- **Exact base:** `0baa6a835ba1fc7d3d575cfc7b5571ded4176fd7`
- **Test commit:** `a17ab1d4eec40ec67207527d08e011219f8dac7a` — `test(API-01-LIFE-01): verify public reads after source withdrawal`
- **Handoff commit:** `3a4e5aeb13808961dcbf5e996252e80ca9ba1295` — `docs(API-01-LIFE-01): record public read test handoff`.
- **Changed paths:** `apps/db/test/source-revision-freshness-transition-composition.test.ts`; this assignment handoff section.
- **Behavior:** after the existing source-withdrawal transition, the test calls the real public API handler through the exact-live list, detail, and GeoJSON runtimes, all using the same isolated in-memory PGlite executor. It verifies list/detail freshness, direct versus unrelated impact freshness, unchanged published content and lifecycle, empty GeoJSON for a fixture without supported geometry, private transition/source details absent from public outputs, and the existing bounded telemetry fields.
- **Checks (Ubuntu-26.04, Node 24.21.0, npm 11.19.0):** focused test passed; `npm run db:test` passed (42/42 DB test files); `npm test` passed (60 web tests, 451 worker tests, 42/42 DB test files, 19 evaluation tests); `npm run typecheck` passed; `npm run build` passed including the Wrangler dry run; `git diff --check 0baa6a835ba1fc7d3d575cfc7b5571ded4176fd7..HEAD` passed after the test commit. Focused command: `cd /mnt/d/Projects/RPL/.codex-build/worktrees/api-01-life-01-public-read-pglite-core/apps/db && /mnt/d/Projects/RPL/node_modules/.bin/tsx --test test/source-revision-freshness-transition-composition.test.ts`.
- **Dependency/runtime record:** existing workspace versions were Node `24.21.0`, npm `11.19.0`, tsx `4.23.15`, TypeScript `7.0.2`, PGlite `0.5.8`, pg `8.16.3`, `@types/pg` `8.23.1`, and Wrangler `4.137.0`. No dependency install or temporary symlink was needed.
- **Limitations:** authored synthetic data exists only in the temporary PGlite database and uses the live dataset tag only to exercise exact-live predicates. The fixture has no supported geometry, so the GeoJSON assertion covers the empty-collection case.
- **Configuration/migration impact:** none. No production, API, schema, dependency, or runtime configuration files changed.
- **Remaining decisions:** none for this test-only task; root independently reviews and accepts the branch.

## Root review and acceptance

Root reviewed agent commits `a17ab1d4eec40ec67207527d08e011219f8dac7a` and `3a4e5aeb13808961dcbf5e996252e80ca9ba1295` from base `0baa6a835ba1fc7d3d575cfc7b5571ded4176fd7`, preserving them on `main` as `a6f8a79` and `69e128d`. Independent review found that the API assertions checked freshness statuses but did not prove event and impact metadata (`evaluated_at`, `review_due_at`, and `basis`) stayed unchanged when a source-withdrawal transition occurred later. Root changed the transition instant to `2026-10-01T10:05:00.000000Z`, kept the published metadata at `2026-10-01T10:00:00.000000Z`, asserted the full event/impact `Freshness` values, and recorded the exact handoff commit identity in root commit `1ed1210`.

Root independently passed the focused composition test (1/1), workspace `npm run typecheck`, and `git diff --check 0baa6a835ba1fc7d3d575cfc7b5571ded4176fd7..HEAD` in WSL Ubuntu-26.04 using Node `24.21.0`/npm `11.19.0`. The agent's WSL verification also passed `npm run db:test` (42/42 DB files), `npm test` (web 60, Worker 451, DB 42 files, evaluation 19), typecheck, build, and its final assigned-base diff check. The branch is accepted locally. The synthetic fixture has no source-supported geometry, so GeoJSON is correctly empty; PGlite does not verify hosted Neon or real source behavior.
