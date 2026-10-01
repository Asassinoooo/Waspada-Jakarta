# RAG-GROUNDED-PROPOSAL-ROUNDTRIP-CORE handoff

**Status:** Implementation complete; root review and integration pending

**Assigned base:** `3f51bb6c71279d4b264b186718a353ca84d5608b`

**Branch:** `work/RAG-GROUNDED-PROPOSAL-ROUNDTRIP-CORE`

**Worktree:** `C:\Users\perry\.codex\worktrees\rag-grounded-proposal-roundtrip-core\RPL` (`/mnt/c/Users/perry/.codex/worktrees/rag-grounded-proposal-roundtrip-core/RPL` in WSL)

## Changes

The test-only PGlite composition seeds an authored synthetic source, eligible report revision, exact evidence reference and origin, plus a deterministic two-dimensional embedding. The existing retrieval repository is called under the L2 reader role with eligible/active/approved filters. The test checks the persisted identity, source and revision status, origin lineage, source timestamps, event time, embedding identity and semantic match, then rehydrates the selected Unicode code-point span from the persisted report.

The direct reasoning service persists its refs-only grounding context under the L2 grounding writer role. At the fixed in-process reasoning double's call boundary, the test reads the committed context row, verifies that the quoted span is absent, and checks that the double received the same typed context assembled from retrieval. The result carries an authored conflict and an `uncertain` model support assessment; the canonical proposal's `under_review` evidence label remains a separate field. The bridge persists exact evidence and origin lineage, the original event-time string, and schema 2.0 model version, prompt version and token metadata. An exact replay leaves proposal, claim, evidence-link and origin-link row counts unchanged.

The test also compares event-version, publication-decision, publication-outbox, audit and moderator-history-review counts before and after draft creation and replay. A separate insufficient-context case verifies that its refs-only context is persisted, reasoning is never invoked, and no proposal or protected write is added.

Only these assigned paths changed:

- `apps/db/test/rag-grounded-proposal-roundtrip.test.ts`
- `docs/assignments/RAG-GROUNDED-PROPOSAL-ROUNDTRIP-CORE-HANDOFF.md`

Implementation commit: `e39f21cb03c1a40c2d6f2c20c6b6dd36244fefb4` — `test(RAG-GROUNDED-PROPOSAL-ROUNDTRIP-CORE): cover grounded private draft path`.

## Verification

Checks ran in WSL Ubuntu-26.04 using Node.js `v24.21.0`, npm `11.19.0`, and the existing lockfile installation. Relevant locked test packages were PGlite `0.5.8`, PGlite pgvector `0.0.9`, PGlite PostGIS `0.2.8`, and tsx `4.23.15`; no dependency was installed or changed.

- Focused test: `node --import tsx --test apps/db/test/rag-grounded-proposal-roundtrip.test.ts` — passed, 2/2.
- Full `npm test` — passed: web 60/60, Worker 377/377, DB 25/25 files (205 tests), evaluation casebook 12/12.
- `npm run typecheck` — passed for web, Worker, DB and evaluation.
- `npm run build` — passed; Vite production build completed and Wrangler used `deploy --dry-run` only.
- `git diff --check 3f51bb6c71279d4b264b186718a353ca84d5608b..HEAD` — passed with no whitespace errors.

The temporary `node_modules` symlink used to expose the existing dependency installation inside the assigned worktree was removed before handoff.

## Limits and remaining work

The fixtures and reasoning result are authored synthetic data, and the capability is a deterministic local test double. These checks establish local PGlite composition only; they do not establish factual support, model quality, source rights, hosted Neon behavior, independent-session concurrency or provider/runtime integration. No schema, migration, API, contract, role, dependency or configuration changed. No publication, moderator, provider, network or live-source path was invoked. No decision remains within this test-only assignment; root acceptance and integration are pending.
