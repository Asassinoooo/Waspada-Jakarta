# ADR-034 — Atomic embedding metadata and vector persistence

- **Status:** Accepted design; implementation assigned
- **Date:** 1 October 2026
- **Owner:** Root planner
- **Task:** DATA-02-EMBEDDING-PERSIST-CORE
- **Requirements:** FR-03/05/06; NFR-01/05/07

## Context and decision

Hybrid retrieval already reads compatible vectors, but tests seed those rows directly. Add an L1 repository for one closed schema 2.0 EmbeddingRun with requested status `available` plus a separate numeric vector. Persist the metadata and vector atomically under the existing L1 role. Resolve the exact input hash and chunk span against its immutable revision, with a same-dataset trace. New runs require active chunks and unreviewed/eligible revisions; quarantined, superseded and retracted revisions cannot create new available embeddings.

Serialize run identity and lock its chunk before writing to prevent overlap with chunk invalidation. Reusing an ID with equal metadata and the same database-stored vector is an idempotent replay. Changed identity, lineage, timestamp, provider/version, hash, or vector is a bounded conflict writing nothing. Reindexing uses a new run ID. Exact replay of an invalidated run reports its unavailable state without restoring either run or chunk; failed, missing or inconsistent prior vectors fail closed.

Use the existing retrieval implementation's 1–2048 dimension bound as the initial persistence budget. Values must remain finite after single-precision storage conversion; cosine vectors must remain nonzero after conversion. Replay comparison uses the stored vector representation, avoiding false conflicts from floating-point rounding. The message schema's larger dimension ceiling stays unchanged; no model dimension or ANN index is selected.

The writer accepts calendar-valid RFC3339 `created_at` with at most six fractional-second digits, rejects finer inputs before SQL and compares equal instants at microsecond precision. Equivalent offsets are replay-compatible; a one-microsecond difference is a conflict. Local PGlite verification must establish this storage comparison; the general schema is unchanged.

Reserve migration 022 for exact column-level L1 reads needed to verify embedding metadata and vectors. No table, write grant, status authority, API, credential, provider invocation, Worker trigger, source activation or dependency changes are included.

## Evidence and limits

Synthetic PGlite checks must cover atomicity, replay/conflict, stale chunks/revisions, non-resurrection after chunk invalidation, dataset isolation, role permissions, numeric storage, and matching identity through the existing semantic retrieval query. They do not prove semantic accuracy, real model performance, source rights, independent PostgreSQL concurrency, or hosted Neon behavior.

The upstream [pgvector vector reference](https://github.com/pgvector/pgvector#vector-type), reviewed 1 October 2026, documents finite single-precision storage. The 2048 cap is Waspada's existing query budget, not pgvector's general ceiling. The source is recorded in REFERENCES.md for the eventual report.
