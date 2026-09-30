# JOB-01-SCHEDULED-POLL-CORE handoff

**Branch:** `work/JOB-01-SCHEDULED-POLL-CORE`
**Worktree:** `C:\Users\perry\.codex\worktrees\l3-coordinator-core\RPL` (`/mnt/c/Users/perry/.codex/worktrees/l3-coordinator-core/RPL` in WSL)
**Base:** `c2d5573a6a05ceaefffa9116d26928cf1d5ce990`
**Implementation commit:** `03828bf17cbff96462e08dc31a8e7494ad20533c`+ßuÁ‚ùÁT `feat(JOB-01): add bounded due source poll scheduler`

## Delivered behavior

Added `SourcePollScheduler`, a standalone L1 service that accepts an explicit RFC3339 evaluation time, dataset, and persisted trace ID. It validates the trace against the requested dataset, then selects at most 100 due sources in deterministic source-ID order. A source is eligible only when active, approved, automatic acquisition is enabled, and its polling interval is configured. A null `last_checked_at` is due, and the interval boundary is inclusive.

The scheduler excludes sources with a same-dataset/source `pending`, `leased`, or `retry` source-poll job. It derives a stable SHA-256 idempotency key from the dataset, source ID, configured interval, and current UTC interval slot. Thus equivalent timestamp offsets map to the same slot, repeat/concurrent enqueues use the existing unique key, and completed or terminal jobs do not suppress a later due slot. Downtime schedules only the current slot.

The service uses only the existing `SqlExecutor` and `AcquisitionJobRepository` interfaces and the current least-privilege database role. It only enqueues requests; it does not claim jobs, fetch source content, mutate source health or events, or call L2/L3. Its return value contains counts only.

## Changed paths

- `apps/db/src/source-poll-scheduler.ts`
- `apps/db/test/queue.test.ts`
- `docs/assignments/JOB-01-SCHEDULED-POLL-CORE-HANDOFF.md`

No migration, grant, schema version, public/API contract, dependency, Worker/configuration, or timer/Cron change was made.

## Verification

All project verification ran in WSL Ubuntu-26.04 with the existing Linux runtime and dependency tree. The existing root `node_modules` tree was temporarily linked into the worktree for checks and the symlink was removed afterward. No packages were installed and no external service was contacted.

Tool versions: Node.js `v24.21.0`; npm `11.19.0`; PGlite `0.5.8`; tsx `4.23.15`; TypeScript `7.0.2`; Wrangler `4.137.0`.

- From `apps/db`, `tsx --test test/queue.test.ts`+ßuÁ‚ùÁT exit 0; 15/15 tests passed.
- `npm run db:test`"È›y¯ßy‘ exit 0; all 21 DB test files passed.
- `npm test`+ßuÁ‚ùÁT exit 0; web 60, Worker 334, DB 21, and evaluation 12 tests passed.
- `npm run typecheck` ∫w^~)ﬁt exit 0.
- `npm run build`"È›y¯ßy‘ exit 0; TypeScript, Vite production build, and Wrangler deploy dry-run completed.
- `git diff --check c2d5573a6a05ceaefffa9116d26928cf1d5ce990..HEAD` ∫w^~)ﬁt run after the handoff commit; see the final task handoff for its result.

## Limitations and remaining decisions

The database behavior was exercised with synthetic PGlite rows. No hosted Neon/Postgres deployment or independent multi-session race was exercised. There is intentionally no timer, Cron/Workflow binding, source access, or runtime wiring in this package. No unresolved implementation decision remains; root review and integration are pending.
