# DB-TEST-RUNNER-ISOLATION — implementation handoff

**Status:** Implementation complete on the task branch; root review pending.

## Branch and commits

- Branch/worktree: `work/DB-TEST-RUNNER-ISOLATION`, `.codex-build/worktrees/db-test-runner-isolation`.
- Base: `8184cac9fa4e2ace6fa61bb2ebaaa0965065ea80`.
- Implementation: `cac88f9eadf0c8bb4d2ce0e1898dda916d24bd4e` — `fix(DB-TEST-RUNNER-ISOLATION): run database tests sequentially`.
- This handoff is committed separately after the implementation.

## Change

`apps/db/package.json` now runs `tsx test/run-db-tests.ts`. The launcher discovers all `*.test.ts` files in stable lexical order, checks each path, and starts one native Node process per file with `--import tsx --test`. It inherits stdout/stderr, records every result, continues after failed, signaled, or spawn-error children, and exits non-zero if any file fails. If the launcher receives SIGINT or SIGTERM, it cancels the active child, starts no remaining children, records those files as not run, and exits non-zero.

Changed implementation paths are limited to `apps/db/package.json` and the new `apps/db/test/run-db-tests.ts`. No assertions, tests, migrations, dependencies, lockfiles, or product behavior changed. The database `test` script is the only configuration impact.

## Diagnosis and checks

Verification used WSL Ubuntu-26.04 with native Node.js `v24.21.0` and npm `11.19.0`, through the existing documented runtime at `/home/perry/.local/opt/waspada-node-v24.21.0/bin`. Its Node binary SHA-256 is `7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c`.

Before the change, `npm run db:test` exited 1 after 29.45 seconds with no test output or assertion diagnostics; it reached the `tsx --test test/*.test.ts` command. Each of the nine DB files passed in a separate process for 68 passing tests total. One additional isolated `migrations.test.ts` attempt exited 1 without output; an immediate retry passed 8/8. The internal cause of the aggregate exit and the one silent migrations exit was not established.

After the change, the assigned checks ran sequentially:

- `npm run db:test` — passed; 9/9 files, 68/68 tests, each file reported once.
- `npm test` — passed; web 5/5, Worker 62/62, DB 68/68, evaluation 12/12 (147 total).
- `npm run typecheck` — passed for web, Worker, DB, and evaluation.
- `npm run build` — passed; Vite production build and Wrangler deploy dry-run completed.
- `git diff --check` — passed in WSL. The Windows-created worktree’s `.git` pointer uses a Windows path, so WSL Git required explicit `--git-dir=/mnt/d/Projects/RPL/.git/worktrees/db-test-runner-isolation` and `--work-tree=/mnt/d/Projects/RPL/.codex-build/worktrees/db-test-runner-isolation` arguments. The staged `git diff --cached --check` also passed for the implementation files.

An initial launcher check found and fixed a path-resolution error: the first draft passed basenames while the child ran from the DB package root. The final launcher passes each discovered absolute path; both final aggregate test commands above passed with that version.

## Environment note and limitation

Before finding the existing runtime path in `docs/BOOTSTRAP.md`, Node.js `v24.21.0` was also installed through WSL-local nvm. That installation changed only `/home/perry/.nvm`, not the repository. Nvm reported a matching checksum for its cached Node archive, whose SHA-256 is `fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6`; its binary hash matches the existing documented runtime. All project checks used the pre-existing documented runtime path.

The isolated migrations exit remains unexplained. The runner deliberately does not retry or hide it: if any child failure or interruption recurs, the aggregate will report that file and return non-zero. No migration, dependency, lockfile, application, or deployment impact is expected. Root review and acceptance remain pending.
