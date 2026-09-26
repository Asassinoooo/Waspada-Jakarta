# API-PUBLIC-SNAPSHOT-CORE — bounded published-event snapshot reader

- **Status:** Assigned; internal database read port only
- **Parent work package:** API-01 — public published-event endpoints
- **Requirements:** FR-09/10; NFR-01/07
- **Dependencies:** DATA-01, DB-TEST-RUNNER-ISOLATION, API-PROJECT-CORE, API-PUBLIC-LOOKUPS-CORE, ADR-012, ADR-019
- **Layer:** L4 data-access boundary for a later public projection service
- **Contract baseline:** Existing schema 2.0 event/impact records and `PublicProjectionLookups`; no public DTO, route, or query-contract change
- **Implementation model:** GPT-6 Luna, max reasoning
- **Branch:** `work/API-PUBLIC-SNAPSHOT-CORE`
- **Worktree:** Create or select a dedicated managed worktree from the pushed assignment commit; do not edit the root checkout.
- **Owner:** Luna Max implementation agent; root plans, reviews, accepts, integrates, and pushes

## Objective

Add a read-only, bounded repository that retrieves one current live published event snapshot and its referenced current impacts through the existing `waspada.public_event_versions` and `waspada.public_event_impacts` views. This is an internal input port for later L4 projection work. It does not return a public DTO or connect to an HTTP route.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md` (first repository document), then `docs/IMPLEMENTATION_BACKLOG.md`
- `docs/DOMAIN_MODEL.md`, `docs/decisions/ADR-012-public-projection-boundary.md`, and `docs/decisions/ADR-019-public-projection-lookups.md`
- `docs/assignments/API-PROJECT-CORE.md` and `docs/assignments/API-PUBLIC-LOOKUPS-CORE.md`
- `apps/db/migrations/001_foundation.sql` (published event/impact views and role grants)
- `apps/db/migrations/011_public_projection_lookups.sql` (safe public lookup views)
- `apps/db/src/sql.ts`, `apps/db/src/public-projection-lookups.ts`, `apps/db/test/harness.ts`, and `apps/db/test/run-db-tests.ts`

## Required behavior

1. Add a typed read port that accepts one bounded event ID and retrieves the matching row from `waspada.public_event_versions` using parameterized SQL. Require `dataset_kind = 'live'` explicitly. The view already restricts rows to the current published version; return an explicit missing result when the configured view has no matching live row. Never fall back to a historical or synthetic row.
2. For a found event, retrieve only impact rows matching that exact live event ID and current event version from `waspada.public_event_impacts`. Sort impacts deterministically and cap the result at 100; if the cap is exceeded, fail with a bounded error instead of silently truncating.
3. Read only from the two existing public views. Do not query base event, impact, evidence, decision, or source tables. Do not broaden database grants, add a migration, or switch roles inside the repository. The caller supplies the already-authorized `SqlExecutor`.
4. Treat each `record_json` value as untrusted internal data. Preserve it only in a typed internal snapshot for the next L4 validation boundary; do not interpret source text, add generated claims, return it from a route, or map it directly to a public response.
5. Validate identifiers and returned row shapes, sort results deterministically, use bounded errors that omit SQL values and record content, and return no row for missing, withdrawn, non-current, or non-live events.
6. Tests use authored fictional PGlite rows only. They prove current-version selection, latest-withdrawal exclusion, live-only filtering, exact event/version impact linkage, bounded results, parameterized SQL, least-privilege view reads, and denial of direct base-table reads under `waspada_public_reader`.

## Explicit boundaries

- Use only authored synthetic test fixtures. A `live` test marker is not a live source record, human review, factuality finding, publication permission, or source-rights grant.
- No public projection composition, HTTP route, Worker/database runtime wiring, pagination/filter behavior, history endpoint, GeoJSON, geometry, approval writer, moderator action, model call, or source acquisition.
- No changes to public DTOs, OpenAPI, domain schemas, L4 allowlists, publication rules, role grants, or database schema.
- No Neon/Cloudflare provisioning, connection string, dependency, paid service, external API, live source, or deployment.

## Allowed paths

- `apps/db/src/public-event-snapshot.ts` (new)
- `apps/db/test/public-event-snapshot.test.ts` (new)
- This assignment's implementation handoff only

Root owns the backlog, SDP, architecture, contracts, source-rights decisions, and Worker/API composition. Report a scope conflict instead of broadening this assignment.

## Acceptance and checks

- PGlite tests prove the required view-only query, current published version semantics, exact impact linkage, bounds, redacted errors, and least-privilege behavior.
- Tests clearly label all authored fixture rows synthetic, including rows that carry `dataset_kind = 'live'` solely to exercise a live-only query predicate.
- In WSL Ubuntu-26.04 run the focused new DB test, `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`; record exact tool versions and actual results.
- Commit implementation and handoff as coherent descriptive commits on the assigned branch. Leave the task worktree clean. Do not merge or push.

## Stop conditions

Stop and report if the existing safe views cannot satisfy the task without changing schema, grants, contracts, source permissions, publication policy, or runtime wiring. GPT-6 Astra xhigh is allowed only after a substantive technical difficulty was attempted by Luna Max and remains unresolved.

## Implementation handoff

Append exact branch/worktree, commit SHAs and messages, changed paths, behavior, actual checks, limitations, migration/configuration impact, and remaining decisions. Root independently reviews and verifies before acceptance.


### Implementer handoff - 26 September 2026

- **Branch/worktree:** `work/API-PUBLIC-SNAPSHOT-CORE`; Windows path `C:\Users\perry\.codex\worktrees\api-geojson-route-core\RPL`; WSL path `/mnt/c/Users/perry/.codex/worktrees/api-geojson-route-core/RPL`.
- **Code commit:** `6a355bc24f00bbdb37fba34520cb2176df03531a` - `feat(API-PUBLIC-SNAPSHOT-CORE): add bounded published-event reader`.
- **Changed paths:** `apps/db/src/public-event-snapshot.ts`; `apps/db/test/public-event-snapshot.test.ts`; this implementation handoff.
- **Behavior:** Added a typed internal read port with explicit `found` / `missing` results. It reads only `waspada.public_event_versions` and `waspada.public_event_impacts`, requires `dataset_kind = 'live'` in both parameterized queries, and relies on the existing views for current published/tombstone selection. Impact reads are bound to the exact returned event ID/version, ordered deterministically, and probe at most 101 rows to fail with a generic error when more than 100 match. Event and impact row identities/shapes are validated; `record_json` remains `unknown` in the internal snapshot for the next L4 validation boundary. Database and validation errors omit query values and record content.
- **Fixture note:** Every DB row is authored fictional test data. Test rows with `dataset_kind = 'live'` are only live-shaped values used to exercise the live-only predicate; they do not represent a live source, reviewed fact, publication authorization, source-rights decision, or human evaluation.
- **WSL tools:** Ubuntu-26.04; Node.js `v24.21.0`; npm `11.19.0`; Git `2.53.0`; TypeScript `7.0.2`; tsx `4.23.15`; PGlite `0.5.8`; PGlite PostGIS `0.2.8`; PGlite pgvector `0.0.9`; Vite `8.3.0`; Wrangler `4.137.0`. The configured WSL Node path was used. Existing dependencies were reused through a temporary symlink to the root `node_modules` and the symlink was removed after verification.
- **Checks:** Focused `node --import tsx --test apps/db/test/public-event-snapshot.test.ts` passed 6/6. `npm run db:test` passed 12/12 files (92 tests). `npm test` passed 271 total (web 22, Worker 145, DB 92, evaluation 12); the run included this task's six DB tests. `npm run typecheck` passed. `npm run build` passed, including the Vite production build and Wrangler dry-run. `git diff --check` and staged diff checks passed.
- **Limitations / remaining decisions:** PGlite proves local view and role behavior; hosted PostgreSQL/Neon behavior remains unverified. No route, public DTO, projection composition, runtime DB wiring, migration, grant, dependency, provider setting, source acquisition, publication action, or public response was added. No contract or scope gap was found; no migration or configuration change is required.
