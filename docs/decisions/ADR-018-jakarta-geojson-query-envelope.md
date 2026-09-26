# ADR-018 — Jakarta GeoJSON application query envelope

- **Status:** Accepted
- **Date:** 26 September 2026
- **Owner:** Root planner, following the user's instruction to document an application-defined query envelope
- **Affected requirements:** FR-09, FR-10, NFR-01, NFR-07
- **Affected interfaces:** `GET /api/v1/events.geojson` `bbox` parameter in `docs/api/openapi.yaml`

## Context

The GeoJSON endpoint needs a bounded CRS84 query area. The OpenAPI contract already describes `bbox` as an optional viewport parameter but did not record numeric Jakarta limits. The app needs a deterministic validation ceiling while preserving the distinction between an administrative boundary and source-supported event geometry.

The Jakarta 2025–2029 regional plan reports the province's geographic extent as 106°19′30″–106°58′18″ E and 5°10′00″–6°23′54″ S. Converted to decimal degrees and rounded outward to hundredths, this gives a conservative application envelope.

## Decision

Use the following inclusive application query envelope in CRS84 longitude/latitude order:

```text
west=106.32, south=-6.40, east=106.98, north=-5.16
```

`bbox` continues to be an optional comma-separated `west,south,east,north` parameter. If omitted, the request uses this full envelope. Supplied values must be four finite numbers in CRS84 order, have `west <= east` and `south <= north`, and be fully contained within the envelope. Bounds on the envelope edges are accepted; antimeridian wrapping is not supported.

## Interpretation and safeguards

This rectangle limits application queries only. It is not an official administrative polygon, a geofence, a map overlay, an event location, or a warning area. It must not be used to create, buffer, clip, strengthen, or validate event geometry. Public features still require exact source-supported geometry, claim/evidence linkage, and L4 projection. The endpoint returns an unchanged projected geometry when it intersects a requested viewport; it does not rewrite the geometry to the viewport. An empty or unavailable result does not imply that an area is safe.

Until a public source-backed reader is implemented, the synthetic runtime has no supported event geometry and the demo GeoJSON response remains an empty collection. It must not add guessed or illustrative event coordinates.

## Alternatives and trade-offs

- Enforcing a definitive administrative polygon would require selecting and versioning a permitted authoritative polygon and resolving its provenance. That is outside this query-limit decision.
- Allowing arbitrary global viewports would weaken resource bounds and exceed the Jakarta product scope.
- Using a broad low-precision rectangle keeps the contract simple and inclusive of the published province extent, but it can include water and small areas outside the administrative polygon. Source-backed spatial logic remains responsible for event eligibility.

## Source

- Government of Jakarta, *Naskah Akademik Rancangan Akhir RPJMD Jakarta 2025–2029*, geographic extent: [Jakarta DPRD PDF](https://dprd-dkijakartaprov.go.id/wp-content/uploads/2025/01/Ranhir-Naskah-Akademik-RPJMD-2025-2029_21-Mei_compressed.pdf).
- Jakarta Provincial Government, *Kajian Lingkungan Hidup Strategis RPJMD 2025–2029*, geographic extent: [Jakarta Environmental Agency PDF](https://lingkunganhidup.jakarta.go.id/files/klhs/Lap_KLHS_RPJMD_Prov_DKI_Jkt_Th_2025-2039_compre.pdf).

The source coordinates are reference bounds for setting the application envelope; this ADR does not reproduce an administrative boundary dataset.
