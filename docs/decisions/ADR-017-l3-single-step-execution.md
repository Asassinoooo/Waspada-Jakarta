# ADR-017 — Bounded single-step investigation execution

- **Status:** Accepted for local synthetic implementation
- **Date:** 26 September 2026
- **Owner:** Root planner
- **Requirements:** FR-07; NFR-01/02/05/07
- **Related work:** ADR-014, L3-LEDGER-CORE, L3-INSUFFICIENT-CONTEXT-ENTRY-CORE, AGENT-01

## Context

The L3 entry adapter can open a durable investigation case from persisted insufficient L2 context. ADR-014 gives the case ledger atomic action reservations and hard budgets, but no Worker service yet binds an approved action to those reservations. Implementing an unbounded agent loop before the source and evaluation gates are ready would blur model proposals, execution authority, source ingestion, and publication.

## Decision

- Each invocation handles **at most one** proposed action. It never loops or starts a background run. A future caller must explicitly request another step.
- An action proposal is data, not authority. Before ledger mutation, a trusted injected registry must contain the exact action name and validate its action-specific input. Unregistered, disabled, malformed, or ambiguous actions are denied without invocation.
- Before invoking a registered handler, the Worker reserves one tool attempt, zero model tokens, and the action's explicit worst-case active-time budget through the existing ledger, then starts that reservation. A `reserveAction` replay returns without a handler call; only a subsequent `startAction` result that grants `mayInvoke` authorizes invocation. Replayed or uncertain reservations never invoke again.
- The handler receives a cancellation signal and runs under the action's active-time deadline. A timeout aborts the handler signal, returns a `timed_out` outcome, and charges the full reservation; an uncertain late completion is never automatically retried. Every invoked result is reconciled through the ledger exactly once using a closed outcome and bounded actual usage measured by an injected clock. Unknown usage after a handler exception or malformed result is charged at the full reservation. Handler exceptions are reduced to a generic failure outcome; raw exception data, source text, prompts, and model output are never written into the ledger or telemetry. If reconciliation itself fails, preserve that ledger error and leave recovery to ADR-014's interruption rules.
- Tool results cross the L3 boundary as stable references and closed status only. Any newly acquired report content must be submitted through L1 processing and re-grounded through L2 before it can influence another step.
- The initial implementation uses injected synthetic handlers in tests only. It registers no real source, model, network, scheduler, route, or publication capability. Production registration remains gated on source rights, action-specific input/output validation, access controls, retention terms, and human review.
- Existing ledger rules remain authoritative for hard budgets, case identity, idempotency, checkpoint versions, and stop transitions. The executor does not duplicate those policies or publish events.

## Consequences

This boundary can be verified locally with a scripted handler and fake ledger while preserving the future investigation workflow: validate proposal, reserve, start, execute once, reconcile, and return a bounded receipt. It proves no hosted database concurrency, real tool behavior, source rights, model quality, scheduler recovery, or deployment. Full planning, source acquisition, L1/L2 refresh, and moderator escalation routing remain separate work.

## Alternatives considered

- **Let a model call tools directly:** rejected because model output must not bypass deterministic registration, budget reservation, or audit controls.
- **Run a loop until the model stops:** rejected because it obscures per-step latency, restart behavior, and budget review; each action must have a durable boundary.
- **Persist tool payloads and exceptions in the ledger:** rejected because the ledger stores bounded operational state, not report text or arbitrary output.
- **Enable live tools now:** rejected because source rights, access/retention terms, and human-adjudicated evaluation remain pending.
