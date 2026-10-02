# LIFE-01-FRESHNESS-DUE-WORKER-RUNTIME-CORE handoff

Backlog item: LIFE-01-FRESHNESS-DUE-WORKER-RUNTIME-CORE
Branch: work/LIFE-01-FRESHNESS-DUE-WORKER-RUNTIME-CORE
Worktree: /mnt/c/Users/perry/.codex/worktrees/life-01-freshness-due-worker-runtime-core/RPL
Assigned base: efc968bf60ff18f20b37fab1e046f49b43605ce0
Implementation commit: 5abbf1089dae8cf0543b3ff766d616028d15af65
Implementation commit message: feat(LIFE-01): add opt-in freshness due Worker runtime

The Worker scheduled handler now composes one Layer 4 freshness due page behind exact DATASET_MODE=live, exact FRESHNESS_DUE_SCHEDULER_ENABLED=true, and a valid dedicated FRESHNESS_DUE_HYPERDRIVE.connectionString. The trigger reads only that dedicated binding. Existing demo defaults and configurations without the new binding remain dormant.

The run ID is freshness-due:<scheduled epoch milliseconds>, which is stable for a platform schedule slot and valid for the evaluator and migration-026 trace functions. The same UTC instant is supplied as the evaluator time and trace start. The runtime opens one request-scoped transactional PostgreSQL client, enters waspada_l4_freshness_writer, calls the begin function, and on an open run composes the real due reader, transition ledger, recorder, and evaluator for one page with a limit of 100 and no page loop. It finalizes completed pages as succeeded, retry/failure results as failed, and passes the evaluator's closed count object to the migration-026 finalizer. An unexpected evaluator exception is closed with a fixed single-failure summary. Existing succeeded/failed traces are left terminal and skip evaluation. The prior role is restored with RESET ROLE; cleanup errors do not replace an earlier failure. Runtime errors use fixed content-free messages.

Changed paths:

- apps/worker/src/runtime/freshness-due-schedule-runtime.ts
- apps/worker/src/runtime/freshness-due-schedule-trigger.ts
- apps/worker/src/index.ts
- apps/worker/src/layers/l4-application-integration/api.ts
- apps/worker/test/l4-freshness-due-schedule-runtime.test.ts
- apps/worker/package.json
- apps/db/test/freshness-due-schedule-runtime-composition.test.ts

The Worker suite covers dormant gates, dedicated-binding selection, invalid schedule times, stable slot identity, role/function order, both terminal replay statuses, single-page boundedness, exact failed summaries, role cleanup, and sanitized errors. The fresh PGlite composition test applies migrations 024-026, runs the real runtime on an empty live database, confirms the final count-only trace and restored role, and asserts that event, impact, evidence, transition, and publication-decision tables remain empty.

Verification ran in WSL Ubuntu-26.04 using Node v24.21.0 and npm 11.19.0. Existing dependencies were used without installation: PGlite 0.5.8, pglite-pgvector 0.0.9, pglite-postgis 0.2.8, pg 8.16.3, tsx 4.23.15, and TypeScript 7.0.2. The build used Vite 8.3.0 and Wrangler 4.137.0.

- Focused Worker test: passed, 9/9.
- Focused PGlite runtime composition: passed, 1/1.
- npm run db:test: passed, 30/30 files.
- npm run typecheck: passed.
- npm test: passed; Worker 396/396, DB 30/30 files, evaluation 12/12.
- npm run build: passed; Vite production build and Wrangler dry-run. The dry-run exposed only DATASET_MODE="demo".
- git diff --check efc968bf60ff18f20b37fab1e046f49b43605ce0..HEAD: passed for the implementation commit. It is rerun after the handoff commit.

Migration/configuration impact: no migration, dependency, public API/DTO, Wrangler schedule, Hyperdrive resource ID, secret, provider, hosted role membership, or deployment change. The checked-in Worker remains dormant because no freshness binding or enable flag is configured. Hosted Neon/Cloudflare behavior and live processing remain unverified. Deployment-time role membership remains a separate activation prerequisite.

Remaining decisions: none for this local runtime slice. Provisioning a dedicated Hyperdrive binding, setting the opt-in flag, and arranging the hosted login's role membership require separate authorization.
