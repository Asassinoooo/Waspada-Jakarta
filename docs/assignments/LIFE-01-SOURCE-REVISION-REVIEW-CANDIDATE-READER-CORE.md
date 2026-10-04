# LIFE-01-SOURCE-REVISION-REVIEW-CANDIDATE-READER-CORE — read affected current publications

**Status:** Assigned for isolated implementation under [ADR-045](../decisions/ADR-045-source-revision-review-candidates.md).
**Backlog ID:** `LIFE-01-SOURCE-REVISION-REVIEW-CANDIDATE-READER-CORE`
**Implementation model:** GPT-6 Luna, max reasoning
**Branch:** `work/LIFE-01-SOURCE-REVISION-REVIEW-CANDIDATE-READER-CORE`
**Worktree:** `.codex-build/worktrees/life01-source-revision-review-candidate-reader-core` (WSL-compatible linked worktree)
**Contract baseline:** Persisted/domain schema 2.0; public API/OpenAPI/DTO and model contracts unchanged.

## Context and dependencies

Read `AGENTS.md`, `SOFTWARE_DEVELOPMENT_PLAN.md`, `ARCHITECTURE.md`, `docs/DOMAIN_MODEL.md`, `docs/IMPLEMENTATION_BACKLOG.md`, ADR-005, ADR-020, ADR-028, ADR-042, ADR-043, ADR-044, ADR-045, and the accepted assignments/handoffs for `LIFE-01-REPORT-REVISION-IMPACT-READER-CORE`, `LIFE-01-SOURCE-REVISION-OBSERVATION-CORE`, and `LIFE-01-L2-SOURCE-REVISION-GROUNDING-GATE-CORE` before editing.

The append-only Layer 1 ledger preserves publisher assertions about exact report revisions; the Layer 4 impact reader maps a report revision to current published targets; and L2 blocks known-invalidated exact spans from new reasoning. Team 12 selected keeping the current published version visible until moderator review. The public freshness treatment remains open, and the course demo moderator surface is read-only. This task composes those facts into an internal read-only projection only; it does not create a queue record or review action.

Dependencies: `LIFE-01-REPORT-REVISION-IMPACT-READER-CORE`, `LIFE-01-SOURCE-REVISION-OBSERVATION-CORE`, `LIFE-01-L2-SOURCE-REVISION-GROUNDING-GATE-CORE`, DATA-01, DB-TEST-RUNNER-ISOLATION, and ADR-042/043/044/045.

## Objective

Add a bounded, read-only database reader that maps explicit non-current source-revision assertions to the exact current published event claim-set and referenced impact versions supported by the asserted report revision.

## Required behavior

1. Require an explicit dataset (`live`, `historical`, or `synthetic`), page limit from 1 to 100, and a strictly validated optional keyset cursor shaped as `{ observationId, eventId, eventVersion, target }`; `target` is exactly `{ kind: 'event_claim_set' }` or `{ kind: 'impact', impactId, impactVersion }`. Never infer or combine dataset namespaces.
2. Select only observations with asserted state `superseded`, `retracted`, or `withdrawn`. A `current` assertion alone creates no candidate. Preserve each observation independently; conflicting assertion rows remain distinct and no latest/winning state is computed.
3. Match the observation's exact target report revision only through the impact reader's support-lineage rules: `evidence_references.relation = 'supports'` and `event_claim_evidence.evidence_kind = 'support'`. Contradiction and context references do not create a candidate.
4. Return one row per `(observation, current event version, target)` identity. Include dataset, observation ID, asserted state, target/assertion/replacement report-revision IDs, publisher-observed/retrieved/recorded times, event ID/version, and target kind; impacts also include exact impact ID/version. Do not return trace/source internals unless root reviews a concrete need before code changes.
5. Match only the latest published event version. If its latest version is withdrawn or otherwise unpublished, exclude that event and its older versions. Include an impact only when the same current event version references that exact impact version and its claim-support relation includes a matched claim.
6. Use one bounded SQL read under `waspada_l4_report_revision_impact_reader`. Keep the role `NOLOGIN`/`NOINHERIT`, preserve its existing grants, and add only the necessary column-level observation reads. Prove source text, claim text, source URLs, arbitrary rows, writes, and unrelated role privileges remain denied.
7. Apply deterministic keyset order across observation ID, event ID/version, target kind, and impact ID/version using stable collation. Query at most `limit + 1` rows to derive continuation, return at most `limit`, and reject malformed, duplicate, unordered, or more-than-`limit + 1` results with fixed content-free errors.
8. Make no writes and no public behavior changes. Do not add persisted queue/review state, review acknowledgement, auth, routes/UI, source fetches, model calls, audit/outbox rows, freshness transitions, publication decisions, lifecycle changes, geometry changes, API/DTO/OpenAPI changes, dependencies, bindings, or deployment changes.
9. Use authored synthetic PGlite fixtures only. Source content is data, never instructions; this task does not interpret or verify the publisher's meaning.

## Allowed paths

- `apps/db/migrations/031_source_revision_review_candidate_reader.sql` (new narrow read capability columns; optional lookup index only if justified by the bounded query)
- `apps/db/src/source-revision-review-candidate-reader.ts` (new typed reader)
- `apps/db/test/source-revision-review-candidate-reader.test.ts` (new synthetic reader/capability tests)
- `apps/db/test/migrations.test.ts` (migration inventory/order and exact role-capability assertions only)
- `apps/db/test/public-event-updates.test.ts` (staged migration inventory/order expectation only, if required)
- `docs/assignments/LIFE-01-SOURCE-REVISION-REVIEW-CANDIDATE-READER-CORE-HANDOFF.md` (new)

Do not change the source-observation ledger semantics, L2 gate, freshness policy/ledger, publication code/data, current public views, API/OpenAPI/DTO/UI, authentication, source adapters/providers, Worker runtime, external services, dependency manifests, or deployment configuration. Stop and ask root if more than the allowed paths are required or an unresolved policy/contract choice blocks the reader.

## Acceptance and verification

- Synthetic PGlite cases prove current-only observations are excluded; each non-current state is included; multiple/conflicting assertions remain distinct; dataset and target-revision scoping are exact; and cursor/page bounds preserve stable order.
- Cases prove only directly supported current event claims map, contradiction/context are excluded, exact impact support is followed, older event versions are excluded, and latest-withdrawn/unpublished versions hide the event and its history.
- Under `SET ROLE waspada_l4_report_revision_impact_reader`, prove required metadata reads work while source text, claim text, URLs/full rows, writes, and unrelated operations are denied. Verify other roles' existing grants are unchanged.
- Assert the projection creates no records and does not alter source observations, event/publication versions, freshness ledger/status, lifecycle, history, geometry, audit, or outbox rows.
- Run in WSL Ubuntu-26.04 with existing dependencies and record Node/npm/package versions: focused reader/migration/update-feed suites, `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD`. No package installation, source/provider access, or external service contact.
- Commit implementation and handoff separately on this task branch. Root independently reviews and integrates only after acceptance; the implementer does not merge or push.

## Stop conditions

Stop and ask root if this needs a public freshness change, publication correction/withdrawal, source-text interpretation, reviewer identity/authentication, review mutation, durable queue state, a new API or UI, source acquisition, a model call, a broader grant, or a dependency/configuration change. Keep the current published version unchanged and the read model content-free.
