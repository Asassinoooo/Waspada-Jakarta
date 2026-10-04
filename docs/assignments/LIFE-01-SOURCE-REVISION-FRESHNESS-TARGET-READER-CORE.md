# LIFE-01-SOURCE-REVISION-FRESHNESS-TARGET-READER-CORE — read exact current freshness state

**Status:** Assigned for isolated implementation under [ADR-046](../decisions/ADR-046-source-revision-freshness.md).
**Backlog ID:** `LIFE-01-SOURCE-REVISION-FRESHNESS-TARGET-READER-CORE`
**Implementation model:** GPT-6 Luna, max reasoning
**Branch:** `work/LIFE-01-SOURCE-REVISION-FRESHNESS-TARGET-READER-CORE`
**Worktree:** `.codex-build/worktrees/life01-source-revision-freshness-target-reader-core` (WSL-compatible linked worktree)
**Contract baseline:** Persisted/domain schema 2.0; public API/OpenAPI/DTO and model contracts unchanged.

## Context and dependencies

Read `AGENTS.md`, `SOFTWARE_DEVELOPMENT_PLAN.md`, `ARCHITECTURE.md`, `docs/DOMAIN_MODEL.md`, `docs/IMPLEMENTATION_BACKLOG.md`, ADR-032, ADR-038, ADR-043, ADR-045, ADR-046, and the accepted handoffs for the source-revision candidate reader, freshness transition recorder/ledger, and current freshness projection before editing.

The read-only source-revision candidate reader runs under `waspada_l4_report_revision_impact_reader`; the append-only freshness writer uses `waspada_l4_freshness_writer`. They have separate capabilities. Before a later Layer 4 transition task can request an append, it needs the effective status and sequence for the exact current event claim set or impact target. The event claim-set status must come from its own immutable event record plus its exact ledger, never from the public aggregate. The existing due-target reader is time-filtered and is not suitable because a source assertion can be recorded before a review deadline.

ADR-046 authorizes `needs_update` for explicit `retracted` or `superseded` support, preserving immutable publication data and changing only the event badge and directly affected impact versions. Public freshness handling for `withdrawn` assertions remains open. This assignment only reads target state; it applies no policy, writes no transition, and does not decide the `withdrawn` policy.

Dependencies: `LIFE-01-SOURCE-REVISION-REVIEW-CANDIDATE-READER-CORE`, `LIFE-01-FRESHNESS-LEDGER-CORE`, `LIFE-01-FRESHNESS-READ-PROJECTION-CORE`, `LIFE-01-FRESHNESS-DUE-TARGET-READER-CORE`, DATA-01, DB test-runner isolation, ADR-032/038/043/045/046.

## Objective

Add a bounded, read-only database reader that resolves effective freshness status, transition sequence, and issuer validity end for exact current live event/impact target identities supplied by the source-revision candidate projection.

## Required behavior

1. Accept only `datasetKind: 'live'`; reject historical and synthetic namespaces before SQL. Require 1–100 exact target identities, each shaped exactly as `{ eventId, eventVersion, target }`, where target is `{ kind: 'event_claim_set' }` or `{ kind: 'impact', impactId, impactVersion }`. Do not accept source text, source-observation assertions, arbitrary query filters, or public request data.
2. Use one bounded, parameterized SQL read under the existing `waspada_l4_freshness_writer` capability. Do not add a role, grant, membership, function, migration, or direct access to source-observation tables. Stop and ask root if existing grants are insufficient.
3. Return only exact targets whose event version is the latest published version. A later withdrawn/unpublished version hides its older versions. For impacts, require the exact impact version to be referenced by that exact event version.
4. Derive effective status from the latest transition for that exact target, falling back to the status in its immutable event/impact record. The event claim-set target uses the grouped claim-set status in the event record, never the event-level public aggregate. Return transition sequence `0` when no transition exists.
5. Include the exact target identity, effective `FreshnessStatus`, transition sequence, and issuer `valid_until` needed to preserve expiry precedence in the later Layer 4 policy. Do not return raw record JSON, review deadlines, claim/evidence/source text, URLs, traces, or unrelated metadata.
6. Deduplicate repeated target identities and return deterministic ordering by event ID/version, target kind, impact ID/version. Do not return more rows than unique requested targets. Missing, historical, withdrawn, superseded, malformed, or otherwise non-current target identities produce no target row.
7. Validate request and database result shapes and return fixed content-free errors. Protect the maximum input size before SQL; do not echo malformed target IDs or database diagnostics.
8. Keep the reader read-only. Prove it works under the existing freshness-writer role while source-observation data, writes, unrelated tables, and privileges outside the role's current grants remain denied. Assert all stored rows and public projections are unchanged.
9. Test with authored PGlite fixtures only. Test rows in the `live` namespace are isolated test fixtures, not public/live data. Do not contact Neon, a source, a provider, or any external service.

## Allowed paths

- `apps/db/src/source-revision-freshness-target-reader.ts` (new read-only repository)
- `apps/db/test/source-revision-freshness-target-reader.test.ts` (new fixture and capability tests)
- `docs/assignments/LIFE-01-SOURCE-REVISION-FRESHNESS-TARGET-READER-CORE-HANDOFF.md` (new)

Do not change the source candidate reader, freshness policy/recorder/ledger, migrations/grants, public projection/API/OpenAPI/DTO, UI, scheduler, provider/source adapters, Worker runtime, dependencies, bindings, or deployment configuration. Stop and ask root if the needed query cannot run under existing grants or would require another contract, capability, or migration.

## Acceptance and verification

- Tests cover exact event claim-set status vs event aggregate, exact impact status and references, latest exact transition sequence, immutable-record fallback, expired validity metadata, dataset rejection, duplicate target handling, key order, hidden latest-withdrawn/unpublished events, and absent/mismatched targets.
- Capability tests prove the reader works under `waspada_l4_freshness_writer` and cannot read source observations or write any row. Existing public/L1/L2 access remains unchanged.
- Tests assert no writes or changes to event/impact versions, freshness transitions/evidence, source observations, publication history, lifecycle, geometry, audit, or outbox data.
- Run in WSL Ubuntu-26.04 with existing dependencies: focused reader test, `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD`. Record exact outcomes and Node/npm/package versions. Do not install packages or contact external services.
- Commit implementation and handoff separately on this branch. Root independently reviews and integrates; the agent does not merge or push.

## Stop conditions

Stop and ask root if the existing `waspada_l4_freshness_writer` grants cannot serve this projection, if reading target state requires source-observation access, or if the reader would need to append transitions, evaluate evidence, change publication/public contracts, introduce a scheduler, or define the `withdrawn` freshness policy. Do not use the public aggregate as the prior status for the event claim-set target.
