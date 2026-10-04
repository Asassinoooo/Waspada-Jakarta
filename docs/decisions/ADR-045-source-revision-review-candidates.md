# ADR-045 — Project source-revision assertions into read-only review candidates

- **Status:** Accepted for local implementation
- **Date:** 4 October 2026
- **Owner:** Root planner
- **Affected scope:** LIFE-01, Layer 4 source-change review discovery, ADR-042/043/044

## Context

The Layer 1 source-observation ledger preserves explicit publisher assertions about exact report revisions, and the Layer 4 impact reader maps one exact report revision to current published claim-set and supported impact targets. Layer 2 now blocks a source revision from new reasoning context when any `superseded`, `retracted`, or `withdrawn` assertion exists. These components do not yet provide one read-only view that lets a moderator inspect which current published versions may need review because of those assertions.

Team 12 selected keeping the current published version visible until moderator review. [ADR-046](ADR-046-source-revision-freshness.md) separately defines `needs_update` freshness for explicitly retracted or superseded supporting reports; this read-only design does not apply that policy. Public treatment of `withdrawn` assertions remains open. The course demo's moderator UI remains read-only; this design must not create a durable queue, review status, action, or public API.

## Decision

1. Add a bounded internal Layer 4 read projection that joins explicit non-current source assertions (`superseded`, `retracted`, `withdrawn`) to the exact current published event claim-set and impact versions that have direct supporting evidence lineage to the asserted target report revision.
2. Treat each source-observation row as independent provenance. Conflicting assertions remain separate candidate rows; do not select a latest or winning assertion, merge contradictory records, or infer source truth. A `current` assertion alone does not create a candidate.
3. Return only the explicit dataset, observation identity and assertion metadata (state, target/assertion/replacement revision IDs, and publisher-observed/retrieved/recorded times) plus the affected event/version and exact target identity. Do not return source text, claim text, excerpts, URLs, hashes, model output, or full database rows.
4. Apply the same current-public lineage rules as the accepted report-revision impact reader: only direct `supports` evidence dependencies qualify; only the latest published event version qualifies; withdrawn or otherwise unpublished latest versions stay hidden; impacts qualify only through exact version references and claim-support links.
5. Keep the read role non-login and non-inheriting. Grant it only the extra observation metadata columns needed for this projection; preserve its existing target-lineage grants and all other capabilities. Use explicit dataset scope, stable keyset ordering, bounded page sizes, and redacted errors.
6. Do not persist queue state or review acknowledgements, authorize a moderator, call a source or model, update freshness/lifecycle/publication/history/geometry, add a route/UI, or change an API/DTO. The public version remains unchanged pending moderator review; this reader does not apply ADR-046's separate freshness policy.

## Consequences

An internal caller can page through exact impact-review candidates without trusting LLM output or scanning source text. Candidates are a projection over the existing immutable observation and publication records, not new workflow state. Any eventual authenticated review UI, review mutation, source-text presentation, or application of ADR-046's freshness policy requires a separate implementation and authorization boundary. Tests use synthetic PGlite rows only; hosted Neon role behavior remains unverified.

## Rejected alternatives

- Resolve contradictory source assertions by timestamp or insertion order: the ledger is deliberately append-only and does not establish a winning state.
- Automatically correct, withdraw, or re-label a public event when a source changes: source revision is not a moderator-reviewed event assessment.
- Store a mutable queue row or review status in this read-only slice: that would introduce workflow state and authorization requirements beyond impact discovery.
