# ADR-019 — Reviewed lookups for public projections

- **Status:** Accepted for local implementation
- **Date:** 26 September 2026
- **Owners:** Root planner/reviewer
- **Affected requirements:** FR-08/09/10/15; NFR-01/07
- **Related decisions:** ADR-012 public projection boundary; ADR-018 Jakarta GeoJSON query envelope

## Context

The L4 public projector needs approved display names for event scope IDs and exact source attributions for each supporting evidence span. DATA-01 stores event, impact, evidence, source, and revision records, but it does not store a reviewed public scope-name catalog or an explicit public-display approval for an exact evidence reference. Source acquisition approval and event publication do not, by themselves, grant permission to display source attribution or excerpts.

The public reader must not recover presentation data by serializing `record_json`, reading raw source text, or guessing names from identifiers. Missing or ambiguous lookup data must keep a record out of the public projection.

## Decision

- Store scope display names as versioned, reviewable records keyed by entity type, ID, and locale. Each revision records its provenance reference, reviewer, decision reason, and review time. Only the latest approved revision is exposed by the public lookup view; a later hold or withdrawal removes it.
- Store public attribution decisions against one exact supporting evidence reference. The approval records an internal permission-basis reference and snapshots the public display name, HTTPS source URL, and source publication/observation times. A later revocation supersedes the prior approval. Acquisition approval, reuse notes, model confidence, and event publication are not substitutes for this explicit decision.
- Keep these records append-only. Their approval means only that the recorded label or attribution may be displayed publicly; it does not establish factual accuracy, incident lifecycle, freshness, physical safety, or user relevance.
- The first public attribution view exposes no excerpt. Public excerpts require a separate permission design and are always `null` with `excerpt_public_use_approved: false` in this slice.
- Grant the `waspada_public_reader` role SELECT access only to the closed lookup views. It receives no access to the review records, source text, or write privileges. No application approval writer or HTTP review action is added before MOD-01 supplies authorization.
- Do not insert real scope names, attributions, rights decisions, or source material until the team has the required source permissions and an authorized human review path. Local tests may use clearly identified, authored synthetic rows only.
- Keep incident lifecycle, evidence status, freshness, and user relevance independent from lookup approval. Neither an empty lookup nor a withdrawn attribution means an incident is resolved or an area is safe.

## Consequences

The database-backed public API remains unavailable for a record whose exact labels or source attributions cannot be resolved. The local schema and read port can be validated without source acquisition, source-rights claims, moderator authentication, a Neon project, or Cloudflare configuration. MOD-01 must later add an authenticated writer for these append-only decisions. API-01 must combine lookup results with the existing strict L4 projector and current published event versions; it must continue to fail closed on missing or ambiguous inputs.
