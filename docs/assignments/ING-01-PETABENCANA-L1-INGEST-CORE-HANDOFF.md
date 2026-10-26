# ING-01-PETABENCANA-L1-INGEST-CORE — Implementation Handoff

**Task ID:** `ING-01-PETABENCANA-L1-INGEST-CORE`
**Parent Package:** `ING-01` (Structured weather/disaster acquisition integration)
**Branch:** `work/ING-01-petabencana-l1-ingest`
**Worktree:** `/mnt/d/Projects/RPL/.codex-build/worktrees/ing-01-petabencana-l1-ingest`
**Base Commit:** `80b109c00b0805fc431ba39678c7720ae0656a1b` on `main`
**Status:** Completed on task branch; ready for review and root integration.

---

## 1. Implemented Behavior

This package implements the core Layer 1 ingestion service for PetaBencana GeoJSON data (`apps/worker/src/layers/l1-data-knowledge/petabencana-ingest.ts`) and connects it to PostgreSQL/PGlite persistence (`apps/db`):

1. **Parser & Schema Normalization**:
   - Consumes PetaBencana GeoJSON text and validates caller-supplied RFC3339 retrieval timestamps.
   - Validates coordinates against the Jakarta regional coverage envelope (`106.32`–`106.98` E, `-6.40`–`-5.16` N) in CRS84, discarding out-of-bounds features.
   - Formats deterministic Bahasa Indonesia text (`formatPetabencanaReportText`) preserving disaster type, status, coordinates, and report timestamp.
   - Applies NFKC normalization and pattern redaction via `preparePermittedText`.

2. **Durable Evidence & Geometry Persistence**:
   - Persists unreviewed raw reports into `waspada.report_revisions` with CC BY-NC 4.0 canonical URLs (`https://petabencana.id/report/{pkey}`), SHA-256 content hashes, source creation timestamps (`observed_at`), and a conservative 24-hour validity window.
   - Computes exact Unicode code-point spans and writes supporting evidence references into `waspada.evidence_references` (`relation = 'supports'`).
   - Chunks permitted text into `waspada.evidence_chunks` via `chunkPreparedText`.
   - Persists CRS84 point geometries into `waspada.geometries` with role `incident_scene`, provider accuracy precision, and exact evidence-span links.

3. **Idempotency & Negative-Path Guarantees**:
   - Re-submitting identical report payloads converges without duplicating `report_revisions` or `geometries` records.
   - Empty `FeatureCollection` inputs cleanly resolve with `outcome: "completed"`, `empty: true`, and zero database mutations, without implying physical safety or an all-clear condition.
   - Malformed payloads or invalid timestamps fail closed without leaking internal database exceptions.

---

## 2. Changed Files

- `apps/worker/src/layers/l1-data-knowledge/petabencana-ingest.ts` (new): Core L1 ingestion pipeline for PetaBencana GeoJSON.
- `apps/worker/test/petabencana-ingest.test.ts` (new): 6 unit tests covering timestamp validation, empty collections, coordinate envelope filtering, span integrity, and failure codes.
- `apps/db/test/petabencana-ingest-pglite.test.ts` (new): End-to-end PGlite database integration test covering atomic persistence, evidence spans, PostGIS geometry insertion, and idempotent replay.
- `docs/assignments/ING-01-PETABENCANA-L1-INGEST-CORE.md` (new): Task assignment specification.
- `docs/assignments/ING-01-PETABENCANA-L1-INGEST-CORE-HANDOFF.md` (this file): Task handoff report.

---

## 3. Actual Checks & Verification Evidence

All checks executed in WSL Ubuntu-26.04 using Node.js `v22.23.2` and npm `11.19.0`:

### 1. Workspace Typecheck
```sh
npm run typecheck
```
**Result**: Clean pass across all workspaces (`@waspada/web`, `@waspada/worker`, `@waspada/db`, `tools/evaluation`, `tools/ai`, `tools/local-pipeline`, `tools/accounts`).

### 2. Worker Unit Test Suite
```sh
npx tsx --test test/petabencana-ingest.test.ts
```
**Result**:
```
TAP version 13
# Subtest: ingestPetabencanaGeoJson: rejects invalid or non-RFC3339 retrievedAt timestamp
ok 1 - ingestPetabencanaGeoJson: rejects invalid or non-RFC3339 retrievedAt timestamp
# Subtest: ingestPetabencanaGeoJson: succeeds with empty FeatureCollection
ok 2 - ingestPetabencanaGeoJson: succeeds with empty FeatureCollection
# Subtest: ingestPetabencanaGeoJson: ingests valid reports and filters out-of-envelope reports
ok 3 - ingestPetabencanaGeoJson: ingests valid reports and filters out-of-envelope reports
# Subtest: ingestPetabencanaGeoJson: fails on malformed GeoJSON syntax
ok 4 - ingestPetabencanaGeoJson: fails on malformed GeoJSON syntax
# Subtest: ingestPetabencanaGeoJson: handles persistence failure cleanly
ok 5 - ingestPetabencanaGeoJson: handles persistence failure cleanly
# Subtest: formatPetabencanaReportText: formats deterministic Bahasa Indonesia summary
ok 6 - formatPetabencanaReportText: formats deterministic Bahasa Indonesia summary
1..6
# tests 6 / pass 6 / fail 0
```

### 3. PGlite Integration Test Suite
```sh
npx tsx --test test/petabencana-ingest-pglite.test.ts
```
**Result**:
```
TAP version 13
# Subtest: ING-01 PetaBencana L1 Ingestion: persists reports, chunks, evidence, and geometries in PGlite
ok 1 - ING-01 PetaBencana L1 Ingestion: persists reports, chunks, evidence, and geometries in PGlite
1..1
# tests 1 / pass 1 / fail 0
```

---

## 4. Limitations & Remaining Gates

1. **L1 Boundary Only**: This package implements L1 acquisition and persistence. It does not invoke L2/L3 AI reasoning models or publish events to the public incident feed.
2. **Review Status**: Persisted reports carry `revision_status: "unreviewed"`. In accordance with product policy, citizen crowdsourced reports require human moderator adjudication or corroboration before publication.
3. **Source Clearance Gate**: PetaBencana is operated under CC BY-NC 4.0 terms for this educational prototype. Production public hosting requires monitoring upstream licensing clarifications.
