# GEO-STORE-CORE — Source-backed geometry persistence

- **Status:** Assigned; implementation in progress
- **Depends on:** DATA-01, DATA-02-CORE
- **Requirements:** FR-03/09; NFR-01/07
- **Architecture:** L1 persistence; stores supplied geometry and its evidence links without geocoding or inference
- **Branch/worktree:** `work/GEO-STORE-CORE-source-backed-geometry`; `.codex-build/worktrees/geo-store-core`
- **Owner:** GPT-6 Luna Max implementation agent; root plans and reviews

## Objective

Add a typed, append-only Layer 1 repository for schema 2.0 `Geometry` records. It must persist a validated CRS84 GeoJSON shape and link it to already-stored, exact `supports` evidence references from the same dataset. Geometry is source-reported or otherwise explicitly supplied input; this writer does not decide factual truth or publication eligibility.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md` — FR-03/09 and five-layer ownership
- `docs/IMPLEMENTATION_BACKLOG.md` — DATA-01 and GEO-STORE-CORE
- `docs/contracts.schema.json` — `Geometry`, `GeoJSONGeometry`, `SupportEvidenceRef`
- `docs/DOMAIN_MODEL.md` — geometry roles, source support, and no inferred warning areas
- `apps/db/migrations/001_foundation.sql` — geometry/evidence tables and current grants
- `apps/db/src/ports.ts`, `apps/db/src/sql.ts`, and the PGlite harness/tests

## Required behavior

- Accept runtime `unknown` input and validate the complete consumed schema 2.0 Geometry shape, IDs, dataset, trace, role, precision fields, CRS, and a non-empty bounded set of unique support references. TypeScript types alone are not validation.
- Accept only GeoJSON geometry kinds in the contract; require two-dimensional finite longitude/latitude positions in CRS84, bounded coordinate counts, valid line/ring lengths, closed polygon rings, and valid PostGIS topology. Use role-compatible geometry types: point/multipoint for point-place/facility/venue/scene roles, line/multiline for `route_segment`, and polygon/multipolygon for `affected_area`, `warning_boundary`, and `service_area`.
- Resolve every supplied support reference to exactly one persisted evidence reference joined to its immutable report revision. Require the same dataset, matching text hash, Unicode code-point offsets within the exact stored text, `unicode_code_points`, and relation `supports`. Reject missing, duplicate, ambiguous, or mismatched evidence. Do not create evidence references in this operation.
- Insert the shape as supplied with SRID 4326/OGC:CRS84. Never buffer a point, calculate a danger radius, geocode, simplify, repair, reproject, or reinterpret geometry. Preserve the exact source evidence references in `record_json` and `geometry_evidence`.
- Persist the geometry and all geometry-evidence relations atomically. Identical retries are idempotent; a reused geometry ID with changed trace, role, shape, precision, label, or support links is a conflict. Records are append-only; do not add update/delete operations or grants.
- Add only the column-level `SELECT` grants on `evidence_references`, `geometries`, and `geometry_evidence` needed to resolve support and check retries under `SET ROLE waspada_l1_pipeline`. Do not grant whole-table reads, expose geometry to public/L2 roles, or change other grants.
- Use authored synthetic rows only. A source reference in tests is not an actual source, source-rights approval, factual validation, or permission to retain provider geometry. Keep the public projection/API and event/impact publication untouched.

## Explicit exclusions

No network, live source data, geocoding, location inference, source activation, model calls, publication writes, event/claim geometry attachment, API/OpenAPI/domain contract change, deployment, credentials, paid service, or new dependency. The repository proves shape, lineage linkage, and storage behavior only; a support relation does not prove the geometry semantically describes an incident.

## Allowed paths

- `apps/db/src/**`
- `apps/db/test/**`
- `apps/db/migrations/006_l1_geometry_evidence_reads.sql` only, for the exact column-level L1 reads above
- This assignment's implementation handoff only

Root owns the contract, architecture, backlog, and any grant scope. If PGlite/PostGIS cannot establish an invariant without a broader contract or permission change, stop and report the exact gap before expanding scope.

## Acceptance and checks

- PGlite tests under `SET ROLE waspada_l1_pipeline` prove successful exact-shape persistence, support linkage, identical retry, conflicting retry rejection, and denial of unrelated reads/writes. Include valid point, route-segment, and polygon fixtures plus unsupported role/type pairs, bad coordinates, invalid rings, missing/ambiguous/non-support references, wrong hashes, and rollback on relation failure.
- No test treats a synthetic support relation as human validation or real-source evidence. Verify all stored geometry coordinates are exactly those submitted; no implicit spatial expansion or transformation occurs.
- In WSL Ubuntu-26.04 run `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check` from the assigned worktree. Record actual tool versions and results.
- Commit coherent work on the assigned branch, leave a clean worktree, and report commit SHAs/messages, changed paths, checks, limitations, migration/configuration impact, and remaining decisions. Do not push or merge.

## Handoff

Append the implementation branch/worktree, exact commits/messages, paths, behavior, actual verification results, limitations, and unresolved decisions. Root reviews and accepts before integration.
