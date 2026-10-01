# DATA-02-EMBEDDING-PERSIST-CORE handoff

- **Status:** Implemented; root review and acceptance pending.
- **Branch:** `work/DATA-02-EMBEDDING-PERSIST-CORE`
- **Worktree:** `C:\Users\perry\.codex\worktrees\l1-fixture-runner-core\RPL` (`/mnt/c/Users/perry/.codex/worktrees/l1-fixture-runner-core/RPL`)
- **Base:** `63def4eab330773ac2537de77b28bac3b1c31028`
- **Implementation commit:** `5e4199a2a39ab15fefb14e16943335b7369e0886` — `feat(DATA-02): persist embedding metadata and vectors`

## Delivered

Added a typed L1 embedding-run repository with atomic create-or-verify behavior. It snapshots and validates the closed schema 2.0 metadata and vector before the first asynchronous operation, stores the validated float32 representation, and compares timestamps at microsecond precision after normalizing valid RFC3339 offsets. Inputs with more than six fractional-second digits, malformed identities, out-of-range dimensions, non-finite or float32-overflowing values, and cosine vectors that become zero are rejected before SQL.

Persistence verifies the same-dataset trace, exact chunk and revision hash, Unicode-code-point span text, and eligible revision state. The run metadata and vector are inserted within one transaction. Exact storage-equivalent replays return `replayed`; changed identity or vector data fails closed. Exact replay of an invalidated run returns `unavailable` without updates. Failed runs, absent or mismatched vectors, and other integrity drift are not repaired or reactivated. Tests compose persistence with real chunk invalidation and semantic retrieval under the existing L2 reader role.

Migration 022 adds only column-level SELECT grants needed by L1 to verify embedding-run metadata and stored vectors. It adds no SELECT grant on evidence chunks and does not alter existing INSERT or status-only UPDATE grants. The repository factory registers the new port. No dependencies or runtime configuration changed.

## Changed paths

- `apps/db/src/embedding-runs.ts`
- `apps/db/src/ports.ts`
- `apps/db/migrations/022_l1_embedding_verification_reads.sql`
- `apps/db/test/embedding-runs.test.ts`
- `apps/db/test/migrations.test.ts` — migration 022 inventory/staging assertions only
- `apps/db/test/public-event-updates.test.ts` — migration 022 staging assertion only
- `docs/assignments/DATA-02-EMBEDDING-PERSIST-CORE-HANDOFF.md`

## Verification

All project checks used WSL Ubuntu-26.04 with Node.js 24.21.0 and npm 11.19.0. Installed key versions observed with `npm ls --depth=0`: PGlite 0.5.8, pgvector PGlite extension 0.0.9, PostGIS PGlite extension 0.2.8, pg 8.16.3, TypeScript 7.0.2, Vite 8.3.0, and Wrangler 4.137.0.

- Focused embedding, migration, and public-update tests: 24/24 passed.
- `npm run db:test`: all 23/23 DB test files passed.
- `npm test`: passed; web 60/60, worker 357/357, DB 23/23 files, evaluation 12/12.
- `npm run typecheck`: passed.
- `npm run build`: passed, including Vite production build and Wrangler `deploy --dry-run --outdir dist`; no deploy occurred.
- `git diff --check 63def4eab330773ac2537de77b28bac3b1c31028..HEAD`: passed.

## Review and failure history

An early lineage-test fixture attempted to mutate an immutable report revision and was rejected by the database. The fixture was replaced with a deliberately malformed persisted chunk row, and focused tests passed on rerun. An initial typecheck also flagged an unused import; it was removed and typecheck passed on rerun.

Root review prompted validated metadata snapshots before asynchronous SQL, storage and equality using the same validated float32 vector snapshot, and removal of the unused `evidence_chunks.trace_id` SELECT and grant. Coverage was added for exact replay of a failed run with its vector present, denied new-run states including quarantined, superseded, and retracted, and semantic retrieval under the existing L2 reader role.

The implementation files remained unchanged after root's hash-bound 24/24 focused test check.

## Limits and follow-up

PGlite coverage does not establish independent PostgreSQL/Neon or multi-session concurrency correctness. Semantic tests validate retrieval composition and identity filtering, not embedding quality. No provider was selected or invoked. Migration 022 has not been applied to a hosted database.

The separately confirmed stale replay behavior in the existing evidence-chunk writer remains outside this assignment and is owned by the root follow-up; this package does not edit that writer.
