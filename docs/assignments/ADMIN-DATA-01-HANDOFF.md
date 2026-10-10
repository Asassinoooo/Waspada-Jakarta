# ADMIN-DATA-01 implementation handoff

- **Branch:** `work/ADMIN-DATA-01`
- **Assignment:** [ADMIN-MAP-01](ADMIN-MAP-01.md)
- **Source commits:** `b450eae`, `965f6de`, `97646bf`
- **Status:** data and monitoring slice complete; awaiting integration with the dashboard and map slices.

## Delivered

- `apps/web/src/admin-monitoring.ts` exports `createAdminMonitor({ onState, fetch?, scheduler?, clock? })`. The returned monitor has `start()`, `pause()`, `refresh()`, `stop()`, `setVisible(boolean)` and `setOnline(boolean)`. The optional fetch, scheduler and clock are test seams.
- Public mode performs only same-origin `GET /api/v1/context`, `GET /api/v1/events?limit=20`, and `GET /api/v1/events.geojson`. It polls every 30 seconds while enabled, visible and online; coalesces concurrent refreshes; aborts/discards work on pause, hidden, offline or stop; and backs off from 60 seconds to a five-minute cap after failures. Each request, including body reading and parsing, has a 15-second abortable deadline.
- Responses are size-bounded and validated against closed public DTO shapes before projection. The first page is limited to 20 events. Context must have a consistent live/demo mode and dataset label before any list or geometry request is made. Every new attempt clears the prior snapshot while the current context, event page and geometry are read, preventing records from a previous dataset from appearing under the new context. Public item geometry is included only for exact `event_id` and version matches; all matching features are retained across `geometry` and `additionalGeometries`. Failed list data does not retain old items, failed geometry does not retain old shapes, and a failed context clears the public snapshot. `lastSuccessAt` remains separate from the most recent attempt and its probe results.
- Public items preserve lifecycle, freshness, event-time precision and validity in `publicStatus`. Date-only values are accepted only with `precision: "date"`; `precision: "range"` requires ordered instant endpoints. Calendar components, instant components and interval order are validated. Internal L1–L3/L5 counts remain `null`/unavailable where the public API provides no measurement.
- `apps/web/src/admin-fixtures.ts` exports the readonly 10-entry `SIMULATION_STEPS` array and `createSimulationSnapshot(step)`. Steps are zero-based; invalid positions deterministically throw `RangeError`. Each snapshot is deeply frozen and uses fictional Jakarta labels, synthetic timestamps and synthetic-only geometry. Scenarios cover an unmapped item, parser quarantine, conflicting evidence, bounded L3 stop, moderator hold, synthetic publication and a cross-layer source outage. The fixture has no network or write path and is not imported by the public API.
- `apps/web/test/admin-monitoring.test.ts` covers fixture immutability, public request allowlists, exact geometry joins, invalid and contradictory contexts, first-page bounds, date validation, partial failures, generation-discard races, lifecycle aborts, timeout/backoff, and retained success timestamps.

## Validation

Run under WSL Ubuntu-26.04 with Node.js `v24.21.0` and the prepared workspace dependencies:

```sh
npm exec --workspace=@waspada/web -- tsx --test test/admin-monitoring.test.ts
npm run typecheck --workspace=@waspada/web
```

Both commands passed; focused tests reported **13 passed, 0 failed**, and web typecheck completed successfully. `git diff --check` is also clean.

## Integration notes and limits

The UI can import `SIMULATION_STEPS` and `createSimulationSnapshot` directly. Keep the array shape: `SIMULATION_STEPS.length` is the finite count, and the UI selects zero-based indexes. For public mode, pass each monitor state from `onState` into the dashboard; call `start` only while the route is active, then coordinate `setVisible`/`setOnline` with browser lifecycle or rely on the monitor's browser listeners. `refresh` coalesces with an in-flight attempt.

This slice does not add authenticated/private monitoring, backend telemetry, source ingestion, writes, routes, browser persistence or hosted configuration. It cannot report internal queues, model/token use, moderator workload or private L1–L3/L5 counts; those remain explicitly unavailable. Full web suite/build, local route smoke, visual/browser checks and cross-slice integration are pending the root integration branch and UI/map deliveries.
