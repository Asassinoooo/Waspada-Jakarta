# ADR-048 — Apply source-withdrawal freshness to directly affected publications

- **Status:** Accepted by Team 12
- **Date:** 5 October 2026
- **Decision owner:** Team 12
- **Related:** ADR-042/043/044/045/046; LIFE-01 source-revision freshness

## Context

ADR-046 defines the public freshness response to explicit publisher assertions that a supporting report revision was retracted or superseded. The source-observation ledger and Layer 2 grounding gate also represent an explicit `withdrawn` assertion, and the read-only candidate projection already identifies its directly supported current publications. The transition implementation accepted under ADR-046 deliberately skipped `withdrawn`; that implementation boundary did not settle the policy.

## Decision

Apply the same public freshness treatment to an explicit publisher `withdrawn` assertion as to `retracted` or `superseded` under ADR-046:

1. For an exact current live published event version directly supported by the withdrawn report revision, mark the event claim-set freshness `needs_update`.
2. Mark only exact current impact versions directly supported by that report revision `needs_update`; leave unrelated impacts unchanged.
3. Keep the exact immutable published event and impact versions visible pending moderator review. Withdrawal of a source report does not withdraw the incident publication, resolve the incident, or imply that an area is safe.
4. Trigger only from an explicit publisher assertion persisted against the exact report revision. Do not infer withdrawal from missing pages, fetch errors, changed hashes, stale caches, source health, or model output. Preserve conflicting assertions; a coexisting `current` assertion does not cancel the explicit withdrawal.
5. Preserve issuer-validity precedence and the existing conservative event-level freshness aggregate. Historical and synthetic datasets do not produce public transitions.

The append-only transition ledger uses the reason `source_report_withdrawn` and retains the exact source-observation ID privately, following ADR-046's provenance and access rules. Existing public DTOs remain unchanged.

## Implementation status

The selected policy is implemented and accepted in `LIFE-01-SOURCE-REVISION-WITHDRAWN-FRESHNESS-CORE`. Migration 034 extends only the private freshness reason/status constraint; the Layer 4 coordinator records the exact observation identity and applies `needs_update` to the current event claim set and directly supported impacts. Existing writer grants, public contracts, publication content, and runtime configuration are unchanged. Authored PGlite fixtures cover the local behavior; hosted Neon and live-source behavior remain unverified. See the [assignment](../assignments/LIFE-01-SOURCE-REVISION-WITHDRAWN-FRESHNESS-CORE.md) and [handoff](../assignments/LIFE-01-SOURCE-REVISION-WITHDRAWN-FRESHNESS-CORE-HANDOFF.md).

This slice does not add a scheduler, source/provider access, moderator mutation, or deployment configuration. The separate source-revision Worker runtime remains paused at its least-privilege role-design stop condition.
