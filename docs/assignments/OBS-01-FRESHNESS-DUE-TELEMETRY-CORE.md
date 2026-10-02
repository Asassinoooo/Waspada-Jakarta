# OBS-01-FRESHNESS-DUE-TELEMETRY-CORE — safe telemetry for freshness schedule runs

**Status:** Assigned for isolated implementation.<br>
**Backlog ID:** `OBS-01-FRESHNESS-DUE-TELEMETRY-CORE`<br>
**Implementation model:** GPT-6 Luna, max reasoning<br>
**Branch:** `work/OBS-01-FRESHNESS-DUE-TELEMETRY-CORE`<br>
**Worktree:** `/mnt/c/Users/perry/.codex/worktrees/obs-01-freshness-due-telemetry-core/RPL`<br>
**Assigned base:** `ec658bf4f1ab986b6a3afe66325b26b1cd7ba8f2`.<br>
**Contract baseline:** Accepted `TelemetryRecord`/`TelemetrySink`, `consoleTelemetry` and `noOpTelemetry`, the `LIFE-01-FRESHNESS-DUE-WORKER-RUNTIME-CORE` scheduled runtime, and its disabled-by-default gates. Do not change public API/DTOs, database contracts, freshness evaluator/trace behavior, or activation configuration.

## Objective

Add privacy-safe Layer 5 operational telemetry to active freshness due schedule runs. Reuse the existing typed telemetry sink and its structured console serializer. Keep telemetry optional and failure-isolated; the scheduled runtime's result and fixed error behavior must not depend on logging success.

## Dependencies

`LIFE-01-FRESHNESS-DUE-WORKER-RUNTIME-CORE`, `OBS-01-API-TELEMETRY-CORE`, and the existing `apps/worker/src/layers/l5-evaluation-monitoring/telemetry.ts` contracts.

## Required behavior

1. Add one closed telemetry event for an active scheduled invocation. Use a bounded outcome vocabulary for completed evaluation, failed evaluation/runtime, and terminal trace replay; record a finite nonnegative duration. Include the evaluator's validated five-counter summary when one exists, with every count in `[0, 100]` and total at most 100. Terminal replays have no newly evaluated counts.
2. The serialized allowlist must exclude scheduled timestamps, run/trace/evaluation IDs, dataset or tenant IDs, event/impact/source/evidence identifiers, event text, SQL/driver/provider details, connection data, exception messages, and arbitrary error codes.
3. A disabled runtime emits no event because it returns before opening a client. The Worker composition may pass the existing `consoleTelemetry` sink to an active runtime; no external telemetry provider, environment binding, sampling configuration, or remote collection setup is added. Keep `noOpTelemetry` available as the runtime default for isolated callers/tests.
4. Telemetry validation, timing, and sink failures must not change a successful/failed trace outcome, leak details, mask the runtime's fixed error, or cause a retry by themselves. Emit at most one record per active scheduled invocation.
5. Keep the runtime opt-in gates, single-client/role boundaries, stable trace identity, one-page limit, and current trace counters unchanged. Do not add database writes, public API behavior, event/source access, or model inference.

## Allowed paths

- `apps/worker/src/layers/l5-evaluation-monitoring/telemetry.ts`
- `apps/worker/src/runtime/freshness-due-schedule-runtime.ts`
- `apps/worker/src/runtime/freshness-due-schedule-trigger.ts`
- `apps/worker/src/index.ts` (scheduled telemetry composition only)
- `apps/worker/test/l4-freshness-due-schedule-runtime.test.ts`
- `apps/worker/test/l5-freshness-due-schedule-telemetry.test.ts` (new)
- `apps/worker/package.json` (test command entry only; no dependencies/version changes)
- `docs/assignments/OBS-01-FRESHNESS-DUE-TELEMETRY-CORE-HANDOFF.md` (new handoff)

Do not change `wrangler.toml`, environment bindings, secrets, migrations, API/OpenAPI schemas, source access, hosted roles, provider resources, retention settings, or deployment state. Ask root before changing any other path or contract.

## Acceptance and verification

- Tests verify the event's exact schema and serialized allowlist, success/failure/terminal-replay outcomes, bounded count and duration validation, one record per active invocation, no record for disabled execution, and sink-failure isolation.
- Existing freshness runtime and telemetry tests remain passing; no synthetic/live classification, identifier, private source content, or driver error is present in console output.
- Use installed dependencies only. Run focused Worker runtime/telemetry tests, `npm run typecheck`, `npm test`, `npm run build`, and `git diff --check ec658bf4f1ab986b6a3afe66325b26b1cd7ba8f2..HEAD` in WSL Ubuntu-26.04. Record actual versions and results.
- Work only in the assigned branch/worktree. Commit implementation/tests and handoff in coherent commits. Do not merge or push; root reviews and integrates.

## Stop conditions

Stop and report to root if safe telemetry requires database/API schema changes, a new provider or external sink, a new environment binding, or changes to the scheduled activation gates. Do not install dependencies or configure any hosted service. Escalate to Astra only if a Luna/max attempt documents a substantive unresolved technical blocker.
