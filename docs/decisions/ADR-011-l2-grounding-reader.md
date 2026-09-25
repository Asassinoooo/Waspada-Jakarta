# ADR-011 — Least-privilege database access for Layer 2 grounding

- **Status:** Accepted for local implementation
- **Date:** 25 September 2026
- **Owners:** Root planner/reviewer

## Context

RAG-CORE adds a read-only query over persisted extraction results, report spans, source state, geometry and origin lineage, active chunks, and optional embeddings. DATA-01 currently defines `waspada_l1_pipeline`, `waspada_l4_publication_writer`, and `waspada_public_reader`, but none is an appropriate retrieval identity. L1 has write privileges and only narrow reads; L4 lacks extraction/chunk/vector access; the public reader sees published projections only. Running retrieval through a migration owner would bypass the intended layer boundary.

## Decision

Add a dedicated non-login group role named `waspada_l2_grounding_reader`. Give it schema usage and column-level `SELECT` only for the fields used by the RAG-CORE query. Grant no writes, sequence access, source-registry administration, report-revision mutation, audit access, or login credential. A deployment-specific service identity may be made a member only in a separately authorized provider integration task.

The role can read the permitted columns across the database's dataset kinds. Dataset isolation remains enforced by the retrieval query's required dataset parameter and the trusted server configuration; callers do not gain a public dataset selector. This prototype schema does not treat dataset kinds as separate tenants. Retrieval stays read-only and may not use the role to publish, investigate, or infer evidence sufficiency.

## Consequences

- RAG-CORE must be exercised after applying the migration and running under `SET ROLE waspada_l2_grounding_reader`, in addition to owner-level fixture setup.
- Column-level grants constrain accidental reads but are not row-level security. The role is for trusted internal service code only.
- The migration remains local and provider-neutral. It does not add an application login, connection secret, hosted role membership, or service wiring.
- Live persistence remains gated by the existing source-rights, backup, privacy, evaluation, and provider-compatibility decisions.

## Affected requirements

FR-05/06/07; NFR-01/05/07.
