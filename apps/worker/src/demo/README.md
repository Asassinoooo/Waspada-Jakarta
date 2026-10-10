# Public reference snapshot

`osm-reference-snapshot.json` contains 100 normalized public facility records acquired from OpenStreetMap via Overpass on 10 October 2026. Source dataset time and acquisition time are recorded in the file. The query covers a central-Jakarta sample window, not all of Jakarta, and reached its 100-record cap. This is a dated reference snapshot; it is not a current incident feed or an authoritative service directory.

Data © OpenStreetMap contributors, licensed under [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/). [Source copyright and attribution](https://www.openstreetmap.org/copyright). The ODbL applies to this OSM-derived dataset; no PetaBencana report content is bundled. Changes: only facility names/categories, identity, coordinates and source links are retained; unnecessary tags are removed. Ways and relations retain the centre supplied by Overpass, labelled `source_extent_center`, not an entrance or observed incident point. Facility operation/hours/availability are unknown.

Query: `nwr` for `amenity=hospital`, `amenity=police`, `amenity=fire_station` inside south=-6.24, west=106.78, north=-6.14, east=106.88, with `out center 100`, JSON, timeout20 and maxsize67108864. See `docs/DEMO_DATA_INTEGRATION.md` and `REFERENCES.md` for acquisition limits and the separate transient API preview.
