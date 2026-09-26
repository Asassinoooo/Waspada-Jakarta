# ADR-023 — Public GeoJSON candidate selection and overflow

- **Status:** Accepted
- **Date:** 27 September 2026
- **Owner:** Root planner/reviewer
- **Affected requirements:** FR-09, FR-10, NFR-01, NFR-07
- **Affected interface:** Existing `GET /api/v1/events.geojson` and `PublicFeatureCollection`

## Context

The existing GeoJSON contract has no pagination fields and caps `features` at 500. Its demo route currently returns an empty collection because no fixture contains source-supported geometry. The live route must eventually select current public live event geometry by the documented application bbox and filters, while preserving the existing strict Layer 4 projection boundary.

If a result exceeds the DTO's capacity, returning the first 500 features without a truncation marker would silently hide matching public events. The map also must not turn a query envelope, point, or historical report into an inferred danger area.

## Decision

- Select only geometry linked to an exact current published live event and its published, supporting claim. Database candidate rows remain untrusted internal input; a later Layer 4 service must validate source support and project the existing `PublicFeatureCollection` allowlist.
- Apply `bbox` as an inclusive CRS84 query constraint using the envelope already accepted in [ADR-018](ADR-018-jakarta-geojson-query-envelope.md). Include a source-supported geometry only when it intersects the viewport; return its original full geometry without clipping, buffering, or converting it into a radius.
- Keep category, lifecycle, and freshness filtering within the existing OpenAPI vocabulary. Do not change the public DTO or add pagination in this slice.
- Bound selection at 500 matching geometry features with one overflow probe. If more than 500 match, fail the request with the existing generic unavailable error rather than return an apparently complete but truncated collection.
- An empty FeatureCollection means no matching source-supported published geometry was returned for the request. It does not imply that the area is safe or that reports do not exist.
- Preserve the least-privilege database boundary. A public reader role may invoke only the new filtered read surface; it gains no direct access to event, claim, geometry, or evidence base relations. Raw database records are never serialized by HTTP handlers.

## Consequences

The candidate reader can be implemented and tested using authored fictional PostGIS rows without enabling a real source or public route. The existing live GeoJSON path remains unavailable until the candidate reader, strict feature projection, and exact route runtime are each accepted. More than 500 matching features produce a generic unavailable response; pagination or a larger limit would require a separately reviewed contract change.

This decision does not establish source/data rights, authorize real publication, or make the Jakarta query envelope an administrative boundary or warning zone. Empty or unavailable map results remain distinct from evidence that an area is safe.
