# ADR-038 — Append-only freshness transitions for immutable published versions

- **Status:** Accepted
- **Date:** 1 October 2026
- **Owner:** Root planner; confirmed by Team 12
- **Affected scope:** LIFE-01, FR-11/13

## Context

Published event and impact versions are immutable. ADR-032 defines how Layer 4 changes the freshness status of one event claim set or impact when an issuer validity window ends, a review deadline passes, or newer applicable evidence is evaluated. Mutating a published record to save the new status would change its versioned content and its evidence history. Creating a new publication version for every time-driven status change would conflate freshness with editorial corrections.

The user selected a separate append-only record for each accepted freshness transition, tied to the exact published event/impact version. Event freshness remains an aggregate status; the existing event-level metadata stays attached to its published claim set, and each impact keeps its own freshness metadata.

## Decision

1. Persist a status transition in a separate append-only freshness ledger. Never update or delete `event_versions`, `impact_versions`, publication decisions, or their record JSON to reflect a freshness transition.
2. Bind every transition to `dataset_kind`, exact `event_id` and `event_version`, and one target: the event's grouped claim set or an exact referenced `impact_id` and `impact_version`. An impact transition is valid only for the exact impact version referenced by that event version. A writer accepts only the latest published event version; a later publication or withdrawal makes earlier transition records historical and ineligible for current public projection.
3. Store status-changing transitions only. Each row records the prior and resulting status, a closed transition reason, explicit evaluation time, per-target transition sequence, trace identity, idempotency key/fingerprint, and exact evidence-reference IDs when applicable. Returning a stale status to `current` requires at least one exact reference to the newer applicable evidence evaluated by Layer 4. Store no source text. A no-op evaluation creates no transition row. An exact retry returns the original row; key reuse with a different request fails closed. Stale expected sequence/status and out-of-order writes fail closed.
4. The effective status for an exact version is the most recent accepted transition for that target, or the status embedded in its published record when no transition exists. A later public projection overlays **status only**: `evaluated_at`, `review_due_at`, and `basis` remain from the immutable event/impact record. Claims remain grouped under event-level freshness; impacts retain their own freshness. Event status continues to follow ADR-032's conservative aggregate over the grouped claim-set status and exact referenced impact statuses.
5. Only the Layer 4 freshness recorder may insert transition rows through a narrow database capability. The transition history is append-only; roles that write freshness state cannot rewrite event versions or publication state. Provenance is kept through typed reasons, exact evidence references, and trace/idempotency metadata.
6. This persistence decision adds no scheduler, source fetch, public reader overlay, new API/DTO field, or change to the publication gate. Those are separate implementation slices. Until the read projection is implemented, existing public responses continue to use the published record's freshness.

## Consequences

Freshness can advance without changing the published version, while exact source/evidence history remains reviewable. The user-selected event freshness contract remains status-only and claim freshness remains grouped under the event. Future public readers must join only transitions matching the exact current published version, preserve the immutable metadata fields, and continue hiding withdrawn events and all their public history. Synthetic and historical records remain isolated from live views.

The first implementation slice adds local persistence and PGlite verification only. It does not establish hosted Neon concurrency or enable time-driven freshness evaluation.
