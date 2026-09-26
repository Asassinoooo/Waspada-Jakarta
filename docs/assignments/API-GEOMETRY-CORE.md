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
