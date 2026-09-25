# DB-TEST-RUNNER-ISOLATION — Deterministic aggregate database tests

**Status:** Assigned for local runner diagnosis and repair.
**Depends on:** DB-TEST-RUNNER-CORE, L3-LEDGER-CORE.
**Requirements:** NFR-08.
**Branch/worktree:** `work/DB-TEST-RUNNER-ISOLATION`; `.codex-build/worktrees/db-test-runner-isolation`.

## Objective

Make the database test command reliable in WSL without suppressing tests or masking failures. A recent local run showed a repeatable aggregate problem: all nine DB test files pass individually (68 tests), but `npm run db:test` and the full-workspace `npm test` exit 1 without DB assertion diagnostics. A one-worker Node test-runner attempt also ended without a final summary after migrations passed. The earlier DB-TEST-RUNNER-CORE investigation passed aggregates before the L3 suite was added and did not explain this new failure.

First verify the current result on this branch. If the built-in aggregate test runner continues to fail while each file passes in a separate process, implement a deterministic sequential runner that launches every discovered `*.test.ts` file in its own Node/tsx process. Preserve stdout/stderr, continue collecting results, and return non-zero if any child fails or is interrupted. Use the built-in `node:child_process`; no dependency is needed.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md` Sections 8–10
- `docs/IMPLEMENTATION_BACKLOG.md`
- `docs/assignments/DB-TEST-RUNNER-CORE.md` and its handoff
- `apps/db/package.json`, `apps/db/test/harness.ts`, and the nine current DB test files
- This assignment and the latest `docs/DELIVERY_LOG.md` evidence

## Allowed paths

- `apps/db/package.json` — database test script only
- `apps/db/test/run-db-tests.ts` — new local test launcher, if needed
- `docs/assignments/DB-TEST-RUNNER-ISOLATION-HANDOFF.md` — implementation handoff only

Do not change tests, database migrations, application behavior, the root lockfile, dependencies, Worker/web scripts, CI, or deployment settings. Do not skip or filter any test. Stop and report the smallest root decision if a passing aggregate cannot be achieved within these paths.

## Acceptance and verification

- Confirm and record Node.js `v24.21.0` and npm `11.19.0` in WSL Ubuntu-26.04.
- Discover and execute every DB `*.test.ts` file exactly once, in stable order. Preserve each child's output and failure status. Missing files, spawn errors, signals, and non-zero exits must fail the aggregate.
- Run sequentially in WSL: `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`. All must pass; the full suite must report each test file exactly once.
- No new dependencies or lockfile changes; all current tests remain intact.
- Commit any runner change and this handoff separately on the assigned branch. Leave a clean worktree and report exact commands/counts, files, actual failure diagnosis, and limitations.

## Stop/escalation

Do not reduce coverage or hide an interruption to make the aggregate pass. If a runner failure remains unexplained, capture exact output and stop; do not claim the issue was fixed. Escalate to GPT-6 Astra xhigh only after a substantive GPT-6 Luna max attempt fails, not because an environment run was interrupted.
