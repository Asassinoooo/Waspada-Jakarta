# ADR-016 — Align stored evidence-reference relations with schema 2.0

- **Status:** Accepted for local implementation
- **Date:** 26 September 2026
- **Owner:** Root planner
- **Requirements:** FR-03/05/07; NFR-01/07
- **Related work:** L1-EVIDENCE-RELATION-ALIGN-CORE, ADR-015

## Context

Schema 2.0 `EvidenceRef` and the L2 model contracts permit `supports`, `contradicts`, `updates`, and `context`. The current database check constraint and `apps/db/src/ports.ts` `EvidenceRelation` type permit only the other three. As a result, valid `updates` evidence cannot be persisted or returned by the typed retrieval repository, and a grounded context cannot preserve every schema-valid reference relation.

## Decision

- Add a forward-only migration that changes the `evidence_references.relation` check constraint to the four values already defined by schema 2.0. Do not rewrite migration 001 or modify existing rows.
- Extend the database `EvidenceRelation` type to include `updates`; preserve the stored value unchanged through report evidence writes and RAG retrieval.
- Keep the L4 publication policy fail-closed for an `updates` reference where it cannot use that relation as claim support. Storing a relation does not assert that its prose supports a claim or authorize publication.
- Add synthetic PGlite tests for migration reapplication, L1 persistence/idempotency, and L2 retrieval under its read role. Do not change the public API, JSON schema, model contract, or policy behavior.
- Keep the change local. No live source, provider, credential, cloud role membership, or deployment is enabled.

## Consequences

Every schema 2.0 evidence-reference relation can be represented in local persistence and preserved by retrieval. This is a representation fix only: `updates` retains its distinct meaning, remains visible to downstream assessment, and is not interchangeable with support or contradiction. PGlite proves the local constraint/type behavior, not hosted PostgreSQL operation or evidence meaning.
