import assert from "node:assert/strict";
import test from "node:test";
import {
  generateProposalFromReport,
  extractLocation,
  detectIncidentCategory,
  detectSeverity,
  mapIncidentTypeToPublicCategory,
  JAKARTA_GAZETTEER,
  type StoredReportRevision,
  type StoredEvidenceChunk,
} from "../src/layers/l2-model-grounding/proposal-engine.js";
import {
  findJakartaToponym,
  correlateSourceReports,
  haversineDistanceMeters,
  JAKARTA_TOPONYMS,
} from "../src/layers/l1-data-knowledge/multisource-correlator.js";
import {
  classifyNewsItem,
  INCIDENT_KEYWORDS,
  JAKARTA_TOPONYMS as RSS_TOPONYMS,
} from "../src/layers/l1-data-knowledge/rss-news-ingest.js";

function makeReport(overrides: Partial<StoredReportRevision> = {}): StoredReportRevision {
  const permitted_text = overrides.permitted_text ?? "Laka lantas truk terguling di Simpang Susun Semanggi Jakarta Selatan.";
  const chunks: StoredEvidenceChunk[] = overrides.chunks
    ? [...overrides.chunks]
    : [
        {
          chunk_index: 0,
          text: permitted_text,
          span_start: 0,
          span_end: Array.from(permitted_text).length,
        },
      ];

  return {
    report_revision_id: "rev-traffic-001",
    source_id: "source-tmc-polda-metro",
    canonical_url: "https://tmcpoldametro.id/lapor/101",
    permitted_text,
    permitted_text_hash: "b".repeat(64),
    chunk_count: chunks.length,
    chunks,
    retrieved_at: "2026-10-26T08:00:00.000Z",
    published_at: overrides.published_at ?? "2026-10-26T07:55:00.000Z",
    ...overrides,
  };
}

test("JAKARTA_GAZETTEER contains 30+ precision micro-landmarks with accurate WGS84 coordinates", () => {
  assert.ok(JAKARTA_GAZETTEER.length >= 30, `Expected at least 30 places, got ${JAKARTA_GAZETTEER.length}`);

  const requiredLandmarks = [
    { name: "Simpang Susun Semanggi", expected: [106.8156, -6.2201] },
    { name: "Tol Cawang Interchange", expected: [106.8710, -6.2420] },
    { name: "Tomang Interchange / Slipi", expected: [106.7940, -6.1770] },
    { name: "Tol JORR TB Simatupang", expected: [106.8350, -6.2950] },
    { name: "Tol Jagorawi Cawang-Cibubur", expected: [106.8850, -6.3100] },
    { name: "Tol Pelabuhan / Pluit Interchange", expected: [106.7860, -6.1240] },
    { name: "Underpass Dukuh Atas", expected: [106.8210, -6.2010] },
    { name: "Underpass Casablanca", expected: [106.8380, -6.2230] },
    { name: "Underpass Senen", expected: [106.8430, -6.1780] },
    { name: "Underpass Mampang-Kuningan", expected: [106.8280, -6.2420] },
    { name: "Underpass Matraman", expected: [106.8610, -6.2020] },
    { name: "Flyover Roxy / Cideng", expected: [106.8080, -6.1660] },
    { name: "Flyover Pancoran", expected: [106.8430, -6.2430] },
    { name: "Flyover Antasari", expected: [106.8050, -6.2620] },
    { name: "Stasiun Manggarai Transit", expected: [106.8500, -6.2098] },
    { name: "Stasiun Tanah Abang Transit", expected: [106.8110, -6.1856] },
    { name: "Stasiun Jatinegara", expected: [106.8670, -6.2150] },
    { name: "Halte CSW / ASEAN MRT Interchange", expected: [106.7985, -6.2395] },
    { name: "Halte Bundaran HI Astra", expected: [106.8230, -6.1930] },
    { name: "Halte Harmoni Central", expected: [106.8190, -6.1640] },
    { name: "Terminal Bus Kampung Rambutan", expected: [106.8760, -6.3090] },
    { name: "Terminal Bus Pulo Gebang", expected: [106.9530, -6.2120] },
    { name: "Terminal Bus Kalideres", expected: [106.7020, -6.1550] },
  ];

  for (const { name, expected } of requiredLandmarks) {
    const found = JAKARTA_GAZETTEER.find((p) => p.name === name);
    assert.ok(found, `Expected gazetteer to contain ${name}`);
    const dist = haversineDistanceMeters(
      [found.coordinates[0], found.coordinates[1]],
      [expected[0], expected[1]],
    );
    assert.ok(dist <= 50, `${name} coordinates should resolve within 50m (dist: ${dist.toFixed(2)}m)`);
  }
});

test("micro-landmark extraction resolves exact coordinates within 50m of Semanggi, Casablanca underpass, and Manggarai hub", () => {
  // 1. Simpang Susun Semanggi
  const semanggiLoc = extractLocation("Truk terguling di Simpang Susun Semanggi arah Kuningan.", "tmc-metro");
  assert.ok(semanggiLoc !== null);
  assert.ok(semanggiLoc.coordinates !== null);
  const semanggiDist = haversineDistanceMeters(
    [semanggiLoc.coordinates[0], semanggiLoc.coordinates[1]],
    [106.8156, -6.2201],
  );
  assert.ok(semanggiDist <= 50, `Semanggi distance should be <= 50m (was ${semanggiDist}m)`);
  assert.equal(semanggiLoc.locationLabel, "Simpang Susun Semanggi, Jakarta Selatan");

  // 2. Underpass Casablanca
  const casablancaLoc = extractLocation("Genangan air menutupi Underpass Casablanca jalur lambat.", "dishub");
  assert.ok(casablancaLoc !== null);
  assert.ok(casablancaLoc.coordinates !== null);
  const casablancaDist = haversineDistanceMeters(
    [casablancaLoc.coordinates[0], casablancaLoc.coordinates[1]],
    [106.8380, -6.2230],
  );
  assert.ok(casablancaDist <= 50, `Casablanca distance should be <= 50m (was ${casablancaDist}m)`);
  assert.equal(casablancaLoc.locationLabel, "Underpass Casablanca, Jakarta Selatan");

  // 3. Stasiun Manggarai hub
  const manggaraiLoc = extractLocation("Kepadatan penumpang dan gangguan sinyal di Stasiun Manggarai transit hub.", "kci");
  assert.ok(manggaraiLoc !== null);
  assert.ok(manggaraiLoc.coordinates !== null);
  const manggaraiDist = haversineDistanceMeters(
    [manggaraiLoc.coordinates[0], manggaraiLoc.coordinates[1]],
    [106.8500, -6.2098],
  );
  assert.ok(manggaraiDist <= 50, `Manggarai hub distance should be <= 50m (was ${manggaraiDist}m)`);
  assert.equal(manggaraiLoc.locationLabel, "Stasiun Manggarai Transit, Jakarta Selatan");
});

test("micro-landmarks take precedence over broad subdistricts during regex matching", () => {
  // "Underpass Senen" vs broad "Senen"
  const underpassSenenLoc = extractLocation("Pohon tumbang di depan Underpass Senen dekat perlintasan.", "source-tmc");
  assert.ok(underpassSenenLoc !== null);
  assert.equal(underpassSenenLoc.locationLabel, "Underpass Senen, Jakarta Pusat");
  assert.equal(underpassSenenLoc.coordinates?.[0], 106.8430);
  assert.equal(underpassSenenLoc.coordinates?.[1], -6.1780);

  // Broad "Senen" alone falls back to district Senen
  const districtSenenLoc = extractLocation("Kebakaran ruko di Pasar Senen lantai dua.", "source-antara");
  assert.ok(districtSenenLoc !== null);
  assert.equal(districtSenenLoc.locationLabel, "Senen, Jakarta Pusat");
  assert.equal(districtSenenLoc.coordinates?.[0], 106.8442);
  assert.equal(districtSenenLoc.coordinates?.[1], -6.1823);

  // "Flyover Pancoran" vs broad "Pancoran"
  const foPancoranLoc = extractLocation("Kecelakaan beruntun di Flyover Pancoran arah MT Haryono.", "source-tmc");
  assert.ok(foPancoranLoc !== null);
  assert.equal(foPancoranLoc.locationLabel, "Flyover Pancoran, Jakarta Selatan");
  assert.equal(foPancoranLoc.coordinates?.[0], 106.8430);
  assert.equal(foPancoranLoc.coordinates?.[1], -6.2430);

  // Broad "Pancoran" alone falls back to district Pancoran
  const districtPancoranLoc = extractLocation("Genangan air di jalan raya Pancoran Jakarta Selatan.", "source-antara");
  assert.ok(districtPancoranLoc !== null);
  assert.equal(districtPancoranLoc.locationLabel, "Pancoran, Jakarta Selatan");
  assert.equal(districtPancoranLoc.coordinates?.[0], 106.8450);
  assert.equal(districtPancoranLoc.coordinates?.[1], -6.2500);

  // "Stasiun Manggarai" vs broad "Tebet"
  const stManggaraiLoc = extractLocation("KRL tertahan menjelang Stasiun Manggarai karena gangguan.", "source-antara");
  assert.ok(stManggaraiLoc !== null);
  assert.equal(stManggaraiLoc.locationLabel, "Stasiun Manggarai Transit, Jakarta Selatan");
  assert.equal(stManggaraiLoc.coordinates?.[0], 106.8500);
  assert.equal(stManggaraiLoc.coordinates?.[1], -6.2098);
});

test("traffic disruption triggers map to category accident and public category transport_road_incidents", () => {
  const trafficPhrases = [
    "rekayasa lalu lintas",
    "rekayasa lalin",
    "penutupan jalan",
    "pengalihan arus",
    "contraflow",
    "macet parah",
    "antrean kendaraan",
    "tabrakan beruntun",
    "truk terguling",
    "transjakarta dialihkan",
    "rute distop",
    "krl anjlok",
    "gangguan persinyalan",
    "krl tertahan",
    "underpass tergenang",
    "jalan amblas",
    "catenary putus",
  ];

  for (const phrase of trafficPhrases) {
    const text = `Terjadi ${phrase} di kawasan Simpang Susun Semanggi Jakarta Selatan.`;
    const catResult = detectIncidentCategory(text);
    assert.ok(catResult !== null, `Expected category detection for phrase: "${phrase}"`);
    assert.equal(catResult.category, "accident", `Phrase "${phrase}" should categorize as accident`);
    assert.equal(
      mapIncidentTypeToPublicCategory(catResult.category),
      "transport_road_incidents",
      `accident should map to public category transport_road_incidents`,
    );
  }
});

test("proposal engine generates schema 2.0 proposal for traffic disruption at micro-landmarks", () => {
  const report = makeReport({
    report_revision_id: "rev-semanggi-truck-404",
    source_id: "source-tmc-polda-metro",
    permitted_text:
      "Truk bermuatan besi terguling di Simpang Susun Semanggi arah Kuningan. Macet total 3 km, dua lajur ditutup.",
    published_at: "2026-10-26T08:30:00.000Z",
  });

  const proposal = generateProposalFromReport(report);
  assert.ok(proposal !== null);
  assert.equal(proposal.schema_version, "2.0");
  assert.equal(proposal.incident_type, "accident");
  assert.equal(proposal.public_category, "transport_road_incidents");
  assert.equal(proposal.severity, "critical", "macet total triggers critical severity");
  assert.equal(proposal.location_label, "Simpang Susun Semanggi, Jakarta Selatan");
  assert.ok(proposal.coordinates !== null);
  assert.equal(proposal.coordinates[0], 106.8156);
  assert.equal(proposal.coordinates[1], -6.2201);
  assert.ok(proposal.claims.length >= 1);
});

test("calibrates severity correctly for traffic disruption keywords", () => {
  // Critical markers: "macet total", "krl anjlok", "jalan amblas", "lalin lumpuh", "tol ditutup"
  assert.equal(
    detectSeverity("Macet total hingga 5 kilometer di Simpang Susun Semanggi."),
    "critical",
  );
  assert.equal(
    detectSeverity("KRL anjlok di dekat Stasiun Manggarai tidak bisa melintas."),
    "critical",
  );
  assert.equal(
    detectSeverity("Jalan amblas sedalam satu meter di Underpass Dukuh Atas."),
    "critical",
  );
  assert.equal(
    detectSeverity("Lalin lumpuh total tidak bergerak di tol dalam kota."),
    "critical",
  );
  assert.equal(
    detectSeverity("Tol ditutup sementara karena ada insiden kecelakaan."),
    "critical",
  );

  // High markers: "contraflow", "truk terguling", "tabrakan beruntun"
  assert.equal(
    detectSeverity("Contraflow diberlakukan sepanjang 2 km untuk mengurai antrean."),
    "high",
  );
  assert.equal(
    detectSeverity("Truk terguling melintang di jalan tol Slipi."),
    "high",
  );
  assert.equal(
    detectSeverity("Tabrakan beruntun melibatkan tiga minibus di Flyover Pancoran."),
    "high",
  );

  // Medium markers: "rekayasa lalin", "pengalihan arus", "macet parah", "antrean kendaraan"
  assert.equal(
    detectSeverity("Rekayasa lalin diberlakukan di Simpang CSW ASEAN."),
    "medium",
  );
  assert.equal(
    detectSeverity("Pengalihan arus kendaraan dilakukan petugas kepolisian."),
    "medium",
  );
  assert.equal(
    detectSeverity("Macet parah terjadi di kawasan Sudirman menjelang jam pulang kerja."),
    "medium",
  );
});

test("multisource-correlator locates micro-landmarks and clusters multi-source traffic incidents", () => {
  // Toponym lookup
  const toponymSemanggi = findJakartaToponym("Truk muatan terguling di Simpang Susun Semanggi.");
  assert.ok(toponymSemanggi !== null);
  assert.equal(toponymSemanggi.name, "Simpang Susun Semanggi");
  assert.equal(toponymSemanggi.key, "simpang_susun_semanggi");
  assert.equal(toponymSemanggi.coordinates[0], 106.8156);
  assert.equal(toponymSemanggi.coordinates[1], -6.2201);

  // Toponym precedence
  const toponymUnderpassSenen = findJakartaToponym("Genangan setinggi 30 cm di Underpass Senen jalur barat.");
  assert.ok(toponymUnderpassSenen !== null);
  assert.equal(toponymUnderpassSenen.key, "underpass_senen");

  // Multi-source correlation: TMC Polda Metro + ANTARA reporting same Semanggi incident
  const tmcReport = makeReport({
    report_revision_id: "rep-tmc-semanggi-1",
    source_id: "source-tmc-polda-metro",
    permitted_text: "Truk terguling di Simpang Susun Semanggi arah Kuningan. Contraflow diberlakukan.",
    published_at: "2026-10-26T08:10:00.000Z",
  });

  const antaraReport = makeReport({
    report_revision_id: "rep-antara-semanggi-1",
    source_id: "source-antara-metro",
    permitted_text: "Tabrakan truk di Simpang Susun Semanggi mengakibatkan kemacetan panjang.",
    published_at: "2026-10-26T08:25:00.000Z",
  });

  const clusters = correlateSourceReports([tmcReport, antaraReport]);
  assert.equal(clusters.length, 1, "Should correlate into 1 incident cluster");
  assert.equal(clusters[0]?.primary_category, "accident");
  assert.equal(clusters[0]?.location_label, "Simpang Susun Semanggi, Jakarta Selatan");
  assert.equal(clusters[0]?.reports.length, 2);
  assert.ok(clusters[0]?.coordinates !== null);
  assert.equal(clusters[0]?.coordinates[0], 106.8156);
  assert.equal(clusters[0]?.coordinates[1], -6.2201);
});

test("rss-news-ingest identifies traffic disruption news items as relevant", () => {
  assert.ok(INCIDENT_KEYWORDS.includes("contraflow"));
  assert.ok(INCIDENT_KEYWORDS.includes("truk terguling"));
  assert.ok(INCIDENT_KEYWORDS.includes("krl anjlok"));
  assert.ok(INCIDENT_KEYWORDS.includes("rekayasa lalu lintas"));
  assert.ok(INCIDENT_KEYWORDS.includes("catenary putus"));

  assert.ok(RSS_TOPONYMS.includes("semanggi"));
  assert.ok(RSS_TOPONYMS.includes("dukuh atas"));
  assert.ok(RSS_TOPONYMS.includes("casablanca"));

  const trafficItem = {
    title: "Truk Terguling di Semanggi, Rekayasa Lalu Lintas Diberlakukan",
    link: "https://antara.news/101",
    guid: "guid-traffic-101",
    pubDate: "2026-10-26T08:00:00.000Z",
    description: "Insiden di Semanggi Jakarta Selatan",
  };

  const classification = classifyNewsItem(trafficItem);
  assert.equal(classification.isRelevant, true);
  assert.ok(classification.matchedToponyms.includes("semanggi"));
  assert.ok(
    classification.matchedKeywords.some((k) =>
      ["truk terguling", "terguling", "rekayasa lalu lintas"].includes(k),
    ),
  );
});
