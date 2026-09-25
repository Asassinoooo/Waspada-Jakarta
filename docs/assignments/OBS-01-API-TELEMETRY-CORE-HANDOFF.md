# OBS-01-API-TELEMETRY-CORE — implementation handoff

## Delivery

- Branch: `work/OBS-01-API-TELEMETRY-CORE`
- Worktree: `D:\Projects\RPL\.codex-build\worktrees\obs-01-api-telemetry-core`
- Implementation commit: `69873247d21d17bf5b1839ea104b2e928589acbd` — `feat(OBS-01-API-TELEMETRY-CORE): add safe sampled API telemetry`
- The handoff documentation is committed separately after the implementation.

## Behavior implemented

`handlePublicApiRequest` accepts an injected `TelemetrySink` and defaults to the existing no-op sink for direct callers and tests. Its `finally` block records one event for each handled request, including successful responses, validation errors, method errors, unavailable demo mode, and not-found responses. It supplies only the fixed `api_request` event name, the `context`/`events`/`other` route category, response status, and a finite non-negative duration in milliseconds. A throwing sink is caught so it cannot replace or prevent the API response.

The Worker entry point explicitly selects `consoleTelemetry`. That sink logs one plain structured object with the stable fields `event_name`, `route`, `http_status`, and `duration_ms`; it constructs this object from an allowlist, so extra properties on a runtime record are ignored. Wrangler enables observability with `head_sampling_rate = 0.01` and sets `observability.logs.invocation_logs = false`.

API response schemas, route behavior, storage, and public contracts are unchanged. No database migration or dependency change was made. The only runtime configuration change is the Worker’s Wrangler observability configuration.

## Changed implementation paths

- `apps/worker/src/index.ts`
- `apps/worker/src/layers/l4-application-integration/api.ts`
- `apps/worker/src/layers/l5-evaluation-monitoring/telemetry.ts`
- `apps/worker/test/api.test.ts`
- `apps/worker/wrangler.toml`

## Verification

Checks ran in WSL Ubuntu-26.04 with Node.js `v24.21.0` and npm `11.19.0`. The repository lockfile versions used were `tsx@4.23.15`, `typescript@7.0.2`, and `wrangler@4.137.0`.

- `npm ci` — installed the 88 already locked packages; audit reported 0 vulnerabilities. No dependency manifest or lockfile changed.
- `npx tsx --test apps/worker/test/api.test.ts` — passed, 7/7 tests. Coverage includes the five response paths (200, 400, 405, 503, and 404), exact safe record fields, privacy-marker exclusion, a throwing sink, and the console sink’s stable allowlisted object.
- `npm run typecheck` — passed for web, Worker, database, and evaluation TypeScript projects.
- `npm run build` — passed. The web build completed, then Wrangler `4.137.0` accepted the observability settings during `wrangler deploy --dry-run --outdir dist` and exited with `--dry-run: exiting now`.
- `git diff --check` — passed before the implementation commit; the staged diff check also passed.

## Limitations and remaining decisions

This is local synthetic-demo telemetry. The Wrangler dry-run verifies configuration parsing and Worker bundling only; no Worker was deployed, no Cloudflare account/resource was changed, and collection in Workers Logs was not verified remotely. This task does not add quality, model-cost, source-health, evaluation-dashboard, alerting, or human-feedback metrics. There are no remaining design decisions within this assignment’s scope.
