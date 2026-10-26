# ING-01-PETABENCANA-L1-INGEST-CORE — PetaBencana Layer 1 Ingestion and Evidence Persistence

**Parent package:** ING-01, FR-02/03/04/15, NFR-01/05/07
**Status:** In Progress on `work/ING-01-petabencana-l1-ingest`
**Branch:** `work/ING-01-petabencana-l1-ingest`
**Worktree:** `/mnt/d/Projects/RPL/.codex-build/worktrees/ing-01-petabencana-l1-ingest`
**Base:** `80b109c00b0805fc431ba39678c7720ae0656a1b` on `main`
**Dependencies:** `ING-PARSE-01`, `DATA-01`, `DATA-02-CORE`, `GEO-STORE-CORE`, `L1-WRITE-IDEMPOTENCY-CORE`
**Contract baseline:** Schema 2.0 domain records (`ReportRevision`, `EvidenceReference`, `EvidenceChunk`, `Geometry`), CC BY-NC 4.0 license metadata, PetaBencana GeoJSON contract.

## 1. Objective

Implement a deterministic Layer 1 ingestion service for PetaBencana GeoJSON reports (`apps/worker/src/layers/l1-data-knowledge/petabencana-ingest.ts`). The service:
1. Receives raw or buffered PetaBencana GeoJSON text and an explicit caller-supplied retrieval timestamp.
2. Parses reports using the accepted `parsePetabencanaGeoJson` parser.
3. Formats permitted report text in Bahasa Indonesia with deterministic field ordering and runs Unicode normalization via `preparePermittedText`.
4. Computes exact Unicode code-point evidence spans and persists immutable chunks via `EvidenceChunkRepository`.
5. Persists raw report revisions via `ReportRevisionRepository` with CC BY-NC 4.0 canonical URLs, source observation timestamps, 24-hour validity envelopes, and SHA-256 content hashes.
6. Persists CRS84 PostGIS point geometries via `GeometryWriter` with evidence-span links.
7. Enforces idempotency: identical reports re-submitted with the same content hash or ID resolve without creating duplicates.
8. Ensures negative-path safety: empty feature collections record successful empty ingestion without creating false incident records; invalid payloads fail closed.

## 2. Invariants & Architecture Constraints

- **Layer 1 Boundary**: Performs ingestion, normalization, chunking, and persistence. Does not autonomously invoke Layer 3, propose public Events, or publish information to public feeds.
- **Timestamp Separation**: `observed_at` uses `sourceCreatedAt` (if valid); `retrieved_at` uses caller-supplied RFC3339 time; `valid_until` is bounded to 24 hours from observation. Missing timestamps remain null.
- **Attribution & Licensing**: Enforces `source_id: "petabencana"` and CC BY-NC 4.0 license provenance.
- **Zero-Trust Input**: Bounded payload sizes, coordinate validation against Jakarta CRS84 bounds (`106.32`–`106.98` E, `-6.40`–`-5.16` N), and rejection of control characters.

## 3. Allowed Paths

- `apps/worker/src/layers/l1-data-knowledge/petabencana-ingest.ts` (new)
- `apps/worker/test/petabencana-ingest.test.ts` (new)
- `apps/db/test/petabencana-ingest-pglite.test.ts` (new)
- `docs/assignments/ING-01-PETABENCANA-L1-INGEST-CORE.md` (this file)
- `docs/assignments/ING-01-PETABENCANA-L1-INGEST-CORE-HANDOFF.md` (new)

## 4. Verification

1. Unit tests in Worker workspace exercising:
   - Valid empty `FeatureCollection` (returns `outcome: "empty"`).
   - Valid flood reports with points, depth, and status.
   - Text preparation and code-point span integrity.
   - Coordinate envelope filtering.
   - Rejection of oversized or malformed payloads.
2. PGlite database integration tests exercising:
   - Atomic persistence of `report_revisions`, `evidence_references`, `evidence_chunks`, and `geometries`.
   - Idempotent re-ingestion of the same payload.
   - Role permissions under `waspada_l1_pipeline`.
