# L2-CONTEXT-PERSIST-CORE implementation handoff

## Delivery

- Branch: `work/L2-CONTEXT-PERSIST-CORE`
- Worktree: `D:\Projects\RPL\.codex-build\worktrees\l2-context-persist-core`
- Implementation commit: `9c5f58228990b828a3fc643f0e16fe718cc14eec` — `feat(L2-CONTEXT-PERSIST-CORE): persist canonical grounding contexts`
- Handoff commit: recorded in the follow-up documentation commit.
- Review/integration: awaiting independent root review; this handoff does not mark the backlog task accepted.

## Behavior implemented

The database repository now accepts only the closed canonical schema 2.0 `GroundingContext` record. It validates exact properties and schema enums/bounds, including the 10,000,000 maximum evidence offset, and stores only reference metadata; no excerpt or retrieved text is accepted. It preserves the caller-supplied `sufficient` boolean without deriving or evaluating it.

`createOrVerify` requires a transactional SQL executor. It resolves evidence only by the exact same-dataset report revision, text hash, span, offset unit, and relation already persisted by L1. Candidate event/version pairs and prior decisions must already exist in that same dataset. It creates the normalized context row and all links atomically. Identical retries verify the normalized columns, JSONB record, and linked sets; any row or link drift raises the stable typed conflict. Missing references and failed link writes leave no partial context. Records are never updated or deleted.

Migration 010 creates or clamps the separate `waspada_l2_grounding_writer` role to `NOLOGIN NOINHERIT` and nonprivileged attributes. It revokes prior schema/table/sequence access before granting schema usage, exact evidence/event/decision/context column reads, and only context/link SELECT and INSERT columns. The synthetic role test exercises create/replay under `SET ROLE`, verifies effective table and column privileges (including TRUNCATE, REFERENCES, and TRIGGER), checks the role attributes, denies unrelated reads and writes, and verifies migration reapplication.

## Changed paths

- `apps/db/migrations/010_l2_grounding_context_writer.sql`
- `apps/db/src/grounding-contexts.ts`
- `apps/db/src/ports.ts`
- `apps/db/test/grounding-contexts.test.ts`
- `apps/db/test/migrations.test.ts`
- `apps/db/test/investigation-ledger.test.ts` — latest migration inventory expectation only; ledger behavior assertions are unchanged.
- `docs/assignments/L2-CONTEXT-PERSIST-CORE-HANDOFF.md`

No dependency or lockfile changes were made. Migration 009 remains the accepted evidence-relation migration; 010 adds only the local writer role and grants. No public contract, OpenAPI, Worker/API wiring, retrieval/model behavior, L3/L4 behavior, live data, or hosted service configuration changed.

## Checks actually run

All project checks ran in WSL Ubuntu-26.04 using Node `v24.21.0` and npm `11.19.0`, with PATH `/home/perry/.local/opt/waspada-node-v24.21.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`. Installed package versions observed during implementation were `tsx 4.23.15`, `typescript 7.0.2`, `@electric-sql/pglite 0.5.8`, `@electric-sql/pglite-postgis 0.2.8`, and `@electric-sql/pglite-pgvector 0.0.9`.

- `npm run db:test` — passed, all 10/10 database test files (76 tests).
- `npm test` — passed: web 5, Worker 62, database 76, evaluation casebook 12 (155 tests total).
- `npm run typecheck` — passed across web, Worker, database, and evaluation tooling.
- `npm run build` — passed; Vite production build succeeded and Wrangler Worker deploy dry-run completed.
- `git diff --check` — passed in WSL after writing this handoff. Because the worktree `.git` pointer contains a Windows path, the WSL invocation supplied `GIT_DIR=/mnt/d/Projects/RPL/.git/worktrees/l2-context-persist-core` and `GIT_WORK_TREE=/mnt/d/Projects/RPL/.codex-build/worktrees/l2-context-persist-core`.

## Follow-up schema-parity correction

- Follow-up implementation commit: `25454b5078765161eb7ff232bebd4860f71b0378` — `fix(L2-CONTEXT-PERSIST-CORE): match schema array semantics`.
- Schema `$defs.Strings` length now counts Unicode code points (`Array.from(value).length`), matching JSON Schema semantics for astral characters. `revision_states` now preserves schema-valid repeated entries because the schema does not declare uniqueness for that array; uniqueness checks remain on the normalized evidence/event/decision link sets and schema-unique prior decision IDs.
- Added a synthetic PGlite boundary test: 500 astral code points are accepted and persisted, 501 are rejected, and repeated `revision_states` remain intact in JSONB.
- Follow-up WSL Ubuntu-26.04 checks with Node `v24.21.0` / npm `11.19.0`: focused grounding-context test passed 7/7; `npm run db:test` passed all 10/10 files (77 tests); `npm test` passed 156 tests total (web 5, Worker 62, database 77, evaluation casebook 12); `npm run typecheck` passed; `npm run build` passed (Vite production build and Wrangler dry-run). WSL `git diff --cached --check` passed for the follow-up implementation, and `git diff --check` was rerun after updating this handoff.

## Limitations and remaining decisions

Persistence and authorization evidence uses authored synthetic fixtures in PGlite only. It does not establish Neon/hosted PostgreSQL behavior or hosted role membership, and the role is intentionally not wired to a Worker or provider. No retrieval, model assessment, proposal creation, API/publication path, source access, deployment, or live data was introduced. There are no contract or design changes requiring a new decision; root review and integration remain outstanding.
