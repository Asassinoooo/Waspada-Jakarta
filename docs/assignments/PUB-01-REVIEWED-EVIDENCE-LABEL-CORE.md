# PUB-01-REVIEWED-EVIDENCE-LABEL-CORE — carry explicit public labels through the manual gate

- **Status:** Assigned for implementation
- **Backlog ID:** `PUB-01-REVIEWED-EVIDENCE-LABEL-CORE`
- **Parent:** `PUB-01`
- **Dependencies:** Accepted `PUB-01-MANUAL-GATE-CORE`, `PUB-WRITE-CORE`, `L2-PROPOSAL-PERSIST-CORE`, `L2-PROPOSAL-REASONING-BRIDGE-CORE`, `MOD-01-WRITER-ROLE-CORE`, and `DB-TEST-RUNNER-ISOLATION`; [ADR-003](../decisions/ADR-003-domain-publication-evidence.md), [ADR-013](../decisions/ADR-013-publication-write-transaction.md), [ADR-036](../decisions/ADR-036-event-proposal-persistence.md), and [ADR-052](../decisions/ADR-052-moderator-selected-public-evidence-labels.md)
- **Assigned base:** `d50626b8b548cbbf35b8e792ce47d7ae300bfe09` (`docs(L3): record accepted review-pending marker`), which includes migration 035 and the completed L3 handoff.
- **Contract baseline:** Private `EventProposal` and `PublicationDecision`, `PublicationWriteCommand`, and `Event` schema version `2.0`; existing public evidence-label enum and normalized `event_claims.evidence_label` column
- **Implementation model:** GPT-6 Luna, max reasoning
- **Branch:** `work/PUB-01-REVIEWED-EVIDENCE-LABEL-CORE`
- **Worktree:** `.codex-build/worktrees/pub-01-reviewed-evidence-label-core`

## Objective

Implement ADR-052's explicit per-claim moderator label choice across the existing Layer 4 manual-publication service and atomic SQL writer. Preserve the current publication-policy and authorization gate, reject malformed label sets before persistence, and prove that each selected label is immutable, consistent across private decision and public Event claim records, and bound into idempotency. Keep the slice local and synthetic. The following real-writer PGlite composition is a separate task and starts only after this task is accepted.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md`
- `docs/IMPLEMENTATION_BACKLOG.md`
- [ADR-003](../decisions/ADR-003-domain-publication-evidence.md)
- [ADR-013](../decisions/ADR-013-publication-write-transaction.md)
- [ADR-036](../decisions/ADR-036-event-proposal-persistence.md)
- [ADR-052](../decisions/ADR-052-moderator-selected-public-evidence-labels.md)
- `docs/contracts.schema.json` and `docs/DOMAIN_MODEL.md`
- `docs/assignments/PUB-01-MANUAL-GATE-CORE.md` and its handoff
- `docs/assignments/PUB-WRITE-CORE.md` and its handoff
- `docs/assignments/L2-PROPOSAL-PERSIST-CORE.md` and `docs/assignments/L2-PROPOSAL-REASONING-BRIDGE-CORE.md`
- `apps/worker/src/layers/l4-application-integration/publication-policy.ts`
- `apps/worker/src/layers/l4-application-integration/manual-publication-service.ts`
- `apps/worker/test/l4-manual-publication-service.test.ts`
- `apps/db/src/publication-writer.ts` and `apps/db/test/publication-writer.test.ts`

## Required behavior

1. Add an exact claim-ID keyed choice list to the existing trusted moderator approval input, using closed entries `{ claimId, evidenceLabel }`. Each entry must name one proposal `claim_id`. Use only `issuer_notice`, `attributed_report`, `independent_corroboration`, or `crowdsourced_observation`.
2. Keep policy eligibility separate from label selection. Recompute the existing policy from the canonical persisted proposal and current inputs. The existing explicit `approve`, trusted-authorization, all-publish disposition, evidence, source, freshness, and target-version requirements remain intact. Labels cannot upgrade policy dispositions or authorize a write.
3. Before invoking the writer, require one and only one valid choice for every persisted proposal claim that the accepted service will publish. Match choices by exact `claim_id`, not by list order. Reject missing, duplicate, unknown, extra, malformed, or invalid choices with the existing stable content-free denial behavior and zero writer calls. Never infer a public label from `EventProposal.evidence_label: "under_review"`.
4. Extend `PublicationClaimDecision` and the typed writer command so the selected value is carried with the matching claim decision. The service must build the command from the reader-returned proposal, the recomputed eligible claims, and the authorized moderator input; caller-supplied command or proposal content remains non-authoritative.
5. Make the SQL writer independently validate the closed public-label enum and exact claim-ID coverage for the claims it will publish, even when called without the manual-gate service. Every `publish` decision has exactly one label; every non-published `review`, `reject`, or `retract` decision has none, and an extra label for one of those claims is rejected. It may accept `under_review` while parsing a private stored proposal only; it must reject it as a selected label or any published claim label. Project the selected label into `PublicationDecision.claim_decisions`, `Event.claims[].evidence_label`, and normalized `event_claims.evidence_label`, with all three values matching for each published `claim_id`.
6. Include labels in the canonical publication command fingerprint. Verify exact replay with the same selection returns the original result; changing a selected label under the same idempotency key returns `idempotency_key_reused` and writes no second decision, event, audit, receipt, or outbox row.
7. Extend `docs/contracts.schema.json` only to describe `PublicationDecision.claim_decisions[].evidence_label` as an optional member of the existing schema 2.0 envelope with the ADR-052 enum. Keep old records without the property valid; require it in service/writer validation for every new published claim decision. Do not bump `schema_version` unless root approves a documented incompatibility finding.
8. Keep all test inputs authored synthetic/live-shaped fixtures. Do not represent them as real source reports, source rights, moderator identities, or factual quality evidence.

## Allowed paths

- `apps/worker/src/layers/l4-application-integration/publication-policy.ts`
- `apps/worker/src/layers/l4-application-integration/manual-publication-service.ts`
- `apps/worker/test/l4-manual-publication-service.test.ts`
- `apps/db/src/publication-writer.ts`
- `apps/db/test/publication-writer.test.ts`
- `docs/contracts.schema.json` — only the optional private schema-2.0 `PublicationDecision.claim_decisions[].evidence_label` property
- This assignment's implementation handoff section only

No database table schema, migration, public DTO/API/OpenAPI, route/runtime, identity integration, source/provider/live access, package, lockfile, dependency, deployment, or hosted-service change is in scope. Root owns all architecture, public contracts, migrations, backlog/status, and acceptance changes beyond the one optional private record field stated above.

## Acceptance and verification

- Service tests cover exact matching by claim ID regardless of input ordering, one distinct label per published claim, all four valid labels, and missing/duplicate/unknown/extra/invalid values. Every malformed or unauthorized path makes zero writer calls.
- Existing policy-denial tests remain valid. Tests show a label selection cannot turn a policy-held/rejected claim, unauthorized caller, stale target, or invalid evidence into an authorized write.
- Writer tests independently cover mixed publish/review/reject dispositions, exact label coverage for published claims only, rejection of an extra label on a non-published claim, missing/duplicate/unknown label mappings, invalid and `under_review` public selections, private `under_review` proposal parsing, and exact projection of selected labels into decision JSON, Event claim JSON, and normalized `event_claims.evidence_label`.
- The schema-2.0 JSON Schema accepts legacy `PublicationDecision` claim-decision records without `evidence_label` and accepts only the four existing labels when the optional property is present. New write paths require the property for every published claim decision.
- Idempotency tests prove identical-label replay is unchanged and a changed label with the same key conflicts without additional publication rows.
- Confirm no route/runtime registration or public contract change was made. Synthetic PGlite/unit fixtures do not prove source rights, moderator identity, hosted Neon behavior, or publication quality.
- In WSL Ubuntu-26.04 with existing dependencies, record Node/npm and PGlite versions. Run the focused service and SQL-writer tests through the existing workspace harnesses, then `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD`. Do not install dependencies or call external services.
- Commit implementation/tests and a completed handoff as separate descriptive commits on the assigned branch, leave the worktree clean, and do not merge or push. Root independently reviews and accepts before the dependent PGlite task starts.

## Stop and escalation conditions

Stop and report if any selected-label path requires changing a database table/migration, public DTO/API/OpenAPI, route/runtime/identity boundary, source/provider access, or a schema version to preserve backward compatibility. Do not broaden the scope or weaken exact claim-ID matching. Ask root to resolve any conflict with a pinned contract or dependency before proceeding; continue unrelated assigned work where possible. Escalate beyond Luna/max only if a substantive technical difficulty was attempted and remains unresolved, not for usage or scheduling constraints.

## Implementation handoff

The implementer records the actual branch/worktree and root-pinned base; commit SHAs and exact messages; changed paths; behavior; runtime/package versions; actual checks and results; limitations; migration/configuration impact; and remaining decisions. Root records independent review and acceptance.
