# L3-LEDGER-CORE implementation handoff

**Branch:** `work/L3-LEDGER-CORE`
**Worktree:** `D:\Projects\RPL\.codex-build\worktrees\l3-ledger-core`
**Base:** `a1a62d7`
**Implementation commit:** `ed0f307` — `feat(L3-LEDGER-CORE): add durable bounded investigation ledger`

## Delivered

Migration `008_l3_investigation_ledger.sql` allows checkpoint grounding-context refresh without changing the request's initial context, adds internal action reservations and transition guards, and creates the `NOLOGIN` role `waspada_l3_coordinator` with narrow ledger and grounding-context column grants. The typed SQL repository creates cases only from persisted insufficient contexts with exact dataset, candidate, and trace linkage; appends schema 2.0 snapshots; supports same-candidate context refresh; and handles version-checked pause/resume/termination, atomic preflight reservations, idempotent starts, bounded reconciliation, interrupted timeout accounting, and safe release of uninvoked reservations. It does not invoke tools/models or publish.

Tests use authored synthetic PGlite fixtures. Coverage includes the create/reserve/start/reconcile path, input and linkage rejection, request/reservation replay conflicts, refreshed context and preserved identity/budget, failed/denied/cancelled/timed-out/succeeded usage, hard/configured bounds, safe release, and coordinator-role grants/denials.

## Changed paths

- `apps/db/migrations/008_l3_investigation_ledger.sql`
- `apps/db/src/investigation-ledger.ts`
- `apps/db/test/investigation-ledger.test.ts`
- `apps/db/test/migrations.test.ts`
- `docs/assignments/L3-LEDGER-CORE-HANDOFF.md` (this handoff commit)

## Verification

All commands ran in WSL Ubuntu-26.04 with `/home/perry/.local/opt/waspada-node-v24.21.0/bin` prepended to `PATH`. Runtime versions were `node v24.21.0` and `npm 11.19.0`.

Individual DB test files passed in separate, sequential WSL processes:

| Command suffix from the worktree root | Result |
| --- | ---: |
| `../../../node_modules/.bin/tsx --test apps/db/test/evidence-chunks.test.ts` | 5/5 |
| `../../../node_modules/.bin/tsx --test apps/db/test/evidence-retrieval.test.ts` | 12/12 |
| `../../../node_modules/.bin/tsx --test apps/db/test/geometry-writer.test.ts` | 7/7 |
| `../../../node_modules/.bin/tsx --test apps/db/test/investigation-ledger.test.ts` | 6/6 |
| `../../../node_modules/.bin/tsx --test apps/db/test/migrations.test.ts` | 8/8 |
| `../../../node_modules/.bin/tsx --test apps/db/test/persistence.test.ts` | 9/9 |
| `../../../node_modules/.bin/tsx --test apps/db/test/publication-writer.test.ts` | 10/10 |
| `../../../node_modules/.bin/tsx --test apps/db/test/queue.test.ts` | 10/10 |
| `../../../node_modules/.bin/tsx --test apps/db/test/synthetic-fixture-pipeline.test.ts` | 1/1 |

The focused ledger command was `../../../node_modules/.bin/tsx --test apps/db/test/investigation-ledger.test.ts` and passed 6/6; migration/role coverage passed 8/8.

Workspace verification results:

- `npm run db:test` was attempted twice in isolation and exited 1 both times. The first emitted Node's generic `Interrupted while running` for the DB test files; the second exited with no test diagnostics. There was no assertion failure reported.
- From `apps/db`, `node --import tsx --test --test-concurrency=1 test/*.test.ts` also exited 1 after the migration suite reported 8/8, without a final summary or diagnostic. No runner or test-concurrency configuration was changed.
- `npm test` passed the web suite 5/5 and worker suite 62/62, then exited 1 after starting the DB workspace, with no DB diagnostics.
- `npm run typecheck` passed for web, worker, DB, and evaluation.
- `npm run build` passed: typecheck, Vite production build, and Wrangler Worker dry-run.
- WSL `git diff --cached --check` passed. WSL Git was given explicit `GIT_DIR=/mnt/d/Projects/RPL/.git/worktrees/l3-ledger-core` and `GIT_WORK_TREE=/mnt/d/Projects/RPL/.codex-build/worktrees/l3-ledger-core` because the worktree's `.git` pointer contains a Windows-form path.

## Limitations and review

PGlite validates local SQL behavior and role grants but is not evidence of hosted PostgreSQL concurrency behavior. Bulk DB test runner failures remain unresolved despite every DB file passing individually; the root reviewer can decide whether a separate runner investigation is needed. No public schema/OpenAPI, Worker/web code, provider/tool/source behavior, dependency, lockfile, ADR, or contract changes were made. Migration 008 must be applied to a database before using this repository. Root review and integration remain pending.
