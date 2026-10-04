# ADR-042 — Preserve published event versions pending source-change review

- **Status:** Accepted
- **Date:** 4 October 2026
- **Owner:** Root planner; confirmed by Team 12
- **Affected scope:** LIFE-01, FR-11/13, ADR-020/028/032/038

## Context

A source can retract a report or publish a revised report after one of its evidence references has supported a published event claim. The event and claim records are immutable, and freshness can be projected separately against an exact published version. The current demo moderator surface is read-only; publication corrections and withdrawals use the Layer 4 publication gate and require moderator review.

Automatically replacing or withdrawing the event on a source update would treat a source change as a completed factual assessment. Rewriting the current event would also violate the immutable publication history. The user selected keeping the current published version until moderator review.

## Decision

1. A source retraction or revision does not itself create, replace, or withdraw a public event version. Preserve the exact current published event version and its source-attributed content until a moderator reviews the impact.
2. Any later correction or withdrawal must be a new immutable Layer 4 publication decision through the existing gate. Do not bypass authorization, evidence review, or the append-only publication path.
3. Source-change handling must resolve exact dependent published claim and impact versions from evidence lineage. Keep that dependency review internal until a separate public-freshness presentation decision is recorded; this ADR does not change public freshness, lifecycle, history, or API contracts.
4. A source change is not proof that an event is resolved or that a location is safe. Do not change lifecycle, invent a warning geometry, or remove history as a side effect of invalidating source material.
5. Source text retention and derived-data deletion continue to follow ADR-005 and the applicable source terms. Retaining the published version does not authorize retaining source text past its permitted period.
6. The read-only course demo remains read-only under ADR-028; this decision authorizes internal impact discovery only, not a moderator mutation screen, login, or publication runtime.

## Consequences

The first implementation slice may enumerate exact current-public versions that cite one report revision through supporting evidence references. It cannot change freshness or publication state. A later Layer 4 slice must decide how to persist review-needed state and how the public freshness badge should behave before moderator review; it must not infer that behavior from this ADR. New source-state storage, retrieval invalidation, and deletion replay also remain separate implementation work.

Tests use authored synthetic rows only. No live source is activated or contacted by this decision.

## Rejected alternatives

- Auto-correct or withdraw the published event when a source changes: a source change alone is not a moderator-reviewed event assessment.
- Rewrite the existing event version: breaks immutable history and the publication contract.
- Treat the report's retraction or revision as incident resolution or safety: source validity and event lifecycle are distinct.
