# LIFE-01-FRESHNESS-DUE-TARGET-READER-CORE — bounded due freshness candidates

**Status:** Assigned for isolated implementation.  
**Backlog ID:** `LIFE-01-FRESHNESS-DUE-TARGET-READER-CORE`  
**Implementation model:** GPT-6 Luna, max reasoning  
**Branch:** `work/LIFE-01-FRESHNESS-DUE-TARGET-READER-CORE`  
**Worktree:** Root creates a dedicated worktree from the exact local `main` commit named in dispatch.  
**Contract baseline:** Schema 2.0 event/impact records and current `FreshnessStatus`; no public contract change.

## Context and dependencies

Read `AGENTS.md`, `SOFTWARE_DEVELOPMENT_PLAN.md`, `ARCHITECTURE.md`, `docs/DOMAIN_MODEL.md`, `docs/IMPLEMENTATION_BACKLOG.md`, ADR-032, ADR-038, and the accepted freshness transition, ledger, and current-read projection assignments/handoffs before editing.

L4 already has a deterministic one-target transition policy, an append-only recorder, and a current-public overlay. A time-driven caller needs a bounded, least-privilege way to find exact current event claim-set and referenced impact targets whose review deadline or issuer validity can cause a time-only transition. The public event view reports aggregate status, so it must not be used as the prior status for the event claim-set target: read the immutable current event record's grouped claim-set freshness plus its exact ledger transition. Every impact target likewise uses its exact current referenced impact record and exact ledger transition.

Dependencies: `LIFE-01-FRESHNESS-TRANSITION-CORE`, `LIFE-01-FRESHNESS-AGGREGATE-CORE`, `LIFE-01-FRESHNESS-LEDGER-CORE`, `LIFE-01-FRESHNESS-READ-PROJECTION-CORE`, DATA-01, DB test runner isolation, ADR-032 and ADR-038.

## Objective

Add a bounded read-only DB repository that returns only exact-current freshness targets eligible for time-based evaluation at an explicit supplied instant. This task finds candidates; it does not evaluate or write transitions, acquire source data, or schedule itself.

## Required behavior

1. Require an explicit `datasetKind`, canonical RFC3339 `now`, bounded page size (maximum 100), and a validated optional keyset cursor. Keep datasets isolated; never infer one from a public request or scan all namespaces.
2. Select only the latest published event version. If its latest version is withdrawn or otherwise unpublished, return no target for an older event version.
3. Return an event claim-set candidate using the status in that exact immutable event record plus the latest event-claim-set transition for that exact event version. Do not substitute the aggregate status from `public_event_versions`.
4. Return impact candidates only for the exact impact versions referenced by the exact current event version. Use each immutable impact record and its latest transition for the exact `(dataset_kind, event_id, event_version, impact_id, impact_version)` tuple. Ignore unreferenced or superseded impact rows and transitions for prior event versions.
5. Return only targets whose time policy could change status at `now`: issuer validity has ended (`valid_until <= now`) while status is `current` or `needs_update`, or the target is `current` and its review deadline has passed (`review_due_at <= now`). Preserve both timestamps when both have passed so the Layer 4 policy can apply issuer-expiry precedence. Do not return stale targets for evidence recovery; that requires a separate evidence evaluation.
6. Include the current target status, last transition sequence (zero when no transition exists), exact target identity, and only the validity/deadline fields needed for the next Layer 4 call. Do not return raw record JSON, report text, claims, source excerpts, or unrelated fields.
7. Filter due targets before applying the `limit + 1` probe. Use deterministic keyset ordering across event ID/version, target kind, and impact identity. Return at most the requested number and a continuation cursor only when more due targets exist.
8. Use only the existing `waspada_l4_freshness_writer` column grants. Demonstrate its allowed read path, and show that public/L1/L2 roles cannot use this internal repository or read the private freshness ledger.
9. Validate request and result shapes with stable, content-free errors. Do not let malformed timestamps reach unsafe casts or include database errors, source content, cursors, or caller values in errors.

## Allowed paths

- `apps/db/src/freshness-due-target-reader.ts` (new)
- `apps/db/test/freshness-due-target-reader.test.ts` (new)
- `docs/assignments/LIFE-01-FRESHNESS-DUE-TARGET-READER-CORE-HANDOFF.md` (new)

The DB test runner discovers `*.test.ts` automatically. Do not change migrations, grants, stored data, record/API/OpenAPI/DTO contracts, Worker runtime, scheduler/Cron configuration, source adapters, providers, model calls, outbox behavior, dependencies, or deployment configuration. Stop and ask root if the current L4 column grants are insufficient; do not broaden them in this task.

## Acceptance and verification

- PGlite tests cover exact event and impact status fallback/transition selection, sequence selection, old event-version exclusion, latest-withdrawn hiding, exact impact references, both due boundaries (before/equal/after), expiry precedence inputs, dataset isolation, filtering before page limits, stable cursor continuation, and redacted malformed inputs.
- Tests prove event claim-set status is read independently from the event aggregate, and returned fields contain no source text or complete record JSON.
- Tests execute under the L4 freshness writer capability and prove public/L1/L2 principals lack the needed base/ledger privileges.
- All rows are synthetic fixtures; no source, model, external service, clock, writer, or live database is used. `now` is caller-supplied and deterministic.
- Run in WSL Ubuntu-26.04 with existing dependencies: focused reader test, `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD`. Record actual results and runtime versions; do not install dependencies.
- Commit implementation and handoff separately on the assigned branch. Root reviews and integrates; the agent does not merge or push.

## Stop conditions

Stop and ask root if correct event claim-set status cannot be distinguished from the current public aggregate using existing rows, if the existing L4 column grants cannot support the bounded query, or if this repository would need to write, evaluate recovery evidence, contact a source, or change a public contract. Do not add a scheduler or ambient clock.
