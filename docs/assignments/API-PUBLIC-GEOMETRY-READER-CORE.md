# API-PUBLIC-GEOMETRY-READER-CORE — bounded public geometry reader

- **Backlog ID:** `API-PUBLIC-GEOMETRY-READER-CORE`
- **Objective:** Add a database-only, least-privilege reader for geometry records referenced by the current published live event and claim scopes, so a later L4 composition can validate/project exact source-supported geometries.
- **Dependencies:** `GEO-STORE-CORE`, `API-GEOMETRY-CORE`, `DATA-01`, `DB-TEST-RUNNER-ISOLATION`, `ADR-012`. `API-PUBLIC-PROJECTION-SERVICE-CORE` is an adjacent accepted slice, not a requirement to alter its code or contract.
- **Requirements:** `FR-09/10`, `NFR-01/07`
- **Allowed paths:** `apps/db/migrations/012_public_geometry_reader.sql`; `apps/db/src/public-event-geometries.ts`; `apps/db/test/public-event-geometries.test.ts`; `apps/db/test/migrations.test.ts` (migration-sequence expectations only); and this assignment's implementation handoff only.
- **Forbidden scope:** No public HTTP route, L4 composition or change to the existing projector/service, public DTO/OpenAPI changes, Worker runtime binding, route wiring, publication/moderation behavior, source acquisition, live/source-rights assumptions, paid service, dependency, or unrelated path changes.
- **Branch/worktree:** `work/API-PUBLIC-GEOMETRY-READER-CORE`, in the dedicated reusable checkout `C:\Users\perry\.codex\worktrees\api-geojson-route-core\RPL` (`/mnt/c/Users/perry/.codex/worktrees/api-geojson-route-core/RPL`). Start from the current pushed `main` after root has prepared the branch; do not work in the root checkout.
- **Contract versions:** Keep domain/DTO/OpenAPI contracts unchanged. Geometry record format remains schema 2.0; consume exact stored records and leave semantic support decisions to the existing L4 geometry projector.
- **Dependencies/configuration:** No new package or runtime configuration. Reuse existing PGlite test dependencies and database test discovery.

## Context to read before editing

Read `SOFTWARE_DEVELOPMENT_PLAN.md`, this assignment and its backlog row, then inspect `docs/decisions/ADR-012-public-projection-boundary.md`, `docs/DOMAIN_MODEL.md`, `docs/contracts.schema.json`, `docs/assignments/API-GEOMETRY-CORE.md`, `apps/db/migrations/001_foundation.sql`, `apps/db/migrations/006_l1_geometry_evidence_reads.sql`, `apps/db/migrations/011_public_projection_lookups.sql`, and the geometry writer and DB test harness. Confirm the actual JSON paths and privileges from those sources; do not assume unverified schema details.

## Required behavior

1. Add a migration creating a security-barrier public-reader view of only geometry rows whose IDs are referenced by the current public event-version view's live event scope or one of its claim scopes. Explicitly exclude non-live geometry datasets. Preserve exact `record_json` for internal L4 validation; this view is not an HTTP response. Avoid broad base-table grants. The `waspada_public_reader` role must not gain direct read access to private geometry/evidence tables. Malformed/untrusted event payload structure must not cause unrelated rows to leak or make the view unsafe; use guarded JSON handling and the existing safe current-event view.
2. Add an injected, parameterized exact-ID repository over that view. Accept only validated, unique geometry IDs; require a non-empty input to stay within a hard maximum of 500; return an empty array without a query for empty input; never silently truncate; return deterministic sorted rows; reject malformed, duplicate, unrequested, or identity-mismatched database results using stable redacted errors. Do not retrieve geometry by broad listing, scope name, bounding box, or caller-supplied SQL.
3. Test least privilege, live/current/published-only reference visibility, claim and event scope references, and exclusion of historical, synthetic, unpublished, withdrawn, non-current, and unreferenced geometries. Also test injection-resistant exact lookups, empty input, cap boundary and overflow, duplicate/mismatched/unrequested DB results, stable sorting, and redacted failures.
4. Use authored fictional PGlite rows only. A `live` marker in a test is a filter fixture, not evidence of live data, permission, publication, or factual support. Do not invent user-facing geometry.

## Acceptance criteria

- Only geometry IDs present in current published live event/claim scopes are visible via the dedicated read view; non-live or otherwise ineligible rows are not visible.
- The public-reader role has only the minimum SELECT privilege required for the view and cannot query the underlying geometry/evidence tables directly.
- Repository reads are parameterized, exact-ID-only, bounded at 500, deterministic, fail-closed, and do not leak raw database errors or input content.
- Migration/test isolation follows existing DB conventions; all new test files are discovered by the current runner without changing it.
- Existing L4 validation remains authoritative for geometry schema, CRS84, dimensions, and source-support links. The DB reader does not itself imply that geometry is safe to display.
- No public contract, Worker route/runtime wiring, source provider, or external service changes.

## Verification (WSL Ubuntu-26.04 only)

Record `node --version`, `npm --version`, `git --version`, and relevant package versions. Use existing dependencies. Run the focused test, `npm run db:test`, full `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`. Report each actual result; do not describe hosted Neon behavior as verified from PGlite.

## Commit and handoff

Implement on this branch/worktree only. Commit the implementation and this assignment's handoff in coherent, descriptive commits. Leave the checkout clean. Do not merge or push. Report the exact branch/worktree, commit SHA(s) and message(s), changed paths, behavior, checks and outcomes, limitations, migration/configuration impact, and remaining decisions. Root independently reviews and integrates.

## Stop conditions

Stop and report if the schema cannot safely express current published references, if read grants require broader access than allowed, or if the task requires a contract, public route, runtime binding, source-rights decision, or L4 policy change. Continue unrelated safe work within scope where possible. Escalate to GPT-6 Astra xhigh only if GPT-6 Luna Max first attempts and cannot resolve a substantive technical difficulty.

## Implementation handoff

Append the exact branch/worktree, commits, changed paths, behavior, actual WSL checks/results, limitations, migration/configuration impact, and remaining decisions here. Do not merge or push.

### Completed implementation handoff

- **Branch/worktree:** `work/API-PUBLIC-GEOMETRY-READER-CORE`; `C:\Users\perry\.codex\worktrees\api-geojson-route-core\RPL` (`/mnt/c/Users/perry/.codex/worktrees/api-geojson-route-core/RPL`).
- **Implementation commit:** `04a43b2b9ce1866fe2953c2d4a8e76df7a689fe8` — `feat(API-PUBLIC-GEOMETRY-READER-CORE): add bounded public geometry reader`.
- **Changed paths:** `apps/db/migrations/012_public_geometry_reader.sql`; `apps/db/src/public-event-geometries.ts`; `apps/db/test/public-event-geometries.test.ts`; `apps/db/test/migrations.test.ts`; this assignment file. The migration test update changes only migration sequence, count, latest-version, and discovery expectations. Root explicitly approved this narrow scope extension and the allowed-path line above records it.
- **Behavior:** Migration 012 adds a `security_barrier` view sourced from the exact current published event-version view. It limits output to live geometry IDs in the current Event scope or a published Claim scope whose stored claim payload and normalized `event_claim_geometries` row match the same dataset/event/version/claim/geometry tuple. It tolerates malformed JSON arrays, validates schema-2.0 envelope identity and 128-character identifiers, and grants `waspada_public_reader` SELECT only on this view while denying direct geometry/evidence-table reads. The injected TypeScript reader validates unique IDs and a strict 500-ID cap, skips SQL for empty input, performs a parameterized exact-ID query, sorts deterministically, validates result identity and shape, and returns stable redacted failures. L4 remains responsible for full geometry, CRS84, and source-support validation.
- **WSL environment:** Ubuntu-26.04; Node `v24.21.0`; npm `11.19.0`; Git `2.53.0`. Reused versions: `@electric-sql/pglite 0.5.8`, `@electric-sql/pglite-postgis 0.2.8`, `@electric-sql/pglite-pgvector 0.0.9`, `tsx 4.23.15`, TypeScript `7.0.2`; build reported Vite `8.3.0` and Wrangler `4.137.0`.
- **Checks:** Focused geometry test 8/8; migration test 9/9; `npm run db:test` passed all 13/13 DB test files; `npm test` passed 317 tests total (web 22, Worker 183, DB 100, evaluation 12); `npm run typecheck` passed; `npm run build` passed (Vite production build and Wrangler dry-run); `git diff --check` passed. The full suite and checks were run from this task worktree. No dependencies were installed. The temporary `node_modules` symlink to `/mnt/d/Projects/RPL/node_modules` was removed after verification.
- **Limitations:** Database coverage uses authored fictional PGlite fixtures; hosted Neon behavior and deployment privileges were not tested. No route, runtime binding, public contract, publication, or source-policy changes were made.
- **Migration/configuration impact:** Adds migration `012_public_geometry_reader.sql`; no package or runtime configuration changes.
- **Remaining decisions:** None within this bounded assignment; root review and integration remain outstanding.
