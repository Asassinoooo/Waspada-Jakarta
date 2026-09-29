# L3-COORDINATOR-CORE — compose one bounded investigation advance

**Parent package:** AGENT-01 / FR-07 bounded investigation  
**Status:** Ready for implementation on the dedicated task branch
**Implementation model:** GPT-6 Luna, max reasoning  
**Branch:** `work/L3-COORDINATOR-CORE`  
**Worktree:** Dedicated managed worktree from the pinned base below; do not edit in the root checkout.
**Base:** `40e94100753a96eabdd908a5a76d6ab8ffd7d188` (root acceptance, ADR-031 and task assignment)
**Contract baseline:** schema 2.0 `GroundingContext`/investigation records; internal investigation plan 1.0; existing L3 ledger port and executors. Do not change public schemas, OpenAPI, or provider/runtime configuration.  
**Dependencies:** `L3-LEDGER-CORE`, `L3-INSUFFICIENT-CONTEXT-ENTRY-CORE`, `L3-SINGLE-STEP-EXECUTOR-CORE`, `L3-REASONING-STEP-CORE`, `L3-PROGRESS-FINGERPRINT-CORE`, `L2-INVESTIGATION-PLAN-CORE`, `RAG-CONTEXT-ASSEMBLY-CORE`, `L2-CONTEXT-PERSIST-CORE`, `DB-TEST-RUNNER-ISOLATION`; [ADR-031](../decisions/ADR-031-l3-bounded-coordinator-advance.md).  

## Objective

Replace the placeholder coordinator contract with a typed, stateless L3 coordinator that composes the accepted case-entry, budgeted-planning, registered-action, ledger, progress-fingerprint, and injected context-refresh boundaries. One call advances one durable step and returns a checkpointed continuation or a closed stop outcome. Do not build a loop or runtime binding.

## Allowed paths

- `apps/worker/src/layers/l3-investigation/`
- Focused Worker tests under `apps/worker/test/`
- `apps/db/test/investigation-ledger.test.ts` only for the real-repository/PGlite composition case
- `docs/assignments/L3-COORDINATOR-CORE-HANDOFF.md`

Do not edit the root-owned SDP, architecture, backlog, ADR, checkpoint, delivery log, public/internal schemas, OpenAPI, migrations, DB production repository, UI, provider/source registrations, deployment config, Workflow bindings, secrets, package dependencies, lockfiles, scripts, or unrelated tests. If correct composition requires one of these, describe the gap and ask root before expanding scope; continue independent work in allowed paths.

## Required behavior

1. Accept only an already validated persisted insufficient-context handoff for case creation. Delegate opening/replay to `InsufficientContextEntryService`; reject sufficient, ambiguous, malformed, stale, cross-dataset, or cross-candidate input without a planner or action call.
2. For each advance, derive question labels from the current validated context, use a trusted bounded action menu, and delegate one proposal call to `ReasoningStepExecutor`. A proposal is data only. Delegate any selected action to `SingleStepExecutor`; do not duplicate its registration, input, idempotency, fingerprint, reservation, timeout, or ledger checks.
3. Perform no more than one planning call, one action execution, and one context refresh per invocation. Do not sleep, retry, fan out, or continue the investigation in an internal loop. A replayed, denied, uncertain, or review-required executor result cannot trigger another action.
4. After a reconciled action, call one injected refresh port. Its contract must require new source material to return through L1 ingestion/cleaning/extraction and L2 persistence/retrieval/grounding; the coordinator itself must never process report content. Validate that refreshed context retains the exact dataset, trace, candidate and event identity before recording progress through `recordGroundingProgress`.
5. Return `sufficient_context` with the refreshed context for a caller-owned L2 synthesis path when the refreshed context is sufficient. Return `continue` with the latest checkpoint and insufficient context when the digest changed and the case remains open, or after the first unchanged refresh when one no-progress allowance remains. Return `review_required` on the second consecutive no-progress snapshot, exact duplicate action, planner abstention, exhausted budget, timeout/uncertain result, material dispute, or invalid/stale context. Never create or publish an event.
6. Use the durable ledger for all budget and stop state; do not keep counters or continuation state only in memory. Replaying the same reservation must not call a planner or handler twice. Preserve the 5-tool / 4-reasoning / 60-second / 12,000-token caps and the per-case limits.
7. Emit only fixed, bounded outcome telemetry if an existing no-op-default sink is used. Do not log source text, prompts, model output, action inputs, URLs, keys, conflict prose, or exception details.

## Acceptance criteria

- Focused tests cover sufficient-context bypass, initial entry/replay, exactly-one planning/action/refresh bounds, question-label derivation from refreshed context, safe continuation on changed progress, one bounded continuation after the first unchanged refresh, review after the second consecutive unchanged refresh, sufficient handoff, duplicate-action stop before extra budget use, planner abstention, budget exhaustion, timeout/uncertain action, stale/cross-case context rejection, and replay with no second provider/tool call.
- A real-repository PGlite composition test proves checkpoint/budget persistence across an advance and verifies refreshed source results are handed through the injected L1/L2 port before the progress digest is recorded.
- Tests prove the coordinator never grants publication authority and never persists raw action inputs, source text, planner output, or error details.
- No public contract, database migration/repository production code, dependency, source, provider, route, secret, deployment setting, or Workflow binding changes.
- WSL Ubuntu-26.04 verification passes: focused coordinator tests; `npm run db:test`; `npm test`; `npm run typecheck`; `npm run build`; and `git diff --check <assigned-base>..HEAD`.

## Stop conditions and handoff

Do not enable live sources/providers, configure keys or Workflows, add a scheduler/runtime, publish, add moderator writes, alter public contracts, or exceed the allowed paths. If a required invariant cannot be enforced using the accepted L3 ports, stop before weakening it and give root the exact failing case.

Commit all task work to this branch in coherent descriptive commits. Do not merge, push, or edit root-owned planning files. Handoff with the exact branch/worktree, base and commit SHA(s) plus messages, changed paths, behavior, WSL commands/results and runtime versions, limitations, migration/configuration impact, and remaining decisions. Root owns review, acceptance, integration and final status.
