# LIFE-01-SOURCE-REVISION-FRESHNESS-RUN-STATE-CORE — persist private scan progress

**Status:** Assigned for implementation; exact base pinned by root.
**Backlog ID:** `LIFE-01-SOURCE-REVISION-FRESHNESS-RUN-STATE-CORE`
**Implementation model:** GPT-6 Luna, max reasoning
**Branch:** `work/LIFE-01-SOURCE-REVISION-FRESHNESS-RUN-STATE-CORE`
**Worktree:** `.codex-build/worktrees/life01-source-revision-freshness-run-state-core`
**Assigned base:** `b73111739ff79f12b4c6343b790c456ee26afe01` (exact task-planning commit).
**Contracts:** Existing source-revision candidate cursor and coordinator-count contracts; source/domain schema 2.0; public API/DTO unchanged. One private migration adding run/cursor state and fixed-purpose SQL functions is allowed by ADR-047.

## Context and dependencies

Read `AGENTS.md`, `SOFTWARE_DEVELOPMENT_PLAN.md`, `ARCHITECTURE.md`, `docs/DOMAIN_MODEL.md`, `docs/IMPLEMENTATION_BACKLOG.md`, ADR-038/039/043/045/046/047, and the accepted source-revision observation, candidate-reader, exact freshness-target-reader, and freshness-transition handoffs.

The accepted Layer 4 coordinator handles one page of at most 100 live candidates. The candidate reader keeps explicit invalidating observations visible after transition, so a scheduled integration needs a durable private cursor to make progress across invocations. The existing freshness-due trace functions have a different fixed trigger and count summary and must not be reused. This assignment adds database run/checkpoint state only; scheduled runtime wiring is a later task.

Dependencies: `LIFE-01-SOURCE-REVISION-FRESHNESS-TRANSITION-CORE`, `LIFE-01-SOURCE-REVISION-REVIEW-CANDIDATE-READER-CORE`, `LIFE-01-SOURCE-REVISION-FRESHNESS-TARGET-READER-CORE`, `LIFE-01-FRESHNESS-DUE-RUN-TRACE-CORE`, `DATA-01`, and ADR-038/039/043/045/046/047.

## Objective

Add a private one-row keyset checkpoint and stable scheduled-slot run identity for future source-revision freshness processing. Bind each opened run to the cursor it started with, allow exactly one page checkpoint compare-and-set, and finalize an auditable existing live trace using a closed count-only summary. Keep all raw cursor access behind fixed-purpose SQL functions granted only to `waspada_l4_freshness_writer`.

## Required behavior

1. Process state is live-only. The checkpoint starts at a null cursor, stores one exact candidate continuation cursor after a fully completed page, and resets to null when a complete page has no continuation. Do not add a loop or runtime handler.
2. `begin` accepts only a bounded trace ID and explicit finite RFC3339 start time. On first begin, atomically create the exact live `traces` row and an immutable private input-cursor snapshot copied from the checkpoint. Return only a fixed status and that cursor. Exact open or terminal retries return the saved input cursor; changed start time, metadata, dataset, or identity conflicts.
3. The closed cursor schema is exactly `{observationId,eventId,eventVersion,target}` where `target` is either `{kind:"event_claim_set"}` or `{kind:"impact",impactId,impactVersion}`. Validate ID patterns, positive bounded versions, no extra fields, and null cursors. Store no source/report/claim content.
4. `advance` is callable only for an exact open run and its saved input cursor. Compare-and-set the singleton checkpoint from that input to the completed page's next cursor. Return fixed `advanced`, `replayed`, or `conflict` outcomes: an exact already-stored output is an idempotent replay; any other checkpoint state conflicts. Never accept a malformed cursor or move from a non-null cursor backwards to a lower key.
5. `finalize` accepts only `succeeded` or `failed`, exact run identity/time, finite ordered end time, and the exact count keys `candidates`, `invalidatingCandidates`, `selectedTargets`, `duplicateCandidates`, `skippedCandidates`, `written`, `replayed`, and `noChange`. Enforce integer bounds 0–100 and the coordinator count invariants. Store only the fixed trigger plus this count summary in trace metadata. Exact terminal replay succeeds; changed final payload conflicts.
6. Use SECURITY DEFINER functions with fixed `search_path`, revoked PUBLIC access, and EXECUTE granted only to the existing `waspada_l4_freshness_writer`. No new role/membership and no direct application-role SELECT/INSERT/UPDATE/DELETE/TRUNCATE on checkpoint or run-input tables. Source observation table grants must not widen.
7. Keep run input cursors immutable. The mutable singleton cursor is updated only through the compare-and-set function. Protect run/checkpoint state from update/delete/truncate by every application role.
8. Test first begin and exact replay, open-run retry after checkpoint advancement, terminal replay, null reset, one-page advancement, malformed cursor/summary rejection, stale/conflicting concurrent advancement, fixed trace metadata, append-only run input, and least privilege under `SET ROLE` in authored PGlite fixtures.
9. No worker runtime/scheduled wiring, Cron/configuration, `wrangler.toml`, binding, source/provider/model, public projection/API, status policy, deployment, or external service is in scope. Do not alter withdrawn policy. No dependencies or live/retained incident data.

## Allowed paths

- `apps/db/migrations/033_source_revision_freshness_run_state.sql` (new)
- `apps/db/src/source-revision-freshness-run-state.ts` (new)
- `apps/db/test/source-revision-freshness-run-state.test.ts` (new)
- `apps/db/test/migrations.test.ts`
- `apps/db/test/public-event-updates.test.ts` (fixture-order update only, as described below)
- `docs/assignments/LIFE-01-SOURCE-REVISION-FRESHNESS-RUN-STATE-CORE-HANDOFF.md` (new)

Root-authorized narrow fixture exception: `public-event-updates.test.ts` may exclude migration 033 from its pre-ledger historical setup and include migration 033 after 032 in the complete migration-order expectation. Do not change public update behavior or weaken the test.

## Acceptance and verification

- `begin` snapshots one page cursor per stable run ID and exact retry always receives that same page.
- Only a fully completed page advances the checkpoint; a failed/conflicted page leaves it unchanged. Exact CAS replay is safe after a crash between cursor advancement and trace finalization.
- The next scheduled-slot implementation can run one page per slot without starvation, with no direct table grants, no cursor in public data, and count-only trace summaries.
- Run focused source-revision run-state, migration, and update-reader tests; `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD` in WSL Ubuntu-26.04 using existing dependencies only. Record exact Node/npm and relevant package versions and actual results.
- Work only in the assigned branch/worktree from the exact base above. Commit implementation and handoff in coherent descriptive commits. Do not merge or push; root reviews and integrates.

## Stop conditions

Stop and report to root if the fixed existing trace schema cannot express this run without exposing cursor data, if another role needs direct state-table access, if one-page recovery needs a public contract change, or if implementation requires a Cron, binding, source, hosted membership, or other external configuration. Do not solve these by widening scope. Escalate only after a GPT-6 Luna/max attempt documents a substantive unresolved technical blocker.
