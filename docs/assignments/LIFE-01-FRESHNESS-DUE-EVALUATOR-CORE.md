# LIFE-01-FRESHNESS-DUE-EVALUATOR-CORE — bounded Layer 4 due-page evaluation

**Status:** Assigned for isolated implementation.  
**Backlog ID:** `LIFE-01-FRESHNESS-DUE-EVALUATOR-CORE`  
**Implementation model:** GPT-6 Luna, max reasoning  
**Branch:** `work/LIFE-01-FRESHNESS-DUE-EVALUATOR-CORE`  
**Worktree:** `/mnt/c/Users/perry/.codex/worktrees/life-01-freshness-due-evaluator-core/RPL`  
**Assigned base:** Exact local `main` SHA supplied in the root dispatch after this assignment is committed.  
**Contract baseline:** Current internal freshness reader and recorder ports, Schema 2.0 event/impact records, ADR-032/038; no public API/DTO/OpenAPI change.

## Context and dependencies

The deterministic Layer 4 item policy, append-only exact-version recorder, current-public status projection, and explicit-time due-target reader are accepted. The reader returns at most 100 exact-current event claim-set or referenced-impact targets with each target's own effective status, transition sequence, and validity/review deadlines. The recorder persists one deterministic transition at a time. This slice composes those existing capabilities without adding a clock, source lookup, cron handler, or runtime binding.

Dependencies: `LIFE-01-FRESHNESS-TRANSITION-CORE`, `LIFE-01-FRESHNESS-LEDGER-CORE`, `LIFE-01-FRESHNESS-DUE-TARGET-READER-CORE`, ADR-032/038, and the existing WSL test workflow.

## Objective

Add a bounded Layer 4 service that reads one explicit-time due-target page and applies the existing freshness policy/recorder to those exact targets. The service is callable with injected reader and recorder ports; it does not instantiate database connections or schedule itself.

## Required behavior

1. Validate a closed request containing an explicit dataset, RFC3339 `now`, limit from 1–100, optional keyset cursor, an existing `traceId` for that dataset, and an `evaluationRunId` that the caller reuses when retrying the same page.
2. Call the due-target reader exactly once per invocation. Process only that bounded page, serially, and return the reader's continuation cursor only after every candidate was handled.
3. For each target, call the existing recorder with its exact identity and effective status; set expected sequence to `transitionSequence + 1`; pass through the same explicit `now` and exact validity/review times; set `newApplicableEvidenceEvaluated: false` and `evidenceReferenceIds: []`. Never use the public event aggregate for the claim-set.
4. Derive a stable, bounded ledger idempotency key from the caller's run ID plus the full dataset/event/version/target/sequence identity. Use built-in Web Crypto or another existing runtime primitive; add no dependency. Same-page retries with the same run ID and target identity must reuse the same key.
5. Continue on `written`, `replayed`, or `no_change`. On the first recorder conflict or port failure, stop processing and return a content-free retry result whose resume cursor is the original request cursor. Do not advance past any unhandled target. Do not run an internal retry loop.
6. Keep results internal and minimal: aggregate counts and the next/resume cursor only; no event text, evidence, source excerpts, or sensitive database details. Do not log target identities or request contents.
7. Recovery remains out of scope: this evaluator must never claim that new evidence was evaluated or supply evidence references. It also does not acquire sources, write publication/event data, change public APIs, configure scheduling, or invoke model providers.

## Allowed paths

- `apps/worker/src/layers/l4-application-integration/freshness-due-evaluator.ts` (new)
- `apps/worker/test/l4-freshness-due-evaluator.test.ts` (new)
- `apps/worker/package.json` (register the focused test)
- `docs/assignments/LIFE-01-FRESHNESS-DUE-EVALUATOR-CORE-HANDOFF.md` (new)

Do not modify database migrations/grants, the accepted reader or ledger implementation, public contracts/routes/UI, source adapters, model providers, scheduler/Cron configuration, secrets, dependencies, or deployment configuration. Stop and ask root if the existing reader or recorder cannot support the composition without broadening a capability or changing a contract.

## Acceptance and verification

- Unit tests prove one read per invocation, page-size enforcement, serial bounded processing, correct target/sequence/status/time mapping, no recovery evidence, stable idempotency keys, returned cursor only after full success, retry from the original cursor after a conflict, and redacted errors.
- Tests use deterministic fakes; no network, wall clock, external source, model, live database, or scheduler is invoked.
- Run in WSL Ubuntu-26.04 with existing dependencies: focused evaluator tests, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD`. Record actual results and runtime versions; do not install dependencies.
- Implement and hand off in separate descriptive commits on the assigned branch. Root reviews and integrates; the implementer does not merge or push.

## Stop conditions

Stop and ask root if a public contract change, permission expansion, new evidence/recovery behavior, unbounded loop, dependency, runtime database composition, external source, or scheduled trigger is required. No model escalation is authorized unless Luna/max attempts and documents a substantive unresolved technical problem.
