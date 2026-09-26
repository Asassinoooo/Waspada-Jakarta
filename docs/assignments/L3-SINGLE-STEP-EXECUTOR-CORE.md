# L3-SINGLE-STEP-EXECUTOR-CORE — reserve and execute one registered investigation action

- **Status:** Accepted on `main` at handoff `22b1f10`; root acceptance recorded in [delivery log](../DELIVERY_LOG.md)
- **Depends on:** ADR-014, ADR-017, L3-LEDGER-CORE, L3-INSUFFICIENT-CONTEXT-ENTRY-CORE, OBS-01-L3-LEDGER-TELEMETRY-CORE
- **Requirements:** FR-07; NFR-01/02/05/07
- **Layer:** L3 — bounded action execution
- **Implementation model:** GPT-6 Luna, max reasoning
- **Branch/worktree:** `work/L3-SINGLE-STEP-EXECUTOR-CORE`; `.codex-build/worktrees/l3-single-step-executor-core`

## Objective

Implement a Worker service that validates a caller-supplied typed action proposal against a trusted injected action registry, reserves the explicit worst-case action budget through the existing durable ledger, invokes a handler only after ledger authorization, and reconciles one result. A service call can execute at most one action. No planner, model, source adapter, network call, scheduler, runtime composition, route, or publication path is added.

The registry is the capability boundary: each registered action supplies its exact action name, a strict input parser, explicit maximum active seconds, and an injected handler returning only a bounded status/reference receipt. The handler receives an `AbortSignal`; the executor enforces the action deadline. An injected clock/timer provides stable wall timestamps and testable monotonic timing. No action is registered in the application runtime. Tests use a synthetic handler and scripted ledger fake.

## Read first

- `AGENTS.md` and `SOFTWARE_DEVELOPMENT_PLAN.md`
- `docs/IMPLEMENTATION_BACKLOG.md`, `docs/ARCHITECTURE_ALIGNMENT.md`, `docs/DOMAIN_MODEL.md`, and `docs/UX_API_SPEC.md`
- `docs/decisions/ADR-014-l3-investigation-ledger.md` and `docs/decisions/ADR-017-l3-single-step-execution.md`
- `docs/assignments/L3-LEDGER-CORE.md` and handoff
- `docs/assignments/L3-INSUFFICIENT-CONTEXT-ENTRY-CORE.md` and handoff
- `docs/assignments/OBS-01-L3-LEDGER-TELEMETRY-CORE.md` and handoff
- `apps/db/src/investigation-ledger.ts` (`InvestigationLedgerRepository`, `ReserveActionInput`, `ReconcileActionInput`)
- `apps/worker/src/layers/l3-investigation/contracts.ts` and `telemetry.ts`

## Required behavior

- Accept only a closed caller-supplied action proposal containing the dataset, investigation ID, expected checkpoint version, caller-supplied stable reservation ID and timestamp, exact registered action name, and action-specific input. Do not add model planning in this task.
- Look up the exact registered action and validate its input before any ledger mutation. Unknown/disabled actions, malformed proposals, or cases that cannot be safely acted on return a closed denied/review-required result without handler invocation.
- Reserve one tool attempt, the registry's explicit maximum active seconds, and zero model tokens using `ledger.reserveAction`. Never default or enlarge the configured action limit. The existing ledger returns `mayInvoke: false` even for a new reservation; distinguish a new reservation from a replay using its `replayed` field. A replay returns its checkpoint without starting or invoking.
- For a new reservation, call `startAction` with the exact case/reservation identity and an injected deterministic timestamp. Invoke the handler exactly once only if `startAction` returns `mayInvoke: true`. A replay or uncertain/non-invocable start must return its checkpoint without invoking the handler again.
- Reconcile each invocation once with a closed outcome, finite integer active seconds bounded by the reservation, and zero model tokens, using the checkpoint version returned by the reservation. Measure execution with an injected monotonic clock and use the injected wall clock for start/finish timestamps. Abort the handler at its explicit active-time deadline; classify timeout as `timed_out` and charge the reservation maximum. If usage is unknown after an exception or malformed handler result, also charge the full active-time reservation and use a generic failure outcome. Never include exception text, source text, prompts, or arbitrary outputs in ledger arguments. An action that may have completed after timeout is never retried automatically.
- Return only the ledger checkpoint and a bounded receipt (closed outcome plus a finite list of stable output reference IDs, if any). Validate handler output at runtime; discard malformed/arbitrary content, reconcile it as generic failure using the full reservation, and pass ledger errors through unchanged. Do not mask reconciliation failures.
- Preserve the ledger decorator model: use `createTelemetryInvestigationLedgerRepository` when telemetry is injected and do not emit duplicate L3 events.
- Enforce one action per `execute` call, with no loop, internal retry, or background continuation. Don't implement interrupted-action recovery beyond returning the existing ledger result; ADR-014's ledger recovery remains authoritative.
- Test reserve-before-start-before-handler order, denied/unregistered actions, exact idempotent replay without a second handler call, bounded error/reconciliation behavior including conservative full-reservation charging, caller input immutability, stable references only, and ledger error pass-through using synthetic values.

## Allowed paths

- `apps/worker/src/layers/l3-investigation/single-step-executor.ts` (new)
- `apps/worker/test/l3-single-step-executor.test.ts` (new)
- `apps/worker/package.json` — test discovery only
- `docs/assignments/L3-SINGLE-STEP-EXECUTOR-CORE-HANDOFF.md` (new)

Do not change database code, migrations, grants, schema/OpenAPI contracts, L2 logic, L3 ledger behavior, dependencies, credentials, external services, source/provider adapters, application runtime composition, API routes, UI, deployment, or ADR-017. If the existing ledger interface cannot support these semantics without changes, stop and report the exact gap.

## Acceptance and checks

- Tests prove one handler call at most and call order `reserve → start → invoke → reconcile`.
- Tests prove reserve/start denial and replay never re-invoke the action; reserve and start errors prevent invocation.
- Tests prove malformed or unknown actions are rejected before ledger calls and raw action/source/error content is never returned or persisted.
- Tests prove reconciliation uses finite, bounded usage and the exact closed handler outcome; ledger errors preserve object identity.
- Run the focused Worker test, `npm test`, `npm run typecheck`, `npm run build`, and WSL Ubuntu-26.04 `git diff --check` with native Node.js `v24.21.0` and npm `11.19.0`.
- Commit implementation and handoff separately on the assigned branch, leave a clean worktree, record exact commits/checks/limitations, and do not push or merge. Root reviews and integrates.

## Handoff

Report branch/worktree, commit SHAs/messages, changed paths, ordering and replay semantics, actual checks/results, and limitations. State explicitly that this enables only one injected action per call: no model planner, live tool/source, L3 loop, runtime wiring, route, or publication behavior.
