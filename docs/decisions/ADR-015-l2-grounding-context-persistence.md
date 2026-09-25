# ADR-015 — Persisted Layer 2 grounding-context boundary

- **Status:** Accepted for local implementation
- **Date:** 26 September 2026
- **Owner:** Root planner
- **Requirements:** FR-05/06/07; NFR-01/05/07

## Context

RAG-CORE returns bounded evidence candidates and RAG-ACCESS-01 gives its query a read-only database role. The schema already defines append-only `grounding_contexts` and link tables, but no typed Layer 2 writer persists a context for L3 or later proposal handling. The Layer 2 Worker contract also carries an expanded in-memory reasoning context with retrieved text and provenance, while the persisted schema 2.0 `GroundingContext` contains evidence references and structured state. Treating those two shapes as the same storage record would copy source excerpts and internal prompt context into the durable ledger. Schema 2.0 permits four evidence-reference relations; accepted L1-EVIDENCE-RELATION-ALIGN-CORE migration 009 now aligns local persistence before this writer resolves canonical evidence references. This task uses migration 010.

## Decision

- Persist only the canonical schema 2.0 `GroundingContext` shape defined in `docs/contracts.schema.json`: dataset/trace/context/candidate identifiers, evidence references, revision states, candidate event versions, prior decision IDs, gaps/conflicts, retrieval/index versions, and the caller-supplied `sufficient` routing value.
- Do not persist the expanded in-memory reasoning payload, retrieved excerpt text, prompts, model output, or source copies in the context record.
- Resolve each evidence reference against an existing same-dataset `evidence_references` row by its exact revision/hash/span/offset/relation identity. Store the database evidence ID in `grounding_evidence`; persist event-version and decision links only when their exact same-dataset foreign keys resolve. Implement only after `L1-EVIDENCE-RELATION-ALIGN-CORE` makes every schema 2.0 relation storable.
- Create one transactional, create-or-verify writer. The context row and all normalized links commit atomically. An identical retry succeeds; any changed payload or link set for the same dataset/context ID fails with a stable conflict. Contexts and links remain append-only.
- Add a separate `NOLOGIN` `waspada_l2_grounding_writer` role. Grant only the column reads needed to resolve/verify references and contexts, and inserts/selects needed for idempotent context links. Do not widen the existing retrieval reader or grant update/delete, sequence, report, event, decision, audit, or publication writes.
- Preserve `sufficient` exactly as supplied. This writer does not assess evidence quality, compute sufficiency, create proposals, start L3, or authorize publication.
- Keep implementation local and synthetic-only. No Worker/Neon wiring, HTTP route, model provider, source acquisition, human labels, public contract, dependency, or cloud resource is part of this decision.

## Consequences

L3 can depend on an immutable, dataset-scoped context record without owning Layer 2 retrieval or its grounding decision. The canonical stored context avoids retaining retrieved text a second time. PGlite role tests prove local repository invariants only; hosted PostgreSQL/Neon locking, service-role membership, source rights, retrieval quality, and sufficiency remain unverified.

## Alternatives considered

- **Persist the expanded reasoning payload as `GroundingContext`:** rejected because it is not the canonical schema 2.0 record and would duplicate permitted source text and transient prompt context.
- **Let the existing L2 reader write contexts:** rejected because retrieval should remain read-only and the context writer requires a separately auditable write boundary.
- **Calculate sufficiency in the repository:** rejected because persistence must not become a model/verification policy and no rights-cleared adjudicated evaluation set is available.
