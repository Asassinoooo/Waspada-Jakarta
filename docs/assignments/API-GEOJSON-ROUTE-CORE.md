# API-GEOJSON-ROUTE-CORE — synthetic public GeoJSON route

- **Status:** Assigned; synthetic route only
- **Parent work package:** API-01 — Public published-event endpoints
- **Requirements:** FR-09/10; NFR-01/07
- **Dependencies:** API-GEOMETRY-CORE, API-DETAIL-HISTORY-ROUTES-CORE, SPEC-03, ADR-018
- **Layer:** L4 — application integration
- **Contract baseline:** Existing OpenAPI 3.1 `GET /api/v1/events.geojson`; the `bbox` envelope is specified in ADR-018 and `docs/api/openapi.yaml`. Do not change the contract.
- **Implementation agent:** GPT-6 Luna, max reasoning
- **Branch:** `work/API-GEOJSON-ROUTE-CORE`
- **Worktree:** `C:\Users\perry\.codex\worktrees\api-geojson-route-core\RPL` (managed checkout; verify the returned path before dispatch)
- **Owner:** Luna Max implementation agent; root plans, reviews, accepts, integrates, and pushes

## Objective

Implement the existing read-only GeoJSON HTTP route for the current synthetic demo runtime and validate its optional bounding box against the documented Jakarta application query envelope. This does not implement the live database reader. The current demo fixtures contain no source-supported geometry, so the route must return a correctly typed empty FeatureCollection; never create illustrative coordinates or imply that the empty response means an area is safe.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md` (first repository document), then `docs/IMPLEMENTATION_BACKLOG.md`
- `docs/UX_API_SPEC.md` and `docs/api/openapi.yaml` — exact route, filters, response, and shared errors
- `docs/decisions/ADR-018-jakarta-geojson-query-envelope.md`
- `docs/assignments/API-GEOMETRY-CORE.md` and its handoff
- `docs/assignments/API-DETAIL-HISTORY-ROUTES-CORE.md`
- `apps/worker/src/contracts/public-api.ts`
- `apps/worker/src/layers/l4-application-integration/api.ts`
- `apps/worker/src/layers/l4-application-integration/public-read-model.ts`
- `apps/worker/src/layers/l4-application-integration/public-geometry-projection.ts`
- `apps/worker/test/api.test.ts` and Worker test scripts

## Required behavior

1. Implement `GET /api/v1/events.geojson` using the existing `PublicFeatureCollection` contract and shared error envelope. Serve the GeoJSON success body as `application/geo+json`. Keep other routes unchanged.
2. If `bbox` is absent, use the full inclusive ADR-018 envelope. Otherwise require exactly four finite CRS84 decimal values in `west,south,east,north` order, `west <= east`, `south <= north`, and every bound within `[106.32,-6.40,106.98,-5.16]`. Reject malformed, reversed, out-of-envelope, or overlong values with the existing safe 400 response. Bounds on the envelope edges are valid; antimeridian wrapping is unsupported.
3. Validate the route's existing `category`, `lifecycle`, and `freshness` query parameters against the OpenAPI enums. Do not silently accept unknown values. No other query filters or pagination are added.
4. Use only the current server-selected demo mode. Preserve the existing behavior: non-GET methods return 405, and an explicitly non-demo runtime returns 503 before fixture access. Browser inputs cannot change dataset mode.
5. Current checked-in demo events have no source-supported geometry. Return `projectPublicGeoJSON([])` (or an equivalent exact allowlist result) and do not emit a fake feature, coordinate, radius, boundary, or hazard polygon. Do not route synthetic fixtures through the live publication projector.
6. Keep route telemetry on the existing fixed `events` category. Never log bbox text, IDs, query values, or exception details; a telemetry sink failure must not affect the response.
7. Preserve error privacy: malformed bounds return a stable generic validation message, and unexpected failures return the existing generic server error without exception text.

## Explicitly out of scope

- Database or Neon reads, public DB roles, SQL, migrations, live source geometry, source activation, auth, publication, moderator workflows, model calls, runtime bindings, Cloudflare changes, or deployment.
- New dependencies, event geometry fixtures, changes to the OpenAPI/domain contract, changes to projector semantics, or user-interface work.
- Computing an administrative polygon, using the query envelope to establish Jakarta membership, clipping geometry, or presenting it as an event danger zone.

## Allowed paths

- `apps/worker/src/layers/l4-application-integration/api.ts`
- `apps/worker/src/layers/l4-application-integration/public-read-model.ts`
- A narrowly scoped new GeoJSON query helper under `apps/worker/src/layers/l4-application-integration/`
- `apps/worker/test/api.test.ts` and a focused Worker test file if useful
- `apps/worker/package.json` only to register a focused test in the existing test script
- The implementation handoff section appended to this assignment only

Do not edit `docs/api/openapi.yaml`, ADR-018, the backlog, architecture, other tasks, package lockfiles, migrations, or the public DTO contracts. Ask root if the unchanged contract is insufficient.

## Acceptance and checks

- Known GeoJSON route returns HTTP 200, `application/geo+json`, and the exact FeatureCollection allowlist with zero features in current demo mode.
- Tests cover absent bbox default, inclusive envelope edges, a normal in-envelope bbox, malformed count/number, non-finite input, reversed bounds, out-of-envelope values, and safe error content.
- Tests cover category/lifecycle/freshness enums, 405 behavior, non-demo 503 before data access, unknown paths, and exact `events` telemetry category with no query-value leakage and sink-failure isolation.
- Existing list/detail/history/context behavior and response content types remain unchanged.
- In WSL Ubuntu-26.04 run focused Worker API tests, the full `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`. Record tool versions and actual results.
- Commit implementation and handoff as coherent descriptive commits on the assigned branch. Do not merge or push. Return exact branch/worktree, SHAs/messages, files, behavior, actual checks, limitations, and migration/configuration impact. Leave the worktree clean.

## Stop conditions

Stop and report the exact issue if safe completion requires database access, a new contract, source permissions, any inferred geometry, or a different application envelope. Escalate to Astra only after a substantive technical issue was attempted and remains unresolved by Luna Max; usage limits, timing, or missing external permissions do not qualify.

## Implementation handoff

Append the completed implementation report here. Root independently reviews and verifies the branch before integration or acceptance.
