# ADR-053 — Audience scope in evidence retrieval

- **Status:** Accepted for local synthetic implementation
- **Date:** 8 October 2026
- **Owner:** Root planner
- **Requirements:** FR-04/05/06; NFR-01/05/07
- **Related work:** RAG-CORE, RAG-ACCESS-01, L1-EXTRACTION-RESULT-PERSIST-CORE

## Context

Extraction schema 2.0 already stores proposed audience IDs in ExtractionResult.scope.audience_ids. The Layer 2 retrieval query can match exact identifiers, terms, time, geometry and optional vectors, but it cannot use this existing scope field. FR-05 and the group-specific notice scenario require audience-compatible retrieval, including notices with no geography.

## Decision

- Extend only the internal Layer 2 evidence-retrieval query and result facets with a bounded list of audience IDs and the exact IDs matched from each candidate's stored extraction scope.
- Match by exact ID intersection. A candidate is included when at least one requested audience ID matches, just as another retrieval facet may include it. Deduplicate and cap query IDs at 20 using the retrieval identifier bounds.
- Rank deterministically by exact identifier match count, then matched audience ID count, then exact-term count, then existing time, geometry, semantic-distance and tie-break rules. These are retrieval ordering rules, not confidence or factuality scores.
- Read the existing schema 2.0 record JSON using the column already granted to the L2 reader. Do not add a migration, grant, public API field, extraction schema field, or stored query filter.
- Version the changed search behavior as hybrid-evidence-v2. Persisted GroundingContext remains schema 2.0 and stores that retrieval version with the selected evidence references; resume continues to rehydrate those exact references rather than repeat search.
- Audience scope is an extraction proposal and is not field-bound to a specific evidence span. A returned audience facet is only a discovery hint. The result remains candidate evidence; no facet establishes support, sufficiency, truth, safety, user relevance, or permission to investigate or publish.
- Browser-local preferences and public briefing interests remain separate from this internal query. Do not pass personal preferences to retrieval, log query IDs, or expose retrieval facets in a public response.
- Missing or malformed stored audience scope produces no audience matches for that candidate and does not suppress matches on other valid facets. Preserve dataset scoping, evidence relations, source/origin provenance and all existing scan/result bounds.

## Consequences

The existing schema and L2 role are sufficient for a read-only extension. An authored synthetic group notice can be found through audience scope alone while its linked source spans and contradictory relations remain intact. This does not prove extraction accuracy or the factual accuracy of audience targeting. Any need to retain a search filter for audit or to rerun it during resume requires a separate contract decision.

## Validation boundary

The implementation uses synthetic PGlite records, including the real retrieval SQL under SET ROLE waspada_l2_grounding_reader. It does not establish retrieval quality, factual support, hosted Neon behavior, provider behavior, source rights, or deployed runtime behavior.
