# RAG-ACCESS-01 — Least-privilege Layer 2 retrieval reader

- **Status:** Assigned for local synthetic implementation
- **Depends on:** DATA-01, DATA-02-CORE, RAG-CORE
- **Requirements:** FR-05, FR-06, FR-07; NFR-01, NFR-05, NFR-07
- **Architecture:** Layer 2 database access; read-only retrieval
- **Branch/worktree:** `work/RAG-ACCESS-01-l2-reader`; `.codex-build/worktrees/rag-access-01`
- **Owner:** GPT-6 Luna Max implementation agent; root plans and reviews
- **Decision:** [ADR-011](../decisions/ADR-011-l2-grounding-reader.md)

## Objective

Make the accepted RAG-CORE SQL query usable under a dedicated least-privilege database role, without using a migration owner or broad L1/L4 privileges. This is a local authorization slice only; it does not add an application login or connect a hosted service.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md`
- `docs/IMPLEMENTATION_BACKLOG.md`
- `docs/ARCHITECTURE.md`
- `docs/decisions/ADR-011-l2-grounding-reader.md`
- `docs/assignments/DATA-01.md`
- `docs/assignments/DATA-02-CORE.md`
- `docs/assignments/RAG-CORE.md`
- `apps/db/migrations/001_foundation.sql`
- `apps/db/migrations/003_evidence_chunk_pipeline_reads.sql`
- `apps/db/src/evidence-retrieval.ts`
- `apps/db/test/evidence-retrieval.test.ts`
- `apps/db/test/harness.ts`

## Scope and required behavior

- Add only migration `apps/db/migrations/004_l2_grounding_reader.sql`, migration and retrieval role tests in `apps/db/test/migrations.test.ts` and `apps/db/test/evidence-retrieval.test.ts`, and this assignment's implementation handoff.
- Create `waspada_l2_grounding_reader` as an idempotent `NOLOGIN` group role, grant usage on the `waspada` schema, and grant column-level `SELECT` for exactly the columns referenced by RAG-CORE in `source_registry`, `report_revisions`, `evidence_references`, `extraction_evidence`, `extraction_results`, `geometries`, `geometry_evidence`, `evidence_origins`, `origin_evidence`, `origin_dependencies`, `evidence_chunks`, `embedding_runs`, and `embedding_vectors`.
- Inspect every `SELECT`, `JOIN`, `WHERE`, `ORDER BY`, geometry expression, and vector expression in `apps/db/src/evidence-retrieval.ts` to determine the exact required columns. Do not use table-wide `SELECT` as a shortcut.
- Verify the real `createSqlEvidenceRetrievalRepository` query against synthetic fixtures after `SET ROLE waspada_l2_grounding_reader`. Cover the non-semantic and semantic query paths and geometry/origin access. Ensure `RESET ROLE` runs even on assertion failure.
- Verify that the role can neither insert/update/delete these records nor read unrelated source/report/audit fields that are not required by the retrieval query. Do not add a grant to existing L1, L4, or public roles.
- Keep dataset filtering in the existing required retrieval query parameter; the role is internal and dataset kinds are not separate tenants in this prototype. Do not add public dataset switching or claim row-level security.
- Preserve the exact RAG-CORE behavior. Do not change query contracts, add RLS or login roles, alter migrations 001–003, introduce Worker/Neon wiring, add dependencies, or access external providers.

## Allowed paths

- `apps/db/migrations/004_l2_grounding_reader.sql`
- `apps/db/test/migrations.test.ts`
- `apps/db/test/evidence-retrieval.test.ts`
- This assignment's implementation handoff only

Root owns ADR, architecture, backlog, and checkpoint edits. If PGlite cannot demonstrate the query under the restricted role or the existing schema requires broader access than this assignment allows, stop and report the precise missing privilege or extension permission; do not widen access independently.

## Acceptance and checks

- The role has only schema usage and required column-level reads; it has no writes, sequence permissions, or access through the changed grants to unrelated private columns.
- Existing hybrid retrieval tests still pass under the database owner. At least one complete real retrieval query passes under the restricted role for each applicable geometry and semantic branch.
- Dataset scoping and RAG-CORE result behavior remain unchanged. No sufficiency, factuality, or retrieval-quality claim is introduced.
- In WSL Ubuntu-26.04 run `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`. No smoke test is needed; no route or runtime wiring changes.
- Commit all work on this task branch with descriptive messages, leave a clean worktree, and report exact commits, changed paths, actual results, privilege coverage, and limitations. Do not push or merge.

## Implementation handoff

The implementation agent appends its branch/worktree, commit SHAs/messages, changed paths, behavior, actual checks, limitations, and any scope issue here. Root reviews and accepts the task before integration.
