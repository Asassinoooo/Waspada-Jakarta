# JOB-01 Synthetic Poll Processor Core Handoff

Branch: work/JOB-01-SYNTHETIC-POLL-PROCESSOR-CORE
Worktree: C:\Users\perry\.codex\worktrees\l3-coordinator-core\RPL
WSL worktree: /mnt/c/Users/perry/.codex/worktrees/l3-coordinator-core/RPL
Assigned base: ab6511cca25f01b53dc4a78dcd41c489e3b9a38f

Implementation commit: 8b8080a4d4deca5f64416ac4089946195e4ec403
Commit message: feat(JOB-01): process synthetic source polls

## Behavior delivered

The injected runSyntheticSourcePollJob runner validates caller-supplied RFC3339 time, calls claimDueSyntheticSourcePoll exactly once, and processes at most the one already-leased eligible job. It resolves caller-buffered fixtures by exact synthetic source ID and verifies that fixture and manifest identity, manifest canonical URL, and registry identity agree. Source-poll processing fails closed unless the existing registry record has the exact source ID, active status, a configured positive interval, approved state, automatic acquisition enabled, and auto-publication policy never.

The shared pipeline reuses existing synthetic GeoJSON parsing, authored text preparation, extraction adapter, report/evidence/chunk/geometry persistence, persisted extraction replay, and queue retry/completion behavior. Empty authored feeds complete without report or publication writes. The existing manual moderator-submission path remains URL-keyed and keeps its manual_fixture, approved, auto-acquisition-disabled, never-publish policy checks.

The runner performs no fetch and has no clock, loop, scheduler, provider, L3, publication, or runtime binding. Synthetic source IDs remain explicit. No database schema, migration, grant, public contract, dependency, or configuration changed.

## Changed paths

- apps/worker/src/layers/l1-data-knowledge/synthetic-fixture-pipeline.ts
- apps/worker/src/layers/l1-data-knowledge/synthetic-source-poll-runner.ts
- apps/worker/test/synthetic-source-poll-runner.test.ts
- apps/db/test/synthetic-fixture-pipeline.test.ts
- apps/worker/package.json (test script registration only)

## Verification

Ran in WSL Ubuntu-26.04 using Node v24.21.0 and npm 11.19.0. Tool versions observed during these runs: TypeScript 7.0.2, tsx 4.23.15, Vite 8.3.0, Wrangler 4.137.0.

- Focused worker runner test: 12/12 passed.
- Focused PGlite pipeline composition test: 3/3 passed.
- npm run db:test: all 21/21 database test files passed.
- npm test: web 60/60, worker 346/346, database 21/21 files, evaluation casebook 12/12 passed.
- npm run typecheck: passed across workspaces and evaluation.
- npm run build: passed; Vite production build and Wrangler dry-run succeeded.
- git diff --check against the assigned base: passed before commit; final post-commit check is recorded in the task handoff message.

The worktree temporarily used the existing repository node_modules through a symlink for verification; the symlink was removed before handoff. No dependency was installed or changed.

## Corrected transient failures

- The first full DB-suite launch used the Windows npm shim and failed before tests with ENOENT for a translated D:\mnt\c\... path. The explicit WSL Ubuntu-26.04 rerun completed with all 21 files passing.
- An early typecheck caught an optional nullable polling-interval narrowing error; it was fixed and typecheck subsequently passed.
- An early runner test expected the empty-feed path to omit the source-registry read; the expectation was corrected to match fail-closed source validation, and all 12 runner tests passed.
- A partial composition-test edit temporarily caused a typecheck error; the test was completed and both focused and full verification passed afterward.

## Limits and remaining decisions

This package only provides the injected Layer 1 processing core. It does not activate a source, schedule jobs, bind a hosted worker or workflow runtime, or define live-source access. A later assigned integration task must choose and authorize runtime invocation. No migration or configuration change is needed for this core.
