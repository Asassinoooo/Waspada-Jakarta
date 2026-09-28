# ADR-029 — Budget Layer 2 investigation-planning calls in Layer 3

- **Status:** Accepted for local synthetic implementation
- **Date:** 28 September 2026
- **Owner:** Root planner
- **Requirements:** FR-07; NFR-01/02/05/07
- **Related work:** ADR-014, ADR-017, ADR-027, L2-INVESTIGATION-PLAN-CORE, L3-LEDGER-CORE

## Context

ADR-027 gives Layer 2 a typed adapter for proposing one trusted-menu investigation action or abstaining. The adapter currently accepts an injected provider but does not reserve or reconcile its model call in the durable Layer 3 ledger. Calling it outside the ledger would let a failed, repeated, or resumed investigation consume uncounted reasoning turns and tokens. Moving the planner into Layer 3 would instead blur the boundary between model capability and orchestration authority.

## Decision

- Keep request grounding, planner input validation, model invocation, output validation, and provider-reported usage parsing in Layer 2. Keep case identity checks, hard-budget reservation, execution authorization, timeout handling, reconciliation, and escalation in Layer 3.
- Before a reservation, Layer 3 must confirm that the case is open, has no in-flight reservation, and matches the supplied insufficient grounding context by dataset, trace, candidate, current context, event identity/version, and stable question labels. Layer 2 must validate the full planner request and provider availability before a reservation is made. Invalid, sufficient, stale, or unconfigured requests make no provider call and consume no budget.
- For one ready call, Layer 3 reserves exactly one reasoning turn and trusted configured worst-case active seconds and total model tokens in the existing ledger. It starts the reservation before passing one call to the Layer 2 planner with a cancellation signal and the reserved token cap. Only a fresh `mayInvoke` start authorizes the provider call. A reservation replay never invokes the provider.
- Layer 2 returns only a validated proposal or closed abstention plus bounded provider usage. Trusted adapter configuration supplies model and prompt version metadata; provider output cannot choose versions or report budget policy. Layer 3 reconciles successful usage and records the model run. Missing, malformed, excessive, or uncertain usage, provider failure, timeout, or invalid output consumes the full reservation. Timeouts abort the signal. No automatic retry occurs.
- A valid proposal is returned as data and is not executed by this call. A valid abstention is reconciled and escalated to `stopped_for_review` with `awaiting_moderator`. A later explicit invocation may pass a proposal to the existing single-step executor, which independently validates and reserves its registered action.
- Reconciliation uncertainty or process interruption is resolved through ADR-014's reservation rules; it must never trigger an automatic second provider call. Do not persist prompts, source excerpts, raw model output, or exceptions in the ledger or telemetry.
- Implement and test with an injected synthetic provider only. This decision adds no schema, migration, route, provider account, live source, production action, or Worker runtime composition.

## Consequences

Every planner call that L3 authorizes is bounded by the same durable reasoning-turn, active-time, and token counters as the investigation. L2 remains independently responsible for model contracts and grounding, while L3 remains the sole authority for whether and how often the capability runs. Full reservations on uncertain outcomes favor budget safety over utilization. A lost successful response can require a new explicitly authorized reasoning turn because the ledger does not retain raw proposals; it cannot be silently replayed.

Synthetic tests can verify reservations, exact one-call behavior, usage reconciliation, failure charging, replay, identity mismatch, timeout and abstention escalation. They do not establish provider cancellation, model quality, hosted Neon transaction behavior, or production runtime composition.

## Alternatives considered

- **Call the Layer 2 planner outside the ledger:** rejected because reasoning turns, time and tokens could bypass durable limits.
- **Move model selection and validation into Layer 3:** rejected because orchestration would absorb Layer 2 model and grounding responsibilities.
- **Let the planner call the selected action immediately:** rejected because a model proposal is not execution authority; the existing L3 executor must independently reserve and invoke one registered action.
- **Retry provider failures automatically:** rejected because an uncertain first response may already have consumed resources or produced an action proposal.
- **Persist raw proposals for replay:** rejected because the ledger stores bounded operational state and usage, not source-derived model content.

## Affected work

`L3-REASONING-STEP-CORE` composes the accepted L2 planner with the durable L3 ledger and existing ledger telemetry decorator for one reasoning call. It adds no public API or database contract.
