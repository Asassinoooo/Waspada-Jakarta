# ADR-052 — Moderator-selected public evidence labels

- **Status:** Accepted by Team 12 on 8 October 2026; implementation remains assigned
- **Owners:** Team 12
- **Scope:** PUB-01; schema 2.0 private publication decisions and public Event claim projection

## Context

Schema 2.0 `EventProposal` claims are private drafts and carry `evidence_label: "under_review"` until Layer 4 authorizes publication. The accepted SQL writer rejects that value as a public label, and the accepted manual-gate service has no authorized moderator input that supplies a public label. Inferring a label from the draft would turn a private placeholder into a public assertion without review.

## Decision

- Every proposal claim included in a newly published Event version must have exactly one explicit public evidence label selected by the authorized moderator and keyed to that claim's exact stable `claim_id`. The moderator choice is part of the trusted approval input. The service maps it to that claim's `PublicationClaimDecision` by ID, never by array position.
- The allowed values remain `issuer_notice`, `attributed_report`, `independent_corroboration`, and `crowdsourced_observation`. No new public label is introduced. `under_review` remains private to draft `EventProposal` records and is never inferred, copied, or accepted as a selected public label.
- Label selection is separate from publication eligibility. The existing L4 policy, current-evidence checks, target-version checks, and explicit trusted moderator approval remain required. A label choice does not turn a held, rejected, disputed, unsupported, stale, or otherwise ineligible claim into a publishable claim.
- L4 rejects missing, duplicate, unknown, extra, or invalid label choices before invoking the writer. The SQL writer independently validates the label set and values against the claims it will publish. A new publish decision must carry the selected label for each published claim.
- The writer stores the selected label in `PublicationDecision.claim_decisions`, the corresponding `Event.claims[].evidence_label`, and normalized `event_claims.evidence_label`. Those copies must agree by `claim_id`; the private proposal's `under_review` value remains unchanged.
- The canonical writer-command fingerprint includes each claim's selected label. Reusing an idempotency key with a changed label conflicts; exact replay with the same labels returns the original result.
- Add `evidence_label` as an optional property on schema 2.0 `PublicationDecision.claim_decisions`. Optionality preserves readability of existing stored decisions that predate the field. The new service and writer require it on new publish decisions. No schema-version bump is needed unless implementation evidence demonstrates that the existing schema-2.0 envelope cannot preserve this compatibility rule.

## Consequences and boundaries

The existing public enum and normalized `event_claims.evidence_label` column already hold the selected values, so no database table schema or migration is needed. The decision is private review metadata; public Event projections continue to expose only the existing label on published claims. No public DTO, API/OpenAPI, identity, route/runtime, source acquisition, live access, or hosted service is authorized by this decision. The implementation must not claim source rights or factual correctness from a selected label alone.

The bounded service/writer implementation and its tests are tracked by [PUB-01-REVIEWED-EVIDENCE-LABEL-CORE](../assignments/PUB-01-REVIEWED-EVIDENCE-LABEL-CORE.md). The real-writer PGlite composition remains a separate dependent task under [PUB-01-MANUAL-GATE-PGLITE-CORE](../assignments/PUB-01-MANUAL-GATE-PGLITE-CORE.md).

## Affected requirements

FR-08/13; NFR-01/05/07.
