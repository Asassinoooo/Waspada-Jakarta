# API-PUBLIC-GEOJSON-PROJECTION-CORE — strict projection of selected candidates

- **Backlog ID:** `API-PUBLIC-GEOJSON-PROJECTION-CORE`
- **Objective:** Project bounded current-public GeoJSON candidate rows through strict Layer 4 event/claim/geometry validation into the existing `PublicFeatureCollection` allowlist.
- **Dependencies:** `API-PUBLIC-GEOJSON-CANDIDATE-READER-CORE`, `API-GEOMETRY-CORE`, `API-PROJECT-CORE`, `SPEC-02`, `SPEC-03`, `ADR-012`, `ADR-023`.
- **Requirements:** `FR-09/10`; `NFR-01/07`.
- **Layer:** L4 — application integration / public projection.
- **Contract boundary:** Existing OpenAPI 3.1 `PublicFeatureCollection`; do not change public types, OpenAPI, query parsing, or routes.
- **Branch/worktree:** `work/API-PUBLIC-GEOJSON-PROJECTION-CORE` in the free managed checkout `C:\Users\perry\.codex\worktrees\api-geojson-route-core\RPL` (WSL: `/mnt/c/Users/perry/.codex/worktrees/api-geojson-route-core/RPL`). Start from the root's pushed assignment commit; do not edit the root checkout.
- **Owner:** GPT-6 Luna Max implementation agent; root plans, reviews, accepts, integrates, and pushes.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md` (first repository document), then `docs/IMPLEMENTATION_BACKLOG.md`
- This assignment and [ADR-023](../decisions/ADR-023-public-geojson-candidate-selection.md)
- [ADR-012](../decisions/ADR-012-public-projection-boundary.md), [ADR-018](../decisions/ADR-018-jakarta-geojson-query-envelope.md), [OpenAPI GeoJSON contract](../api/openapi.yaml)
- [API-PUBLIC-GEOJSON-CANDIDATE-READER-CORE](API-PUBLIC-GEOJSON-CANDIDATE-READER-CORE.md), [API-GEOMETRY-CORE](API-GEOMETRY-CORE.md), and [API-PROJECT-CORE](API-PROJECT-CORE.md)
- `apps/worker/src/contracts/public-api.ts`
- `apps/worker/src/layers/l4-application-integration/public-projection.ts`
- `apps/worker/src/layers/l4-application-integration/public-geometry-projection.ts`
- `apps/worker/test/l4-public-geometry-projection.test.ts` and `apps/worker/package.json`

## Context and required design

The accepted database reader returns at most 500 source-geometry candidates that already intersect the requested bbox. Such a candidate set is intentionally a subset of an event's complete geometry references: geometries outside the viewport are absent. The existing `projectPublicEventDetail` requires the full set of event- and claim-referenced geometries and must keep that strict detail behavior. Do not weaken it or treat a viewport subset as a complete `EventDetail`.

Add a distinct pure Layer 4 projection boundary for GeoJSON candidates. It may reuse `projectPublicEventForGeometry` for full schema-2.0 Event validation and public event projection, and reuse/refactor the existing geometry-record validator and `projectPublicFeatureCollection` allowlist. Validate each selected candidate independently against the exact same current published event and a published claim whose geometry ID and complete supporting `EvidenceRef` match the source Geometry record. Then emit only the selected candidates. This boundary does not repeat spatial selection; the database reader owns bbox intersection.

The projection input must carry the candidate rows from the accepted reader plus the exact-version projection lookup values needed by the existing event projector (scope names, reviewed public attributions, and impact records). These are injected inputs for a later runtime; this task does not fetch them. Reject missing, duplicate, extraneous, inconsistent, malformed, stale or unreviewed input with fixed errors that contain no IDs, geometry, source text, hashes, or database details. Require repeated event payloads within a candidate group to agree exactly, and require the lookup group to match the event ID and version.

## Required behavior

1. Add a pure injected/untrusted-input projection under `apps/worker/src/layers/l4-application-integration/`. It accepts a closed outer envelope of candidate rows and exact event/version lookup batches. Keep database JSON explicitly typed `unknown`; do not trust TypeScript assertions as validation.
2. Enforce the existing 500-feature bound before unbounded work. Require at most one lookup batch per distinct candidate event/version, no missing or unused batches, and bounded batch/array sizes. Validate that every candidate row has `dataset_kind: live`, a positive supported event version, allowed category/lifecycle/freshness, and consistent Event record identity. Candidate category, lifecycle, freshness, event ID, and version must match the strict projected Event.
3. Project each Event through the accepted strict Layer 4 Event boundary using its complete injected lookup/impact inputs. Reject withdrawn, non-live, malformed, duplicate, inconsistent-version, or stale event data with no older-version fallback.
4. Validate candidate Geometry records with the accepted CRS84/GeoJSON/role/coordinate/precision rules. A candidate ID must be present in a published claim's geometry scope and its Geometry `source_evidence` must exactly match a `supports` reference on that same claim, including revision ID, hash, code-point span, offset unit and relation. Event scope or normalized database linkage alone is not sufficient support.
5. Accept only geometries present in the bounded selected candidate set. Do not require unselected/out-of-bbox geometry references to appear in this projection input, and never emit them. Duplicate candidate identities, duplicate geometries within an event, unclaimed candidates, geometry/event/version mismatches, and inconsistent repeated Event JSON fail closed.
6. Return only the unchanged `PublicFeatureCollection` allowlist: stable Feature IDs/order, exact property keys and source coordinates preserved without clipping or alteration. Never expose traces, evidence references, hashes, source text, lookup records, raw JSON, geometry precision basis, SQL fields, or candidate metadata.
7. An empty candidate set with no lookup batches returns the exact empty FeatureCollection. It does not imply safety, no reports, or all-clear. A latest-withdrawn event is absent from the reader; a withdrawn Event passed directly to this boundary is rejected rather than falling back to an earlier version.
8. Keep this slice pure: no database calls, HTTP route, bbox parsing/intersection, pagination, runtime binding, source access, publication, moderator mutation, telemetry, provider, new dependency, or contract change.

## Allowed paths

- `apps/worker/src/layers/l4-application-integration/public-geometry-projection.ts` (or one narrowly scoped new L4 GeoJSON projection module)
- `apps/worker/test/l4-public-geojson-candidate-projection.test.ts`
- `apps/worker/package.json` — focused test registration only
- This assignment's implementation handoff only

Do not edit `apps/worker/src/contracts/public-api.ts`, `public-projection.ts`, database/Worker route code, OpenAPI, other assignments, migrations, lockfiles, deployment config, or any source/provider settings. Ask the root planner if an existing contract cannot express strict candidate projection.

## Acceptance and checks

- Tests verify exact top-level, Feature and properties allowlists; stable IDs/order; exact coordinates for supported Point, LineString and Polygon geometries; and no evidence, source, trace, or storage metadata in serialized output.
- A selected in-bbox candidate is accepted when other geometry IDs remain referenced by its event/claims but are absent from the selected set; only candidate geometries appear in the FeatureCollection.
- Tests verify each emitted geometry belongs to an exact published claim and an exactly matching supporting EvidenceRef; event-/claim-reference mismatch, claim absence, evidence mismatch, malformed/unreviewed lookup, stale identity, non-live/withdrawn input, inconsistent repeated event payload, duplicate/unrequested candidate, malformed CRS84/GeoJSON/role, and oversized coordinates fail closed.
- Tests cover an empty candidate/lookup input, the 500-feature bound and overflow, bounded lookup groups, redacted errors, and latest-withdrawn no-fallback behavior.
- Use authored fictional live-shaped objects only; the tests establish structure, not factual evidence, source rights, publication truth, or safety.
- In WSL Ubuntu-26.04 run the focused test, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`; record actual versions/results. Do not install dependencies.
- Commit implementation and this assignment handoff in coherent descriptive commits, leave the checkout clean, and return exact branch/worktree, commit SHAs/messages, changed paths, behavior, actual results, limitations, and migration/configuration impact. Do not merge or push.

## Stop conditions

Stop and report the exact gap if the existing schema 2.0 Event/Geometry/EvidenceRef fields or public lookups cannot prove same-claim support, if viewport-selected geometry cannot be projected without weakening the detail validator, or if the existing DTO cannot safely express the result. Do not add a new contract or access real sources. Escalate to GPT-6 Astra xhigh only after a GPT-6 Luna Max attempt fails on a substantive technical difficulty; timing or tool availability is not such a failure.

## Implementation handoff

Append exact branch/worktree, commits, changed paths, behavior, actual WSL checks/results, limitations and remaining decisions here. The root independently reviews and integrates accepted commits.

### Implementation handoff — 2026-09-27

- **Branch/worktree:** `work/API-PUBLIC-GEOJSON-PROJECTION-CORE` — `C:\Users\perry\.codex\worktrees\api-geojson-route-core\RPL` (`/mnt/c/Users/perry/.codex/worktrees/api-geojson-route-core/RPL` in WSL Ubuntu-26.04).
- **Implementation commit:** `8ded4c96b7fa3f11b0ba7e0c14f5dcb21f7df168` — `feat(API-PUBLIC-GEOJSON-PROJECTION-CORE): project selected public geometry candidates`.
- **Changed paths:** `apps/worker/src/layers/l4-application-integration/public-geometry-projection.ts`; `apps/worker/test/l4-public-geojson-candidate-projection.test.ts`; `apps/worker/package.json`; this assignment handoff.
- **Behavior:** Added a pure candidate-set projection with a closed envelope, 500-candidate bound, bounded lookup batches and work, exact repeated Event/version consistency, strict reuse of the current live published Event and impact/scope/attribution validation, and Geometry CRS84/role/coordinate validation. Every selected Geometry must match a geometry ID and complete `supports` EvidenceRef on the same published claim. The output reuses the existing FeatureCollection allowlist, stable IDs/order, and exact source coordinates; it contains selected geometries only. Empty input returns the exact empty collection. Withdrawn direct input fails closed without version fallback. Existing full-detail validation and the public DTO/OpenAPI are unchanged.
- **Runtime versions recorded in WSL:** Ubuntu-26.04; Node `v24.21.0`; npm `11.19.0`; Git `2.53.0`; TypeScript `7.0.2`; tsx `4.23.15`; Wrangler `4.137.0`. No dependencies were installed.
- **Checks actually run:** Focused `tsx --test apps/worker/test/l4-public-geojson-candidate-projection.test.ts` passed 10/10. `npm test` passed: Web 22/22, Worker 216/216, all 18 DB test files, and evaluation 12/12. `npm run typecheck` passed for the workspaces and evaluation package. `npm run build` passed for the Vite web build and Wrangler Worker dry-run. WSL `git diff --check` passed with no whitespace errors; Git printed only CRLF conversion warnings for unchanged repository files.
- **Limitations/configuration:** This is an injected-input projector only; it does not add runtime wiring, database reads, route behavior, or repeat bbox selection. Fixtures are authored live-shaped structures and do not establish factual support or safety. No migration or configuration impact. No remaining design decision identified in this slice; root review and acceptance remain outstanding.
- **Handoff commit:** The documentation commit containing this handoff follows the implementation commit; its exact SHA and message are returned to the root with the final handoff.


### Root review and acceptance — 27 September 2026

Root independently reviewed agent commits `8ded4c96b7fa3f11b0ba7e0c14f5dcb21f7df168` (`feat(API-PUBLIC-GEOJSON-PROJECTION-CORE): project selected public geometry candidates`) and `2d4ce22b410956efae900e9f97127de2dfe89f1a` (handoff) on `work/API-PUBLIC-GEOJSON-PROJECTION-CORE`, then cherry-picked them to `main` as `f6330eb` and `62e7dec`. The pure L4 projection validates viewport-selected geometries against the exact current live Event, published claim, and complete same-claim supporting EvidenceRef. It allows out-of-viewport references to be absent, emits only selected geometries through the unchanged FeatureCollection allowlist, preserves source coordinates, and fails closed on withdrawn or mismatched inputs without fallback.

Root independently passed the focused WSL projection test 10/10; full `npm test` (web 22, Worker 216, DB 18 test files, evaluation 12); `npm run typecheck`; `npm run build` including Wrangler `4.137.0` dry-run; and `git diff --check`. Verification used Ubuntu-26.04, Node `v24.21.0`, npm `11.19.0`, and Git `2.53.0`. No migration, dependency, contract, database read, route, provider, source access, binding or live data changed. Hosted Neon and factual support remain unverified. Runtime wiring is the next task.
