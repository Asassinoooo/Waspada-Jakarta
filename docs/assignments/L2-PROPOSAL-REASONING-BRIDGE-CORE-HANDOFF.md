# Handoff: L2-PROPOSAL-REASONING-BRIDGE-CORE

## Assignment and branch

- Branch: work/L2-PROPOSAL-REASONING-BRIDGE-CORE
- Worktree: /mnt/c/Users/perry/.codex/worktrees/l2-proposal-reasoning-bridge/RPL (Windows: C:/Users/perry/.codex/worktrees/l2-proposal-reasoning-bridge/RPL)
- Assigned base: 8db76941fcfdb5168d709df1a021439cfd0caca5
- Implementation commit: 153aba16cbf0e3bb89361635f410333d829dbd30
- Implementation commit message: feat(L2): bridge reasoning results to private proposals
- Review state: implementation and checks are complete; root review and acceptance remain pending.

## Changed paths

- apps/worker/src/layers/l2-model-grounding/reasoning-proposal-bridge.ts
- apps/worker/test/l2-reasoning-proposal-bridge.test.ts
- apps/worker/package.json (test command registration only)
- docs/assignments/L2-PROPOSAL-REASONING-BRIDGE-CORE-HANDOFF.md

## Behavior implemented

The bridge accepts an already-produced capability outcome and its grounding context, validates the runtime shapes and exact match with the persisted context record, then writes only through the injected EventProposalRepository. It does not retrieve evidence, call a provider, open or advance an investigation, or invoke publication.

Non-success capability outcomes return a no-write result. Successful results preserve claim, evidence-reference, and time-precision ordering; map support assessment as data; label every draft claim under_review; and pass through proposal ID, proposed-at time, target, and optional investigation ID. Update targets must match the context's exact candidate pair. Abstentions are persisted as empty-claim drafts with unresolved fields.

Claim IDs are deterministic proposal-local values claim-001 through claim-020 in preserved order because ProposedClaim has no claim ID. Reordering claims under the same proposal ID therefore changes the immutable proposal payload and conflicts on replay. Origin IDs are derived only from exact context-origin metadata for support references, then sorted and deduplicated. Missing, ambiguous, or non-context lineage fails closed before repository access. The canonical ModelRun has no provider field, so the bridge maps capability, model_version, prompt_version, and token fields and does not encode ReasoningResult.provider elsewhere.

The bridge validates untrusted objects without invoking getters, checks calendar dates, time precision and validity intervals before persistence, and returns typed content-free errors. Unexpected repository errors are wrapped without echoing claim or source text; typed repository errors are preserved.

## Checks run

All project checks ran in WSL Ubuntu-26.04 with Node v24.21.0 and npm 11.19.0, using the existing dependency installation. The worktree initially had no node_modules directory; a temporary symlink to /mnt/d/Projects/RPL/node_modules was used and removed before handoff.

- node --import tsx --test --test-concurrency=1 apps/worker/test/l2-reasoning-proposal-bridge.test.ts - passed, 18/18.
- npm test - passed: web 60/60, Worker 375/375, DB 24/24 test files, eval 12/12.
- npm run typecheck - passed.
- npm run build - passed; Vite 8.3.0 build and Wrangler 4.137.0 dry-run completed. No deployment was performed.
- git diff --check 8db76941fcfdb5168d709df1a021439cfd0caca5..HEAD - run after both commits; passed.

## Limitations and impact

No new dependencies, database schema or migration, public API, runtime binding, provider configuration, or publication behavior was added. The existing test command is registered in apps/worker/package.json.

Tests use authored synthetic fixtures and a recording repository fake; they do not establish Neon or hosted database behavior. The repository remains responsible for persisted investigation/checkpoint lineage checks. The bridge preserves model assessments as data and does not validate semantic factual support, source rights, independence, or publication eligibility. No provider calls or publication side effects occur in this slice.

## Remaining decisions

No contract, schema, runtime, or scope change was needed. Root clarification on order-derived proposal-local claim IDs and omission of provider from the closed ModelRun shape is reflected above. Root review and acceptance remain outstanding.
