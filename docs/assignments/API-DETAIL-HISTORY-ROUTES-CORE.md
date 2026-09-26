# API-DETAIL-HISTORY-ROUTES-CORE — synthetic public detail and history routes

- **Status:** Assigned; local demo-only HTTP route slice
- **Depends on:** API-PROJECT-CORE, API-GEOMETRY-CORE, SPEC-03
- **Requirements:** FR-09/10; NFR-01/07
- **Layer:** L4 — application integration
- **Implementation model:** GPT-6 Luna, max reasoning
- **Branch/worktree:** `work/API-DETAIL-HISTORY-ROUTES-CORE`; `.codex-build/worktrees/api-detail-history-routes-core`
- **Owner:** Luna Max implementation agent; root plans and reviews

## Objective

Implement the existing public `GET /api/v1/events/{event_id}` and `GET /api/v1/events/{event_id}/history` contracts for the local synthetic demo runtime. Reuse only the current explicitly fictional demo EventView fixtures. Detail adds an empty geometry array; history contains only the known synthetic fixture version. This gives the current UI safe route behavior while database-backed public reads remain unimplemented.

This is demo route composition only. The accepted projectors reject synthetic records from publication, so do not relabel fixtures as live or force them through a live-publication path. A future live reader must separately load internal rows and invoke the accepted L4 projectors before serialization.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md` and `docs/IMPLEMENTATION_BACKLOG.md`
- `docs/UX_API_SPEC.md` and `docs/api/openapi.yaml` — exact existing paths and DTO schemas
- `docs/decisions/ADR-012-public-projection-boundary.md`
- `docs/assignments/API-PROJECT-CORE.md` and `docs/assignments/API-GEOMETRY-CORE.md`
- `apps/worker/src/contracts/public-api.ts`
- `apps/worker/src/layers/l4-application-integration/api.ts`
- `apps/worker/src/layers/l4-application-integration/public-read-model.ts`
- `apps/worker/src/layers/l4-application-integration/synthetic-fixtures.ts`
- `apps/worker/test/api.test.ts`

## Required behavior

- Add the detail and history GET routes using the existing OpenAPI paths, methods, shared error envelope, and closed `EventDetail`, `HistoryEntry`, and `HistoryPage` shapes. Do not modify OpenAPI or UX contracts.
- Return detail only for a known synthetic fixture, preserving its explicit fictional title/summary and all current EventView fields, and add `geometries: []`. Do not invent claims, sources, dates, places, locations, safety assessments, or spatial regions.
- Return history only for a known synthetic fixture. Represent only its single checked-in fixture version with a concise demo-specific summary and its existing `published_at`; use bounded cursor/limit behavior matching the existing page convention. Unknown IDs return the documented 404 without exposing private data.
- Validate the path identifier and history query bounds; malformed IDs, cursors, or page sizes return the existing safe 400 error. Non-GET methods remain read-only and return 405. Unexpected read failures return a generic safe error without exception details.
- Preserve the current server-selected `DATASET_MODE` behavior. Any explicitly non-demo mode must return the existing 503 before reading a fixture. Browser query/header input cannot switch datasets.
- Keep telemetry bounded to the existing fixed route category `events`; never include event IDs, query values, or exception text. Sink failure must not change the response.
- Add typed HistoryEntry/HistoryPage DTOs only if needed to match the unchanged OpenAPI schema. Keep demo fixtures visibly synthetic in returned title/summary and the existing context response.
- Test only local synthetic fixtures. Do not claim these routes verify source evidence, real publication, user safety, or live behavior.

## Explicitly out of scope

- `/api/v1/events.geojson` and `bbox` validation. OpenAPI describes a configured Jakarta viewport but the project has not selected/recorded its bounds; do not invent them.
- Database, Neon, public-reader database roles, SQL/views, migrations, auth, publication, source/model calls, credentials, new dependencies, Cloudflare configuration, deployment, or human-evaluation claims.
- Changes to response schemas, OpenAPI, UI, the event-list contract, or public projector semantics.

## Allowed paths

- `apps/worker/src/contracts/public-api.ts`
- `apps/worker/src/layers/l4-application-integration/api.ts`
- `apps/worker/src/layers/l4-application-integration/public-read-model.ts`
- `apps/worker/test/api.test.ts`
- This assignment's implementation handoff only

Root owns API/OpenAPI contracts, database and runtime composition, future live readers, GeoJSON viewport decisions, architecture and backlog acceptance. If a contract cannot be followed safely within these paths, report the exact gap rather than broadening scope.

## Acceptance and checks

- Tests compare exact detail/history response keys with the existing OpenAPI schemas and assert demo fixture markers remain present.
- Tests cover known and unknown event IDs, malformed/overlong IDs, history default/max page size and invalid cursors, no geometry or fabricated source content, and stable empty/single-version pagination.
- Tests prove explicit non-demo mode returns 503 before reading fixture data, query/header values cannot select a dataset, non-GET methods cannot mutate data, generic failures do not leak exception detail, and telemetry includes no path IDs/query values.
- In WSL Ubuntu-26.04 run focused API tests, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`; record actual tool versions/results.
- Commit coherent implementation and handoff on the assigned branch, leave the worktree clean, and record exact commits, changed paths, checks, and limitations. Do not push or merge; root reviews and integrates.

## Handoff

Append the implementation report here.
