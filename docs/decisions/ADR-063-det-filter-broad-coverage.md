# ADR-063 — Deterministic prefilter with broad Jakarta coverage

- **Status:** Accepted on 13 November 2026 by owner request under DET-FILTER-03. Implemented on branch `work/DET-FILTER-03-broad-coverage`, not merged. Builds on [ADR-061](ADR-061-agent-driven-publication.md) for the downstream gate. Replaces the candidate rule of DET-FILTER-01 (`det-filter-v1`).
- **Date:** 2026-11-13
- **Owner:** Team 12
- **Scope:** `apps/worker/src/layers/l1-data-knowledge/deterministic-relevance.ts`, its JSON datasets, the replay constant in `news-triage.ts` and `news-triage-store.ts`, and the offline shadow-eval modifier list. Public API contracts, DB schema and grants, the publication gate and source rights are unchanged. No migration.

## Context

DET-FILTER-01 made the RSS prefilter the near-total blocker. Measured on the real 14-feed snapshot of 13 November 2026 (642 in-window items; 770 in total):

- Before: candidate 2, ambiguous 143, low_signal 497 in-window. Only one unique story passed.
- Scene role was `unknown` for 625 of 642 items, so the scene requirement blocked nearly every Jakarta report.
- Broad places (province, city) could never be candidates, and most real Jakarta incidents were phrased with a road, a station, a toll road or a landmark that the gazetteer did not know.
- Several incident kinds had no strong term at all: traffic and mogok, riots and tawuran, crime, utility outages, demonstrations, crowds, infrastructure failure, health and air.

Stage B (AI triage, `wj-int-02-v2`) is the precision layer. The prefilter is only a cost gate, so it should pass Jakarta-relevant incidents of many kinds and keep national politics, out-of-Jakarta and foreign news out.

## Decision

1. **Candidate rule.** A candidate needs (a) a strong event term from any group, and (b) a Jakarta place at one of these levels: a specific kelurahan or kecamatan, a curated `jakarta_place` name, a DKI city or regency (including Kepulauan Seribu), or the province name (`Jakarta`, `DKI`, `DKI Jakarta`, and `Ibu Kota` only when it refers to Jakarta). The location role must not be `non_scene_or_reference`. An `unknown` role no longer blocks candidacy. Forecast and alert-only language stays at most ambiguous. An event with no Jakarta place stays ambiguous.
2. **Named places.** `jakartaPlaces` are name-only curated entries: roads, toll roads, landmarks, stations, terminals, malls, port areas, Patung Kuda. Each has `coordinates: null`, `source: curated_name_only`, `canSatisfyPlaceGate: true` and `canSatisfySpecificAdministrativeLocationGate: false`. The loader rejects any entry that breaks these. Level `jakarta_place`, strength `named_place`.
3. **No points.** A city, province or `jakarta_place` match never produces coordinates, a point or a radius. The matcher output feeds only the Stage A decision, the poll counters, the `keywordHit` and `gazetteerHit` flags on `TriageNewsItem` (not read by the Stage B prompt builder), and rss-news-ingest's `matchedToponyms`, `matchedKeywords` and `isLikelyRelevant`. No geometry, coordinate or radius code reads any of them (checked by grep across `apps/worker/src`, `apps/db/src`, `apps/intelligence/src` and `tools/`).
4. **Agency and dateline exclusions.**
   - A leading dateline (`JAKARTA, KOMPAS.com -`, `Jakarta (ANTARA) -`, `JAKARTA -`, `Jakarta - `) within the first 60 characters is removed before normalization when its place is the province or a non-DKI name. A dateline that names a DKI city, kecamatan, kelurahan or named place is kept, because it may be the incident location.
   - Place tokens inside office names are consumed (`agency_reference_consumed`): Polda Metro Jaya, Polres Metro, Kapolres, Kapolsek, Pemprov DKI, Pemerintah Provinsi, Pemkot, DPRD, Gubernur, Wagub, Wali Kota, Kejari, PN, Sudin (with a gap of up to three tokens), BPBD, Dishub.
5. **False-specific fix.** A single-token kelurahan or kecamatan is `specific` only with incident co-context and its own corroboration: a kecamatan corroborates itself, and a kelurahan needs its own parent kecamatan or its own kota in the text. A province or other-city hit never corroborates. A blocklist (`singleTokenAliasBlocklist`) covers ordinary words (baru, gunung, pulo, jati, kenari, setu, karet, tangki, gelora, rambutan, guntur, kapuk, dukuh, gedong, penggilingan, bungur, joglo, palmerah, harmoni) and out-of-DKI homonyms (bintaro, cibubur, bangka, makasar, selong, kamal, setiabudi, cipayung, tambora, serdang, susukan). A blocklisted bare word never matches. Only its prefixed multi-token form matches (`Kelurahan Baru`). Containment: a span strictly inside a longer location span is dropped.
6. **Homonym guards.** A named place or road is dropped when an out-of-DKI cue appears (for example Bekasi or Bandung next to a road name, or Manila or Filipina next to Kota Tua) and the text names no DKI kelurahan, kecamatan, city or province.
7. **Vocabulary.** Strong and supporting terms added to the existing event groups (no new group was needed). Traffic, public transport, demonstrations, riot and violence, crime, utilities, infrastructure, fire, crowds, health and environment, and water rescue, as listed in DET-FILTER-03. A reversal of earlier notes: `terbakar`, `hangus`, `terguling`, `tenggelam`, `amblas`, `ambruk`, `macet total`, `macet parah` and `listrik padam`-class terms become strong. Because the legacy treatment table is term-global, those legacy rows and their global-supporting duplicates were updated in the same change.
8. **Scene cues.** New scene phrases (di kawasan, di jalan, di jl, di ruas, di depan, di sekitar, di wilayah, di simpang, di perempatan, di persimpangan, di halte, di stasiun, di tol, di jembatan, di flyover, di underpass, di pintu, di arah). Event-anchored cues ("<strong term> di") are generated at load. `menuju` and bare `arah` are excluded, because they mark destination or direction rather than a scene. A scene phrase that overlaps a reference cue does not count, so "ditangkap di jalan" stays a reference.
9. **Replay.** `TRIAGE_POLICY_VERSION` (worker) and `NEWS_TRIAGE_POLICY_VERSION` (db) move from `wj-int-02-v2` to `wj-int-02-v3`. Reason: the attempt rows store no deterministic rule version, so no column can carry it, and a migration is out of scope. Without a bump, an old skip would replay forever after a rule change. Checked: the DB has no policy-version constraint (only `DEFAULT 'wj-int-02-v1'` in migrations 040 and 041); the intelligence job runner compares a snapshot's version with the latest attempt's version, and both are written together, so the comparison stays consistent.

## Measurement

Same 642 in-window items, same matcher code path, before and after.

| Run | In-window candidate rows | Ambiguous | Low signal | Notes |
| --- | --- | --- | --- | --- |
| Before (`det-filter-v1`) | 2 (1 unique) | 143 | 497 | Measured baseline |
| After, iteration 1 (rules 1–5, 7–8) | 12 (6 unique) | 116 | 514 | 0 noise |
| After, iteration 2 (rule 6, homonym guards) | 12 (6 unique) | 115 | 515 | 0 noise |
| After, iteration 3 (kecamatan self-corroboration) | 12 (6 unique) | 115 | 515 | No change |

Unique candidates after the change: the Kalideres tawuran (Jakbar), the Muara Baru truck, the Landmark Pluit truck, the Gunung Sahari truck, the Cakung LPG fire (Padam variant) and the Cakung LPG fire (existing). All six are relevant on reading. None of the national-politics, out-of-Jakarta or foreign items became a candidate. The low-signal increase (+18) is mostly village-name false positives removed: "baru", "gunung", "bangka" and similar. The one out-of-window candidate in the full 770 items is an assault in a mall.

The noise threshold (25% of candidates) was not reached, so no tightening iteration was needed beyond the homonym guards.

## Consequences

- **Stage B load.** The corpus adds about 10 in-window candidate rows (about 1.5% of items; about 5 unique stories) to a 642-item window. Under enforce, ambiguous and low_signal items still make no model call. The NineRouter limit is 10 chat per minute, so this snapshot's added load is small. Broader vocabulary on busier days can raise the candidate rate, and the rate limit and the Stage B precision layer remain the bound. This estimate covers one snapshot only.
- **One-time re-evaluation.** Because of the replay bump, items that reappear in a feed are re-evaluated once. In enforce mode that is the previous candidates and skips that are now candidates. In shadow mode (the Worker default) every cached item that reappears is sent to Stage B once. Shadow is not the live mode, but this is a real cost in shadow environments.
- **Precision risk.** Some strong terms are broad by design, so they make a candidate once a Jakarta place is present: `demo`, `bom`, `teror`, `pembakaran`, `menduduki`, `anjlok` (price drops), `macet`, `terbakar`, `membludak`, `layanan dihentikan`, `tenggelam` (sunset), `limbah`, `mayat`, `ditendang`. Named roads and landmarks also exist in other cities (Sudirman, Gatot Subroto, Antasari, Kota Tua, Casablanca, Kemang, Kuningan), so homonym guards apply. Stage B decides; the matcher only gates. The data README and the lexicon `matchingPolicy.eventVocabularyRisk` record these.
- **No points.** Broad and named matches stay scope signals. Geometry, coordinates and radii are not derived from them, which keeps the invariant in `CLAUDE.md`.
- **Partly outside DKI.** JORR, Tol Sedyatmo and Sudirman-type names are seeds, so they carry an out-of-DKI cue guard, and Stage B keeps the final location decision.
- **Not done.** `halte <name>` is not generalised beyond the Transjakarta operator name and named haltes, because Transjakarta corridors reach Tangerang. Sensitive official names (DPR, Istana, KPK) are not seeded, per the owner instruction on national bodies.
- **Numbering.** ADR-062 already exists; CLAUDE.md's "highest ADR is 061" is stale. This ADR is 063 as requested.

## Verification boundary

Checks run for this change, all offline and with synthetic fixtures:

- `npm run typecheck` runs the workspaces first. The `apps/web` step fails on `pipeline-flow` test fixtures at the branch base (`ae75527`), which this change does not touch. The other workspaces pass. Each `tools/*` tsconfig was run separately and passes.
- Test files, one at a time: `deterministic-relevance` (20 tests, including the DET-FILTER-03 synthetic cases), `deterministic-filter-integration` (5), `rss-news-ingest` (7), `traffic-gazetteer` (8), `det-filter-shadow-eval` (30), `news-triage` (21), `news-triage-rate-limit` (8), `news-ai-call-profile` (10), `news-poll-runtime` (14), `gated-rss-revision-identity` (16 on a rerun), and the db `news-triage-decisions` (8).
- Not run: the full worker suite, `db:test`, `test:intelligence`, `pipeline:test`, `npm test`, `npm run build`, `serve:live` and any model call. Those belong to GitHub Actions CI under the local test policy.
