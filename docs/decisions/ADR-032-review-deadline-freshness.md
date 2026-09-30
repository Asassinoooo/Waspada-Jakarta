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

Neither `needs_update` nor `expired` changes event or impact lifecycle to resolved, cancelled, or safe.

## Consequences

The 60-minute fast-observation and 24-hour undated-advisory thresholds are review deadlines: if they pass without new applicable evidence, the corresponding evidence becomes `needs_update`. They do not age an observation into `expired`. Source-specific explicit validity and cancellation/update statements remain authoritative for source expiry.

This is a design rule; no clock-driven freshness evaluator, scheduled job, migration, or public API behavior is implemented by this ADR. LIFE-01 must add deterministic transition tests before runtime scheduling is enabled.

### Item-level deterministic evaluation boundary

For one event or impact freshness record, evaluate an explicit issuer `valid_until` before its review deadline. At or after `valid_until`, freshness is `expired`, including when new evidence was just evaluated but still carries an ended issuer validity window. Otherwise, a current record becomes `needs_update` at or after `review_due_at` when no newer applicable evidence has been evaluated. Existing `needs_update` and `expired` states remain until Layer 4 evaluates newer applicable evidence; that evaluation may return the record to `current` only while issuer validity is not ended. A fetch, unchanged page, or HTTP 304 is not such an evaluation.

This item-level policy does not schedule evaluations, persist transitions, or alter lifecycle/publication state.

### Conservative event-level freshness aggregation

An event-level badge is a conservative summary of the event's public claim set and its public impacts. Public claims remain grouped under the containing event's freshness in the current schema/API; each impact retains its separate freshness. If any included freshness value is `needs_update`, or if the values mix `current` and `expired`, the event badge is `needs_update`. The event is `expired` only when every included public freshness value is explicitly expired under issuer validity, and is `current` only when every included value is current. Keep impact freshness visible; never let the aggregate change lifecycle or imply safety. The publication gate must continue to exclude an event with no public claim set.

This decision selects the aggregation rule and preserves the existing contract boundary: `EventView` has one event/claim-set freshness value, each impact has its own freshness, and `PublicClaim` does not gain a freshness field. Do not imply that freshness is independently tracked per claim. No aggregator implementation, migration, or public contract change is included here.
