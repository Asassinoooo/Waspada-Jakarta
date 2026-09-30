# JOB-01-SYNTHETIC-POLL-CYCLE-PGLITE-CORE handoff

- **Branch:** `work/JOB-01-SYNTHETIC-POLL-CYCLE-PGLITE-CORE`
- **Worktree:** `C:\Users\perry\.codex\worktrees\l3-coordinator-core\RPL` (`/mnt/c/Users/perry/.codex/worktrees/l3-coordinator-core/RPL` in WSL)
- **Assigned base:** `f5f9aa70c3aafc09525d5b986bcf52ac92395033`
- **Implementation commit:** `e2af44424d7adcf968520539eec00c3b38f1dfe3` — `test(JOB-01): verify scheduled synthetic poll cycle`

## Delivered

Added one PGlite composition case in `apps/db/test/synthetic-fixture-pipeline.test.ts`. Under `SET ROLE waspada_l1_pipeline`, it calls the real `SqlSourcePollScheduler` with an explicit time, synthetic dataset, and persisted trace; verifies one bounded queue request; and invokes `runSyntheticSourcePollJob` with the real SQL queue repository and in-memory source-ID fixtures. A decoy fixture confirms that only the exact queued source ID is processed.

The test intercepts the pipeline completion port and checks, before delegating to the real SQL acknowledgement, that the same job is leased and that its report, five evidence references, four extraction links, extraction result, chunk, and geometry are persisted with the expected source and trace identities. It verifies report retrieval and observation times remain earlier than the poll completion time. Health remains `unknown` until the acknowledgement call, then becomes `healthy` with `last_checked_at` and `last_success_at` set to the explicit completion instant. Registry approval and publication policy remain unchanged. After resetting the L1 role, the test confirms zero event-version and publication-decision rows for its trace.

The existing retry, replay, and out-of-scope queue tests remain intact. No production behavior, schema, grant, API/DTO, dependency, or runtime configuration changed. No migration or source activation is required.

## Verification

All commands ran in WSL Ubuntu-26.04 using the existing WSL Node runtime and workspace dependencies: Node `v24.21.0`, npm `11.19.0`, TypeScript `7.0.2`, tsx `4.23.15`, PGlite `0.5.8`, PGlite pgvector `0.0.9`, and PGlite PostGIS `0.2.8`.

- Focused composition: from `apps/db`, `node --import tsx --test --test-name-pattern="schedules and persists one exact synthetic poll before acknowledging its queue job" test/synthetic-fixture-pipeline.test.ts` — 1/1 passed.
- `npm run db:test` — 21/21 database test files passed, including the existing retry/replay cases.
- `npm test` — passed with exit code 0; the database runner reported 21/21 files and the evaluation casebook reported 12/12.
- `npm run typecheck` — passed for the web, Worker, database, and evaluation workspaces.
- `git diff --check f5f9aa70c3aafc09525d5b986bcf52ac92395033..HEAD` — passed after the implementation commit and was rerun after the handoff commit.

The worktree dependency link used for verification was temporary and removed after each run. No dependency was installed or changed.

## Transient setup issues

The WSL login PATH did not include Node, so verification used the existing runtime at `/home/perry/.nvm/versions/node/v24.21.0/bin`. WSL could not create a symlink directly on the mounted C: worktree; a temporary Windows junction to the existing `/mnt/d/Projects/RPL/node_modules` was visible to WSL as a symlink and removed by an absolute-path cleanup trap. An early combined-check wrapper returned nonzero because its final status-printing expression was malformed; the focused test, full database suite, workspace suite, and typecheck were subsequently run with separate commands and passed. WSL Git also could not resolve the Windows `.git` pointer directly, so the diff check used the worktree’s explicit WSL `--git-dir` and `--work-tree` paths. The initial staged handoff whitespace check found trailing spaces on the three metadata lines; those lines were changed to a list, and subsequent staged and assigned-base checks passed.

## Limits and remaining decisions

This verifies the synthetic local PGlite path only. Hosted Neon behavior, independent PostgreSQL concurrency, live-source access and rights, and any timer/Cron/Workflow or Worker runtime invocation remain outside this assignment. No migration, permission, or configuration decision remains for this test-only slice.
