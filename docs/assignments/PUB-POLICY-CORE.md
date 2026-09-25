# PUB-POLICY-CORE — Deterministic manual publication assessment

- **Status:** Assigned for local synthetic implementation
- **Depends on:** SPEC-02, L2-ADAPTER-01, RAG-CORE
- **Requirements:** FR-08; NFR-01, NFR-05, NFR-07
- **Architecture:** Layer 4 publication-policy kernel
- **Branch/worktree:** `work/PUB-POLICY-CORE-manual-gate`; `.codex-build/worktrees/pub-policy-core`
- **Owner:** GPT-6 Luna Max implementation agent; root plans and reviews

## Objective

Implement a deterministic, fail-closed policy assessment for an explicit moderator-reviewed L2 proposal. It returns per-claim dispositions and reason codes that a later persistence service can consume. This policy slice neither writes event versions nor authenticates moderators; an eventual MOD-01 boundary must supply the actor identity from trusted authorization.

This work is allowed before EVAL-01 because it uses no learned threshold, automatic-publication path, retrieval-quality claim, or factuality claim. Every publication approval in this slice is an explicit moderator action.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md`
- `ARCHITECTURE.md`
- `docs/DOMAIN_MODEL.md`
- `docs/IMPLEMENTATION_BACKLOG.md`
- `docs/assignments/L2-ADAPTER-01.md`
- `docs/assignments/RAG-CORE.md`
- `apps/worker/src/layers/l2-model-grounding/contracts.ts`
- `apps/db/src/evidence-retrieval.ts`
- `docs/contracts.schema.json`

## Scope and required behavior

- Add only `apps/worker/src/layers/l4-application-integration/publication-policy.ts`, `apps/worker/test/l4-publication-policy.test.ts`, the test script entry in `apps/worker/package.json`, and this assignment's implementation handoff.
- Define typed inputs for a validated `GroundingContext`, `ReasoningResult`, matching RAG-CORE evidence candidates, current event-version snapshot, and explicit moderator decision. Preserve dataset, source/revision states, evidence relations and geometry links. Since `ProposedClaim` has no ID, identify output dispositions by zero-based `claimIndex` within this proposal; do not add an ID to the L2 contract.
- Require an explicit moderator `approve`, `hold`, or `reject` action with a bounded actor ID, decision time, reason, and trusted-caller authorization result. Missing or unauthorized review always holds a proposal; model output, confidence, or `GroundingContext.sufficient` alone never authorizes publication. The function does not authenticate an actor; it accepts only an authorization result supplied by a trusted L4 caller.
- An approval can pass only for a proposed, non-empty set of claims whose support assessment is `supported`, whose support references exactly match same-dataset references in both the grounding context and current RAG retrieval, and whose stored evidence relation is `supports`. Match on dataset plus revision ID, permitted-text hash, span start/end, offset unit, and relation; the RAG candidate must also carry its exact evidence-reference ID. Require the referenced revision to be `eligible` and the source approval state to be `approved`. Uncertain or disputed claims remain held. Contradictory/context references remain separate in the decision output and cannot satisfy the support requirement.
- Require current L4 evidence-state input for each supporting reference: source-remit state must be `in_scope`, and freshness must be `current`. Missing, out-of-scope, needs-update, or expired state holds the affected claim. Do not infer freshness from retrieval time, source health, registry lifecycle, or model output.
- Require every proposed geometry ID to be linked to source geometry on cited support evidence. Never derive, buffer, geocode, or expand a geometry in the policy kernel.
- Model event targeting explicitly as either a new event with no current target, or an update with an event ID and base version. For updates, compare that pair to the current event snapshot; any mismatch holds the proposal with a stable stale-version reason. The function must not select a newer version or rebase it. It does not resolve possible duplicate events for a new-event target.
- Reject or hold abstentions, unresolved required fields, empty proposals, cross-dataset references, missing support, mismatched hashes/offsets/relations, ineligible revisions, and unapproved sources. Return deterministic per-claim dispositions and bounded reason codes; do not return a confidence or truth score. Registry lifecycle and source-health fields are informational only and must never substitute for explicit remit/freshness or approval inputs.
- Keep all decisions pure and repeatable for identical inputs. Do not write database records, publish events, expose routes, implement login/session handling, modify database roles/migrations, configure a model/source, or set auto-publication rules.

## Allowed paths

- `apps/worker/src/layers/l4-application-integration/publication-policy.ts`
- `apps/worker/test/l4-publication-policy.test.ts`
- `apps/worker/package.json` — only to include the new test in the workspace test command
- This assignment's implementation handoff only

Root owns architecture, backlog, and other planning documents. If the current contracts do not contain enough identity to join a proposal citation to an exact retrieval reference, report the precise gap and propose the narrowest root decision before changing a contract.

## Acceptance and checks

- Tests prove that explicit reviewed support is required, current evidence/revision/source gates are deterministic, and no automatic or model-only path can produce a publish disposition.
- Tests retain contradictions, enforce geometry provenance and event-version concurrency, hold unknown freshness/remit, reject cross-dataset or mismatched evidence, and prove stable reason codes/order.
- No test label or result is presented as factual or retrieval-quality ground truth. No database, HTTP route, auth, source or model integration is introduced.
- In WSL Ubuntu-26.04 run `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`. No smoke test is needed because this is a pure policy module.
- Commit all work on the task branch with descriptive messages, leave a clean worktree, and append actual changes, checks, limitations and unresolved decisions. Do not push or merge.

## Implementation handoff

The implementation agent appends its branch/worktree, commit SHAs/messages, changed paths, behavior, actual checks, limitations, and any scope issue here. Root reviews and accepts the task before integration.
