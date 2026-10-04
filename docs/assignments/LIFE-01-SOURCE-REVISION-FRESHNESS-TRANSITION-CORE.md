# LIFE-01-SOURCE-REVISION-FRESHNESS-TRANSITION-CORE — apply explicit source invalidation to freshness

**Status:** Assigned for implementation; root review required.
**Backlog ID:** `LIFE-01-SOURCE-REVISION-FRESHNESS-TRANSITION-CORE`
**Implementation model:** GPT-6 Luna, max reasoning
**Branch:** `work/LIFE-01-SOURCE-REVISION-FRESHNESS-TRANSITION-CORE`
**Worktree:** `.codex-build/worktrees/life01-source-revision-freshness-transition-core`
**Assigned base:** To be pinned by root after the assignment commit.
**Contracts:** Persisted/domain schema 2.0; public API, OpenAPI, DTO, model and source-observation contracts unchanged. One private freshness-ledger migration is allowed by ADR-046.

## Context and dependencies

Read `AGENTS.md`, `SOFTWARE_DEVELOPMENT_PLAN.md`, `ARCHITECTURE.md`, `docs/DOMAIN_MODEL.md`, `docs/IMPLEMENTATION_BACKLOG.md`, ADR-032/038/042/043/045/046, and the accepted candidate-reader, source-observation, freshness-target-reader, freshness-ledger, freshness-read-projection and freshness-writer handoffs before editing.

The accepted Layer 4 candidate reader returns exact event claim-set and directly supported current impact targets for each explicit report-revision observation. It deliberately preserves conflicting observations. The accepted freshness target reader returns exact current live target status, sequence, and `validUntil`; it does not write. The append-only freshness ledger currently supports issuer-expiry, reviewed-evidence recovery, and review-deadline reasons. ADR-046 selects an event-level `needs_update` badge and `needs_update` only for directly affected impact versions when a live report is explicitly `retracted` or `superseded`. Publication content remains visible and immutable pending moderator review. User policy selects a conservative event badge alongside only directly affected impact statuses.

Dependencies: `LIFE-01-SOURCE-REVISION-REVIEW-CANDIDATE-READER-CORE`, `LIFE-01-SOURCE-REVISION-OBSERVATION-CORE`, `LIFE-01-SOURCE-REVISION-FRESHNESS-TARGET-READER-CORE`, `LIFE-01-FRESHNESS-LEDGER-CORE`, `LIFE-01-FRESHNESS-READ-PROJECTION-CORE`, `ADR-032/038/042/043/045/046`.

## Objective

Implement one bounded Layer 4 pass that consumes explicit live `retracted`/`superseded` candidates and appends exact-version freshness transitions through the existing ledger. Keep source acquisition and observation persistence in Layer 1, candidate and exact-state reads in their existing repositories, and the deterministic transition decision in Layer 4.

## Required behavior

1. Process exactly one candidate page per invocation, with a caller-supplied `limit` from 1 through 100, optional exact continuation cursor, explicit RFC3339 `now`, and an existing trace ID. Reject historical/synthetic datasets and invalid bounds before reader calls. Do not read or paginate another page in the same invocation.
2. Accept candidates only when their assertion state is `retracted` or `superseded` and dataset is `live`; skip `withdrawn` and `current` without writes. Preserve conflicting observations as independent candidates and deterministically choose one source observation for a duplicate exact target within a page.
3. Deduplicate target identities, read each exact target at most once through the accepted freshness target reader (maximum 100 targets), and append at most one transition per target. Candidate rows for an event claim set and a directly linked impact remain distinct targets.
4. For each exact current target, if `validUntil <= now`, append `expired` with reason `issuer_validity_ended` only when the existing status is `current` or `needs_update`. Otherwise append `needs_update` with reason `source_report_retracted` or `source_report_superseded` only when the existing status is `current`. Never downgrade `needs_update` or `expired`, never infer from fetch failures, missing pages, hash changes, source health, model output or absent data.
5. Preserve exact current live publication and impact-version guards, expected transition sequence, previous status, and ledger idempotency. Use deterministic idempotency keys for the exact target plus selected observation and reason; use bounded keys. Supply the exact candidate `observationId` for source-reason transitions only. Issuer-expiry transitions have no source-observation ID. Do not send claim/source text or retrieve source-observation rows from Layer 4.
6. Extend the private append-only freshness ledger to persist the two source reasons and exact source-observation ID. The new ID is required only for source reasons, validated against the existing observation identity constraints and immutable observation row, included in request fingerprint/replay validation, and kept private. Preserve null/no-ID for existing transition reasons. If an FK or trigger needs source-table grants, stop and ask root; do not widen writer read access to observations. The public status views and DTOs must not expose this ID.
7. Use the exact candidate-reader and target-reader ports and the existing freshness ledger. Append serially with no internal retries. If a target becomes stale, a sequence/status conflict or target-changed error occurs, stop processing that page and return a result that does not advance `nextCursor`; the same input page must be safe to process again. Do not swallow storage/read errors or advance past a failed page.
8. Return only bounded processing counts, the next candidate cursor after a fully completed page, or a fixed typed failure/conflict. Do not expose IDs, source metadata, SQL diagnostics or row content in errors. No public route, API, UI, scheduler, runtime binding, source, model, provider or publication-write integration is in scope.
9. No new role or role membership. Grant only the exact new freshness-transition column needed to insert/read the source-observation ID to the existing `waspada_l4_freshness_writer`; preserve all other privileges, and verify it still cannot directly read source observations. The database must enforce reason/status/ID consistency and append-only behavior.
10. Test with authored fictional PGlite fixtures only. Verify exact event badge and directly supported impacts, unaffected impacts, exact observation linkage/replay, coexisting `current` and invalidating assertions, `withdrawn` skip, expired-validity precedence, already-needs-update/expired no downgrade, stale conflict/cursor behavior, bounds, role grants, append-only ledger, and unchanged publication/history/public projections.

## Allowed paths

- `apps/db/migrations/032_source_revision_freshness_transitions.sql` (new)
- `apps/db/src/freshness-transition-ledger.ts`
- `apps/db/test/freshness-transition-ledger.test.ts`
- `apps/db/test/migrations.test.ts`
- `apps/db/test/source-revision-freshness-transition-composition.test.ts` (new; may import the Layer 4 module for PGlite composition)
- `apps/worker/src/layers/l4-application-integration/source-revision-freshness-transition.ts` (new)
- `apps/worker/test/source-revision-freshness-transition.test.ts` (new)
- `apps/worker/package.json` (register only the focused test in the existing test command, if needed)
- `docs/assignments/LIFE-01-SOURCE-REVISION-FRESHNESS-TRANSITION-CORE-HANDOFF.md` (new)

Do not change candidate/target-reader queries or contracts, public API/DTO/OpenAPI, public projections/views, source observation persistence, L1/L2 behavior, moderator behavior, freshness policy for `withdrawn`, scheduler/runtime bindings, source/provider/model adapters, deployment settings, package dependencies, or unrelated tests. Stop and ask root if the candidate/target/ledger contracts cannot support this composition within these paths or the migration would require broader privileges or a public contract change.

## Acceptance and verification

- Focused DB ledger/migration/composition tests and focused Worker coordinator tests pass.
- `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD` pass in WSL Ubuntu-26.04 with existing dependencies. Capture actual Node/npm and relevant package versions. Do not install dependencies or contact any external service.
- Commit implementation and the completed handoff separately on this task branch. The handoff must report branch/worktree/base, commit SHAs and exact messages, changed paths, implemented behavior, actual check commands/results, limits, migration/privilege impact, and unresolved decisions. Do not merge or push; root reviews and integrates.

## Stop conditions

Stop if implementation requires direct Layer 4 access to source-observation tables, if the freshness role must gain broader privileges, if any task dependency is not actually accepted, if current contract changes are needed, or if a change would touch withdrawn policy, publication content, public API, live source/runtime configuration or an external service. Ask root with the concrete blocker and continue no dependent edits.
