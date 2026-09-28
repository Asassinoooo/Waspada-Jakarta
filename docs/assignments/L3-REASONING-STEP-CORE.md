# L3-REASONING-STEP-CORE — durable budget wrapper for one L2 planner call

**Parent package:** AGENT-01 / FR-07 bounded investigation
**Status:** Accepted on `main`; design is recorded in [ADR-029](../decisions/ADR-029-l3-budgeted-planner-call.md). Implementation review and verification are recorded in the [handoff](L3-REASONING-STEP-CORE-HANDOFF.md).
**Implementation model:** GPT-6 Luna, max reasoning
**Branch:** `work/L3-REASONING-STEP-CORE`
**Worktree:** Dedicated task worktree based on the assignment commit; do not edit the root checkout.
**Contract baseline:** L2 investigation-plan 1.0; schema 2.0 grounding context and L3 ledger; no public API/OpenAPI changes.

## Objective

Implement one bounded Layer 3 service that authorizes exactly one already-grounded Layer 2 investigation-planning call through the durable ledger. Keep grounding, request/output validation and usage parsing in L2; keep case checks, reservations, timeout/failure accounting and escalation in L3. The service returns a proposal as data and never executes its proposed action.

## Read first and dependencies

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md`, then `docs/IMPLEMENTATION_BACKLOG.md`
- `ARCHITECTURE.md`, `docs/DOMAIN_MODEL.md`, and `docs/decisions/ADR-014-l3-investigation-ledger.md`
- `docs/decisions/ADR-017-l3-single-step-execution.md`, `docs/decisions/ADR-027-l2-investigation-action-proposals.md`, and `docs/decisions/ADR-029-l3-budgeted-planner-call.md`
- `apps/worker/src/layers/l2-model-grounding/investigation-planner.ts` and its tests
- `apps/worker/src/layers/l3-investigation/single-step-executor.ts`, `entry.ts`, and `telemetry.ts`
- `apps/db/src/investigation-ledger.ts`
- Relevant package test scripts and accepted handoffs for L2 planner, ledger, entry, executor and ledger telemetry

Dependencies L2-INVESTIGATION-PLAN-CORE, L3-LEDGER-CORE, L3-INSUFFICIENT-CONTEXT-ENTRY-CORE, L3-SINGLE-STEP-EXECUTOR-CORE and OBS-01-L3-LEDGER-TELEMETRY-CORE are accepted. Use only synthetic fixtures, the current ledger interface and an injected provider double. Do not activate a source or model provider.

## Allowed paths

- `apps/worker/src/layers/l2-model-grounding/investigation-planner.ts`
- `apps/worker/src/layers/l3-investigation/reasoning-step-executor.ts` (new)
- `apps/worker/test/l2-investigation-planner.test.ts`
- `apps/worker/test/l3-reasoning-step-executor.test.ts` (new)
- `apps/worker/package.json` (test script registration only)
- `docs/assignments/L3-REASONING-STEP-CORE-HANDOFF.md` (new implementation handoff)

Root owns the ADR, architecture, SDP, backlog, delivery log and final acceptance. Do not change other files without reporting the need to the root first.

## Required behavior

1. Add a side-effect-free L2 preflight that validates the full planner request and confirms the injected provider is configured before L3 reserves anything. A malformed request, sufficient context, invalid menu/question labels, or unconfigured provider returns a closed non-call outcome with no reservation and no provider invocation.
2. L3 loads the latest checkpoint and rejects to review without reserving if the case is missing, not open, has a reservation in flight, or does not exactly match the supplied context identity: dataset, trace ID, candidate ID, current context ID, and event ID/version. The context must be explicitly insufficient. Schema 2.0 checkpoints do not duplicate question labels, so compare the preflighted questions to the deterministic `missing_field_N` then `conflict_N` projection from this structurally validated, checkpoint-matched context. Do not add a database request-read API. Never infer identity from model output.
3. Validate trusted per-call limits against the existing hard ledger ceilings. For one ready invocation reserve `actionKind: 'reasoning'`, one reasoning turn, a stable fixed action name, configured worst-case active seconds and a configured total input-plus-output token cap. Do not reserve from provider-supplied values. A failed reservation or stale checkpoint makes no provider call.
4. Start the reservation and invoke the L2 planner only when `startAction` returns the first non-replayed `mayInvoke: true` transition. Pass an `AbortSignal` and the reserved total-token cap to the provider. Invoke exactly once; no loop or retry. A reservation/start replay never invokes. Measure elapsed active time with injected monotonic and wall clocks, and enforce the reserved timeout with an injected timer.
5. The L2 provider envelope must contain the bounded plan output and non-negative integer input/output token counts. L2 enforces the output schema and configured sum cap. Trusted adapter configuration, not provider output, supplies `model_version` and `prompt_version`. Return only the validated plan and typed usage metadata to L3; do not expose raw provider output or exceptions.
6. Reconcile a valid proposal or abstention exactly once with actual provider usage and append a closed `ModelRun` to the checkpoint. For an abstention, after reconciliation transition the case to `stopped_for_review` with stop reason `awaiting_moderator`. For a proposal, return it as a non-authoritative proposal; do not call the action executor in this invocation.
7. A thrown provider error, timeout, malformed result, missing/invalid usage, token overage, or uncertain usage reconciles the full reserved time and token maximum with a closed outcome. Timeout aborts the signal. Do not retry. If reconciliation is uncertain or interrupted, return a review/uncertain result and rely on ADR-014 recovery; never repeat the provider call. Avoid persisting request content, source excerpts, provider output or exceptions.
8. Route ledger writes through the existing optional L3 telemetry decorator when telemetry is supplied. Add no telemetry fields containing case/action/model identifiers or content; telemetry failures must not alter ledger outcomes.

## Acceptance criteria

- A valid invocation reserves and starts one reasoning turn before exactly one provider call, then reconciles validated actual usage.
- Preflight failures, mismatched checkpoint/context identity, stale/closed cases, existing in-flight work, reservation denials, and replay paths make zero provider calls.
- Tests cover proposal, abstention/escalation, provider error, timeout/abort, malformed output, missing/over-cap usage, exact model-run metadata, full-reservation failure accounting, and non-retry after uncertain/replayed transitions.
- The planner cannot return unvalidated provider content, claim sufficient evidence, select arbitrary actions, set budget/version metadata, or execute a tool.
- No public API, OpenAPI, SQL/schema/migration, dependency version, source, live provider, production registry, route, runtime composition, deployment or paid service changes.
- In WSL Ubuntu-26.04 run focused planner/executor tests, full Worker tests, `npm run typecheck`, `npm run build`, and `git diff --check`. Root independently runs integrated workspace tests on the task branch before acceptance.
- Commit implementation and handoff separately on the task branch. Leave the task worktree clean. Do not merge or push.

## Stop conditions and handoff

Stop and ask the root planner about any required DB/API/schema/contract change, provider activation, production tool registration, new dependency, unclear reservation/replay behavior, or conflict with a parallel assignment. Keep synthetic implementation moving on unrelated requirements. Escalate to GPT-6 Astra xhigh only if Luna max attempts and cannot resolve a substantive technical difficulty.

The handoff must include branch/worktree, base and full commit SHAs with exact messages, changed paths, actual WSL commands/results and runtime versions, behavior, limitations, migration/configuration impact and remaining decisions. Do not claim hosted database behavior or provider cancellation was verified.
