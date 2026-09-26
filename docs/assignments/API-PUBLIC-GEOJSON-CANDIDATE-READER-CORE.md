# API-PUBLIC-GEOJSON-CANDIDATE-READER-CORE — bounded spatial read foundation

- **Backlog ID:** `API-PUBLIC-GEOJSON-CANDIDATE-READER-CORE`
- **Objective:** Add a least-privilege database reader that returns bounded, current-public live event/geometry candidates intersecting the existing GeoJSON viewport and filters.
- **Dependencies:** `API-GEOJSON-ROUTE-CORE`, `API-GEOMETRY-CORE`, `API-PUBLIC-GEOMETRY-READER-CORE`, `API-PUBLIC-DETAIL-PROJECTION-CORE`, `DATA-01`, `DB-TEST-RUNNER-ISOLATION`, `ADR-012`, `ADR-018`, `ADR-023`.
- **Requirements:** `FR-09/10`; `NFR-01/07`.
- **Contract boundary:** Existing `GET /api/v1/events.geojson`, query values in `docs/api/openapi.yaml`, `PublicFeatureCollection` capped at 500 features. Do not change OpenAPI, the public DTO, or the demo route.
- **Layer:** L1 database/read foundation for a later L4 projection and route runtime.
- **Branch/worktree:** Use branch `work/API-PUBLIC-GEOJSON-CANDIDATE-READER-CORE` in the prepared managed worktree `C:\Users\perry\.codex\worktrees\api-geojson-route-core\RPL` (WSL: `/mnt/c/Users/perry/.codex/worktrees/api-geojson-route-core/RPL`). Start from the root's pushed assignment commit; do not edit through the root checkout.
- **Owner:** GPT-6 Luna Max implementation agent; root plans, reviews, accepts, integrates and pushes.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md` (first repository document), then `docs/IMPLEMENTATION_BACKLOG.md`
- This assignment and [ADR-023](../decisions/ADR-023-public-geojson-candidate-selection.md)
- [ADR-012](../decisions/ADR-012-public-projection-boundary.md), [ADR-018](../decisions/ADR-018-jakarta-geojson-query-envelope.md), [OpenAPI GeoJSON route and enums](../api/openapi.yaml)
- The accepted [synthetic GeoJSON route](API-GEOJSON-ROUTE-CORE.md), [geometry reader](API-PUBLIC-GEOMETRY-READER-CORE.md), [detail projection service](API-PUBLIC-DETAIL-PROJECTION-CORE.md), and their current implementation/tests
- `apps/db/src/public-event-geometries.ts`, `apps/db/src/public-event-list.ts`, `apps/db/test/harness.ts`, migration 012 and the DB test runner
- `apps/db/src/sql.ts`, `apps/db/package.json`, and the current database roles/views in migrations

## Required behavior

1. Add an injected, read-only repository under `apps/db/src/` that accepts the already-parsed query values: a CRS84 `[west, south, east, north]` bbox plus optional OpenAPI `category`, `lifecycle`, and `freshness` enums. Validate the closed input shape and values before SQL. Enforce the inclusive ADR-018 application envelope at the repository boundary as defense in depth.
2. Select only exact current published `live` event versions and geometry linked to the exact event and its published claim. Exclude historical, synthetic, withdrawn, stale-version, unlinked, and non-current geometry candidates. Keep database record JSON explicitly typed as untrusted internal input for later Layer 4 validation.
3. Apply exact spatial intersection against the supplied bbox using the persisted source geometry. Return the original unmodified source geometry record; do not clip, buffer, geocode, create points/radii/polygons, or infer geometry. The query envelope is only a bound on selection, not an administrative boundary.
4. Apply the three existing enum filters without introducing undocumented filters. Return deterministic unique `(event_id, version, geometry_id)` candidate rows in stable order.
5. The public DTO has no pagination. Read at most 501 candidate features as a 500-plus-one overflow probe. Return at most 500 candidates; if a 501st matching row exists, fail with a fixed typed limit error instead of silently truncating. Do not return partial results or include raw values in errors.
6. Preserve database least privilege. Add migration `015` for a narrowly filtered security-barrier view or an equivalently constrained database read surface. `waspada_public_reader` may use only that filtered surface; it must not gain direct reads of event, claim, geometry, source, or evidence base tables. Revoke broad/default access as needed and test the grants under the reader role. Do not alter earlier migration history.
7. Use parameterized SQL and bound work. Query errors and malformed result rows map to stable redacted repository errors. The reader does not perform source acquisition, publication, moderator review, authorization, telemetry, or public serialization.

## Explicitly out of scope

- Worker/API route wiring, HTTP query parsing, L4 event/geometry projection, `PublicFeatureCollection` construction, UI or OpenAPI changes.
- New public DTOs, pagination fields, source attribution/rights decisions, real event data, external source access, or reviewer records.
- Worker bindings, secrets, Hyperdrive/Neon resources, deployment changes, providers, paid services, dependencies, lockfiles, or model calls.
- Altering migration 012 or grants on existing base relations; bypassing the public reader role; emitting SQL rows directly from a response.

## Allowed paths

- `apps/db/migrations/015_public_geojson_candidates.sql`
- New `apps/db/src/public-event-geojson-candidates.ts`
- New `apps/db/test/public-event-geojson-candidates.test.ts` (the runner auto-discovers `*.test.ts`)
- This assignment's implementation handoff only

Do not edit the backlog, SDP, ADRs, OpenAPI, Worker/API code, earlier migrations, or package manifests. Ask the root planner if the unchanged public contract cannot support the bounded reader.

## Acceptance criteria

- PGlite/PostGIS tests prove exact current-live/current-version event association, exact published-claim geometry linkage, bbox intersection, enum filters, stable ordering, and original geometry preservation.
- Tests prove latest-withdrawn, non-live, historical, synthetic, orphaned, stale-version, duplicate, and malformed candidate rows are excluded or rejected without falling back to prior versions.
- Invalid bboxes, unsupported enum values, malformed query objects, and over-limit input fail before SQL. A 501st matching candidate produces the stable overflow error; no partial page is returned.
- Under `SET ROLE waspada_public_reader`, the reader can call/select only the new filtered surface and cannot read protected event, claim, geometry, source, or evidence base relations directly. No broader role grant is introduced.
- No existing migration, API contract, demo behavior, dependency, provider configuration, or live source changes.
- Under WSL Ubuntu-26.04, run the focused candidate-reader PGlite test, `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`.

## Verification (WSL Ubuntu-26.04 only)

Record Node.js, npm, Git, TypeScript, PGlite, the PostGIS extension package, and Wrangler versions. Run each required check and record actual outcomes. Use authored fictional PGlite rows only; do not connect to Neon/Hyperdrive or provision a provider resource.

## Commit and handoff

Implement only on the assigned branch/worktree. Commit implementation/tests and this handoff in coherent, descriptive commits, leave the checkout clean, and do not merge or push. Return the branch/worktree, exact commit SHAs/messages, changed paths, behavior, actual checks, limitations, configuration/migration impact, and remaining decisions. Root independently reviews and integrates.

## Stop conditions

Stop and report if the exact published-claim relationship cannot be enforced through the existing evidence model, if the safe query cannot preserve the envelope/500-feature cap without a public contract change, or if least privilege requires exposing base tables or source content. Do not access real sources, providers, or live records. Escalate to GPT-6 Astra xhigh only after a GPT-6 Luna Max attempt fails on a substantive technical difficulty; time, usage limits, or missing permissions are not such a failure.

## Implementation handoff

Append the exact branch/worktree, commits, changed paths, behavior, actual WSL checks, limitations and remaining decisions here. Do not merge or push.
