# Versioned deterministic-filter datasets

Seed data for `../deterministic-relevance.ts` (DET-FILTER-01 shadow-first;
DET-FILTER-03 broad coverage, rule `det-filter-v2`).

- `jakarta-gazetteer.json` — dataset `waspada-jakarta-administrative-gazetteer`,
  `datasetVersion 2026-11-13-det-filter-03`. 6 areas, 44 districts, 267 canonical
  kelurahan (user-supplied snapshot, not a verified official export; reconcile
  against the DKI ArcGIS layer + Perda DKI No. 2/2026 before production
  activation). DET-FILTER-03 adds:
  - `jakartaPlaces`: curated named DKI places (roads, toll roads, landmarks,
    stations, terminals, malls, port areas). Name only, `coordinates: null`,
    `source: curated_name_only`. They satisfy the place gate for candidacy but
    never the administrative gate.
  - `singleTokenAliasBlocklist`: ordinary words and out-of-DKI homonyms. A bare
    blocklisted word never matches; its prefixed form ("Kelurahan Baru") does.
  - `outOfDkiHomonymCueTerms` and `jakartaPlaceHomonymGuards`: a named place or
    road next to an out-of-DKI or foreign cue is dropped unless a DKI anchor is
    also in the text.
  - `contextualAliasGuards`: "Ibu Kota" counts as Jakarta only when the next
    token keeps that reading.
  - `supplementalLegacyLocalities`: only `csw` remains (unverified acronym).
- `incident-lexicon.json` — dataset `waspada-jakarta-incident-lexicon`,
  `datasetVersion 2026-11-13-det-filter-03`. BPBD labels, event groups (strong
  and supporting terms), alert signals, 3 contextual overrides, location role
  cues (scene, reference, event-anchored "<strong term> di"), and
  `agencyReferenceExamples` (office names whose place tokens are consumed).

`Rawa Badak` is present ONLY under `unverifiedLocalities` — never counted as a
canonical kelurahan (44 districts / 267 kelurahan assertion covers this).

Legacy term treatments are term-global in the matcher. A term that changes
strength must change in `legacyKeywordCoverage` too, and its
`globalSupportingTerms` entry must be removed when it becomes strong.
