# LIFE-01-FRESHNESS-DUE-RUN-TRACE-CORE handoff

Backlog item: LIFE-01-FRESHNESS-DUE-RUN-TRACE-CORE
Branch: work/LIFE-01-FRESHNESS-DUE-RUN-TRACE-CORE
Worktree: /mnt/c/Users/perry/.codex/worktrees/life-01-freshness-due-run-trace-core/RPL
Assigned base: 0525feff019c42fb75c88b23a848a836d9f676a8
Implementation commit: e1e14731dc3c6618f0b078e49deb9dafeea8db2b
Implementation commit message: feat(LIFE-01): add freshness due run trace functions

The additive migration 026 defines two fixed-purpose SECURITY DEFINER functions: waspada.begin_freshness_due_evaluation_run(text, timestamptz) and waspada.finalize_freshness_due_evaluation_run(text, timestamptz, timestamptz, text, jsonb). Both pin search_path to pg_catalog and use fully qualified waspada.traces references. They accept only 1-128 character evaluator-compatible IDs, finite explicit instants, dataset live, and trigger metadata freshness_due_evaluation.

Begin creates an open trace, resumes the exact same open identity, or returns an exact existing terminal status without reopening it. Changed identity, timestamp, dataset, or metadata fails closed. Finalize updates only the matching live open run and accepts succeeded or failed plus a closed count-only summary with non-negative integer fields written, replayed, noChange, conflicts, and failures, each bounded to 2147483647. Exact terminal replay is idempotent; changed terminal fields conflict. A NULL outcome is explicitly rejected as not-open.

PUBLIC execute is revoked from both functions and EXECUTE is granted only to waspada_l4_freshness_writer. The migration does not grant direct trace-table INSERT or UPDATE. The PGlite suite checks the function privilege configuration, denied direct table writes, unchanged existing role permissions, preserved unrelated traces, fixed metadata, open resume, successful and failed completion, replay and conflict paths, invalid IDs/times/counts, and nullable non-open trace rejection.

Changed implementation and test paths:

- apps/db/migrations/026_freshness_due_run_traces.sql
- apps/db/test/freshness-due-run-traces.test.ts
- apps/db/test/migrations.test.ts
- apps/db/test/public-event-updates.test.ts

Root approved the two existing test-path additions narrowly: migrations.test.ts updates migration 026 sequence/count/latest-version expectations; public-event-updates.test.ts excludes migration 026 from the pre-024 fixture subset and includes it in the full applied-version list.

Verification ran in WSL Ubuntu-26.04 with Node v24.21.0 and npm 11.19.0. Existing database dependencies were used without installing packages: PGlite 0.5.8, pglite-pgvector 0.0.9, and pglite-postgis 0.2.8. The build reported Vite 8.3.0 and Wrangler 4.137.0.

- Focused test: ./node_modules/.bin/tsx --test apps/db/test/freshness-due-run-traces.test.ts - passed, 6/6.
- npm run db:test - passed, 29/29 DB test files.
- npm run typecheck - passed.
- npm test - passed; web/workspace tests 387/387, DB tests 29/29, evaluation tests 12/12.
- npm run build - passed; Vite production build and Wrangler deploy dry-run exited successfully.
- git diff --check 0525feff019c42fb75c88b23a848a836d9f676a8..HEAD - passed for the implementation commit; the final-tree check is run after this handoff commit.

An intermediate full DB rerun exposed a missing 026 row in the updated migration-ledger expected list. That expectation was corrected; the final standalone DB run and final npm test both passed.

Migration/configuration impact: this is one additive database migration. It grants EXECUTE on the two narrow functions to the already-existing freshness-writer role and makes no role-membership, public contract, Worker, schedule, provider, or deployment-binding changes. Scheduled Worker wiring remains unimplemented and disabled by this task.

Limitation: verification used the repository PGlite harness; no hosted PostgreSQL/Neon instance was changed or exercised. Root review and integration remain pending.
