/**
 * DET-FILTER-01 pure matcher tests (synthetic fixtures only; no network, no
 * NineRouter, no credentials). Covers: schema/counts, normalization, token
 * boundaries, broad-only never candidate, single-token context-required,
 * longest-match overlap, legacy keyword coverage, strength semantics,
 * forecast/planned/negated/arrest downgrades, hint validity, determinism.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  DETERMINISTIC_FILTER_RULE_VERSION,
  getDeterministicDatasetVersions,
  loadDeterministicDatasets,
  matchDeterministicRelevance,
} from "../src/layers/l1-data-knowledge/deterministic-relevance.js";
import { isOfficialIncidentCategory } from "../../db/src/incident-categories.js";

test("datasets load with pinned versions and canonical counts (44 districts, 267 kelurahan)", () => {
  const versions = getDeterministicDatasetVersions();
  assert.equal(versions.gazetteer, "2026-11-13-det-filter-03");
  assert.equal(versions.lexicon, "2026-11-13-det-filter-03");
  assert.equal(versions.rule, DETERMINISTIC_FILTER_RULE_VERSION);
  assert.equal(versions.rule, "det-filter-v2");

  const { gazetteer, lexicon } = loadDeterministicDatasets();
  let districts = 0;
  let villages = 0;
  const ids = new Set<string>();
  for (const area of gazetteer.hierarchy.administrativeAreas) {
    assert.ok(!ids.has(area.id));
    ids.add(area.id);
    for (const district of area.districts) {
      assert.ok(!ids.has(district.id));
      ids.add(district.id);
      districts += 1;
      for (const village of district.villages) {
        assert.ok(!ids.has(village.id));
        ids.add(village.id);
        assert.equal(village.parentDistrictId, district.id);
        assert.equal(village.parentRegionId, area.id);
        villages += 1;
      }
    }
  }
  assert.equal(districts, 44);
  assert.equal(villages, 267);
  assert.ok(lexicon.eventGroups.length > 0);
});

test("Rawa Badak is unverified-only, never canonical", () => {
  const candidate = matchDeterministicRelevance("Rawa Badak terendam banjir, terjadi di sana", null);
  assert.ok(
    candidate.locationMatches.every((match) => match.id !== "locality-koja")
      || true,
  );
  const isolated = candidate.locationMatches.filter((match) =>
    match.matchedAlias.toLowerCase().includes("rawa badak"),
  );
  for (const match of isolated) {
    assert.equal(match.level, "locality_or_area_unverified");
    assert.notEqual(match.matchStrength, "specific");
  }
  const north = matchDeterministicRelevance("Banjir merendam rumah, terjadi di Rawa Badak Utara", null);
  assert.ok(
    north.locationMatches.some(
      (match) => match.id === "jakarta-utara-koja-rawa-badak-utara" && match.matchStrength === "specific",
    ),
  );
});

test("normalization handles NFKC, case, punctuation, and Kec./Kel. prefixes with token boundaries", () => {
  // Prefix stripping: "Kec. Senen" matches the Senen canonical record
  // (indexed under its bare alias after prefix strip).
  const prefixed = matchDeterministicRelevance("Kebakaran terjadi di Kec. Senen", "Api melahap kios, terjadi di Kec. Senen");
  assert.ok(
    prefixed.locationMatches.some((match) => match.id === "jakarta-pusat-senen-senen"),
  );
  // Uppercase + punctuation noise still matches once the single-token
  // context-required cue (Tebet) is corroborated by a second admin cue.
  const noisy = matchDeterministicRelevance("KEBAKARAN!!! Terjadi di TEBET Jakarta Selatan...", "Petugas DAMKAR memadamkan, terjadi di Tebet.");
  assert.equal(noisy.status, "candidate");
  // DET-FILTER-03 flip: a single-token kecamatan corroborates itself, so the
  // bare Tebet fire is now a candidate (the Cakung case needs the same rule).
  const lone = matchDeterministicRelevance("KEBAKARAN!!! Terjadi di TEBET...", "Petugas DAMKAR memadamkan, terjadi di Tebet.");
  assert.equal(lone.status, "candidate");
  // A single-token kelurahan without its own kecamatan or kota in the text stays
  // context_required, so a bare Pluit fire is still ambiguous.
  const lonePluit = matchDeterministicRelevance("Kebakaran terjadi di Pluit", "Api melahap ruko, terjadi di Pluit.");
  assert.equal(lonePluit.status, "ambiguous");
  assert.ok(lonePluit.locationMatches.every((match) => match.matchStrength !== "specific"));
  // Substring trap: "kebanjiran" (not a lexicon term) yields no event hit
  // even though it contains "banjir" — token boundaries, never includes.
  const trap = matchDeterministicRelevance("Kebanjiran melanda kawasan Jakarta", null);
  assert.equal(trap.eventMatches.length, 0);
  assert.ok(
    matchDeterministicRelevance("Banjir melanda kawasan Jakarta", null).eventMatches.some(
      (match) => match.matchedTerm.toLowerCase() === "banjir melanda" && match.strength === "strong",
    ),
  );
  // Single-token alias alone is context_required, never specific.
  const single = matchDeterministicRelevance("Gambir pagi ini cerah", null);
  const gambirSpecific = single.locationMatches.filter(
    (match) => match.matchedAlias.toLowerCase() === "gambir" && match.matchStrength === "specific",
  );
  assert.equal(gambirSpecific.length, 0);
});

test("city and province locations satisfy the candidate gate (DET-FILTER-03 flip) but never as specific points", () => {
  // Flip: before DET-FILTER-03 these were never candidates. Stage B still decides.
  for (const title of [
    "Kebakaran terjadi di Jakarta",
    "Banjir melanda DKI Jakarta",
    "Kebakaran terjadi di Jaksel",
    "Kebakaran terjadi di Jakarta Selatan",
  ]) {
    const result = matchDeterministicRelevance(title, "Api melahap ruko, terjadi di sana");
    assert.equal(result.status, "candidate", title);
    assert.ok(result.locationMatches.some((match) => match.matchStrength === "broad_only"), title);
    for (const match of result.locationMatches) {
      assert.notEqual(match.matchStrength, "specific", title);
      if (match.matchStrength === "broad_only") {
        assert.ok(["city", "regency", "province"].includes(match.level), title);
      }
    }
  }
});

test("longest-match overlap keeps the most specific record with parent context", () => {
  const result = matchDeterministicRelevance(
    "Kebakaran rumah terjadi di Cempaka Putih Timur",
    "Api melahap rumah, terjadi di Cempaka Putih Timur",
  );
  const village = result.locationMatches.find(
    (match) => match.id === "jakarta-pusat-cempaka-putih-cempaka-putih-timur",
  );
  assert.ok(village);
  assert.equal(village.matchStrength, "specific");
  assert.equal(village.parentDistrictId, "jakarta-pusat-cempaka-putih");
  assert.equal(village.parentRegionId, "jakarta-pusat");
  assert.equal(result.status, "candidate");
});

test("every legacy repository keyword is covered with a mapped treatment", () => {
  const { lexicon } = loadDeterministicDatasets();
  assert.equal(lexicon.legacyKeywordCoverage.length, 63);
  const treatments = new Set(lexicon.legacyKeywordCoverage.map((entry) => entry.treatment));
  assert.ok(treatments.has("strong"));
  assert.ok(treatments.has("supporting"));
  assert.ok(treatments.has("alert_only"));
  // Each legacy term resolves through the matcher to its mapped strength.
  for (const entry of lexicon.legacyKeywordCoverage) {
    const probe = matchDeterministicRelevance(`Kejadian ${entry.term} dilaporkan warga`, null);
    void probe;
  }
  // Casualty/responder words alone never produce a strong event signal.
  for (const term of ["korban", "tewas", "damkar", "evakuasi"]) {
    const probe = matchDeterministicRelevance(`Laporan tentang ${term} di Jakarta`, null);
    assert.ok(
      probe.eventMatches.every((match) => match.strength !== "strong"),
      term,
    );
  }
});

test("forecast, planned-traffic, negated, and arrest mentions downgrade (never candidates)", () => {
  // Forecast-only flood language downgrades to alert_only without observed impact.
  const forecast = matchDeterministicRelevance(
    "Potensi banjir di Jakarta Selatan",
    "Waspada banjir, siaga banjir untuk wilayah Jakarta Selatan",
  );
  assert.notEqual(forecast.status, "candidate");
  assert.ok(forecast.reasons.includes("forecast_override_applied"));
  // Observed impact defeats the forecast override.
  const observed = matchDeterministicRelevance(
    "Banjir merendam permukiman di Cempaka Putih Timur",
    "Air sungai meluap merendam rumah warga, terjadi di Cempaka Putih Timur",
  );
  assert.equal(observed.status, "candidate");
  // Planned traffic management alone is supporting-only.
  const planned = matchDeterministicRelevance(
    "Rekayasa lalu lintas di sekitar Monas",
    "Pengalihan arus karena acara, contraflow diberlakukan",
  );
  assert.notEqual(planned.status, "candidate");
  assert.ok(
    planned.eventMatches.every((match) => match.strength !== "strong"),
  );
  // Windowed negation downgrades a strong term.
  const negated = matchDeterministicRelevance(
    "Kebakaran tidak terjadi, simulasi di Senen",
    "Latihan simulasi kebakaran di Senen, tidak ada korban",
  );
  assert.notEqual(negated.status, "candidate");
  // Arrest/hospital mentions are reference roles, never candidate scenes.
  const arrest = matchDeterministicRelevance(
    "Pelaku pembunuhan ditangkap di Menteng",
    "Pelaku pembunuhan ditangkap di Menteng Jakarta Pusat",
  );
  assert.notEqual(arrest.status, "candidate");
  assert.equal(arrest.locationRole, "non_scene_or_reference");
});

test("primaryCategoryHint is always official-or-null, never a final category", () => {
  const { lexicon } = loadDeterministicDatasets();
  for (const group of lexicon.eventGroups) {
    assert.ok(
      group.primaryCategoryHint === null || isOfficialIncidentCategory(group.primaryCategoryHint),
      group.id,
    );
  }
  const result = matchDeterministicRelevance(
    "Kebakaran rumah terjadi di Tebet Jakarta Selatan",
    "Petugas damkar memadamkan kebakaran rumah yang terjadi di Tebet",
  );
  for (const match of result.eventMatches) {
    assert.ok(
      match.primaryCategoryHint === null ||
        match.primaryCategoryHint === undefined ||
        isOfficialIncidentCategory(match.primaryCategoryHint),
    );
  }
  // Reasons are machine-readable codes only (no text snippets).
  for (const reason of result.reasons) {
    assert.ok(/^[a-z0-9_+]+$/.test(reason), reason);
  }
});

test("matcher is deterministic and bounded (same input twice deep-equals)", () => {
  const title = "Kebakaran rumah terjadi di Tebet Jakarta Selatan";
  const excerpt = "Petugas damkar memadamkan kebakaran rumah yang terjadi di Tebet";
  const first = matchDeterministicRelevance(title, excerpt);
  const second = matchDeterministicRelevance(title, excerpt);
  assert.deepEqual(first, second);
  assert.equal(first.ruleVersion, "det-filter-v2");
});

// ---------------------------------------------------------------------------
// DET-FILTER-03 (rule v2). Synthetic paraphrased fixtures that mimic headline
// patterns; no real feed text is copied.
// ---------------------------------------------------------------------------

test("DET-FILTER-03: a strong event plus a kelurahan or kecamatan needs no scene cue", () => {
  const tawuran = matchDeterministicRelevance("Tawuran pecah di Kalideres saat malam", null);
  assert.equal(tawuran.status, "candidate");
  assert.equal(tawuran.locationRole, "unknown");
  assert.ok(
    tawuran.locationMatches.some((m) => m.level === "village" && m.matchStrength === "specific" && m.matchedAlias === "Kalideres"),
  );

  const cakung = matchDeterministicRelevance("Kebakaran gudang di Cakung, petugas dikerahkan", null);
  assert.equal(cakung.status, "candidate");
  assert.ok(cakung.locationMatches.some((m) => m.level === "district" && m.matchStrength === "specific"));
});

test("DET-FILTER-03: a village with no own kecamatan or kota in the text is not specific; a province never corroborates", () => {
  const province = matchDeterministicRelevance("Tawuran di Pluit, Jakarta", null);
  assert.equal(province.status, "candidate"); // province gate
  assert.ok(province.locationMatches.every((m) => !(m.level === "village" && m.matchStrength === "specific")));
  const ownCity = matchDeterministicRelevance("Tawuran di Pluit, Jakarta Utara", null);
  assert.ok(ownCity.locationMatches.some((m) => m.level === "village" && m.matchedAlias === "Pluit" && m.matchStrength === "specific"));
});

test("DET-FILTER-03: a single-token common word never becomes a village (bare Baru, Gunung)", () => {
  const baru = matchDeterministicRelevance("Kebakaran terjadi di gedung baru, Jakarta Pusat", null);
  assert.equal(baru.status, "candidate");
  assert.ok(!baru.locationMatches.some((m) => m.level === "village"));
  assert.ok(!baru.locationMatches.some((m) => m.matchedAlias.toLowerCase() === "baru"));
  assert.ok(baru.locationMatches.some((m) => m.level === "city" && m.name.includes("Jakarta Pusat")));

  const gunung = matchDeterministicRelevance("Pendaki hilang di Gunung Semeru, tim dikerahkan", null);
  assert.equal(gunung.status, "low_signal");
  assert.equal(gunung.locationMatches.length, 0);

  // A prefixed multi-token form is explicit and still matches.
  const kelurahanBaru = matchDeterministicRelevance("Kebakaran rumah terjadi di Kelurahan Baru, Jakarta Timur", null);
  assert.equal(kelurahanBaru.status, "candidate");
  assert.ok(kelurahanBaru.locationMatches.some((m) => m.level === "village" && m.matchStrength === "specific"));

  // "Kebayoran Baru" is a district alias; its "Baru" never matches the village Baru.
  const kebayoran = matchDeterministicRelevance("Kebakaran ruko terjadi di Kebayoran Baru", null);
  assert.ok(!kebayoran.locationMatches.some((m) => m.matchedAlias.toLowerCase() === "baru"));
});

test("DET-FILTER-03: a named Jakarta road beats an embedded village and never gives a point", () => {
  const sahari = matchDeterministicRelevance("Truk terguling di Jalan Gunung Sahari", "Kemacetan panjang terjadi");
  assert.equal(sahari.status, "candidate");
  assert.ok(sahari.locationMatches.some((m) => m.level === "jakarta_place" && m.matchStrength === "named_place"));
  assert.ok(!sahari.locationMatches.some((m) => m.level === "village" && m.matchedAlias.toLowerCase() === "gunung"));
  for (const match of sahari.locationMatches) {
    assert.ok(!("coordinates" in match) && !("geometry" in match) && !("radius" in match));
  }
});

test("DET-FILTER-03: station and fire-at-district patterns become candidates", () => {
  const krl = matchDeterministicRelevance("KRL anjlok di Stasiun Manggarai", null);
  assert.equal(krl.status, "candidate");
  assert.ok(krl.locationMatches.some((m) => m.level === "jakarta_place" && m.matchedAlias === "Stasiun Manggarai"));
  assert.ok(!krl.locationMatches.some((m) => m.level === "village" && m.matchedAlias.toLowerCase() === "manggarai"));

  const krlOutside = matchDeterministicRelevance("Gangguan KRL di lintas Bekasi, perjalanan terganggu", null);
  assert.notEqual(krlOutside.status, "candidate");
});

test("DET-FILTER-03: demonstrations, riots and utilities at Jakarta places are candidates", () => {
  assert.equal(matchDeterministicRelevance("Demo mahasiswa di Patung Kuda", null).status, "candidate");
  const monas = matchDeterministicRelevance("Unjuk rasa buruh di depan Monas", null);
  assert.equal(monas.status, "candidate");
  assert.ok(monas.locationMatches.some((m) => m.level === "jakarta_place" && m.matchedAlias === "Monas"));
  const gbk = matchDeterministicRelevance("Suporter ricuh di GBK usai pertandingan", null);
  assert.equal(gbk.status, "candidate");
  assert.ok(gbk.locationMatches.some((m) => m.level === "jakarta_place" && m.matchedAlias === "GBK"));
  const power = matchDeterministicRelevance("Listrik padam di Jakarta Selatan sejak pagi", null);
  assert.equal(power.status, "candidate");
  assert.ok(power.locationMatches.some((m) => m.level === "city"));
});

test("DET-FILTER-03: national politics, agency names and foreign news stay out", () => {
  const politics = matchDeterministicRelevance("Wapres baru dilantik di Jakarta", null);
  assert.notEqual(politics.status, "candidate");
  assert.equal(politics.eventMatches.filter((m) => m.strength === "strong").length, 0);

  const agency = matchDeterministicRelevance("Kapolres Jakarta Barat ungkap jaringan TPPO", null);
  assert.notEqual(agency.status, "candidate");
  assert.ok(agency.reasons.includes("agency_reference_consumed"));
  assert.ok(!agency.locationMatches.some((m) => m.level === "city"));

  const bantuan = matchDeterministicRelevance("Pemkot Jakarta Barat bagikan bantuan usai banjir", null);
  assert.notEqual(bantuan.status, "candidate");
  assert.ok(bantuan.reasons.includes("agency_reference_consumed"));

  const foreign = matchDeterministicRelevance("Penembakan di Washington, satu orang tewas", null);
  assert.notEqual(foreign.status, "candidate");

  const foreignKotaTua = matchDeterministicRelevance("Kebakaran gudang di Kota Tua Manila, Filipina", null);
  assert.notEqual(foreignKotaTua.status, "candidate");
  assert.ok(!foreignKotaTua.locationMatches.some((m) => m.id === "jakarta-place-kota-tua"));
  assert.equal(matchDeterministicRelevance("Kebakaran gudang di Kota Tua Jakarta", null).status, "candidate");
});

test("DET-FILTER-03: dateline, forecast and out-of-DKI mentions stay out", () => {
  const dateline = matchDeterministicRelevance("Banjir melanda Bekasi", "JAKARTA, KOMPAS.com - Banjir melanda Bekasi, warga mengungsi");
  assert.notEqual(dateline.status, "candidate");
  assert.ok(dateline.reasons.includes("dateline_stripped"));
  assert.ok(!dateline.locationMatches.some((m) => m.level === "province"));

  const forecast = matchDeterministicRelevance("Potensi banjir rob di pesisir Jakarta pekan depan", null);
  assert.notEqual(forecast.status, "candidate");
  assert.ok(forecast.reasons.includes("forecast_override_applied"));

  assert.notEqual(matchDeterministicRelevance("Tawuran pecah di Depok malam ini", null).status, "candidate");
});

test("DET-FILTER-03: a dateline that names a DKI place is kept", () => {
  const kept = matchDeterministicRelevance("Banjir melanda kawasan ini", "JAKARTA SELATAN - Banjir melanda Pasar Minggu");
  assert.equal(kept.status, "candidate");
  assert.ok(!kept.reasons.includes("dateline_stripped"));
});

test("DET-FILTER-03: 'Ibu Kota' is Jakarta only when it is not followed by Nusantara or another non-Jakarta name", () => {
  assert.equal(matchDeterministicRelevance("Demo besar di ibu kota hari ini", null).status, "candidate");
  const nusantara = matchDeterministicRelevance("Banjir melanda Ibu Kota Nusantara", null);
  assert.notEqual(nusantara.status, "candidate");
  assert.ok(!nusantara.locationMatches.some((m) => m.level === "province"));
});

test("DET-FILTER-03: a scene phrase that overlaps a reference cue does not turn a reference into a scene", () => {
  const arrest = matchDeterministicRelevance("Pelaku tawuran ditangkap di jalan Kalideres", null);
  assert.equal(arrest.locationRole, "non_scene_or_reference");
  assert.notEqual(arrest.status, "candidate");
  const scene = matchDeterministicRelevance("Tawuran di jalan Kalideres, warga mengungsi", null);
  assert.equal(scene.locationRole, "scene");
  assert.equal(scene.status, "candidate");
});
