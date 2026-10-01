# LIFE-01 Freshness Ledger Core Handoff

Status: implementation is committed and ready for root review. Reviewer acceptance remains outstanding.

## Branch and commits

- Branch: `work/LIFE-01-FRESHNESS-LEDGER-CORE`
- Worktree: `/mnt/c/Users/perry/.codex/worktrees/life-01-freshness-ledger-core/RPL`
- Base: `838bc679cd4bd9c70c41951d6c86168d312c9239`
- Implementation commit: `1c07ddd6e6cfa5453963c6c8afba15a67dd6f129` — `feat(LIFE-01): add append-only freshness transition ledger`
- This handoff is committed separately; its commit SHA is reported with the implementation SHA to the root reviewer.

## Delivered behavior

Migration 024 creates a private append-only `freshness_transitions` ledger and dataset-scoped evidence-reference links. Each transition is bound to an exact published event version; an impact transition also has a composite foreign key to the exact impact version referenced by that event version. Database guards verify the target is still the latest published event version, the base record has a valid freshness status, and the requested sequence and previous status follow the last transition. A deferred constraint requires linked evidence for `new_applicable_evidence_evaluated`. Both ledger tables reject updates and deletes.

The insert guard takes the same per-event advisory transaction lock as the publication writer, `hashtextextended('waspada:publication-event:' || event_id, 0)`. That lock serializes the latest-publication check with publication-version inserts and remains held through commit. The repository also takes a separate advisory transaction lock for each idempotency key before replay lookup.

The repository validates and snapshots a closed request, fingerprints its canonical payload with SHA-256, returns the identical stored transition and evidence links on a same-payload replay, and returns a conflict for changed-payload key reuse or stale target/sequence state. It writes a row only for a status change. The Layer 4 recorder calls the existing pure `evaluateFreshnessTransition` policy, accepts its evaluation time from the caller, supports only event claim-set or exact impact targets, skips persistence on no-op evaluations, and requires the exact evidence-reference IDs for stale-to-current recovery.

A standalone `waspada_l4_freshness_writer` role is `NOLOGIN` and `NOINHERIT`. Its grants are limited to the fields needed to validate targets, replay ledger rows, insert transitions, and add evidence links. It cannot insert an identity value or rewrite publication/event/impact state. `PUBLIC`, L1, L2, and publication-writer roles have no direct ledger access. Public contracts and DTOs, event/impact JSON, publication decisions, outbox rows, and publication behavior are unchanged; no freshness rows are backfilled by the migration.

The isolated PGlite fixture seeds minimal synthetic publication-decision rows solely to satisfy the existing event-version foreign key. Those rows are fixture setup only: the recorder and repository never create publication decisions or outbox rows, and tests snapshot/assert that decisions, outbox rows, event JSON, and impact JSON remain unchanged across recorder calls.

The root authorized one migration-order fixture update outside the original allowed-path list: `apps/db/test/public-event-updates.test.ts` now excludes migration 024 during its staged pre-016 setup and includes 024 in the subsequent expected migration list. The first full DB run exposed that 024 was otherwise applied before withheld migrations; the targeted fixture and full suite passed after this ordering update. No other test behavior was changed.

## Changed paths

- `apps/db/migrations/024_freshness_transition_ledger.sql`
- `apps/db/src/freshness-transition-ledger.ts`
- `apps/db/test/freshness-transition-ledger.test.ts`
- `apps/db/test/migrations.test.ts`
- `apps/db/test/public-event-updates.test.ts` (root-authorized migration-order fixture update)
- `apps/worker/src/layers/l4-application-integration/freshness-transition-recorder.ts`
- `apps/worker/test/l4-freshness-transition-recorder.test.ts`
- `apps/worker/package.json` (focused recorder test registration only)
- `docs/assignments/LIFE-01-FRESHNESS-LEDGER-CORE-HANDOFF.md`

## Verification

All project commands were run in WSL Ubuntu-26.04 using the existing dependency tree. No package was installed and no external service was used. Captured versions: Node `v24.21.0`, npm `11.19.0`, Git `2.53.0`, PGlite `0.5.8`, tsx `4.23.15`, TypeScript `7.0.2`, Vite `8.3.0`, and Wrangler `4.137.0`.

- `cd apps/worker && tsx --test test/l4-freshness-transition-recorder.test.ts` — 5/5 passed.
- `cd apps/db && tsx --test test/freshness-transition-ledger.test.ts` — 10/10 passed.
- `cd apps/db && tsx --test test/public-event-updates.test.ts` — 4/4 passed after the authorized fixture update.
- `npm run db:test` — 26/26 DB test files passed.
- `npm test` — exit 0; web 60/60, worker 382/382, DB 26/26 files, evaluation casebook 12/12.
- `npm run typecheck` — passed.
- `npm run build` — passed; web production build succeeded and Wrangler ran with `--dry-run`.
- `git diff --check 838bc679cd4bd9c70c41951d6c86168d312c9239..HEAD` — passed for the implementation commit. The same requested range check was repeated after the separate handoff commit and its final result is in the root handoff message.

## Limits and remaining review

Database integration coverage uses isolated synthetic PGlite fixtures; no live Neon/PostgreSQL service was contacted. The migration adds no historical transition rows, and no scheduler, ambient clock, public reader projection, API/DTO change, provider behavior, or publication/outbox path was added. Root review should verify the branch diff, migration privileges/ordering, the shared publication lock contract, and the fixture clarification before integration.
