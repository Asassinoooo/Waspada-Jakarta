# DATA-02-EMBEDDING-GENERATION-CORE — implementation handoff

- **Branch:** `work/DATA-02-EMBEDDING-GENERATION-CORE`
- **Worktree:** `/mnt/d/Projects/RPL/.codex-build/worktrees/data-02-embedding-generation-core`
- **Assigned base:** `ff7de506c3d4f9833956e9d0bcb850a0e328273a`
- **Implementation commit:** `35e2ecd` — `feat(DATA-02): generate and persist validated embeddings`
- **Handoff commit:** committed separately as `docs(DATA-02): record embedding generation handoff`; its full SHA is reported with the branch result.

## Changed paths

- `apps/worker/src/layers/l1-data-knowledge/embedding-generation.ts`
- `apps/worker/test/embedding-generation.test.ts`
- `apps/db/test/embedding-generation-composition.test.ts`
- `docs/assignments/DATA-02-EMBEDDING-GENERATION-CORE-HANDOFF.md`

## Behavior

The L1 runner accepts a closed request with caller-owned dataset, trace ID, embedding run ID, timestamp, and an L1 chunk. It checks the request and timestamp before invoking the injected validated `ModelCapabilityAdapter.embed` once, then explicitly projects only the existing L2 chunk fields. Only a validated success is mapped to the schema 2.0 embedding-run metadata and persisted through the existing `EmbeddingRunRepository.createOrVerify`, with the vector passed separately. Results use fixed closed outcomes for adapter and repository failures. The caller supplies and must reuse run identity and timestamp for retries; exact retries replay, changed vector identity conflicts, and invalidated chunks remain unavailable.

The tests use authored synthetic fixtures and deterministic provider doubles. The PGlite composition verifies provider-before-transaction ordering, exact persisted metadata/vector and timestamp, stable replay, L2 semantic retrieval, no-write failures, conflict immutability, invalidation behavior, and unchanged publication/outbox counts.

## Verification

All project checks ran in WSL Ubuntu-26.04 with Node `v24.21.0` and npm `11.19.0`. Relevant installed versions were PGlite `0.5.8`, PGlite pgvector `0.0.9`, PGlite PostGIS `0.2.8`, `tsx` `4.23.15`, TypeScript `7.0.2`, Vite `8.3.0`, and Wrangler `4.137.0`.

- Focused Worker test: passed, 3/3.
- Focused PGlite composition test: passed, 3/3.
- `npm run db:test`: passed, 39/39 database test files.
- `npm test`: passed; web 60/60, Worker 431/431, database 39/39 files, evaluation casebook 12/12.
- `npm run typecheck`: passed.
- `npm run build`: passed; web production build completed and Worker Wrangler dry-run completed without deployment.
- Staged implementation whitespace check: `git diff --cached --check` passed. The required assigned-base-to-HEAD check is reported after the handoff commit in the branch result.

No API keys, network provider calls, live source data, dependency installation, or external service was used. A temporary `node_modules` symlink to the existing root dependency cache was used for local checks and removed before handoff.

## Limitations and impact

No real provider was selected or configured, and the tests make no semantic-quality or provider-performance claim. The runner adds no retry loop, clock or ID generation, queue, Worker binding, L3 call, or publication behavior. No migration, grant, schema, package, or runtime-configuration change is required. No additional architecture decision remains for this slice.
