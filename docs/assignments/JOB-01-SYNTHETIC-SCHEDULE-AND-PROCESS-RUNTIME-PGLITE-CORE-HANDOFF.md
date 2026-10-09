# JOB-01-SYNTHETIC-SCHEDULE-AND-PROCESS-RUNTIME-PGLITE-CORE handoff

## Assignment and commits

- **Branch:** `work/JOB-01-SYNTHETIC-SCHEDULE-AND-PROCESS-RUNTIME-PGLITE-CORE`
- **Worktree:** `/mnt/d/Projects/RPL/.codex-build/worktrees/job-01-synthetic-schedule-process-runtime-pglite-core`
- **Assigned base:** `0f9d2baabe88448e5448fd255558eb2ba06e49ef`
- **Implementation commit:** `4f2d92e5fa3657ba0a2f2c2fed605d115116ab4e` — `test(JOB-01): compose synthetic schedule and processing runtimes`
- **Changed paths:**
  - `apps/db/test/synthetic-schedule-process-runtime-composition.test.ts`
  - `docs/assignments/JOB-01-SYNTHETIC-SCHEDULE-AND-PROCESS-RUNTIME-PGLITE-CORE-HANDOFF.md`

The test adds one auto-discovered PGlite composition case. It applies the current migrations to a fresh disposable database, writes an authored synthetic namespace/source/seed trace, and invokes the actual scheduled-enqueue runtime with a fixed timestamp and a dedicated test SQL executor. The scheduler creates one persisted synthetic trace and one due job for the approved source; the test checks the count-only trace metadata and that the job points to that trace.

The actual processor runtime then receives that same database, a fixed in-memory catalog containing the exact source fixture plus an unrelated decoy, and a deterministic test-only L2 extraction adapter. It completes the scheduled job after persisting the exact-source report revision, five linked evidence references, one extraction result with four evidence links, one chunk, and one supported geometry. The decoy report remains absent. The successful acquisition records source health at the fixed supplied time. The test separately verifies that the database contains no Event version or publication decision; acquisition completion does not establish Event lifecycle, publication, or physical safety.

No production, runtime, Worker entrypoint, source, schema, migration, grant, package script, dependency, API, or configuration path changed. The test performs no network, model-provider, L3, or hosted-service call. It does not activate a Worker trigger or deployed Cron.

## Verification

Environment: WSL Ubuntu 26.04, Node.js `v24.21.0`, npm `11.19.0`, `@electric-sql/pglite` `0.5.8`, `pg` `8.16.3`, `tsx` `4.23.15`, and TypeScript `7.0.2`. Dependencies were already present; none were installed or updated.

- From `apps/db`, `PATH=/home/perry/.local/opt/waspada-node-v24.21.0/bin:/usr/bin:/bin npm exec -- tsx --test test/synthetic-schedule-process-runtime-composition.test.ts` — **passed, 1/1** (first run).
- `npm ls --depth=0 @electric-sql/pglite pg tsx typescript` — **passed** with the versions above.
- `git diff --cached --check` for the implementation commit — **passed**.
- `npm run db:test`, `npm test`, and `npm run typecheck` were not run on this task branch. Root requested that broad suites wait until review/integration and plans one shared sequential validation.
- The assigned-base `git diff --check 0f9d2baabe88448e5448fd255558eb2ba06e49ef..HEAD` is run after the documentation commit; its result is reported in the agent delivery.
- Build is not required by this test-only assignment.

No test failure or rerun occurred. Hosted Neon behavior, independent PostgreSQL concurrency, Cloudflare scheduled execution, deployed Cron, live-source access/rights, and real-provider behavior remain unverified. No migration, permission, configuration, or dependency decision is needed; root review and the shared broad validation remain pending.
