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

### Diagnosis report

- **Branch/worktree/base:** `work/DB-TEST-RUNNER-CORE`, `.codex-build/worktrees/db-test-runner-core`, based on clean commit `3b9930a874250f2bcb9e1eabcb2efb5bc17e3c5c`.
- **Changed paths:** `docs/assignments/DB-TEST-RUNNER-CORE.md` only. No runner, test, product, migration, dependency, or lockfile changes were made.
- **Runtime:** WSL Ubuntu-26.04; Node.js `v24.21.0`, npm `11.19.0`.
- **First aggregate reproduction:** Ran `npm run db:test` by itself, without another aggregate test or build running. It exited 0 and reported eight suites/files exactly once: DATA-02-CORE evidence chunks, RAG-CORE retrieval, GEO-STORE-CORE geometry, DATA-01 migrations, DATA-01 persistence, PUB-WRITE-CORE, JOB-01, and L1 synthetic fixture pipeline. Result: **61 tests, 8 suites, 61 passed, 0 failed**.
- **Second aggregate reproduction:** Ran `npm test` by itself after the DB command finished. It exited 0 and reported web **5/5**, Worker **62/62**, database **61/61** across eight suites, and evaluation **12/12**: **140 tests passed**. No test file was skipped or duplicated.
- **Other checks:** `npm run typecheck` passed. `npm run build` passed the Vite production build and Wrangler deploy dry-run. `git diff --check` passed after the handoff edit.
- **Root-cause conclusion:** The historical aggregate exit 1 without a test summary was not reproducible in this clean assigned worktree during either isolated aggregate run. The recorded historical attempts provide no failure summary or other diagnostic evidence from which to establish a root cause. Although the default runner executes DB test files in parallel and each file creates a PGlite instance, the two passing runs do not establish that concurrency caused the earlier exits. No concurrency override or other unsupported workaround was added.
- **Commits:** No implementation fix commit was warranted because no defect or fix was established. Handoff commit: `docs(DB-TEST-RUNNER-CORE): record aggregate verification and non-reproduction` (SHA is reported by the implementer with the branch handoff).
- **Remaining limitation/decision:** Root should decide whether to accept the repeated passing aggregate evidence or provide a reproducible failing environment/log before any runner change is authorized. The earlier exit-1 remains unexplained; it is not reported as fixed.
