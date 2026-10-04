# ADR-046 — Mark source-invalidated publications as needing update

- **Status:** Accepted by Team 12
- **Date:** 4 October 2026
- **Owner:** Root planner; confirmed by Team 12
- **Affected scope:** LIFE-01, public freshness projection, ADR-032/038/042/043/044/045

## Context

The Layer 1 source-observation ledger records explicit publisher assertions about exact report revisions. The Layer 2 grounding gate blocks new reasoning from a report revision when any `superseded`, `retracted`, or `withdrawn` assertion exists. ADR-042 preserves the current published event version pending moderator review. Freshness is projected separately from immutable publication content, and the public contract exposes event-level freshness plus per-impact freshness.

Keeping published content visible does not mean its evidence is current. Team 12 selected a `needs_update` public freshness status when a supporting report is explicitly retracted or superseded, while preserving the current event version and distinguishing only impacts with exact support lineage to that report.

## Decision

1. For an exact current live published event version, an explicit source-observation assertion of `retracted` or `superseded` about a report revision that directly supports its claim set makes that exact event claim-set freshness `needs_update`.
2. Set `needs_update` only for exact current impact versions whose claims are directly supported by that report revision and whose event version references that exact impact version. Leave unrelated impact freshness unchanged. The event-level badge remains `needs_update` under the accepted conservative aggregate policy.
3. Preserve the exact immutable published event and impact versions and all their content. Freshness is an append-only status overlay bound to those exact publication versions; it does not change lifecycle, imply resolution or safety, alter history, or withdraw the event.
4. Any exact `retracted` or `superseded` observation triggers this policy even if a separate `current` observation also exists. A later `current` assertion does not clear `needs_update`; recovery follows the existing Layer 4 evidence-evaluation transition rules or a moderator-reviewed new publication.
5. Trigger only from an explicit publisher assertion persisted against the exact report revision. Missing pages, fetch errors, timeouts, changed hashes, cache age, model output, and source health do not trigger this freshness transition.
6. This decision covers only `retracted` and `superseded`. Public freshness treatment for `withdrawn` assertions remains open and must not be inferred from this decision. Historical and synthetic datasets do not create public freshness transitions.
7. Use the existing append-only freshness ledger and exact-version read projection. No event version or existing transition is updated or deleted. Public DTO shape remains unchanged; the existing `needs_update` status is used.

## Consequences

Once implemented, readers may display an event's existing published content with an event badge of `needs_update`, and only directly affected impact versions receive that item-level status. The review-candidate reader under ADR-045 remains read-only and does not record freshness. A separate bounded implementation task must connect exact observations and impact lineage to the Layer 4 append-only transition writer, use idempotent target identities, and verify current-public projections without changing publication content. No live source is enabled by this decision.

## Rejected alternatives

- Keep the prior `current` freshness badge while the source explicitly retracts or supersedes its supporting report: this would make the public evidence-status indicator contradict a known publisher assertion.
- Mark every impact in the event as `needs_update`: that would discard the exact report-to-claim-to-impact lineage already available.
- Automatically correct or withdraw the event: source revision is not a moderator-reviewed assessment of the incident.
- Infer invalidation from failed fetches, stale caches, model confidence, or absent pages: none is an explicit publisher assertion about the exact report revision.
