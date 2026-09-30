# ADR-032 — Review deadlines do not imply source expiry

- **Status:** Accepted
- **Date:** 30 September 2026
- **Owner:** Root planner; confirmed by Team 12
- **Affected scope:** LIFE-01, FR-11/13

## Context

The freshness baseline sets review deadlines for fast-changing observations and advisories without an explicit end date. A review deadline is an operational prompt to re-evaluate evidence; it is not the same as an issuer's validity window. Treating elapsed observation age as `expired` could imply that a report ceased to be valid without a source statement or new evidence. Freshness also remains separate from incident lifecycle and physical safety.

## Decision

When `review_due_at` passes without newer applicable evidence, set freshness to `needs_update`. Keep the record available as history, and remove language or map treatment that implies the observation still describes current conditions.

Set freshness to `expired` only when the issuing source's explicit validity window ends. A review deadline, feed rebuild, refetch, HTTP 304, or unchanged source page does not establish expiry or renew an observation. Returning `needs_update` to `current` requires new applicable evidence and a new Layer 4 evaluation. An expired record remains expired until new source evidence is evaluated.

Neither `needs_update` nor `expired` changes event or impact lifecycle to resolved, cancelled, or safe. This decision does not define how an event-level freshness value aggregates different claim and impact states; that remains open for LIFE-01 design.

## Consequences

The 60-minute fast-observation and 24-hour undated-advisory thresholds are review deadlines: if they pass without new applicable evidence, the corresponding evidence becomes `needs_update`. They do not age an observation into `expired`. Source-specific explicit validity and cancellation/update statements remain authoritative for source expiry.

This is a design rule; no clock-driven freshness evaluator, scheduled job, migration, or public API behavior is implemented by this ADR. LIFE-01 must add deterministic transition tests before runtime scheduling is enabled.
