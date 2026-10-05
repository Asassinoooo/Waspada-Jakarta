# LIFE-01-SOURCE-REVISION-WITHDRAWN-FRESHNESS-CORE — apply withdrawn-source freshness

**Status:** Assigned for implementation; exact base pinned by root.
**Backlog ID:** `LIFE-01-SOURCE-REVISION-WITHDRAWN-FRESHNESS-CORE`
**Implementation model:** GPT-6 Luna, max reasoning
**Branch:** `work/LIFE-01-SOURCE-REVISION-WITHDRAWN-FRESHNESS-CORE`
**Worktree:** `.codex-build/worktrees/life01-source-revision-withdrawn-freshness-core`
**Assigned base:** `c3dca9dc8ab4e6ef6ae6b23521d98f13211c5e91` (exact task-planning commit).
**Contracts:** ADR-048; source-observation schema 2.0; existing source-revision candidate and exact-target read contracts; append-only freshness ledger; public Freshness DTO and API remain unchanged.

## Context and dependencies

Read `AGENTS.md`, `SOFTWARE_DEVELOPMENT_PLAN.md`, `ARCHITECTURE.md`, `docs/DOMAIN_MODEL.md`, `docs/IMPLEMENTATION_BACKLOG.md`, ADR-042/043/044/045/046/048, and the accepted source-observation, review-candidate, exact freshness-target, transition, ledger, read-projection, and run-state assignments/handoffs.

ADR-048 selects the same public freshness behavior for explicit publisher `withdrawn` assertions as for `retracted` and `superseded`: the exact current event claim set and only directly supported impact versions become `needs_update`, while immutable publication content stays visible pending moderator review. Migration 033 and the private run-state are accepted. The existing one-page Layer 4 coordinator deliberately skips `withdrawn`, and migration 032 restricts the private reason check to retracted/superseded. Implement this policy as a separate bounded slice, leaving scheduling/runtime integration for a later task.

Dependencies: `LIFE-01-SOURCE-REVISION-FRESHNESS-RUN-STATE-CORE`, `LIFE-01-SOURCE-REVISION-FRESHNESS-TRANSITION-CORE`, `LIFE-01-SOURCE-REVISION-REVIEW-CANDIDATE-READER-CORE`, `LIFE-01-SOURCE-REVISION-FRESHNESS-TARGET-READER-CORE`, `LIFE-01-SOURCE-REVISION-OBSERVATION-CORE`, `LIFE-01-FRESHNESS-LEDGER-CORE`, `LIFE-01-FRESHNESS-READ-PROJECTION-CORE`, and ADR-042/043/044/045/046/048.

## Objective

Extend the existing private append-only freshness transition and bounded Layer 4 page coordinator to apply ADR-048 to explicit live `withdrawn` source observations. Preserve exact evidence lineage, publication immutability, the current conservative aggregate, and all existing retracted/superseded behavior.

## Required behavior

1. Process one explicit live candidate page per call, with caller-supplied limit 1–100, exact continuation cursor, finite RFC3339 `now`, and existing trace ID. Do not fetch or internally paginate another page; reject non-live or invalid bounds before reader access.
2. Treat explicit `withdrawn` as an invalidating assertion alongside `retracted` and `superseded`. A same-report `current` assertion does not cancel it. Current-only candidates remain no-ops. Preserve existing deterministic duplicate-target selection and bounded counts.
3. For an exact current live target whose issuer validity has not ended, append `needs_update` with reason `source_report_withdrawn` to the exact event claim-set and only exact impact versions directly supported by that report. Leave unrelated impacts unchanged. Keep immutable event/impact publication content visible; do not imply resolution or safety.
4. At or after `valid_until`, issuer expiry takes precedence and uses `issuer_validity_ended`, with no source-observation ID. Never downgrade existing `needs_update` or `expired` states. No missing-page, fetch-error, hash-change, source-health, model-output, or absence inference.
5. Extend the append-only ledger reason/status constraint through migration 034 to require `source_report_withdrawn` only for live `current` -> `needs_update` transitions with an exact non-null source observation ID. Reuse existing private column, FK, role and grants; do not add direct L4 access to observation tables or broaden privileges.
6. Preserve exact event/impact identity, expected sequence, idempotency, replay validation, trace, and source-observation ID. The ID remains private and exact. Stale target or ledger conflicts stop the page and return no advancing cursor. No report/claim text enters Layer 4.
7. Keep fixed typed outcomes and bounded count-only responses. Do not alter public API/DTO/OpenAPI, safe views, browser output, publication/version history, moderator behavior, or source/L1/L2 persistence/retrieval.
8. Test authored fictional PGlite fixtures only. Cover withdrawn event and direct-impact transitions, unaffected impacts, current-plus-withdrawn assertions, exact private lineage and replay, expiry precedence, already-needs-update/expired no downgrade, stale conflict/cursor behavior, current-only skips, malformed/bounded inputs, migration reason/status constraints, least privilege, append-only behavior, and unchanged public projections.
9. No runtime, scheduler, Cron, source/provider/model adapter, deployment setting, public contract, external resource, or dependency is in scope. Do not use live or retained incident data.

## Allowed paths

- `apps/db/migrations/034_source_revision_withdrawn_freshness.sql` (new)
- `apps/db/src/freshness-transition-ledger.ts`
- `apps/db/test/freshness-transition-ledger.test.ts`
- `apps/db/test/migrations.test.ts`
- `apps/db/test/public-event-updates.test.ts` (migration-order fixture correction only)
- `apps/db/test/source-revision-freshness-transition-composition.test.ts`
- `apps/worker/src/layers/l4-application-integration/source-revision-freshness-transition.ts`
- `apps/worker/test/source-revision-freshness-transition.test.ts`
- `apps/worker/package.json` (register the focused test in the existing command only, if needed)
- `docs/assignments/LIFE-01-SOURCE-REVISION-WITHDRAWN-FRESHNESS-CORE-HANDOFF.md` (new)

Root-authorized narrow fixture exception: `public-event-updates.test.ts` may exclude migration 034 from its partial pre-ledger setup and include it after migration 033 in the complete migration-order expectation. Do not change reader behavior or weaken assertions.

## Acceptance and verification

- Existing retracted/superseded behavior remains unchanged, and explicit withdrawn transitions match ADR-048 exactly.
- Focused DB ledger/migration/composition and Worker coordinator tests pass. `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD` pass in WSL Ubuntu-26.04 with existing dependencies. Record actual Node/npm and relevant package versions; do not install dependencies or contact an external service.
- Work only in the assigned branch/worktree from the exact pinned base. Commit implementation and handoff separately in descriptive commits. Handoff must list branch/worktree/base, exact commit SHAs/messages, changed paths, behavior, actual checks/results, limits, migration/privilege impact, and unresolved decisions. Do not merge or push; root reviews and integrates.

## Stop conditions

Stop and ask root if migration 034 would require new roles, broader grants, source-observation table reads, a public contract change, or changes to accepted candidate/target-reader contracts. Do not add a runtime or live source as a workaround. Escalate only after a GPT-6 Luna/max attempt documents a substantive unresolved technical blocker.
