# ADR-043 — Preserve publisher source-revision observations separately

- **Status:** Accepted
- **Date:** 4 October 2026
- **Owner:** Root planner
- **Affected scope:** L1 ingestion, L2 grounding, L3 investigation, LIFE-01, FR-03/11/13, ADR-005/032/042

## Context

`report_revisions` are immutable acquisitions, but their existing `revision_status` field contains several concepts: processing eligibility (`unreviewed`, `eligible`, `quarantined`) and source-change labels (`superseded`, `retracted`). It cannot safely represent changing publisher statements over time, and changing it would erase which source statement was observed. A source update also does not decide whether a published event should change; Team 12 selected preserving the current immutable publication until moderator review under [ADR-042](ADR-042-source-revision-publication-review.md).

## Decision

1. Record publisher statements about an exact source report revision in a separate append-only L1 observation ledger. Do not update an existing report revision or overload its immutable eligibility field to record later source statements.
2. Store the exact dataset and target report revision, the same-source report revision carrying the statement, the asserted source state (`current`, `superseded`, `retracted`, or `withdrawn`), the optional exact replacement revision, the publisher-stated observation time when available, retrieval time, database-recorded time, and trace/idempotency identity.
3. An observation is an attributed publisher assertion, not proof, moderator adjudication, source eligibility, claim evidence status, incident lifecycle, or public freshness. Keep contradictory statements as separate immutable observations. No L1 writer or model chooses a winning current state; any resolved interpretation belongs to a later typed L2/L4 reader and review workflow.
4. A `superseded` assertion must identify an exact replacement revision from the same source and dataset. `retracted` or `withdrawn` assertions must cite an exact same-source report revision containing the publisher's notice. A missing page, failed fetch, `404`, or stale cache alone does not mean retracted or withdrawn; it updates source availability/health separately.
5. Keep `observed_at`, `retrieved_at`, and database `recorded_at` distinct. Source text and evidence retention remain subject to [ADR-005](ADR-005-source-retention.md).
6. L1 acquisition and persistence remain independent of the agent loop. L2 may later consume a resolved source-state projection before grounding; L3 cannot create or reconcile publisher status. The accepted Layer 4 report-revision impact reader may identify affected current published targets, but publication changes still require moderator review through the existing gate.
7. This decision does not change public event versions, freshness, lifecycle, geometry, history, or API output. Public freshness for explicit `retracted` and `superseded` assertions is specified separately in [ADR-046](ADR-046-source-revision-freshness.md); treatment of `withdrawn` assertions remains open. Expiry or retraction never means incident resolution or safety.

## Consequences

The first implementation slice stores and replays attributed observations only. It does not compute a latest/winning status, alter RAG retrieval, invalidate embeddings or caches, create moderator review records, or alter publication/freshness. ADR-046 separately defines one exact-version freshness consumer for explicit retraction/supersession; other consumers remain distinct follow-up tasks. Tests use authored synthetic records; live-source access remains gated by permissions.

## Rejected alternatives

- Mutate `report_revisions.revision_status` when a source changes: it is append-only, conflates source assertions with processing eligibility, and loses observation history.
- Treat the latest fetch result or missing page as a source retraction: transient availability does not establish publisher intent.
- Let an LLM assign the source state from article text: source state needs typed, source-grounded provenance and must not be inferred inside the orchestration loop.
- Auto-correct or withdraw a public event when a source report changes: conflicts with ADR-042 and bypasses moderator review.
