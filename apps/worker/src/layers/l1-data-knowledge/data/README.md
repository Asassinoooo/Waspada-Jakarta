# Versioned deterministic-filter datasets

Seed data for `../deterministic-relevance.ts` (DET-FILTER-01, shadow-first).

- `jakarta-gazetteer.json` — dataset `waspada-jakarta-administrative-gazetteer`,
  `datasetVersion 2026-11-02-seed-1`. 6 areas, 44 districts, 267 canonical
  kelurahan. User-supplied 268-row snapshot, not a verified official export;
  reconcile against the DKI ArcGIS layer + Perda DKI No. 2/2026 before
  production activation.
- `incident-lexicon.json` — dataset `waspada-jakarta-incident-lexicon`,
  `datasetVersion 2026-11-02-seed-1`. BPBD labels + event groups + alert /
  supporting terms + 3 contextual overrides + role cues.

`Rawa Badak` is present ONLY under `unverifiedLocalities` — never counted as a
canonical kelurahan (44 districts / 267 kelurahan assertion covers this).
