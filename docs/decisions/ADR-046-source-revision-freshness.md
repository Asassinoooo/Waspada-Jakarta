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
6. The original implementation scope of this decision covers `retracted` and `superseded`; at acceptance, `withdrawn` was left open and excluded from that implementation. Team 12 later selected the same freshness treatment for explicit `withdrawn` assertions in [ADR-048](ADR-048-source-report-withdrawn-freshness.md). Historical and synthetic datasets do not create public freshness transitions.
7. Use the existing append-only freshness ledger and exact-version read projection. No event version or existing transition is updated or deleted. Public DTO shape remains unchanged; the existing `needs_update` status is used.
8. Persist source-driven transitions with reason `source_report_retracted` or `source_report_superseded`, and retain the exact immutable source-observation ID on the private freshness transition row. Layer 4 receives that identity through the bounded candidate projection and does not read source-observation tables directly. The database grants the existing freshness writer only the new transition column; the public projection does not expose it.
9. Issuer validity keeps precedence over source-invalidation freshness. When `valid_until` has passed, a target transitions to `expired` under the existing `issuer_validity_ended` reason if needed; source invalidation changes a still-valid `current` target to `needs_update`. Existing `needs_update` and `expired` targets are not downgraded.

## Consequences

Once implemented, readers may display an event's existing published content with an event badge of `needs_update`, and only directly affected impact versions receive that item-level status. The review-candidate reader under ADR-045 remains read-only and does not record freshness. The Layer 4 transition writer connects exact observations and impact lineage to the append-only freshness ledger, retains the exact source-observation ID privately, uses idempotent target identities, and verifies current-public projections without changing publication content. No live source is enabled by this decision.

The bounded transition implementation is `LIFE-01-SOURCE-REVISION-FRESHNESS-TRANSITION-CORE`. It consumes a single page from the accepted candidate reader, resolves exact current live target state through the freshness target reader, and appends only required transitions. It uses `source_report_retracted` and `source_report_superseded` for still-valid targets that move from `current` to `needs_update`; issuer-expired targets use the existing `issuer_validity_ended` transition. Each source-driven transition retains its exact observation ID in a private ledger column. The workflow must stop on stale sequence conflicts without advancing the candidate cursor. No source-observation table access is added to the freshness writer.

**Later policy amendment:** ADR-048 selects the same behavior for explicit publisher `withdrawn` assertions, using a separate implementation slice and the reason `source_report_withdrawn`. That amendment does not retroactively expand the accepted transition implementation.

## Rejected alternatives

- Keep the prior `current` freshness badge while the source explicitly retracts or supersedes its supporting report: this would make the public evidence-status indicator contradict a known publisher assertion.
- Mark every impact in the event as `needs_update`: that would discard the exact report-to-claim-to-impact lineage already available.
- Automatically correct or withdraw the event: source revision is not a moderator-reviewed assessment of the incident.
- Infer invalidation from failed fetches, stale caches, model confidence, or absent pages: none is an explicit publisher assertion about the exact report revision.
