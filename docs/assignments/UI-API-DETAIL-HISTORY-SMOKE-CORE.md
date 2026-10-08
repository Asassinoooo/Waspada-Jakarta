# UI-API-DETAIL-HISTORY-SMOKE-CORE — verify synthetic detail/history through the local UI/API smoke

- **Status:** Implementation and WSL verification complete; pending root review.
- **Backlog ID:** `UI-API-DETAIL-HISTORY-SMOKE-CORE`
- **Depends on:** `BOOT-01`, `API-DETAIL-HISTORY-ROUTES-CORE`, `UI-API-DETAIL-HISTORY-CORE`, `SPEC-03`.
- **Requirements:** `US-01`; `FR-09/10/15`; `NFR-03/07/08`.
- **Architecture:** Test-only local Vite-to-Worker API/UI composition.
- **Exact base:** `931ebef205166dd273e507ba3fe397c16309338d`.
- **Branch/worktree:** `work/UI-API-DETAIL-HISTORY-SMOKE-CORE` at `D:\Projects\RPL\.codex-build\worktrees\ui-api-detail-history-smoke-core` (`/mnt/d/Projects/RPL/.codex-build/worktrees/ui-api-detail-history-smoke-core` in WSL).
- **Contracts:** Existing public `EventDetail` and `HistoryPage` shapes and OpenAPI operations remain unchanged.

## Objective

Extend the existing local smoke so an event returned by the synthetic event-list route is read through its detail and history routes, then rendered through the actual `EventDetail` component. This verifies the route-to-client-to-component seam with the existing demo fixtures. It does not verify live database reads, source evidence, or current conditions.

## Required behavior

- Keep the existing local Vite shell, context, event-list, header, and feed checks.
- Use the existing browser API client for `/context`, `/events`, `/events/{event_id}`, and `/events/{event_id}/history` while routing requests through the local Vite proxy.
- Select a listed event ID and require its returned detail and history entry to match that event's ID and version.
- Render the returned detail and history in the real `EventDetail` component with the returned demo context.
- Assert the global demo banner; the API-provided title, summary, event time, history change label, history summary, publication timestamp, and change timestamp; and the existing explanatory states for missing evidence and geometry.
- Keep the existing fictional fixture data unchanged. Do not add source names, claims, coordinates, geometry, safety claims, or live-mode behavior.

## Scope

- **Allowed paths:** `apps/web/test/smoke-local.tsx`; this assignment and its handoff; `docs/IMPLEMENTATION_BACKLOG.md`.
- **Forbidden scope:** Production code, API/OpenAPI/DTO/domain contracts, fixture records, dependencies, runtime gates, database configuration, cloud or hosted resources, and external services.
- **No design decision or ADR change is needed.** The task uses the accepted synthetic demo routes and the existing detail/history UI.

## Acceptance criteria

- With local Vite and Worker development servers running, `npm run smoke` fetches context and a listed event, then fetches that event's detail/history through the proxy.
- The smoke renders the actual `EventDetail` component using those API responses and confirms matching event identity/version.
- Rendered output contains the demo label, API-provided title, summary, and formatted event time; the mapped history label and summary; and the exact API publication/change timestamps.
- Rendered output keeps empty evidence and geometry explicitly unavailable and does not present synthetic data as live or empty geometry as safety.
- Only the smoke script and assigned task documentation change; public contracts, production behavior, dependencies, and configuration remain unchanged.

## Verification

Verified in WSL Ubuntu-26.04 using the existing Linux Node runtime (`v24.21.0`, npm `11.19.0`):

- `npm run dev` with `npm run smoke`: passed against the local Vite-to-Worker proxy; smoke fetched context, list, detail, and history routes and rendered the actual detail component.
- `npm exec --workspace=@waspada/web -- tsx --test test/api-client.test.ts test/ui.test.tsx`: passed, 23/23 tests.
- `npm test`: passed (web 60/60, Worker 451/451, DB 43/43 test files, and the remaining workspace checks; exit code 0).
- `npm run typecheck`: passed.
- `npm run build`: passed, including Vite production build and Wrangler Worker dry-run.
- `git diff --check`: passed before commit; assigned-base range check is recorded in the implementation handoff after commit.

No install, external service, or browser automation was used.

## Stop conditions

Stop and report to root if the local route responses cannot be rendered under the existing contract, if passing the demo context requires changing production behavior, or if the work would need a fixture/contract/provider/authentication change. Do not merge or push.

## Implementation handoff

The change is limited to the smoke test, this assignment, and the backlog row. The API contracts, production UI, fixture data, dependencies, runtime gates, and configuration are unchanged. The smoke covers local synthetic data only and makes no live-data, source-evidence, or safety claim. No migration/configuration impact or design decision remains.
