# LIFE-01-L2-SOURCE-REVISION-GROUNDING-GATE-CORE handoff

## Branch and commits

- Branch: `work/LIFE-01-L2-SOURCE-REVISION-GROUNDING-GATE-CORE`
- Worktree: `/mnt/d/Projects/RPL/.codex-build/worktrees/life01-l2-source-invalidation-grounding-gate-core`
- Base: `6e2b88bfe6ae57bc896af41586abaecc3ee6c005`
- Implementation commit: `270290ecd117912ffff4bc4c0a937a70b31a9565` — `fix(l2): block source-invalidated exact spans`
- Handoff commit message: `docs(LIFE-01): record source revision grounding gate handoff`

The handoff commit SHA is reported in the orchestrator handoff message after this document is committed.

## Behavior and scope

The bounded exact-span SQL read now checks for any `superseded`, `retracted`, or `withdrawn` assertion matching the exact dataset and report revision. It returns `NULL` for exact span text in the same SQL snapshot when blocked, even if a `current` assertion also exists. Missing observations and current-only observations preserve existing reads; observations for an identical revision ID in another dataset do not affect the read. The database reader returns the redacted `source_invalidated` error, which L2 maps to a fixed typed context error before constructing model input.

Migration 030 grants the existing `waspada_l2_grounding_reader` column-only `SELECT` for `dataset_kind`, `target_report_revision_id`, and `asserted_state`. Tests verify no other role, schema, membership, or object grants change; no observation-table writes or table-level reads are added; and the pre-existing exact-span `permitted_text` grant remains unchanged. Synthetic PGlite coverage verifies denial and no returned text under `SET ROLE`, the mixed-current case, the cross-dataset case, and that blocked rehydration performs no reasoning/proposal/publication/freshness writes and leaves published rows and freshness unchanged.

No schema 2.0 grounding payload, model prompt, public API/OpenAPI/DTO, publication, freshness, acquisition, or hosted configuration changed. Migration 030 is additive and requires no data backfill. No dependencies were installed and no external source or provider was contacted.

## Changed paths

- `apps/db/migrations/030_l2_source_revision_grounding_gate.sql`
- `apps/db/src/evidence-retrieval.ts`
- `apps/db/test/evidence-retrieval.test.ts`
- `apps/db/test/migrations.test.ts`
- `apps/db/test/public-event-updates.test.ts`
- `apps/db/test/rag-grounded-proposal-roundtrip.test.ts`
- `apps/worker/src/layers/l2-model-grounding/grounding-context.ts`
- `apps/worker/test/l2-grounding-context.test.ts`
- `docs/assignments/LIFE-01-L2-SOURCE-REVISION-GROUNDING-GATE-CORE-HANDOFF.md`

## Verification

All commands ran in WSL Ubuntu 26.04 using the existing workspace dependencies: Node `v24.21.0`, npm `11.19.0`, PGlite `0.5.8`, tsx `4.23.15`, Vite `8.3.0`, and Wrangler `4.137.0`.

- Focused DB and L2 tests (`node --import tsx --test apps/db/test/evidence-retrieval.test.ts apps/worker/test/l2-grounding-context.test.ts apps/db/test/migrations.test.ts apps/db/test/public-event-updates.test.ts apps/db/test/rag-grounded-proposal-roundtrip.test.ts`): **45/45 passed** after the final type-import change.
- `npm run db:test`: **34/34 DB test files passed**.
- `npm test`: web **60/60 passed**, Worker **424/424 passed**, DB **34/34 test files passed**, evaluation **12/12 passed**.
- `npm run typecheck`: passed.
- `npm run build`: passed; web production build completed and Wrangler Worker dry-run completed without deployment.
- `git diff --check 6e2b88bfe6ae57bc896af41586abaecc3ee6c005..HEAD`: passed for the implementation commit. The same check is rerun after this handoff commit.

## Limitations and remaining decisions

Validation uses authored synthetic fixtures and PGlite only. No live database, source/provider, hosted configuration, or deployment was used. No implementation decision remains; root review and acceptance are pending.
