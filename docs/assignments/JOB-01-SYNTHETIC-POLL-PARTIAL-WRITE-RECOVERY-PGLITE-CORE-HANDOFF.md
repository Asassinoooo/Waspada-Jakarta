# JOB-01 synthetic poll partial-write recovery handoff

## Delivery

- Branch: `work/JOB-01-SYNTHETIC-POLL-PARTIAL-WRITE-RECOVERY-PGLITE-CORE`
- Worktree: `/mnt/d/Projects/RPL/.codex-build/worktrees/job-01-synthetic-poll-partial-write-recovery-pglite-core`
- Assigned base: `931ebef205166dd273e507ba3fe397c16309338d`
- Implementation commit: `1609ee83d079a1df944c383c26f21a6ffc966169` — `test(JOB-01): cover synthetic poll partial-write recovery`
- Changed paths:
  - `apps/db/test/synthetic-fixture-pipeline.test.ts`
  - `docs/assignments/JOB-01-SYNTHETIC-POLL-PARTIAL-WRITE-RECOVERY-PGLITE-CORE-HANDOFF.md`

## Behavior covered

The PGlite composition test authors a local synthetic poll, writes one report revision and one evidence reference, then injects a second-reference write failure and an interrupted queue-failure transition. It verifies the job remains leased, no extraction result/chunks/geometry/publication rows were persisted, and source health did not change until expired-lease recovery.

Recovery runs under `waspada_l1_pipeline`; the test checks the active role, preserved source policy fields, retry boundary, degraded health, and retained attempt count. Replay claims a new token, rejects the original token while that replacement lease is active, and completes with exact row counts and five unique evidence-reference identities. Source health then becomes healthy with the expected timestamps, while policy fields and publication state remain unchanged.

The synthetic adapter is called twice because the first run fails before its extraction result is persisted. Persisted writes converge idempotently; this test does not establish exactly-once adapter execution. No production, schema, grant, API, fixture-catalog, dependency, or configuration changes were made. No live source, paid API, or hosted resource was used.

## Verification

Executed in WSL Ubuntu-26.04 with Node 24.21.0 and npm 11.19.0:

- Focused post-review PGlite case: passed.
- `npm run db:test`: passed all 43/43 DB test files after correcting an initial test-clock collision that made a separate 03:10 queued fixture due in the new scenario.
- `npm test`: passed the full workspace command, including the DB suite (43/43) and casebook tests (19/19). This full run preceded the two final test-only review assertions; the focused case was rerun afterward.
- `npm run typecheck`: passed after the final assertions.
- `npm run build`: passed after the final assertions; Vite and Wrangler dry-run completed.
- `git diff --check 931ebef205166dd273e507ba3fe397c16309338d`: passed after the final assertions.

Focused command:

```sh
export PATH=/home/perry/.local/opt/waspada-node-v24.21.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
node --import tsx --test --test-name-pattern="recovers a synthetic source poll after partial writes" apps/db/test/synthetic-fixture-pipeline.test.ts
```

No known blockers or remaining contract decisions. The root task owns central backlog and delivery-log updates after review.
