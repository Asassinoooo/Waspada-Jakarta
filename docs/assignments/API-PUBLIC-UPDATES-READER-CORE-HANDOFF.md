# API-PUBLIC-UPDATES-READER-CORE handoff

- **Branch:** `work/API-PUBLIC-UPDATES-READER-CORE`
- **Worktree:** `C:\Users\perry\.codex\worktrees\api-updates-reader-core\RPL` (`/mnt/c/Users/perry/.codex/worktrees/api-updates-reader-core/RPL`)
- **Implementation commit:** `4341a2ab3296ce1ada74d62e919d0f96b1fd39c6` — `feat(db): add transactional public update reader`

## Changed paths

- `apps/db/migrations/016_public_update_feed_order.sql`
- `apps/db/src/public-event-updates.ts`
- `apps/db/test/public-event-updates.test.ts`
- `apps/db/test/migrations.test.ts`
- `docs/assignments/API-PUBLIC-UPDATES-READER-CORE-HANDOFF.md`

## Behavior

Migration 016 assigns a deterministic baseline sequence to preexisting review decisions and initializes a private singleton counter from that watermark. A `BEFORE INSERT` trigger overrides any supplied sequence using a transactional row update; its row lock remains held until commit or rollback, and missing or overflowed counter state fails closed. The one-time legacy backfill order is deterministic but does not claim to reconstruct historical commit order.

The migration adds separate security-barrier watermark and candidate views. The candidate view selects the latest decision across all statuses, then exposes only approved metadata joined through `public_event_history_versions`, so latest withdrawals hide every version. Both views omit reviewer IDs; only `waspada_public_reader` receives `SELECT`. Migration 014's internal history disclosure view and grant remain unchanged.

The reader exposes `readWatermark()` as a validated decimal string and bounded `readCandidates()` pages. It validates signed-64-bit decimal sequence bounds and page size before SQL, queries strictly after the lower bound through the upper bound, orders by the underlying bigint sequence, probes `limit + 1`, validates closed result shapes, and returns internal candidates without serializing raw rows as an API DTO.

## Checks

Runtime used WSL Ubuntu-26.04 Node.js `v24.21.0` and npm `11.19.0`; existing dependency packages were reused through a temporary ignored symlink to the root cache. No dependencies were installed, and the symlink was removed after verification.

- `npm run db:test` — passed; all 20/20 DB test files passed. The focused `public-event-updates.test.ts` passed 4/4 tests, and `migrations.test.ts` passed 9/9.
- `npm run db:typecheck` — attempted but unavailable at tested baseline `77afb73` because the root package had no such script. The equivalent existing command, `npm run typecheck --workspace=@waspada/db`, passed.
- `git diff --check` — passed (exit 0); `git diff --cached --check` also passed before the implementation commit.

## Limitations and impact

PGlite provides one session, so simultaneous-transaction stress coverage was not performed. The transactional `UPDATE` row lock is the ordering mechanism; hosted Neon behavior remains unverified. Migration 016 is additive, with no runtime configuration, dependency, secret, provider, or deployment change. The later runtime must read the watermark and candidates in its request-scoped repeatable-read transaction as specified by ADR-026.

No unresolved decision blocks this DB-only work package. HTTP, Layer 4 projection, cursor handling, Worker wiring, and browser polling remain separate tasks.
