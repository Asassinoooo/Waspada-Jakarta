# DATA-02-CORE — Deterministic text preparation and chunk persistence

- **Status:** Accepted after root review; local synthetic implementation merged to `main`
- **Depends on:** DATA-01, L2-ADAPTER-01
- **Requirements:** FR-03, NFR-07
- **Architecture:** Layer 1 processing and persistence; independent of L2 providers and L3 orchestration
- **Branch/worktree:** `work/DATA-02-core-text-pipeline`; `.codex-build/worktrees/data-02-core`; merged into `main` as `31bf43e`
- **Owner:** GPT-6 Luna Max implementation agent; root plans and reviews

## Objective

Create a deterministic local path from already permission-screened report text to normalized, privacy-filtered text and persisted evidence chunks. Use synthetic fixtures and the existing `report_revisions`, `evidence_chunks`, and embedding metadata schema. The slice must produce exact, versioned hashes and Unicode code-point offsets that the L2 evidence contracts can consume.

## Read first

- `SOFTWARE_DEVELOPMENT_PLAN.md` — FR-03 and NFR-07
- `docs/IMPLEMENTATION_BACKLOG.md` — DATA-02-CORE and DATA-02
- `docs/DOMAIN_MODEL.md` — immutable revisions, evidence offsets, chunk/embedding lineage
- `docs/assignments/DATA-01.md` and `docs/assignments/L2-ADAPTER-01.md`
- `apps/db/migrations/001_foundation.sql` — existing report, chunk, embedding, and role schema
- `apps/worker/src/layers/l2-model-grounding/contracts.ts` — `EvidenceChunkInput`
- `AGENTS.md`

## Required behavior

- Accept text only from a caller that has already applied source access and reuse policy. Do not fetch, read, or scrape a source. Do not store or log the raw input.
- Implement a deterministic, explicitly versioned normalization transform. Normalize Unicode and line endings, bound input/output work, and compute separate SHA-256 digests for the source input and exact permitted output where required by the existing report revision contract. Do not infer event time, type, location, severity, or public safety meaning.
- Apply narrowly specified, deterministic contact-detail redaction to synthetic examples. Record only the redaction rule/count, never the matched value. State clearly in code and handoff that pattern matching is incomplete and is not a comprehensive PII detector or authorization to persist live reports.
- Chunk the exact normalized permitted text with bounded size/count and deterministic overlap. Emit stable IDs, `chunker_version`, `chunk_text_hash`, and zero-based, end-exclusive Unicode code-point spans. Every span must resolve exactly to its chunk text in the immutable revision. Align output fields with L2 `EvidenceChunkInput` without invoking an L2 capability.
- Add a typed DB repository operation that verifies dataset, revision, normalization version, text hash, chunk hashes, and spans against the persisted immutable `report_revisions` row. Store only chunk metadata and offsets in `evidence_chunks`; do not duplicate the text or write embeddings/vectors.
- Make persistence retries idempotent and reject an existing chunk ID with different lineage or content. When reprocessing the same immutable revision with a new chunker version, invalidate superseded active chunks and their available embedding-run metadata as one atomic database operation. Do not delete vector rows or mutate the report revision. If the existing executor/schema cannot support these guarantees, report the exact gap to root rather than changing a migration or contract unilaterally.
- Exercise the repository under `SET ROLE waspada_l1_pipeline`, not only as the migration owner. The L1 role must have only the column-level read access it needs for idempotent collision checks and old-chunk/embedding-run invalidation.
- Add meaningful unit and PGlite tests for Unicode/combining marks, emoji, privacy redaction, deterministic hashes/IDs, complete span coverage and overlap, size bounds, idempotence, dataset isolation, immutable revision checks, and old chunk/embedding invalidation. Use only clearly synthetic text and identities.

## Explicit exclusions

No network access, live acquisition, ingestion scheduler changes, source approval, raw source persistence, model/provider call, embedding generation, gazetteer/geocoding, location or event extraction, entity truth claims, RAG retrieval, publication, API/OpenAPI or UI change, new dependency, any migration other than the exact additive role-grant migration authorized below, cloud account, secret, paid service, or deployment. DATA-02 and RAG-01 remain separate follow-on work.

## Root-approved scope clarification — least-privilege L1 reads

A synthetic `SET ROLE waspada_l1_pipeline` persistence check confirmed SQLSTATE `42501` (`permission denied for table evidence_chunks`) in the atomic write: DATA-01 grants the L1 role `INSERT` on `evidence_chunks` and `UPDATE(status)` on chunks/runs but no `SELECT`, while collision and invalidation predicates must read existing metadata. The operation wrote no rows. Root therefore authorizes exactly one additive migration, `apps/db/migrations/003_evidence_chunk_pipeline_reads.sql`, plus migration and repository tests. Grant column-level `SELECT` on `evidence_chunks` for `dataset_kind`, `chunk_id`, `report_revision_id`, `permitted_text_hash`, `span_start`, `span_end`, `offset_unit`, `chunker_version`, `chunk_text_hash`, and `status`; and on `embedding_runs` for `dataset_kind`, `embedding_run_id`, `chunk_id`, and `status`. Do not grant table-wide `SELECT`, expose vectors or source text, alter migration 001/002, or expand any other role privilege. The repository test must exercise insert/retry and invalidation under `SET ROLE waspada_l1_pipeline` and verify that vector rows remain present.

## Allowed paths

- `apps/worker/src/layers/l1-data-knowledge/**`
- `apps/worker/test/**`
- `apps/worker/package.json`
- `apps/db/src/**`
- `apps/db/test/**`
- `apps/db/migrations/003_evidence_chunk_pipeline_reads.sql` only, under the scope clarification above
- This assignment's implementation handoff only

Root owns the backlog, architecture, and other planning documents. Do not change L2 contracts, database migrations other than the exact 003 grant migration authorized above, package lockfiles, root package manifests, public API contracts, or other assignments. If a new schema or executor contract beyond that grant is necessary, stop and ask root for a bounded scope decision.

## Acceptance and checks

- Processing is a pure Layer 1 transform before orchestration; repeat inputs produce byte-identical output and metadata.
- Hashes bind to the exact UTF-8 text, and offsets/counts use Unicode code points end to end. Sensitive fixture values are absent from persisted/logged metadata.
- Chunks preserve all normalized text through exact spans and declared overlap. Existing version rows are retained as invalidated history; current output is retry-safe.
- PGlite proves storage constraints and the exact `waspada_l1_pipeline` column privileges using synthetic rows, but makes no claim about Neon or multi-session locking.
- In WSL Ubuntu-26.04 run `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`. No smoke test is needed because this task does not change a runtime route.
- Commit all work on the assigned branch with descriptive messages. Leave the worktree clean and report exact commits, paths, check results, schema/configuration impact, limitations, and unresolved decisions. Do not push or merge.

## Implementation handoff

The implementation agent appends the branch and worktree, commit SHAs/messages, changed paths, behavior, actual checks, limitations, and any scope issue here. Root reviews and accepts the branch before integration.

### User checkpoint — 25 September 2026

The user asked to stop implementation and record the current state. Root interrupted the Luna Max implementation agent. The partial work is preserved locally on `work/DATA-02-core-text-pipeline` in `.codex-build/worktrees/data-02-core` at `e5d4fe1` (`wip(DATA-02-CORE): checkpoint interrupted text pipeline`). This is an unreviewed WIP snapshot, not a completed or accepted implementation, and it has not been pushed or merged.

The snapshot adds deterministic text-preparation and code-point chunking modules, an evidence-chunk repository, and a repository-port registration: `apps/worker/src/layers/l1-data-knowledge/text-preparation.ts`, `apps/worker/src/layers/l1-data-knowledge/evidence-chunking.ts`, `apps/db/src/evidence-chunks.ts`, and `apps/db/src/ports.ts`. No test files or package configuration were added before the stop. The implementation has not been compiled, tested, or reviewed for behavioral correctness. `git diff --cached --check` passed before the WIP commit. No tests or typecheck were run for this snapshot.

The next step after resumption is to review the existing changes against this assignment, continue the task on this branch, add the required synthetic unit and PGlite coverage, then run all listed WSL checks on the completed revision. Keep the branch based on or integrate it with the latest `main` documentation before acceptance; root has since added the RAG-CORE planning commit. Preserve the single-session PGlite limitation and do not push or merge this WIP before root review.

### Final implementation handoff — 25 September 2026

- **Branch/worktree:** `work/DATA-02-core-text-pipeline` / `D:\Projects\RPL\.codex-build\worktrees\data-02-core` (`/mnt/d/Projects/RPL/.codex-build/worktrees/data-02-core` in WSL); final implementation head `5d7ce2de13db5a0078b621085d11645b0238e947` before this handoff entry.
- **Implementation commits:** `e5d4fe11dd9a8d90e45303a2d05a26f3bd3e9069` — `wip(DATA-02-CORE): checkpoint interrupted text pipeline`; `8f4386c0679698c8f084057a8c3e6d9c4db97298` — `test(DATA-02-CORE): cover text and chunk persistence`; `5d7ce2de13db5a0078b621085d11645b0238e947` — `fix(DATA-02-CORE): grant L1 chunk metadata reads`. The root-approved scope update is `b3df14e82c56020c6dc77329af6bed1c5124867d` — `docs(DATA-02-CORE): authorize least-privilege metadata grants`, merged into this branch by `7d778ccab481b9bb241e6357992ca9c2f6d96b73` — `Merge branch 'main' into work/DATA-02-core-text-pipeline`.
- **Changed paths:** `apps/worker/src/layers/l1-data-knowledge/text-preparation.ts`, `apps/worker/src/layers/l1-data-knowledge/evidence-chunking.ts`, `apps/worker/package.json`, `apps/worker/test/l1-text-preparation.test.ts`, `apps/db/src/evidence-chunks.ts`, `apps/db/src/ports.ts`, `apps/db/test/evidence-chunks.test.ts`, `apps/db/test/migrations.test.ts`, and `apps/db/migrations/003_evidence_chunk_pipeline_reads.sql` (this assignment handoff only for documentation). Migrations 001/002, dependencies, lockfiles, public contracts, API/UI, and provider configuration were unchanged.
- **Behavior:** L1 applies versioned NFKC and line-ending normalization, bounded input/output work, and deterministic email/Indonesian-mobile pattern redaction. It returns SHA-256 digests for source input and exact permitted output plus rule counts only; matched values are omitted from metadata. Chunking emits stable IDs and hashes with exact Unicode code-point spans, 4,096-code-point maximum chunks, and 512-code-point overlap. The typed repository checks the dataset-scoped immutable revision, normalization/hash lineage, every chunk digest and span, then writes metadata only. One atomic SQL statement supports identical retries, rejects conflicting IDs without partial changes, and invalidates superseded active chunks and available embedding-run rows while retaining vector rows. Migration 003 grants `waspada_l1_pipeline` column-level `SELECT` only on the chunk and embedding metadata named in the approved scope. Migration assertions and repository tests exercise the operation under `SET ROLE waspada_l1_pipeline` and confirm the vector row remains present.
- **WSL verification:** Ubuntu-26.04, Node.js `v24.21.0`, npm `11.19.0`. `npm run db:test` passed 27/27; `npm test` passed 57/57 total (web 5, Worker 25, database 27); `npm run typecheck` passed; `npm run build` passed the TypeScript checks, Vite production build, and Wrangler deploy dry-run; `git diff --check` passed. No deployment occurred.
- **Limits:** contact matching is incomplete, is not comprehensive PII detection, and does not authorize live-report persistence. PGlite uses a single in-memory connection, so these checks do not establish multi-session locking, Neon behavior, or provider extension compatibility. No live source, model, embedding generation, Worker database wiring, or external service was exercised.
- **Configuration and remaining decisions:** the only schema change is the additive 003 column-read grant migration authorized by root; it grants no table-wide reads and exposes neither source text nor vector columns. No new dependency or application secret was added.

### Root review and acceptance — 25 September 2026

Root reviewed the final branch diff against the assignment and integrated it into `main` as `31bf43e` (`merge: accept DATA-02-CORE text preparation`). The change stays within the authorized paths and adds no provider, source, model, public API, or UI behavior. Root independently reran the required checks from the merged main worktree in WSL Ubuntu-26.04 using Node.js `v24.21.0` and npm `11.19.0`: `npm run db:test` passed 27/27; `npm test` passed 57/57 (web 5, Worker 25, database 27); `npm run typecheck`, `npm run build` (including Vite and Wrangler deploy dry-run), and `git diff --check origin/main...HEAD` passed. These results verify the local implementation only. Pattern redaction is incomplete; PGlite does not establish Neon compatibility or locking across independent sessions, and no live source or provider was exercised. RAG-CORE is now the next ready local package. See [delivery log](../DELIVERY_LOG.md).
