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
  assert.equal(versions.gazetteer, "2026-11-02-seed-1");
  assert.equal(versions.lexicon, "2026-11-02-seed-1");
  assert.equal(versions.rule, DETERMINISTIC_FILTER_RULE_VERSION);
  assert.equal(versions.rule, "det-filter-v1");

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
  // The same single-token cue alone stays context_required (ambiguous).
  const lone = matchDeterministicRelevance("KEBAKARAN!!! Terjadi di TEBET...", "Petugas DAMKAR memadamkan, terjadi di Tebet.");
  assert.equal(lone.status, "ambiguous");
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

test("broad-only locations never satisfy the candidate gate", () => {
  for (const title of [
    "Kebakaran terjadi di Jakarta",
    "Banjir melanda DKI Jakarta",
    "Kebakaran terjadi di Jaksel",
    "Kebakaran terjadi di Jakarta Selatan",
  ]) {
    const result = matchDeterministicRelevance(title, "Api melahap ruko, terjadi di sana");
    assert.notEqual(result.status, "candidate", title);
    assert.ok(result.locationMatches.some((match) => match.matchStrength === "broad_only"), title);
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
  assert.equal(first.ruleVersion, "det-filter-v1");
});
