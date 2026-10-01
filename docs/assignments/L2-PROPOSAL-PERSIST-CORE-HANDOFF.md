# L2-PROPOSAL-PERSIST-CORE handoff

- **Status:** Implementation complete; root review and acceptance pending.
- **Branch:** `work/L2-PROPOSAL-PERSIST-CORE`
- **Worktree:** `C:\Users\perry\.codex\worktrees\l1-fixture-runner-core\RPL` (`/mnt/c/Users/perry/.codex/worktrees/l1-fixture-runner-core/RPL`)
- **Assigned base:** `20757bfaa61d25399fd8563583ec2311f8504446`
- **Runtime:** WSL Ubuntu-26.04; Node `v24.21.0`; npm `11.19.0`; existing dependencies, no install.
- **Commits:** `310f27d` - `docs(L2): preserve refreshed investigation trace lineage` (root clarification cherry-picked per instruction); `fbf190ff2abd9b968c9787fade5349b8e5afb348` - `feat(L2): persist grounded event proposal drafts`; `42dd61d07b87e575596266631a019b435b4a3854` - `test(L2): exercise proposal writer under narrow role`. A separate documentation-only handoff commit records this report.

## Behavior implemented

Added a transaction-required, typed canonical schema-2.0 private draft writer. It snapshots and validates the closed input before asynchronous work under ADR-036's local budgets, preserves timestamp precision and uncertain/stale evidence provenance, and resolves trace, candidate, grounding context, every evidence relation, support-origin coverage, and optional event or investigation lineage before writing. Initial investigation context must match the immutable request trace; a refreshed context may match its exact persisted checkpoint trace/context and target while retaining the request's immutable dataset/candidate/target pair.

The writer serializes `(dataset_kind, proposal_id)` with a deterministic transaction-scoped advisory lock. It writes the proposal and normalized claim/evidence/origin rows atomically. Exact complete replay succeeds; payload, normalized metadata, link-set drift or incomplete stored rows conflict without repair. Validation, reference, conflict, and storage errors are stable and do not expose input content or raw database errors. The writer does not assess source eligibility or semantic support, invoke a model, map reasoning results, or grant publication authority.

Migration 023 changes only the private draft claim label/text constraints and adds a clamped `NOLOGIN NOINHERIT` proposal-writer role with narrow lineage/replay reads and proposal select/insert. It grants no update/delete, sequence, membership, context/case write, or publication write access. Existing public claim constraints, publication roles and APIs remain unchanged. No application configuration or dependency changes are required; migration 023 must be applied for the writer role/schema alignment.

## Changed paths

The implementation commit changes:

- `apps/db/src/event-proposals.ts`
- `apps/db/src/ports.ts`
- `apps/db/migrations/023_l2_event_proposal_writer.sql`
- `apps/db/test/event-proposals.test.ts`
- `apps/db/test/migrations.test.ts`
- `apps/db/test/public-event-updates.test.ts`

The required lineage clarification commit also updates:

- `docs/DELIVERY_LOG.md`
- `docs/assignments/L2-PROPOSAL-PERSIST-CORE.md`
- `docs/decisions/ADR-036-event-proposal-persistence.md`

This report is `docs/assignments/L2-PROPOSAL-PERSIST-CORE-HANDOFF.md`.

## Verification

All commands ran sequentially in WSL with the runtime versions above.

- `node --import tsx --test --test-concurrency=1 apps/db/test/event-proposals.test.ts apps/db/test/migrations.test.ts apps/db/test/public-event-updates.test.ts` - exit 0; 25 tests, 3 suites passed.
- `npm run db:test` - exit 0; all 24 database test files passed.
- `npm test` - exit 0; 357 web/worker tests, all 24 database test files, and 12 evaluation tests passed.
- `npm run typecheck` - exit 0 across the configured workspaces.
- `npm run build` - exit 0; Vite build and Wrangler deploy dry-run completed. Wrangler reported a 560.49 KiB upload bundle and exited in dry-run mode; nothing was deployed.
- `git diff --check 20757bfaa61d25399fd8563583ec2311f8504446..HEAD` - exit 0 after commits; no whitespace errors.
- Final worktree status - clean on `work/L2-PROPOSAL-PERSIST-CORE`.

The tests use authored synthetic fixtures and local PGlite transaction/role boundaries. They cover creation/replay, empty abstention, draft labels and 4,000-character claims, claim-specific provenance, all four grounded evidence relations, missing/mismatched lineage, refreshed different-trace lineage, replay drift and incomplete rows, rollback, copied input, bounded malformed data, error redaction, migration reapplication, retained public restrictions, a successful `createOrVerify` under `SET ROLE waspada_l2_proposal_writer`, and denied unrelated access.

## Limitations and review

Root review and acceptance remain pending. Sequential PGlite checks establish the local transaction and access behavior but do not prove concurrent behavior under hosted PostgreSQL/Neon. The advisory lock is implemented but no concurrent database test was run. Semantic truth, source eligibility, corroboration independence, publication authorization, authenticated moderation, hosted configuration and live data behavior are outside this slice and remain unverified. No model/provider or external source was enabled or called.
