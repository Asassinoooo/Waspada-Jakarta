# DATA-02-CORE — Deterministic text preparation and chunk persistence

- **Status:** Paused at user checkpoint; partial unreviewed WIP is preserved on the assigned branch
- **Depends on:** DATA-01, L2-ADAPTER-01
- **Requirements:** FR-03, NFR-07
- **Architecture:** Layer 1 processing and persistence; independent of L2 providers and L3 orchestration
- **Branch/worktree:** `work/DATA-02-core-text-pipeline`; `.codex-build/worktrees/data-02-core`
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
- Add meaningful unit and PGlite tests for Unicode/combining marks, emoji, privacy redaction, deterministic hashes/IDs, complete span coverage and overlap, size bounds, idempotence, dataset isolation, immutable revision checks, and old chunk/embedding invalidation. Use only clearly synthetic text and identities.

## Explicit exclusions

No network access, live acquisition, ingestion scheduler changes, source approval, raw source persistence, model/provider call, embedding generation, gazetteer/geocoding, location or event extraction, entity truth claims, RAG retrieval, publication, API/OpenAPI or UI change, new dependency, database migration, cloud account, secret, paid service, or deployment. DATA-02 and RAG-01 remain separate follow-on work.

## Allowed paths

- `apps/worker/src/layers/l1-data-knowledge/**`
- `apps/worker/test/**`
- `apps/worker/package.json`
- `apps/db/src/**`
- `apps/db/test/**`
- This assignment's implementation handoff only

Root owns the backlog, architecture, and other planning documents. Do not change L2 contracts, database migrations, package lockfiles, root package manifests, public API contracts, or other assignments. If a new schema or executor contract is necessary, stop and ask root for a bounded scope decision.

## Acceptance and checks

- Processing is a pure Layer 1 transform before orchestration; repeat inputs produce byte-identical output and metadata.
- Hashes bind to the exact UTF-8 text, and offsets/counts use Unicode code points end to end. Sensitive fixture values are absent from persisted/logged metadata.
- Chunks preserve all normalized text through exact spans and declared overlap. Existing version rows are retained as invalidated history; current output is retry-safe.
- PGlite proves storage constraints and authorization using synthetic rows, but makes no claim about Neon or multi-session locking.
- In WSL Ubuntu-26.04 run `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`. No smoke test is needed because this task does not change a runtime route.
- Commit all work on the assigned branch with descriptive messages. Leave the worktree clean and report exact commits, paths, check results, schema/configuration impact, limitations, and unresolved decisions. Do not push or merge.

## Implementation handoff

The implementation agent appends the branch and worktree, commit SHAs/messages, changed paths, behavior, actual checks, limitations, and any scope issue here. Root reviews and accepts the branch before integration.
