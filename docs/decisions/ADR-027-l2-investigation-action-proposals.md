# ADR-027 — Layer 2 investigation action proposals

- **Status:** Accepted for local synthetic implementation
- **Date:** 27 September 2026
- **Owner:** Root planner
- **Requirements:** FR-07; NFR-01/02/05/07
- **Related work:** ADR-014, ADR-017, L2-ADAPTER-01, RAG-CONTEXT-ASSEMBLY-CORE, L3-INSUFFICIENT-CONTEXT-ENTRY-CORE, L3-SINGLE-STEP-EXECUTOR-CORE

## Context

Initial hybrid retrieval and the sufficiency assessment happen in Layer 2 before an investigation opens. The existing direct reasoning path calls the event-synthesis capability only for sufficient context; insufficient context is persisted and handed to the Layer 3 ledger. Layer 3 can open a durable case and execute one registered action, but the repository does not yet define a typed model proposal for selecting a next investigation action. Letting a model call a tool directly would bypass the durable budget and registry boundaries.

## Decision

- Define a separate, versioned Layer 2 investigation-planning request and result. This is not the event `ReasoningResult` or an `EventProposal`.
- A request may be built only from an already retrieved, identity-validated GroundingContext marked insufficient, stable non-content question labels from the open investigation, and a bounded menu of actions supplied by trusted server-side composition. Source excerpts remain untrusted data; no source text is copied into durable question labels or operational logs.
- A successful result may propose exactly one action name from that menu and a small bounded JSON input value. The other result is a closed abstention code (`no_available_action`, `ambiguous_context`, or `cannot_form_valid_input`). The model cannot report that evidence is sufficient, adjust a budget, claim a stop condition, name an arbitrary host, register a tool, or propose publication.
- The Layer 2 adapter validates request shape and bounds, checks that the proposed action is in the supplied menu, validates and bounds the JSON value, and reduces provider errors to typed outcomes. It confers no execution authority.
- Layer 3 independently checks the current case/checkpoint, exact trusted registry entry, action-specific input parser, and stop/budget state. Only the existing ledger reservation and single-step executor can authorize invocation. Any acquired material returns through L1 and L2 before another action proposal.
- The initial implementation is a provider-injected adapter tested with synthetic data and a fake provider. It adds no model API, source tool, database/schema change, route, credential, production registration, or publication path.

## Consequences

The model can help choose among explicitly permitted next steps while deterministic Layer 3 code remains the capability and budget authority. The single-step boundary provides a restartable stop point; each subsequent proposal requires a new invocation and current grounded context. Local tests establish contract enforcement only, not model quality, prompt-injection resistance in a hosted prompt, source rights, or end-to-end orchestration.

## Alternatives considered

- **Let the model invoke tools or choose arbitrary URLs:** rejected because it bypasses Layer 3's registered capabilities, argument validation, budget reservation, and audit boundary.
- **Reuse the event ReasoningResult:** rejected because event-claim synthesis and investigation action selection have different outputs and authority.
- **Run a multi-action loop in Layer 2:** rejected because iteration, stop rules, budgets, checkpointing, and human escalation belong to Layer 3.
- **Allow the planner to mark evidence sufficient or publish:** rejected because Layer 2 grounding and Layer 4 publication rules own those decisions.

## Affected work

`L2-INVESTIGATION-PLAN-CORE` adds only the internal typed adapter, synthetic tests, and its handoff. A later bounded Layer 3 coordinator may compose the proposal adapter, ledger, executor, and L1/L2 refresh callbacks after their contracts are reviewed.
