# ADR-012 — Public API projection boundary

- **Status:** Accepted for local implementation
- **Date:** 25 September 2026
- **Owners:** Root planner/reviewer

## Context

The DATA-01 views `waspada.public_event_versions` and `waspada.public_event_impacts` expose `record_json` from schema 2.0 `Event` and `Impact` records. Those records are storage envelopes and include internal evidence references, revision hashes and offsets, origin IDs, decision metadata, and event/impact linkage. The public API contract deliberately uses a smaller `EventView` with resolved source attributions and display names. A security-barrier view and a read-only database role do not make a storage JSON document safe to serialize.

## Decision

- Treat all database `record_json` values as internal, untrusted input. Never return them directly from an HTTP handler or spread them into a public response.
- Layer 4 validates the schema and exact versions of the fields it consumes, then constructs `EventView`, `PublicClaim`, and `PublicImpact` values from an explicit allowlist.
- Resolve place, service, institution, and audience IDs through a trusted display-name resolver. Resolve each claim's support references only through a trusted, source-rights-approved public attribution record. Resolve each impact reference by the exact event and impact version pair.
- Fail closed when required names, attributions, or versioned impacts are missing, ambiguous, invalid, or not approved for public use. Do not use excerpts unless a separate permission check explicitly allows public display.
- The public projection accepts only current `live` published events. Historical and synthetic examples remain in the visibly labelled demo path and cannot be promoted through this projector.
- Keep the OpenAPI `EventView` contract unchanged. This projection boundary does not provide database connectivity, moderator authentication, publication writes, source approval, or event-quality evidence.

## Consequences

The existing views may remain useful as server-side read sources, but `record_json` is not a public DTO. The pure projector can be tested with authored, live-shaped in-memory values; those tests prove field filtering and fail-closed behavior only. Source/data rights remain pending, so no actual attribution record, excerpt, or human label is authorized or created. Database read wiring and HTTP route integration remain later tasks.

The storage and read-view foundation for scope-name and exact source-attribution lookup inputs is specified in [ADR-019](ADR-019-public-projection-lookups.md). Its test-only records do not create public rights or authorize an HTTP read path.

## Affected requirements

FR-09/10/12/15; NFR-01/07.
