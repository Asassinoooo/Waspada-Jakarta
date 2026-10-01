# Handoff: L2-PROPOSAL-REASONING-BRIDGE-CORE

## Assignment and branch

- Branch: work/L2-PROPOSAL-REASONING-BRIDGE-CORE
- Worktree: /mnt/c/Users/perry/.codex/worktrees/l2-proposal-reasoning-bridge/RPL (Windows: C:/Users/perry/.codex/worktrees/l2-proposal-reasoning-bridge/RPL)
- Original assigned base: 8db76941fcfdb5168d709df1a021439cfd0caca5
- Follow-up base: 1a38f6beec2c953e447496b39aea58b93447c5b7
- Implementation commits:
  - 153aba16cbf0e3bb89361635f410333d829dbd30 - feat(L2): bridge reasoning results to private proposals
  - 7b15b89edb6c482fbd435f2fd1d34d1ede98a993 - refactor(L2): reuse shared reasoning output validation
- Review state: implementation and checks are complete; root review and acceptance remain pending.

## Changed paths

- apps/worker/src/layers/l2-model-grounding/reasoning-proposal-bridge.ts
- apps/worker/test/l2-reasoning-proposal-bridge.test.ts
- apps/worker/package.json (test command registration only)
- docs/assignments/L2-PROPOSAL-REASONING-BRIDGE-CORE-HANDOFF.md

## Behavior implemented

The bridge accepts an already-produced capability outcome and grounding context, validates the context against its persisted record, then writes only through the injected EventProposalRepository. It does not retrieve evidence, call a provider, open or advance an investigation, or invoke publication. Non-success capability outcomes return a no-write result.

Successful results are descriptor-safely snapshotted and revalidated through the existing parseReasoningOutput parser. The bridge compares conflicts to the validated context before reparsing, reconstructs only the parser's closed output/usage envelope and model identity, and rejects results if parser validation changes claims, unresolved fields, model metadata, or provider. It preserves claim/reference/time order and support assessment, labels draft claims under_review, and derives sorted unique origin IDs only from exact support-reference context origins. Missing, ambiguous, or non-context origin lineage fails before persistence. Abstentions remain empty-claim drafts with unresolved fields.

Claim IDs are deterministic proposal-local values claim-001 through claim-020 in preserved order because ProposedClaim has no claim ID. Reordering claims under the same proposal ID therefore changes the immutable proposal payload and conflicts on replay. The canonical ModelRun has no provider field, so only capability, model_version, prompt_version, and token fields are persisted.

Caller proposal ID, proposed-at text, target, and optional investigation ID are passed through. Update targets must match the exact context candidate pair. The bridge bounds proposed-at as a string but leaves calendar and canonical timestamp validation to the EventProposalRepository.

## Checks run

Checks ran in WSL Ubuntu-26.04 with Node v24.21.0 and npm 11.19.0. The worktree had no node_modules directory; a temporary symlink to /mnt/d/Projects/RPL/node_modules was used and removed before handoff.

- node --import tsx --test --test-concurrency=1 apps/worker/test/l2-reasoning-proposal-bridge.test.ts - passed, 18/18.
- npm test - passed: web 60/60, Worker 375/375, DB 24/24 test files, eval 12/12.
- npm run typecheck - passed.
- npm run build - passed; Vite 8.3.0 build and Wrangler 4.137.0 dry-run completed. No deployment was performed.
- git diff --check 8db76941fcfdb5168d709df1a021439cfd0caca5..HEAD - passed after the final handoff commit.

An intermediate focused run failed after cleanup removed the generic scalar-string helper; it was restored and the focused suite passed. An intermediate typecheck also identified an unused import, which was removed before the final passing typecheck and build.

## Limitations and impact

No new dependencies, database schema or migration, public API, runtime binding, provider configuration, or publication behavior was added. The existing test command is registered in apps/worker/package.json. Tests use synthetic fixtures and a recording repository fake; they do not establish hosted database behavior or semantic factual support.

A shared-parser precision limitation was confirmed with a direct runtime check: parseReasoningOutput accepts an exact event-time interval with start 2026-10-01T10:00:00.123456Z and end 2026-10-01T10:00:00.123455Z. The parser uses Date.parse for exact/range ordering, so reversed endpoints within the same millisecond can pass. The bridge no longer has a duplicate interval parser; fixing this belongs in a separate bounded task on the shared L2 parser, outside this assignment's allowed paths.

## Remaining decisions

No contract, schema, runtime, or scope change was needed. Root review and acceptance remain outstanding. A separate follow-up is needed to make shared-parser exact and range interval ordering compare full RFC3339 precision.
