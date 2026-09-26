# L2-DIRECT-REASONING-CORE implementation handoff

## Delivery

- **Branch/worktree:** `work/L2-DIRECT-REASONING-CORE` / `D:/Projects/RPL/.codex-build/worktrees/l2-direct-reasoning-core` (`/mnt/d/Projects/RPL/.codex-build/worktrees/l2-direct-reasoning-core` in WSL).
- **Implementation commit:** `42afe02298b2b5d3d1fbd439dba8cb33128f7128` — `feat(L2-DIRECT-REASONING-CORE): persist before direct reasoning`.
- **Handoff commit:** `docs(L2-DIRECT-REASONING-CORE): record implementation handoff`; its SHA is reported to the root reviewer after this file is committed.

## Behavior implemented

`createDirectReasoningService` composes the existing injected `ReasoningContextPersister` and `ModelCapabilityAdapter.reason`. The persister validates the untrusted request and persists its canonical refs-only context before the service branches. When the validated caller-supplied `sufficient` value is false, the service returns `investigation_required` with the validated in-memory request and persisted record and does not call the reasoner. When it is true, the service calls `reason` once with the validated request and returns the adapter's exact typed outcome object.

Validation and persistence failures skip reasoning and propagate the original error object. Direct-reasoning telemetry records only a closed outcome and finite non-negative duration. Outcomes are `investigation_required`, `succeeded`, `not_configured`, `invalid_request`, `invalid_output`, `provider_error`, or `error`. The console sink emits only `event_name`, `outcome`, and `duration_ms`; the default sink is no-op, and sink exceptions cannot replace service results or errors.

Tests use authored synthetic requests and a scripted provider double defined only in test code. They cover persist-before-reason ordering, insufficient-context bypass, exact typed-outcome passthrough, explicit adapter failure states, validation/persistence error identity, telemetry privacy/allowlisting, the no-op default, and sink failures.

## Changed paths

- `apps/worker/src/layers/l2-model-grounding/direct-reasoning.ts`
- `apps/worker/src/layers/l5-evaluation-monitoring/telemetry.ts`
- `apps/worker/test/l2-direct-reasoning.test.ts`
- `apps/worker/package.json` — explicit test discovery only
- `docs/assignments/L2-DIRECT-REASONING-CORE-HANDOFF.md`

No model/public API contract, schema, validator, retrieval, database, migration, grant, provider configuration, dependency, lockfile, route, or deployment change was made.

## Checks actually run

Checks ran in WSL Ubuntu-26.04 using native Node.js `v24.21.0` and npm `11.19.0`.

- `./node_modules/.bin/tsx --test apps/worker/test/l2-direct-reasoning.test.ts` — passed, 9/9.
- `npm test` — passed, 188/188 total: web 5, Worker 93, database 78 across 10 isolated files, and evaluation casebook 12.
- `npm run typecheck` — passed across web, Worker, database, and evaluation tooling.
- `npm run build` — passed; Vite `8.3.0` production build and Wrangler `4.137.0` deploy dry-run succeeded. No deployment occurred.
- `git diff --check` and staged `git diff --cached --check` — passed in WSL with explicit Git worktree paths.

## Limitations

No live provider, L3 coordinator, application route, publication path, deployment, or model-quality claim was added. The scripted provider verifies the local adapter boundary only. Hosted provider behavior and application/database runtime composition remain unverified. Root review and integration remain pending.
