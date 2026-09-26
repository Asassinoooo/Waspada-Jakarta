# API-GEOMETRY-CORE — Layer 4 public geometry projection

- **Status:** Assigned; synthetic-only projection work
- **Depends on:** API-PROJECT-CORE, GEO-STORE-CORE, SPEC-02, SPEC-03
- **Requirements:** FR-09/10; NFR-01/07
- **Architecture:** Layer 4 allowlist projection from a current published Event and linked Geometry records to EventDetail / GeoJSON
- **Branch/worktree:** `work/API-GEOMETRY-CORE`; `.codex-build/worktrees/api-geometry-core`
- **Owner:** GPT-6 Luna Max implementation agent; root plans and reviews

## Objective

Add a pure, fail-closed Layer 4 projection for event-linked geometry. Given the same schema 2.0 Event and public lookup inputs accepted by API-PROJECT-CORE, plus its exact referenced schema 2.0 Geometry records, produce the existing OpenAPI `EventDetail` and `PublicFeatureCollection` shapes. This is local projection logic only: it does not read a database, serve HTTP routes, authorize sources, publish events, or assert factual accuracy.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md` and `docs/IMPLEMENTATION_BACKLOG.md`
- `docs/DOMAIN_MODEL.md` — geometry evidence, roles and CRS84 constraints
- `docs/UX_API_SPEC.md` and `docs/api/openapi.yaml` — EventDetail / GeoJSON contracts
- `docs/decisions/ADR-012-public-projection-boundary.md`
- `docs/assignments/API-PROJECT-CORE.md`
- `docs/assignments/GEO-STORE-CORE.md`
- `apps/worker/src/contracts/public-api.ts`
- `apps/worker/src/layers/l4-application-integration/public-projection.ts`
- Existing Worker test files and scripts

## Required behavior

- Accept untrusted `unknown` event and geometry JSON. Reuse the accepted event validator and `EventView` projector; only `dataset_kind: live`, `publication_status: published` events can produce public detail. Historical, synthetic, withdrawn, malformed, and unresolved data fail closed with bounded errors.
- Require the supplied geometry records to match exactly the unique geometry IDs referenced by the event and its claims. Missing, duplicate, mismatched-dataset, unreferenced, or malformed geometries fail closed. A geometry is public only when a published claim both references it and has an exact matching `supports` EvidenceRef; compare revision ID, text hash, start/end code-point span, offset unit, and relation. Do not treat geometry/evidence linkage alone as proof of factual truth.
- Runtime-validate the consumed schema 2.0 Geometry fields, allowed roles, `OGC:CRS84`, precision and label. Validate RFC 7946 geometry structure, finite longitude/latitude bounds, bounded positions, line/ring sizes and polygon ring closure. Preserve coordinates exactly; do not buffer, geocode, simplify, repair, reproject, infer, or create geometries. Accept only the GeoJSON geometry kinds allowed by `docs/contracts.schema.json` (no invented GeometryCollection support).
- Construct exact `PublicGeometry` / `EventDetail` / `PublicFeatureCollection` allowlists matching the current OpenAPI contract. Never spread stored JSON or copy evidence references, provenance IDs, hashes, private fields, precision basis, or other storage metadata into output.
- Build a deterministic collection from already projected event details only, with stable feature IDs/order, exact allowed feature properties, and a finite maximum of 500 features. This helper does not add query filters, bounding-box semantics, HTTP routes, or pagination.
- Use authored, synthetic live-shaped test values only; they are not actual reports, publications, source permissions, or factual validation. Do not alter the demo runtime or represent these test records as live data.
- Keep the OpenAPI and domain contracts unchanged. No DB calls, routes, database views/grants, migrations, source/model calls, credentials, providers, dependencies, cloud changes, or publication authorization changes.

## Allowed paths

- `apps/worker/src/contracts/public-api.ts`
- `apps/worker/src/layers/l4-application-integration/public-projection.ts` (only as needed to reuse the validated event boundary)
- `apps/worker/src/layers/l4-application-integration/public-geometry-projection.ts`
- `apps/worker/test/l4-public-geometry-projection.test.ts`
- `apps/worker/package.json` — only add the focused test to the existing test command
- This assignment's implementation handoff only

Root owns routes, DB composition, storage access, API/OpenAPI contracts, architecture, backlog, and any source-rights decisions. If an unchanged contract or available geometry fields are insufficient for a safe projection, stop at the exact gap and report it.

## Acceptance and checks

- Tests compare exact top-level and nested output keys with the OpenAPI geometry, EventDetail and GeoJSON feature schemas.
- Tests cover valid point, line, and polygon projection; exact coordinate preservation; geometry-to-claim and exact support matching; stable ordering/IDs; and the 500-feature bound.
- Tests prove fail-closed behavior for non-live/withdrawn events, wrong dataset or event references, missing/duplicate/unreferenced geometry, support mismatch, extra malformed coordinates, invalid bounds/rings/roles, unsupported GeoJSON kinds, and oversized geometry/feature collections.
- Serialized responses contain none of the synthetic evidence hashes, revision IDs, trace IDs, source text markers, or storage-only geometry fields. No test claims semantic support or source permission.
- In WSL Ubuntu-26.04 run the focused test, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`. Record actual tool versions and results.
- Commit coherent work on the assigned branch, leave the worktree clean, and append exact commit SHAs/messages, changed paths, behavior, checks, limitations, and unresolved decisions. Do not push or merge.

## Handoff

Append implementation details and results here. Root reviews the branch diff and independently verifies the task before integration.

### Implementation handoff — 26 September 2026

- **Branch/worktree:** `work/API-GEOMETRY-CORE` at `D:\Projects\RPL\.codex-build\worktrees\api-geometry-core` (`/mnt/d/Projects/RPL/.codex-build/worktrees/api-geometry-core` in WSL).
- **Implementation commit:** `ac30df25d989a79219fa098a4e5f2e8073b24e8b` — `feat(API-GEOMETRY-CORE): project supported public geometry`.
- **Changed paths:** `apps/worker/src/contracts/public-api.ts`; `apps/worker/src/layers/l4-application-integration/public-projection.ts`; `apps/worker/src/layers/l4-application-integration/public-geometry-projection.ts`; `apps/worker/test/l4-public-geometry-projection.test.ts`; `apps/worker/package.json` (focused test registration only). This handoff entry is the only additional path changed for documentation.
- **Behavior:** Added typed `PublicGeometry`, `EventDetail`, and GeoJSON feature contracts; reused the accepted event validator/projector to retain an internal validated snapshot of event/claim geometry IDs and claim support references; and added a fail-closed detail projection requiring exact geometry-reference coverage, live dataset identity, compatible roles, CRS84 metadata, bounded 2D coordinates, closed polygon rings, and an exact per-claim `supports` reference match. Public geometry, EventDetail, and FeatureCollection outputs use explicit allowlists. The feature helper sorts deterministically, uses stable tuple IDs, and caps output at 500 features. Coordinate work is capped at 10,000 positions per geometry and 100,000 positions per detail or feature collection.
- **Synthetic test data:** All authored live-shaped test values and `.invalid` URLs are synthetic-only. They are not actual reports, publications, source permissions, source data, factual validation, or human review. Tests establish structure, matching and privacy filtering only.
- **WSL checks:** Ubuntu-26.04 with Node `v24.21.0`, npm `11.19.0`, TypeScript `7.0.2`, tsx `4.23.15`, Wrangler `4.137.0`, and Vite `8.3.0`. The focused geometry suite passed 8/8; full `npm test` passed web 5/5, Worker 125/125, DB 78/78 across 10 isolated files, and evaluation 12/12 (220 total); `npm run typecheck` passed; `npm run build` passed (typecheck, Vite production build, and Wrangler dry-run); `git diff --check HEAD` and `git diff --cached --check` passed. The Windows-created worktree has a Windows-form `.git` pointer, so WSL Git commands supplied its explicit `GIT_DIR` and `GIT_WORK_TREE`.
- **Migration/configuration/dependency impact:** None. No API/OpenAPI or domain contract schema changed. The temporary worktree-local `node_modules` symlink used the existing root dependency cache and was removed before staging and commit.
- **Limitations and remaining decisions:** This remains pure projection code with no database read, route, source call, publication authorization, or runtime integration. Exact structural linkage does not prove that a source semantically supports geometry or has reuse permission; hosted PostgreSQL/Neon behavior and factual quality are unverified. No unresolved decision remains within this assignment.
