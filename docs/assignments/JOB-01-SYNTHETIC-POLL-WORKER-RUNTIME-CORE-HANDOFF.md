# JOB-01 Synthetic Poll Worker Runtime Core — Handoff

## Assignment

- Backlog item: `JOB-01-SYNTHETIC-POLL-WORKER-RUNTIME-CORE`
- Branch: `work/JOB-01-SYNTHETIC-POLL-WORKER-RUNTIME-CORE`
- Worktree: `C:\Users\perry\.codex\worktrees\job01-synthetic-poll-worker-runtime\RPL` (WSL: `/mnt/c/Users/perry/.codex/worktrees/job01-synthetic-poll-worker-runtime/RPL`)
- Base: `2cf9612ea365b8a72801c04049c3af3abe7bc9ec`
- Implementation commit: `59673c6` — `feat(JOB-01): compose synthetic source poll processor runtime`

## Delivered behavior

The scheduled Worker now invokes a separate, independently gated synthetic poll trigger after the existing enqueue trigger. The runtime returns without opening SQL or claiming work unless dataset mode is exactly `demo`, the processor flag is exactly `true`, a dedicated `L1_HYPERDRIVE` binding is valid, and both an exact-source-ID fixture catalog and fixed L2 extraction adapter were injected. It never falls back to public `HYPERDRIVE`.

When enabled with all dependencies, one request-scoped SQL client and L1 session role are used to compose the accepted `runSyntheticSourcePollJob` runner with the existing repository ports. Session role reset is attempted even on failure. Repository transactions remain scoped to individual persistence operations; no explicit transaction spans L2 extraction. The runtime does not use L3, live fetch, event creation, or publication. If role reset or client cleanup fails after the runner returns a bounded failure, that bounded failure is retained; success and driver errors are redacted.

The checked-in Worker composition injects neither a fixture catalog nor an extractor, so no production mock, fabricated success, or active synthetic processing is introduced. The scheduled composition uses only the platform-supplied scheduled time.

The Worker unit tests exercise gating, L1-only binding selection, timestamp preflight, one-claim bounds, role reset, redacted errors, and client-close failure behavior. The PGlite test uses authored fixtures and a test-only L2 adapter with real L1 repositories. It checks persistence-before-acknowledgement, bounded recovery/replay, no repeated extraction after uncertain acknowledgement, one job per invocation, no transaction across extraction, and no event/publication writes.

## Changed paths

- `apps/worker/src/runtime/synthetic-source-poll-process-runtime.ts` (new)
- `apps/worker/src/runtime/synthetic-source-poll-process-trigger.ts` (new)
- `apps/worker/src/index.ts` (scheduled composition only)
- `apps/worker/src/layers/l4-application-integration/api.ts` (environment type only)
- `apps/worker/test/synthetic-source-poll-process-runtime.test.ts` (new)
- `apps/db/test/synthetic-source-poll-process-runtime.test.ts` (new)
- `apps/worker/package.json` (test registration only)
- `docs/assignments/JOB-01-SYNTHETIC-POLL-WORKER-RUNTIME-CORE-HANDOFF.md` (this file)

## Checks and environment

All commands ran in WSL Ubuntu-26.04 using installed dependencies; no packages were installed.

- Node.js `v24.21.0`; npm `11.19.0`
- `tsx` `4.23.15`; TypeScript `7.0.2`
- `@electric-sql/pglite` `0.5.8`; `@electric-sql/pglite-postgis` `0.2.8`; `@electric-sql/pglite-pgvector` `0.0.9`; `pg` `8.16.3`
- Build toolchain reported Vite `8.3.0` and Wrangler `4.137.0`.
- Focused Worker runtime tests: **6/6 passed**.
- Focused PGlite composition test: **1/1 passed**.
- `npm run db:test`: **passed**, 31 test files.
- `npm test`: **passed**; Web 60/60, Worker 413/413, DB 31 test files, evaluation 12/12.
- `npm run typecheck`: **passed**.
- `npm run build`: **passed**, including typecheck, Vite build, and Wrangler dry-run (848.75 KiB total / 166.45 KiB gzip).
- Working-tree `git diff --check`: **passed**. The required post-commit `git diff --check 2cf9612ea365b8a72801c04049c3af3abe7bc9ec..HEAD`: **passed** after both commits.

## Impact and remaining gates

No migrations, grants, schemas, dependencies, secrets, Wrangler configuration/bindings, provider setup, source access, or deployment were added. No root-owned plan, ADR, backlog, or checkpoint files were changed.

This validates local synthetic processing mechanics only. Cloudflare scheduled execution, hosted Neon, provider behavior, and any real source access were not exercised. The trigger remains dormant until an authorized deployment supplies the exact demo/enable gates, a valid dedicated L1 binding, and explicit fixture catalog plus extractor dependencies. Root review and acceptance remain outstanding.
