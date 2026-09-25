# DB-TEST-RUNNER-CORE — Reliable aggregate DB test execution

**Status:** Assigned for diagnosis and bounded repair.

## Objective

Reproduce and diagnose why the WSL aggregate database test command exits with code 1 without a test failure summary, even though all eight database test files pass when run individually. Fix the smallest test-runner or test-harness cause so aggregate verification is reliable and reports failures clearly. Do not change product behavior or weaken coverage.

## Read first

- [SOFTWARE_DEVELOPMENT_PLAN.md](../../SOFTWARE_DEVELOPMENT_PLAN.md), [IMPLEMENTATION_BACKLOG.md](../IMPLEMENTATION_BACKLOG.md), and [CURRENT_CHECKPOINT.md](../CURRENT_CHECKPOINT.md)
- Root `package.json`, `apps/db/package.json`, `apps/db/test/harness.ts`, and all `apps/db/test/*.test.ts`
- [L1-FIXTURE-PIPE-CORE](L1-FIXTURE-PIPE-CORE.md) and [DATA-01](DATA-01.md) for the current PGlite test boundaries

Root observations to reproduce: `npm run db:test` exited 1 without a summary; `npm test` passed the web and Worker suites, then the DB runner exited 1 after its first suite without a failure summary. All eight DB test files passed individually, including the new synthetic pipeline PGlite test. Do not assume the cause is concurrency or WSL resource pressure without evidence.

## Constraints and allowed paths

- Keep all work local and test-infrastructure-only. No source/data rights, model, provider, cloud account, service, credential, or network access is needed.
- Do not remove, skip, weaken, duplicate, or conditionally hide tests to make the aggregate command pass. Preserve each test file's assertions and ensure every `*.test.ts` file is discovered exactly once.
- Do not change production code under `apps/db/src`, Worker code, migrations, API contracts, dependency versions, or the lockfile.
- Allowed paths:
  - `apps/db/package.json` for a root-cause-supported test-script adjustment only
  - `apps/db/test/**` for test-runner setup, cleanup, or harness fixes only; keep existing assertions intact
  - this assignment's implementation handoff
- No new dependencies.
- Branch: `work/DB-TEST-RUNNER-CORE`; worktree: `.codex-build/worktrees/db-test-runner-core`.

## Acceptance

1. Record a minimal reproduction and evidence for the root cause, including the runtime versions and exact command.
2. `npm run db:test` succeeds in WSL Ubuntu-26.04 and visibly reports every database test file and its results.
3. `npm test` succeeds from the repository root and reports the web, Worker, database, and evaluation suites; no test is omitted.
4. `npm run typecheck`, `npm run build`, and `git diff --check` pass in WSL using native Linux Node.js `v24.21.0` and npm `11.19.0`.
5. No product runtime, schema, migration, dependency, or API behavior changes.
6. Commit the fix and the handoff separately on the assigned branch; leave a clean worktree and report exact files, commands, test counts, cause, and limitations. Do not push or merge.

Run one aggregate test command at a time. Do not run PGlite suites concurrently with another aggregate suite or a build. If the cause cannot be repaired within the allowed paths, stop with a precise reproduction and the smallest required root decision.

## Handoff

The implementation agent records its branch and worktree, commits and messages, changed paths, root-cause evidence, exact checks and counts, and any remaining limitation here. Root reviews and integrates only after the aggregate checks pass.
