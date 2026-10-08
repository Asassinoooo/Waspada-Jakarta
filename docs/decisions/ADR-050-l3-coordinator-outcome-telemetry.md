# ADR-050 — Bounded Layer 5 telemetry for coordinator advances

- **Status:** Accepted for local implementation
- **Date:** 8 October 2026
- **Owner:** Root planner
- **Affected scope:** OBS-01, FR-14, NFR-04/07

## Context

The accepted Layer 3 ledger decorator reports individual durable write transitions. It does not measure the result and elapsed time of one bounded coordinator advance. Future Workflow/runtime wiring needs a privacy-safe outcome signal, while the current coordinator has no production caller and the demo remains synthetic/read-only.

## Decision

1. Add an opt-in Layer 5 decorator around the existing `InvestigationCoordinator` port. It emits at most one `l3_coordinator_advance` event for each call.
2. The event contains only a closed outcome (`continue`, `sufficient_context`, `review_required`, or `error`) and finite, non-negative `durationMs`. Do not record a review reason, case status, budget, identifiers, inputs, model/tool details, source data, or exception details.
3. Preserve the exact returned object or original thrown error. Invalid runtime outcomes are summarized as `error`; telemetry validation, clock, and sink failures cannot change coordinator behavior.
4. Use the existing no-op-default telemetry sink and construct console output from an exact field allowlist. Do not add a runtime caller, Worker binding, workflow, external log sink, or deployment setting in this slice.
5. This is operational telemetry only. It does not measure factual quality, evidence sufficiency, model cost, or safety, and does not change the coordinator or ledger contract.

## Consequences

One coordinator invocation can be measured without exposing case-level information. The wrapper remains opt-in and uncomposed until a separately authorized runtime exists. Local tests verify only the typed port and injected sink; hosted logging and Cloudflare execution remain unverified.

## Rejected alternatives

- Add review reasons, IDs, or token/tool details: these increase disclosure without being required to measure coordinator latency and broad outcome classes.
- Instrument every coordinator branch directly: a port decorator keeps Layer 3 decisions unchanged and can be enabled explicitly by a future composition root.
- Treat an outcome rate as factual quality: synthetic outcomes do not establish accuracy or safe operation.
