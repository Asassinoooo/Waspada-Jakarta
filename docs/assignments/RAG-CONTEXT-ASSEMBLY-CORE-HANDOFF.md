# RAG-CONTEXT-ASSEMBLY-CORE implementation handoff

- **Branch/worktree:** `work/RAG-CONTEXT-ASSEMBLY-CORE`; `D:\Projects\RPL\.codex-build\worktrees\rag-context-assembly-core` (WSL: `/mnt/d/Projects/RPL/.codex-build/worktrees/rag-context-assembly-core`)
- **Implementation commit:** `6a2ee3be0267a605ac0c4e6224f9f1c079549475` — `feat(RAG-CONTEXT-ASSEMBLY-CORE): rehydrate exact grounding spans`
- **Handoff commit:** separate commit immediately after the implementation commit; its SHA and exact message are reported in the agent handoff.
- **Changed paths:**
  - `apps/db/src/evidence-retrieval.ts`
  - `apps/db/test/evidence-retrieval.test.ts`
  - `apps/worker/package.json` (test discovery only)
  - `apps/worker/src/layers/l2-model-grounding/grounding-context.ts`
  - `apps/worker/test/l2-grounding-context.test.ts`
  - `docs/assignments/RAG-CONTEXT-ASSEMBLY-CORE-HANDOFF.md`

The database module now exposes an injected exact-span reader. It queries by dataset, evidence-reference ID, and candidate ID; compares the persisted report revision, text hash, offsets, Unicode code-point unit, relation, and revision status with the retrieval snapshot; and returns only the bounded exact substring. Spans over 40,000 code points, missing references, and any stored identity/status mismatch fail with typed errors. Its query uses only the existing `waspada_l2_grounding_reader` column grants. The PGlite role test executes both retrieval and rehydration under `SET ROLE`, checks exact text around a supplementary Unicode character, rejects stale hash/offset/relation/status values, confirms an oversized request fails, and verifies an unrelated source restriction column remains inaccessible.

The Worker adapter accepts explicit selected evidence-reference IDs and caller-owned adjacent context. It rejects scan/result truncation, invalid-span omissions, mixed datasets or candidate IDs, duplicate/ambiguous natural identities, more than eight references, oversized spans, and any reader identity or exact-length mismatch. It rehydrates selected references in caller order, maps the four stored relations, source ID, publication/observation/retrieval times, revision states, and origin independence/dependencies into the closed schema 2.0 shape, and validates the final request with `validateReasoningRequest`. Candidate-event matches, prior decisions, missing fields, conflicts, and the required `sufficient` boolean are copied from the caller without assessment. A `sufficient: true` request with no selected exact evidence is rejected. A missing index version uses the documented `not_applicable` sentinel.

All test records and texts are authored synthetic fixtures. The stored hash is checked for equality between the evidence reference, report revision, and retrieval snapshot; the reader does not return or re-hash the whole report. The existing L1 revision creation path verifies the actual SHA-256 before storing the immutable report revision. The schema 2.0 reasoning request carries source ID, revision state, source timestamps, and origin lineage fields available in that contract; it has no source-registry status fields. PGlite establishes the local query/role boundary only; hosted PostgreSQL/Neon behavior and Worker/database runtime wiring remain unverified. No migration, grant, dependency, lockfile, model/provider, route, API, source, L3/L4, or publication change was made. No smoke test was needed because no route changed.

**Verification in WSL Ubuntu-26.04** used native Node.js `v24.21.0` and npm `11.19.0`. The existing lockfile versions include TypeScript `7.0.2`, tsx `4.23.15`, Wrangler `4.137.0`, PGlite `0.5.8`, PGlite PostGIS `0.2.8`, and PGlite pgvector `0.0.9`.

- Focused `tsx --test apps/db/test/evidence-retrieval.test.ts` — 14/14 passed under the PGlite harness.
- Focused `tsx --test apps/worker/test/l2-grounding-context.test.ts` — 6/6 passed.
- `npm run db:test` — passed, 10/10 DB files and 78 tests.
- `npm test` — passed, 179 tests total: web 5, Worker 84, DB 78, evaluation casebook 12.
- `npm run typecheck` — passed for web, Worker, DB, and evaluation tools.
- `npm run build` — passed typecheck, Vite production build, and Wrangler deploy dry-run.
- `git diff --check` and `git diff --cached --check` — passed in WSL with explicit `GIT_DIR` and `GIT_WORK_TREE` for the Windows-created worktree metadata.

The full suite passed before the final focused stale-status assertions were added; those final DB and Worker test files were rerun successfully, and final typecheck/build passed after the last source edit. No external provider or live source was contacted. No remaining implementation decision was needed; root review and integration remain pending.
