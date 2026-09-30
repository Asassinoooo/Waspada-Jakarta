# LIFE-01-FRESHNESS-TRANSITION-CORE — deterministic item freshness policy

**Parent package:** LIFE-01, FR-11/13  
**Status:** Assigned for a bounded local implementation  
**Implementation model:** GPT-6 Luna, max reasoning  
**Branch:** `work/LIFE-01-FRESHNESS-TRANSITION-CORE`  
**Worktree:** `C:\Users\perry\.codex\worktrees\l3-coordinator-core\RPL` (`/mnt/c/Users/perry/.codex/worktrees/l3-coordinator-core/RPL` in WSL); reuse only after confirming the prior task left it clean  
**Base:** Exact `main` commit supplied in the root dispatch after this assignment is committed  
**Contract baseline:** Schema 2.0 event/impact `freshness` and `validity`; `FreshnessStatus`; accepted [ADR-032](../decisions/ADR-032-review-deadline-freshness.md). Do not change contract versions or public DTOs.

## Context and constraints

The user selected `needs_update` when `review_due_at` passes without newer applicable evidence and reserved `expired` for the issuing source's explicit validity end. The current ADR leaves the event-level aggregate of claim and impact freshness open. This task implements a pure policy for one event or impact record, without choosing that aggregate.

Layer 4 owns the deterministic decision. The function is not a scheduler, database writer, publication endpoint, or complete runtime transition workflow. Do not infer event resolution, cancellation, current physical safety, evidence support, or freshness from a fetch, HTTP 304, source-page rebuild, event time, or elapsed age alone.

## Dependencies

- LIFE-01 and accepted ADR-032.
- Existing `FreshnessStatus` and schema 2.0 event/impact freshness fields.
- Existing Worker test command explicitly lists files; register a new test file there if the test is not placed in an already-run file.

## Objective

Add a deterministic, typed Layer 4 policy function that decides the freshness state of one event or impact record from its prior freshness state, explicit issuer validity end, review deadline, current evaluation time, and whether newer applicable evidence has completed Layer 4 evaluation.

## Required policy

1. Treat time inputs as explicit RFC3339 instants and validate them before comparison. Use the instant boundary `now >= valid_until` for issuer expiry and `now >= review_due_at` for a missed deadline.
2. Check explicit issuer validity first. At or after its end, return `expired`, even if a review deadline or new-evidence flag is also present.
3. Without ended issuer validity, a previously `current` record becomes `needs_update` when its non-null review deadline is due and no newer applicable evidence has been evaluated.
4. Preserve existing `needs_update` and `expired` states when no newer applicable evidence has been evaluated. A fetch or unchanged source response must not clear either state.
5. With newer applicable evidence explicitly evaluated by Layer 4 and issuer validity still in force or absent, allow the result to return to `current`. The caller supplies the applicable evidence evaluation and the new deadline; this task does not assess evidence or calculate category-specific deadlines.
6. Return a closed, typed result with a bounded transition reason or equivalent. Reject malformed input with a stable error that does not echo caller values.
7. Operate on exactly one record. Do not aggregate claims or impacts into event freshness. Do not change lifecycle, publication, evidence, or user relevance.

## Allowed paths

- `apps/worker/src/layers/l4-application-integration/freshness-transition-policy.ts`
- `apps/worker/test/l4-freshness-transition-policy.test.ts`
- `apps/worker/package.json` (only to register the focused test in the Worker test command)
- `docs/assignments/LIFE-01-FRESHNESS-TRANSITION-CORE-HANDOFF.md`

Do not change schemas/contracts, migrations, database code, public API/OpenAPI, routes, schedulers, outbox, source adapters, providers, dependencies, configuration, or root planning documents.

## Acceptance and verification

- Tests cover exact deadline equality and immediately-before values, issuer-expiry precedence, current-to-needs-update, sticky stale states without new evidence, recovery after new evidence evaluation while validity is in force, expired retention without new evidence, invalid timestamp/input handling, and absence of lifecycle/publication side effects.
- The function has no ambient clock or I/O and its comparisons are deterministic for supplied inputs.
- Only the allowed paths change; no public contract or runtime caller is added.
- Run in WSL Ubuntu-26.04 with existing dependencies: focused freshness-policy test, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD`. Record exact commands, results, and runtime versions; do not install dependencies or contact external services.

## Stop conditions and handoff

Stop if satisfying these rules needs a public/persisted contract change, event-level freshness aggregation, a scheduler, or a source policy that is not in ADR-032. Ask the primary orchestrator about that boundary and continue no unrelated scope. Do not escalate to another model unless a Luna/max attempt first encounters and documents a substantive unresolved technical failure.

Commit the implementation and handoff on the assigned branch in coherent commits. Do not merge or push. The handoff must give the exact base, branch/worktree, commit SHAs and messages, changed paths, policy behavior, actual checks and versions, limitations, configuration/migration impact, and remaining decisions. Root independently reviews and integrates accepted work.
