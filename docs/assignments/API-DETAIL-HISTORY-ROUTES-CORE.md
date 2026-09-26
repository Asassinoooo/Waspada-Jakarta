# API-DETAIL-HISTORY-ROUTES-CORE — synthetic public detail and history routes

- **Status:** Accepted on `main` at handoff `48c7f73`; local demo-only HTTP route slice. Root acceptance and independent checks are recorded in [the delivery log](../DELIVERY_LOG.md).
- **Contract:** Existing OpenAPI 3.1 at `docs/api/openapi.yaml`; unchanged
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

## Stop/escalation conditions

Stop and ask root to resolve any conflict between the existing OpenAPI 3.1 response shapes and the synthetic-only data; do not invent source attribution, history, locations, or live-publication behavior to fill a gap. Stop if completing a route would require database access, a new API contract, external data rights, or the unassigned GeoJSON viewport. Escalate to Astra only if Luna Max first attempts a substantive technical issue and remains unable to resolve it; a missing external permission or undecided product contract is not an escalation reason.

## Acceptance and checks

- Tests compare exact detail/history response keys with the existing OpenAPI schemas and assert demo fixture markers remain present.
- Tests cover known and unknown event IDs, malformed/overlong IDs, history default/max page size and invalid cursors, no geometry or fabricated source content, and stable empty/single-version pagination.
- Tests prove explicit non-demo mode returns 503 before reading fixture data, query/header values cannot select a dataset, non-GET methods cannot mutate data, generic failures do not leak exception detail, and telemetry includes no path IDs/query values.
- In WSL Ubuntu-26.04 run focused API tests, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`; record actual tool versions/results.
- Commit coherent implementation and handoff on the assigned branch, leave the worktree clean, and record exact commits, changed paths, checks, and limitations. Do not push or merge; root reviews and integrates.

## Handoff

Append the implementation report here.

### Implementation handoff — 26 September 2026

- **Branch/worktree:** `work/API-DETAIL-HISTORY-ROUTES-CORE` at `D:\Projects\RPL\.codex-build\worktrees\api-detail-history-routes-core` (`/mnt/d/Projects/RPL/.codex-build/worktrees/api-detail-history-routes-core` in WSL).
- **Implementation commit:** `c66bdc140a7365556e6173e1644c0a3e06267f97` — `feat(API-DETAIL-HISTORY-ROUTES-CORE): add synthetic detail and history routes`.
- **Changed paths:** `apps/worker/src/contracts/public-api.ts`; `apps/worker/src/layers/l4-application-integration/api.ts`; `apps/worker/src/layers/l4-application-integration/public-read-model.ts`; `apps/worker/test/api.test.ts`. This handoff entry is the only additional path changed for documentation.
- **Behavior:** Added the existing public detail and history GET routes over the two checked-in fictional fixtures. Detail explicitly copies the existing `EventView` fields and adds `geometries: []`. History contains one `published` entry for the fixture version, uses the fixture's `published_at`, and labels its summary as synthetic demo data. Both routes return the shared safe error envelope for invalid or absent IDs, validate the existing 1–100/default-20 cursor page bounds, reject writes with 405, and keep unexpected errors generic. The runtime's server-selected dataset check still returns 503 before fixture reads in non-demo mode. Telemetry records only the fixed `events` route category, status, and duration; sink failures remain isolated.
- **Checks:** Ubuntu-26.04 under WSL with Node.js `v24.21.0`, npm `11.19.0`, TypeScript `7.0.2`, tsx `4.23.15`, Vite `8.3.0`, and Wrangler `4.137.0`. The focused API suite passed 13/13. `npm test` passed: web 5/5, Worker 131/131, DB 78/78 across 10 isolated test files, and casebook 12/12 (226 total). `npm run typecheck` passed; `npm run build` passed, including the Vite production build and Wrangler dry-run; WSL `git diff --check` and `git diff --cached --check` passed. A temporary worktree `node_modules` symlink pointed to the existing root dependency cache for these checks and was removed before commit.
- **Migration/configuration/dependency impact:** None. No database, OpenAPI, UX contract, runtime binding, dependency, or Cloudflare configuration changed.
- **Limitations and remaining decisions:** Routes read only the current synthetic fixtures. This does not provide a database-backed live public reader or establish evidence quality, source permission, publication authorization, current real-world conditions, or user safety. Detail geometry is intentionally empty because the fixtures contain no supported geometry. No unresolved decision remains within this assignment.
