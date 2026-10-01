# JOB-01-SYNTHETIC-SCHEDULE-RUNTIME-CORE — implementation handoff

- **Status:** Implementation ready; root review pending
- **Branch:** `work/JOB-01-SYNTHETIC-SCHEDULE-RUNTIME-CORE`
- **Worktree:** `C:\Users\perry\.codex\worktrees\l3-coordinator-core\RPL` (`/mnt/c/Users/perry/.codex/worktrees/l3-coordinator-core/RPL`)
- **Assigned base:** `94c25f754182b0b992c971200e5bc93e90f7f831`
- **Contract:** schema 2.0; public DTO/OpenAPI unchanged

## Behavior

Added an opt-in synthetic scheduled enqueue runtime and Worker scheduled-trigger adapter. Runtime creation requires exact `DATASET_MODE=demo`, exact `SYNTHETIC_POLL_SCHEDULER_ENABLED=true`, and a valid separate L1 connection string. It never falls back to public-reader `HYPERDRIVE`; checked-in provider configuration remains disabled and has no scheduler binding, secret, or cron expression.

A valid platform scheduled epoch is normalized to UTC RFC3339 before connecting. One lazy SQL operation begins a transaction, selects `waspada_l1_pipeline` locally, verifies exactly one synthetic namespace row before writes, creates a random trace ID, and runs the existing SQL acquisition-job repository and source-poll scheduler on the same executor. It closes the trace with the four validated scheduler counts and commits. Callback failures trigger best-effort rollback and surface a fixed redacted error; setup and client-close failures are also redacted. There is no implicit retry.

Trace `started_at` and `ended_at` use the supplied scheduling instant. They record the enqueue operation's completion summary; they do not measure execution duration or establish intake, model, or publication completion.

The runtime only schedules source-poll jobs. It does not update source health, claim or process jobs, invoke L2/L3, or create event/publication records. Public fetch behavior is unchanged.

## Changed paths

- `apps/worker/src/runtime/synthetic-poll-schedule-runtime.ts`
- `apps/worker/src/runtime/synthetic-poll-schedule-trigger.ts`
- `apps/worker/src/index.ts` (scheduled entrypoint only)
- `apps/worker/src/layers/l4-application-integration/api.ts` (environment types only)
- `apps/worker/test/synthetic-poll-schedule-runtime.test.ts`
- `apps/worker/package.json` (test registration only)
- `apps/db/migrations/021_l1_scheduler_namespace_read.sql`
- `apps/db/test/synthetic-poll-schedule-runtime.test.ts`
- `apps/db/test/migrations.test.ts` (migration 021 inventory/staging)
- `apps/db/test/public-event-updates.test.ts` (migration 021 staging)

No dependencies were added. Migration 021 grants only L1 `SELECT(dataset_kind)` on the namespace table. The privilege test preserves migration 005's existing L4 publication-writer dataset-kind read and verifies the new L1 read without namespace mutation or unrelated role grants. Migration 022 remains untouched.

## Verification

Performed in WSL Ubuntu-26.04 with Node `v24.21.0`, npm `11.19.0`; package versions recorded at implementation start: PGlite `0.5.8`, pg `8.16.3`, tsx `4.23.15`, TypeScript `7.0.2`, Wrangler `4.137.0`. A temporary worktree `node_modules` symlink to the existing root dependencies was removed before handoff.

- From `apps/worker`: `PATH=/home/perry/.nvm/versions/node/v24.21.0/bin:/usr/bin:/bin npm exec -- tsx --test test/synthetic-poll-schedule-runtime.test.ts` — **passed, 8/8**.
- From `apps/db`: `PATH=/home/perry/.nvm/versions/node/v24.21.0/bin:/usr/bin:/bin npm exec -- tsx --test test/synthetic-poll-schedule-runtime.test.ts` — **passed, 4/4**. PGlite exercised the actual scheduler, same-timestamp idempotency, synthetic-only writes, role privileges, mismatch/absence with no writes, and rollback after real queue insertion when trace completion did not return a row.
- Repository root `npm test` — **passed**: web 60 tests, Worker 357 tests, DB runner 22/22 test files, evaluation 12 tests.
- Repository root `npm run typecheck` — **passed**.
- Repository root `npm run build` — **passed**: Vite build and Wrangler `deploy --dry-run --outdir dist`; dry-run retained only the existing `DATASET_MODE="demo"` binding.
- Worktree `git diff --check` — **passed** before commit. Assignment-required `git diff --check 94c25f754182b0b992c971200e5bc93e90f7f831..HEAD` is to be run after commit and recorded in the final handoff.

### Failure and rerun history

- The first focused PGlite run had 3/4 pass: one JSONB object comparison was sensitive to property ordering. The assertion was changed to structural deep equality; rerun passed 4/4.
- The first typecheck reported unused test helpers and missing executor parameter types. The helpers were removed and types added; rerun passed.
- Initial WSL setup invocations had a shell/PATH mismatch, and `rg` was not installed in the distro. Commands were rerun with the assigned Node path and file inspection used available tools. These were environment/setup issues, not project test failures.

## Limits and remaining decisions

Hosted Cloudflare behavior and true multi-session concurrency remain unverified, as scoped by the assignment. Root review and acceptance are pending. No additional design or migration decision is outstanding.
