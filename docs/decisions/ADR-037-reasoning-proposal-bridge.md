# ADR-037 — Reasoning result to draft proposal bridge

- **Status:** Accepted; local implementation verified
- **Date:** 1 October 2026
- **Owner:** Root planner
- **Task:** L2-PROPOSAL-REASONING-BRIDGE-CORE
- **Requirements:** FR-05/06/07/14; NFR-01/05/07

## Context

The project now has a typed Layer 2 `ReasoningResult` capability and a separate atomic repository for canonical schema 2.0 `EventProposal` drafts. The model result does not contain source-origin IDs or a public evidence label; grounding contexts do contain exact evidence references and their recorded origins. Connecting these boundaries must not infer source status, independence, or publication eligibility, and it must not make the repository or the bridge responsible for invoking a model.

## Decision

- Add a deterministic, injected bridge that accepts a typed reasoning capability outcome, its grounding context and corresponding persisted context record, and caller-supplied proposal identity/time, event target, and optional investigation ID. It invokes no model, retrieval, source, or publication capability.
- Persist only a `succeeded` reasoning outcome. Other capability statuses return a no-write result. Validate that the in-memory context and its persisted record share exact dataset, trace, candidate, context, evidence, event-candidate, gap, conflict, version and sufficiency metadata before mapping. The reasoning result's preserved conflicts must match the context conflicts.
- Map claim fields and all four evidence relations exactly, retaining input claim/reference order and time precision. `ProposedClaim` has no claim ID, so assign stable proposal-local IDs by claim order (`claim-001` through `claim-020`) to make unchanged retries deterministic. The canonical draft `ModelRun` has no provider field; map its existing capability, model version, prompt version and token fields, and do not place provider identity in another field. For each claim, derive origin IDs only from exact `origins` attached to its support references; deduplicate and sort those IDs for deterministic replay. Missing, ambiguous, or unsupported origin lineage fails closed before repository invocation. Do not infer origin independence from the status or count of IDs.
- Store the model's `supportAssessment` as data and use `under_review` as the draft evidence label. Do not infer public source labels from provider output, source identity, origin metadata, confidence or claim assessment. The canonical context remains the persisted home for conflicts and gaps.
- Require a tagged caller-supplied target: new (`null/null`) or update (exact event ID and positive base version). An update pair must occur in the supplied grounding context. Pass the optional investigation ID through unchanged; the proposal repository remains responsible for persisted request/checkpoint lineage.
- Preserve the existing public contract and Layer 4 gate. No new API, runtime trigger, persistence schema, source access, publication write, L3 budget/state operation, dependency or provider configuration is authorized.

## Consequences

Both direct and investigation-backed reasoning can share one deterministic mapping path while retaining their caller-owned identity and target metadata. Abstention remains a private proposal with an empty claim list and its unresolved fields; no event is created. Stable claim IDs depend on claim order; reordering claims under an existing proposal ID is a changed replay and the immutable repository will reject it. The current canonical draft schema does not retain the provider identifier returned alongside a reasoning run. The mapper cannot determine whether evidence semantically supports a claim, whether sources are independent, or whether a draft is publishable. Those decisions remain with Layer 4 and human review.

Tests use authored synthetic contexts, typed outcomes and a recording proposal repository. They make no provider or external-service calls. Local checks establish mapping and short-circuit behavior only; model quality, source rights, authenticated moderation, and hosted database behavior remain separate work. The accepted local bridge reuses the shared `parseReasoningOutput` validator after descriptor-safe snapshotting. That shared parser currently compares timestamp interval endpoints through millisecond-resolution `Date.parse`; a separate `L2-TIME-PRECISION-CORE` task will correct sub-millisecond ordering without changing the contract.
