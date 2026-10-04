# ADR-044 — Gate exact L2 grounding on source-revision assertions

- **Status:** Accepted
- **Date:** 4 October 2026
- **Owner:** Root planner
- **Affected scope:** L2 retrieval and grounding, LIFE-01, RAG-CORE, RAG-ACCESS-01, ADR-011/042/043

## Context

The accepted Layer 1 ledger records explicit publisher assertions about exact report revisions. The hybrid retriever can still find an older eligible revision after the publisher explicitly supersedes, retracts, or withdraws it. Layer 2's exact-span reader is the last database boundary before a selected source excerpt is placed in a typed reasoning request. If it ignores the ledger, a new model call could continue grounding from a report the publisher has explicitly invalidated.

Team 12 selected preserving the exact current public event version until moderator review under [ADR-042](ADR-042-source-revision-publication-review.md). That public decision does not authorize new model calls to rely on a known-invalidated source revision.

## Decision

1. At exact-span rehydration, Layer 2 checks the append-only source-observation ledger for the exact dataset and report revision in the same bounded SQL read that rehydrates the span.
2. Any explicit `superseded`, `retracted`, or `withdrawn` assertion blocks that exact report revision from new reasoning context. This remains true if a `current` assertion also exists; L2 does not resolve conflicts by timestamp, insertion order, majority, model judgment, or last-write-wins.
3. No observation or only `current` assertions leaves existing Layer 1 eligibility rules unchanged. An exact replacement revision is not automatically promoted; it is checked independently under its own identity and existing eligibility.
4. When blocked, the exact-span reader returns no source text and the L2 context assembler fails closed with a typed, content-free source-invalidated error. The reasoning request is not built from that span. Retrieval candidates and source assertions remain available to internal callers for review, subject to existing source access controls.
5. Grant the existing L2 NOLOGIN role only the dataset, exact target revision, and asserted-state columns needed for this check. Do not grant source-text, write, or general table access.
6. The gate changes neither stored reports nor evidence relations, embeddings, publication versions, public lifecycle, freshness, event history, geometry, or API/DTOs. It does not create moderator decisions or unblocking semantics. Restoring an invalidated revision to new model context requires a separately designed review/clearance path.
7. Source assertions remain data, not instructions. They cannot expand L3 budgets or authorize tools/publication. No provider, live source, model, or external service is enabled.

## Consequences

New model-grounding requests fail closed when any supporting exact report revision has an explicit non-current publisher assertion. Conflicting assertions remain visible in the L1 ledger and are not silently reconciled. Existing public event versions remain as published until a moderator-reviewed Layer 4 correction or withdrawal; the public freshness badge decision remains open. A source revision blocked here remains blocked until a future, explicitly authorized review policy can safely permit reuse.

The implementation is local and synthetic-only. Hosted Neon behavior and any deployed Layer 2 database binding remain unverified.

## Rejected alternatives

- Use the newest observation as the winner: fetch and recording order do not establish publisher intent, and this would erase conflict.
- Mutate `report_revisions.revision_status`: that field is immutable and mixes source state with processing eligibility.
- Automatically change public event versions or freshness when L2 blocks a source revision: source support validity and public presentation are separate decisions under ADR-042.
- Let the LLM decide whether a retracted or superseded excerpt remains trustworthy: the eligibility boundary is deterministic and precedes model invocation.

