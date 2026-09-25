# OBS-01-API-TELEMETRY-CORE — measured Worker request telemetry

**Parent package:** OBS-01 (Layer 5 evaluation and monitoring)
**Status:** Assigned; local synthetic demo only
**Implementation model:** GPT-6 Luna, max reasoning
**Branch:** `work/OBS-01-API-TELEMETRY-CORE`
**Worktree:** `.codex-build/worktrees/obs-01-api-telemetry-core`

## Objective

Replace the synthetic read API's discarded request measurements with an injected, privacy-safe Layer 5 telemetry sink. Keep the public API response contract and route behavior unchanged. The Worker entry point writes a small structured event through `console`; Cloudflare Workers Logs collects that event when this Worker is later deployed with the committed configuration.

This is request-operational telemetry only. It does not implement event-quality, model-cost, source-health, evaluation dashboards, alerting, or human-feedback metrics, which need later integrations and/or adjudicated data.

## Read first and dependencies

- `SOFTWARE_DEVELOPMENT_PLAN.md`
- `ARCHITECTURE.md`
- `docs/IMPLEMENTATION_BACKLOG.md` and this assignment
- `apps/worker/src/layers/l4-application-integration/api.ts`
- `apps/worker/src/layers/l5-evaluation-monitoring/telemetry.ts`
- `apps/worker/src/index.ts`
- `apps/worker/test/api.test.ts`
- `apps/worker/wrangler.toml`

Dependencies `BOOT-01` and ongoing package `OBS-01` are accepted. Only the local demo read API is in scope. No real report/event data or source connection is involved.

## Allowed paths

- `apps/worker/src/layers/l4-application-integration/api.ts`
- `apps/worker/src/layers/l5-evaluation-monitoring/telemetry.ts`
- `apps/worker/src/index.ts`
- `apps/worker/test/api.test.ts` and a focused telemetry test file if needed
- `apps/worker/package.json` only to include a new focused test file
- `apps/worker/wrangler.toml`
- `docs/assignments/OBS-01-API-TELEMETRY-CORE-HANDOFF.md`

Do not change the OpenAPI contract, public response schema, route behavior, storage, other layers' schemas, dependency manifests/lockfile, or any unrelated files.

## Design and guardrails

- Preserve an injected `TelemetrySink` boundary. Keep direct API tests able to inject a recorder; test helpers may default to the existing no-op sink. The actual Worker entry point explicitly selects the structured console sink.
- Emit one structured custom record for each sampled request with only a fixed event name and the route category (`context`, `events`, or `other`), HTTP status, and non-negative duration in milliseconds. Never pass/log the `Request`, URL, query string, headers, body, error message, request ID, source text, event text, or user-supplied values.
- A sink failure must not change or prevent the API response.
- Continue measuring success, validation errors, method errors, unavailable demo mode, and not-found responses. Do not change their existing response behavior.
- Configure `[observability]` with `enabled = true` and `head_sampling_rate = 0.01`. Under `[observability.logs]`, set `invocation_logs = false` so Cloudflare's default per-invocation URL logging does not expose query strings. No Cloudflare resource is provisioned or deployed by this assignment.
- Workers Logs is currently included in Free with 200,000 log events per day and three-day retention; the committed 1% sampling rate limits custom event volume. See Cloudflare's [Workers Logs documentation](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/). Do not switch to a paid plan or add a paid log service.

## Acceptance criteria

1. Tests prove the injected sink receives one correctly categorized, bounded record on representative success and error paths.
2. Tests prove records contain only the permitted fields and never include request-derived content.
3. A throwing telemetry sink leaves the original response status/body behavior unchanged.
4. The structured console sink maps the internal camel-case record to the documented stable JSON field names without adding request data.
5. Wrangler configuration enables 1% Workers Logs sampling and disables invocation URL logs; the Worker dry-run accepts it.
6. Existing API contract and all unrelated responses remain unchanged.
7. Implementer runs focused Worker tests and relevant typecheck/build checks in WSL Ubuntu-26.04, then commits implementation and a separate detailed handoff commit on the assigned branch. No deployment.

## Verification and handoff

Use WSL Ubuntu-26.04 and the repository's existing pinned dependencies. At minimum run focused Worker API/telemetry tests, `npm run typecheck`, `npm run build`, and `git diff --check`. Report exact commands/results, files, both commit SHAs/messages, limitations, and confirm no deployment, external account change, or dependency change.

Stop and ask the root orchestrator if a public contract change, new dependency, request-content logging, migration, external account operation, or paid capability appears necessary. Do not widen scope to fill later OBS-01 metrics without an explicit assignment.
