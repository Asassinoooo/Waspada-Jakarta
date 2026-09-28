# ADR-028 — Read-only moderator experience in the course demo

- **Status:** Accepted
- **Date:** 28 September 2026
- **Owner:** Root planner; confirmed by Team 12
- **Affected scope:** MOD-01, UI-00, UI-03, US-03

## Context

The project has local moderator authorization and database-writer foundations, but the course demo has no selected identity provider, provisioned moderators, live review records, or approved source corpus. Adding authentication and protected write routes would expand the demo without improving its current synthetic evidence-review flow.

## Decision

Keep moderator access read-only for the course demo. Use the existing UI-00 moderator evidence review with explicitly labelled synthetic/demo fixtures. Do not add moderator login/session handling, identity-provider configuration, protected mutation routes, source approvals, publication, corrections, merges, retractions, or other review writes to the demo.

The existing login and mutation shapes in OpenAPI remain future design contracts; they are not implemented or enabled by this decision. ADR-006 remains a possible security design for a later authenticated release. This decision selects no identity provider and does not change the API contract, Layer 4 publication gate, authorization kernel, or least-privilege database writer role.

## Alternatives considered

- **Cloudflare Access for the demo:** deferred because the demo has no moderator write capability to protect and this would introduce an external configuration dependency.
- **OIDC with application-managed sessions:** deferred for the same reason; provider choice can be revisited for an authenticated release.
- **Enable unauthenticated moderator mutations:** rejected because it would expose source approval and publication writes without actor authentication and authorization.

## Consequences

The course demo remains easier to run and review without moderator accounts or an identity service. Its moderator screen can explain evidence provenance and review state, but cannot change them. Corrections, source registration/approval, candidate merging, retraction and review audit writes remain future authenticated-release scope. Synthetic fixtures must remain labelled and isolated from live data.

Before adding moderator mutations in a later release, revisit ADR-006, select and configure an identity/session approach, complete CSRF and revocation controls, provision restricted operators, and verify authorization through the shared Layer 4 publication gate and dedicated database capability.
