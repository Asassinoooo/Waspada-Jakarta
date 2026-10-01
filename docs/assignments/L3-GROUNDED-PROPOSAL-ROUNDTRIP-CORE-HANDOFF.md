# Handoff: L3-GROUNDED-PROPOSAL-ROUNDTRIP-CORE

**Status:** implementation complete; root review pending.
**Branch:** `work/L3-GROUNDED-PROPOSAL-ROUNDTRIP-CORE`
**Worktree:** `/mnt/c/Users/perry/.codex/worktrees/l3-grounded-proposal-roundtrip-core/RPL` (WSL Ubuntu-26.04)
**Assigned base:** `856c29a0377877a5acd43f7e2f9a1f061719e94c`

## Commits and paths

- `54e16f3220eb502a1bb2038b39299a91314da147` - `test(L3-GROUNDED-PROPOSAL-ROUNDTRIP-CORE): verify investigated proposal roundtrip`
- Handoff commit message: `docs(L3-GROUNDED-PROPOSAL-ROUNDTRIP-CORE): record bounded proposal roundtrip handoff` (its resulting SHA is reported in the completion message).

Changed paths:

- `apps/db/test/investigation-ledger.test.ts`
- `docs/assignments/L3-GROUNDED-PROPOSAL-ROUNDTRIP-CORE-HANDOFF.md`

## Behavior verified

The existing PGlite composition now persists an explicitly insufficient refs-only L2 context and proves the direct reasoning capability is not called before L3. Exactly one coordinator advance runs the bounded planner/action/refresh sequence, including the authored synthetic L1 fixture through SQL persistence and L2 retrieval of the exact revision/reference/span. Its refreshed context and typed reasoning request match the persisted refs-only record and the same investigation checkpoint.

The refreshed `sufficient: true` value is an explicit synthetic fixture input, not an evaluation. A deterministic reasoning double receives the exact refreshed request after the coordinator returns `sufficient_context`, and the canonical reasoning-proposal bridge persists a private schema 2.0 proposal. Assertions bind dataset, trace, candidate, context, investigation, revision, hash, span, relation, evidence reference, origin, and model run. Exact proposal replay creates no duplicate proposal, claim, evidence, or origin rows. The lineage independence value remains `unknown`; claim support is `uncertain`; the proposal evidence label is `under_review`. Existing L3 budget, reservation, checkpoint, replay, and no-raw-text checks remain in place. Counts verify no event-version, publication-decision, outbox, audit, or moderator writes.

An initial focused run exposed that the canonical proposal bridge requires persisted origin lineage. The fixture was extended within the allowed test path to persist an origin tied to the exact evidence reference, explicitly marked unknown; no contract or production code changed. Typecheck also caught optional checkpoint narrowing and a callback-assigned request not narrowing after the callback. The test now asserts the checkpoint and captures the request in a typed holder before bridge construction.

## Checks and environment

All commands ran in WSL Ubuntu-26.04 with the existing dependency tree and no installs. Versions: Node.js `v24.21.0`, npm `11.19.0`, Git `2.53.0`, PGlite `0.5.8`, TypeScript `7.0.2`, Wrangler `4.137.0`.

- `npm exec tsx -- --test apps/db/test/investigation-ledger.test.ts` - passed, 12/12 tests after the final synthetic claim wording correction.
- `npm run db:test` - passed, all 25 DB test files; run before that final wording-only fixture correction.
- `npm test` - passed: web 60 tests, worker 377/377, DB 25 test files, evaluation casebook 12/12; run before that final wording-only fixture correction.
- `npm run typecheck` - passed after the test-local narrowing fixes and final wording correction.
- `npm run build` - passed: typecheck, Vite production build, and Wrangler deploy dry-run; no deployment. Run before the final wording-only fixture correction.
- `git diff --check 856c29a0377877a5acd43f7e2f9a1f061719e94c..HEAD` - passed on the implementation commit; the final completion message records the rerun after the handoff commit.

## Limitations and impact

This is a synthetic integration test only. It establishes neither real-world factual support nor source rights, model quality, or actual report sufficiency. It uses PGlite and deterministic injected doubles; it makes no hosted Neon, concurrency, live provider, or runtime claim. No production behavior, schema, migration, API, package, dependency, or deployment configuration changed; migration and configuration impact are none. No remaining implementation decisions are known; root review and acceptance remain.
