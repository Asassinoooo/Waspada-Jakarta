# ADR-051 — L3 advance replay boundary and action-stage timing

- **Status:** Accepted for local implementation
- **Date:** 8 October 2026
- **Owner:** Root planner
- **Requirements:** FR-07; NFR-01/02/05/07
- **Related work:** ADR-014, ADR-017, ADR-029, ADR-031, ADR-049, L3-COORDINATOR-CORE

## Context

One coordinator advance may reserve and reconcile a reasoning stage, then reserve and reconcile a single action stage, refresh L1/L2 context, and record progress. Checkpoint versions change as each durable stage commits. The current coordinator accepts both stage timestamps before planning starts, although the action reservation must be no earlier than the checkpoint produced by planner reconciliation. A timestamp captured at call start can therefore make a valid later action reservation fail the ledger's monotonic checkpoint rule.

Cloudflare Workflows treats each `step.do` as individually retryable and defaults to five retries unless a step supplies its own policy. A retry after a durable L3 stage is not equivalent to restarting from the original checkpoint: the checkpoint may have advanced, an action may have started, or its result references may have been lost. The ledger records reservation state and closed usage, but it has no execution-owner or liveness field that proves the previous handler has stopped.

## Decision

1. Keep the coordinator's stable reservation IDs, but obtain the action reservation timestamp only after the planner returns a validated proposal and its reconciled checkpoint. Require a valid RFC3339 timestamp that is at least the planner checkpoint's `updated_at`. If the clock fails, returns an invalid value, or moves behind that checkpoint, stop before calling the action executor and return a closed review result.
2. Treat an advance that has durably entered a reasoning or action stage as non-replayable from its old input checkpoint. A stale checkpoint fails closed; the coordinator must not repeat a planner or action to recover a lost acknowledgement.
3. Do not recover an in-flight reservation while its prior execution may still be active. A future runtime may recover only after it proves the prior attempt is terminal or fenced. Once that proof exists, `reserved` work may be released only when the corresponding start operation never granted invocation; `started` work is reconciled as timed out at its full reserved budget and the case stops for review. Never call that handler again automatically.
4. If action reconciliation committed but its output references were lost, stop for review. Do not reconstruct a result from guesswork, refresh L1/L2 with unknown outputs, or re-run the action. Transparent continuation requires a separately designed durable result receipt and an action adapter that can query or deduplicate by its stable reservation ID.
5. Keep Workflow event/state/result data identifier-only and limited to closed statuses. Rehydrate evidence through the exact L2 context reference inside an ephemeral step; do not persist `GroundingContext`, excerpts, prompts, proposals, tool inputs, or content-bearing coordinator results. L4 remains the only publication authority.
6. Any future Workflow composition must set an explicit per-stage retry policy and prove its behavior against these rules. Do not inherit the platform's default retry count for an action with uncertain side effects. This decision does not enable a Workflow binding or runtime.

## Consequences

The local implementation can fix action-stage timestamp ordering without changing database or public contracts. It does not add automatic recovery, action receipts, Workflow wiring, migration, grant, or deployment setting. A failed or interrupted partial advance remains review-required until a trusted runtime can establish terminal-attempt fencing. Successful automatic continuation after a lost action result is outside this version.

Cloudflare's current Workflow documentation describes per-step retries and recommends idempotent operations: [retry configuration](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/) and [Workflow rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/). These pages are design references, not evidence that the current repository has a Workflow runtime.

## Rejected alternatives

- **Capture both timestamps at advance start:** rejected because the action timestamp can precede the planner's committed checkpoint.
- **Retry the entire coordinator advance after a partial commit:** rejected because it may repeat an action or lose the identity and output of already committed work.
- **Release any old reservation on restart:** rejected because a started handler may already have produced an external side effect.
- **Store proposal or action output in the investigation ledger:** rejected because ADR-014 restricts the ledger to bounded operational metadata and excludes prompts, model output, and source text.
- **Add an action-result receipt in this task:** deferred because external handlers do not yet accept or expose an idempotency lookup contract, and a receipt alone cannot resolve a side effect that committed before the receipt.
