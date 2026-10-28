import assert from "node:assert/strict";
import test from "node:test";
import {
  correlateSourceReports,
  haversineDistanceMeters,
  suppressDuplicateReports,
  detectReportCategory,
  extractReportLocation,
  extractReportTimestamp,
  areCategoriesCompatible,
  JAKARTA_ENVELOPE,
  type StoredReportRevision,
  type StoredEvidenceChunk,
} from "../src/layers/l1-data-knowledge/multisource-correlator.js";
import {
  generateCorrelatedProposal,
  type EventProposalDto,
} from "../src/layers/l2-model-grounding/correlated-proposal-engine.js";

function makeReport(overrides: Partial<StoredReportRevision> = {}): StoredReportRevision {
  const report_revision_id = overrides.report_revision_id ?? "rep-default-001";
  const permitted_text =
    overrides.permitted_text ??
    "Banjir setinggi 50 cm merendam kawasan Mampang Prapatan Jakarta Selatan pada pagi ini.";
  const chunks: readonly StoredEvidenceChunk[] = overrides.chunks ?? [
    {
      chunk_index: 0,
      text: permitted_text,
      span_start: 0,
      span_end: Array.from(permitted_text).length,
    },
  ];

  return {
    report_revision_id,
    source_id: "petabencana",
    canonical_url: `https://petabencana.id/report/${report_revision_id}`,
    permitted_text,
    permitted_text_hash: `hash-${report_revision_id}-${permitted_text.length}`,
    published_at: "2026-10-26T08:00:00.000Z",
    retrieved_at: "2026-10-26T08:05:00.000Z",
    revision_status: "unreviewed",
    chunks,
    ...overrides,
  };
}

test("haversineDistanceMeters accurately computes known Jakarta distance", () => {
  const monas: [number, number] = [106.8272, -6.1754];
  const gambir: [number, number] = [106.8302, -6.1754];
  const dist = haversineDistanceMeters(monas, gambir);
  assert.ok(dist >= 300 && dist <= 360, `Expected ~330m, got ${dist}m`);
});

test("detectReportCategory classifies major hazard categories", () => {
  assert.equal(
    detectReportCategory(makeReport({ permitted_text: "Banjir merendam jalan raya setinggi 60 cm" })),
    "flood",
  );
  assert.equal(
    detectReportCategory(makeReport({ permitted_text: "Kebakaran melahap puluhan kios di pasar" })),
    "fire",
  );
  assert.equal(
    detectReportCategory(makeReport({ permitted_text: "Kecelakaan beruntun melibatkan tiga mobil" })),
    "accident",
  );
  assert.equal(
    detectReportCategory(makeReport({ permitted_text: "Pohon tumbang menimpa kabel listrik di pinggir jalan" })),
    "tree_fall",
  );
  assert.equal(
    detectReportCategory(makeReport({ permitted_text: "Aksi tawuran pemuda bersenjata tajam diamankan" })),
    "crime",
  );
  assert.equal(
    detectReportCategory(makeReport({ permitted_text: "Hujan lebat disertai angin puting beliung" })),
    "weather",
  );
});

test("areCategoriesCompatible allows same category and flood-weather cross correlation", () => {
  assert.equal(areCategoriesCompatible("flood", "flood"), true);
  assert.equal(areCategoriesCompatible("fire", "fire"), true);
  assert.equal(areCategoriesCompatible("flood", "fire"), false);
  assert.equal(
    areCategoriesCompatible("flood", "weather", "Banjir di jalanan", "Hujan lebat memicu genangan"),
    true,
  );
});

test("extractReportLocation identifies bracketed coordinates and Jakarta toponyms", () => {
  const repWithCoords = makeReport({
    permitted_text: "Laporan banjir PetaBencana ID 1234: Koordinat lokasi [106.82500, -6.25000].",
  });
  const loc = extractReportLocation(repWithCoords);
  assert.ok(loc !== null);
  assert.ok(loc.coordinates !== null);
  assert.equal(loc.coordinates[0], 106.825);
  assert.equal(loc.coordinates[1], -6.25);

  const repWithToponym = makeReport({
    permitted_text: "Banjir merendam kawasan Kemang Raya Jakarta Selatan.",
  });
  const locToponym = extractReportLocation(repWithToponym);
  assert.ok(locToponym !== null);
  assert.equal(locToponym.locationLabel, "Kemang, Jakarta Selatan");
});

test("extractReportTimestamp parses published_at, in-text timestamps, or retrieved_at", () => {
  const rep1 = makeReport({ published_at: "2026-10-26T09:15:00.000Z" });
  assert.equal(extractReportTimestamp(rep1), Date.parse("2026-10-26T09:15:00.000Z"));

  const rep2 = makeReport({
    published_at: null,
    permitted_text: "Laporan observasi pada 2026-10-26T10:00:00.000Z di lapangan.",
  });
  assert.equal(extractReportTimestamp(rep2), Date.parse("2026-10-26T10:00:00.000Z"));
});

test("correlates 2 distinct sources (PetaBencana + ANTARA) in Mampang within 1 hour into 1 cluster", () => {
  const petabencanaReport = makeReport({
    report_revision_id: "rep-petabencana-mampang-001",
    source_id: "petabencana",
    canonical_url: "https://petabencana.id/report/mampang-001",
    permitted_text:
      "Laporan banjir PetaBencana ID 90123: status laporan tergenang. " +
      "Koordinat lokasi [106.82500, -6.25000]. Waktu pembuatan laporan: 2026-10-26T08:00:00.000Z.",
    published_at: "2026-10-26T08:00:00.000Z",
    retrieved_at: "2026-10-26T08:02:00.000Z",
    chunks: [
      {
        chunk_index: 0,
        text: "Laporan banjir PetaBencana ID 90123: status laporan tergenang. Koordinat lokasi [106.82500, -6.25000].",
        span_start: 0,
        span_end: 103,
      },
    ],
  });

  const antaraReport = makeReport({
    report_revision_id: "rep-antara-mampang-002",
    source_id: "source-antara-metro",
    canonical_url: "https://www.antaranews.com/berita/20261026/banjir-mampang-prapatan",
    permitted_text:
      "Banjir setinggi 60 cm merendam kawasan Mampang Prapatan Jakarta Selatan pada Senin pagi. " +
      "Petugas gabungan dan pompa air dikerahkan untuk mempercepat penyurutan genangan.",
    published_at: "2026-10-26T08:45:00.000Z", // 45 minutes later (< 4 hours)
    retrieved_at: "2026-10-26T08:50:00.000Z",
    chunks: [
      {
        chunk_index: 0,
        text: "Banjir setinggi 60 cm merendam kawasan Mampang Prapatan Jakarta Selatan pada Senin pagi.",
        span_start: 0,
        span_end: 89,
      },
      {
        chunk_index: 1,
        text: "Petugas gabungan dan pompa air dikerahkan untuk mempercepat penyurutan genangan.",
        span_start: 90,
        span_end: 170,
      },
    ],
  });

  const clusters = correlateSourceReports([petabencanaReport, antaraReport]);

  assert.equal(clusters.length, 1, "Should merge both reports into exactly 1 cluster");
  const cluster = clusters[0]!;

  assert.equal(cluster.primary_category, "flood");
  assert.equal(cluster.is_multi_source, true);
  assert.equal(cluster.sources.length, 2);
  assert.ok(cluster.sources.includes("petabencana"));
  assert.ok(cluster.sources.includes("source-antara-metro"));
  assert.equal(cluster.reports.length, 2);
  assert.ok(cluster.location_label.includes("Mampang"));

  // Coordinates should match exact GPS coordinates
  assert.ok(cluster.coordinates !== null);
  assert.equal(cluster.coordinates[0], 106.825);
  assert.equal(cluster.coordinates[1], -6.25);

  // Generate Correlated Proposal
  const proposal: EventProposalDto = generateCorrelatedProposal(cluster);

  assert.equal(proposal.schema_version, "2.0");
  assert.equal(proposal.incident_type, "flood");
  assert.equal(proposal.is_multi_source, true);
  assert.equal(proposal.source_count, 2);
  assert.ok(proposal.title.includes("Banjir"));
  assert.ok(proposal.title.includes("Mampang"));

  // Check claims corroboration elevation
  assert.ok(proposal.claims.length >= 2, "Proposal must contain claims from both evidence sources");
  for (const claim of proposal.claims) {
    assert.equal(claim.is_corroborated, true, "Multi-source claims must be flagged as corroborated");
    assert.equal(claim.evidence_label, "under_review");
    assert.equal(claim.support_assessment, "supported");
  }

  // Verify citation faithfulness (100% exact substring match against referenced chunks)
  for (const claim of proposal.claims) {
    const report =
      claim.evidence_ref_id.includes(petabencanaReport.report_revision_id)
        ? petabencanaReport
        : antaraReport;
    const matchingChunk = report.chunks.find((c) =>
      claim.evidence_ref_id === `ref-${report.report_revision_id}-${c.chunk_index}`,
    );
    assert.ok(matchingChunk !== undefined, `Could not find chunk for ${claim.evidence_ref_id}`);
    assert.ok(
      matchingChunk.text.includes(claim.quote_text),
      `Quote "${claim.quote_text}" is not an exact substring of chunk "${matchingChunk.text}"`,
    );
  }
});

test("suppresses duplicate reports from same source within 6 hours", () => {
  const originalReport = makeReport({
    report_revision_id: "rep-peta-kemang-1",
    source_id: "petabencana",
    permitted_text: "Laporan banjir PetaBencana ID 1111: genangan di Kemang Raya setinggi 40 cm. Koordinat lokasi [106.81500, -6.26000].",
    published_at: "2026-10-26T07:00:00.000Z",
  });

  const duplicateReport = makeReport({
    report_revision_id: "rep-peta-kemang-2",
    source_id: "petabencana", // Same source
    permitted_text: "Laporan banjir PetaBencana ID 1112: genangan air di Kemang Raya terpantau 45 cm. Koordinat lokasi [106.81510, -6.26010].",
    published_at: "2026-10-26T07:45:00.000Z", // 45 minutes later (well within 6h window)
  });

  const suppressed = suppressDuplicateReports([originalReport, duplicateReport]);
  assert.equal(suppressed.length, 1, "Duplicate report from same source within 6 hours must be suppressed");
  assert.equal(suppressed[0]?.report_revision_id, "rep-peta-kemang-1");
});

test("does not suppress reports from same source beyond 6-hour window", () => {
  const morningReport = makeReport({
    report_revision_id: "rep-peta-morning",
    source_id: "petabencana",
    permitted_text: "Laporan banjir Kemang Raya Koordinat lokasi [106.81500, -6.26000].",
    published_at: "2026-10-26T06:00:00.000Z",
  });

  const eveningReport = makeReport({
    report_revision_id: "rep-peta-evening",
    source_id: "petabencana",
    permitted_text: "Laporan banjir Kemang Raya Koordinat lokasi [106.81500, -6.26000].",
    published_at: "2026-10-26T14:30:00.000Z", // 8.5 hours later (> 6 hours)
  });

  const result = suppressDuplicateReports([morningReport, eveningReport]);
  assert.equal(result.length, 2, "Reports beyond 6-hour window must not be suppressed as duplicates");
});

test("multi-source correlation with duplicate suppression leaves only clean distinct sources", () => {
  const pb1 = makeReport({
    report_revision_id: "rep-pb-1",
    source_id: "petabencana",
    permitted_text: "Banjir di Rawamangun Jakarta Timur ketinggian 50 cm.",
    published_at: "2026-10-26T08:00:00.000Z",
  });

  const pb2Duplicate = makeReport({
    report_revision_id: "rep-pb-2-dup",
    source_id: "petabencana", // duplicate from petabencana in same location
    permitted_text: "Genangan di Rawamangun Jakarta Timur setinggi 50 cm.",
    published_at: "2026-10-26T08:20:00.000Z",
  });

  const antara = makeReport({
    report_revision_id: "rep-antara-1",
    source_id: "source-antara-metro",
    permitted_text: "Banjir merendam kawasan Rawamangun Jakarta Timur akibat luapan saluran air.",
    published_at: "2026-10-26T08:35:00.000Z",
  });

  const clusters = correlateSourceReports([pb1, pb2Duplicate, antara]);

  assert.equal(clusters.length, 1);
  const cluster = clusters[0]!;
  assert.equal(cluster.reports.length, 2, "Cluster must have exactly 2 reports (duplicate pb2 suppressed)");
  assert.equal(cluster.is_multi_source, true);
  assert.deepEqual([...cluster.sources].sort(), ["petabencana", "source-antara-metro"].sort());
});

test("separates incidents that are spatially distant (> 1,200m)", () => {
  // Kemang in Jakarta Selatan vs Rawamangun in Jakarta Timur (~15 km apart)
  const kemangReport = makeReport({
    report_revision_id: "rep-kemang",
    permitted_text: "Banjir melanda kawasan Kemang Raya Jakarta Selatan.",
    published_at: "2026-10-26T08:00:00.000Z",
  });

  const rawamangunReport = makeReport({
    report_revision_id: "rep-rawamangun",
    permitted_text: "Banjir merendam kawasan Rawamangun Jakarta Timur.",
    published_at: "2026-10-26T08:30:00.000Z",
  });

  const clusters = correlateSourceReports([kemangReport, rawamangunReport]);
  assert.equal(clusters.length, 2, "Distant incidents must not be merged");
  assert.equal(clusters[0]!.is_multi_source, false);
  assert.equal(clusters[1]!.is_multi_source, false);
});

test("separates incidents that are temporally distant (> 4 hours)", () => {
  const morningReport = makeReport({
    report_revision_id: "rep-mampang-morning",
    source_id: "petabencana",
    permitted_text: "Banjir di Mampang Prapatan Jakarta Selatan.",
    published_at: "2026-10-26T06:00:00.000Z",
  });

  const afternoonReport = makeReport({
    report_revision_id: "rep-mampang-afternoon",
    source_id: "source-antara-metro",
    permitted_text: "Banjir di Mampang Prapatan Jakarta Selatan.",
    published_at: "2026-10-26T12:00:00.000Z", // 6 hours difference (> 4 hours)
  });

  const clusters = correlateSourceReports([morningReport, afternoonReport]);
  assert.equal(clusters.length, 2, "Incidents beyond 4 hours window must not be merged");
});

test("separates incidents with incompatible hazard categories", () => {
  const floodReport = makeReport({
    report_revision_id: "rep-flood-cawang",
    permitted_text: "Banjir setinggi 70 cm merendam terowongan Cawang Jakarta Timur.",
    published_at: "2026-10-26T08:00:00.000Z",
  });

  const fireReport = makeReport({
    report_revision_id: "rep-fire-cawang",
    permitted_text: "Kebakaran ruko melahap kawasan Cawang Jakarta Timur.",
    published_at: "2026-10-26T08:15:00.000Z",
  });

  const clusters = correlateSourceReports([floodReport, fireReport]);
  assert.equal(clusters.length, 2, "Flood and Fire incidents must not be merged");
});

test("single-source cluster produces proposal with is_multi_source false and uncorroborated claims", () => {
  const singleReport = makeReport({
    report_revision_id: "rep-single-fire",
    source_id: "source-antara-metro",
    permitted_text: "Kebakaran hebat melanda deretan ruko di Pasar Senen Jakarta Pusat pada dini hari.",
    published_at: "2026-10-26T02:00:00.000Z",
    chunks: [
      {
        chunk_index: 0,
        text: "Kebakaran hebat melanda deretan ruko di Pasar Senen Jakarta Pusat pada dini hari.",
        span_start: 0,
        span_end: 81,
      },
    ],
  });

  const clusters = correlateSourceReports([singleReport]);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0]!.is_multi_source, false);

  const proposal = generateCorrelatedProposal(clusters[0]!);
  assert.equal(proposal.is_multi_source, false);
  assert.equal(proposal.source_count, 1);
  assert.equal(proposal.incident_type, "fire");
  for (const claim of proposal.claims) {
    assert.equal(claim.is_corroborated, false);
  }
});

test("handles empty inputs and malformed reports safely", () => {
  assert.deepEqual(correlateSourceReports([]), []);
  assert.throws(
    () => generateCorrelatedProposal(null as unknown as Parameters<typeof generateCorrelatedProposal>[0]),
    /Cannot generate proposal from empty or malformed cluster/,
  );
});

test("verifies all proposal coordinates fall strictly inside Jakarta bounding envelope", () => {
  const report1 = makeReport({
    permitted_text: "Pohon tumbang menimpa jalur busway di Gatot Subroto Jakarta Selatan.",
    published_at: "2026-10-26T09:00:00.000Z",
  });
  const clusters = correlateSourceReports([report1]);
  assert.equal(clusters.length, 1);

  const proposal = generateCorrelatedProposal(clusters[0]!);
  assert.ok(proposal.coordinates !== null);
  const [lng, lat] = proposal.coordinates;
  assert.ok(lng >= JAKARTA_ENVELOPE.west && lng <= JAKARTA_ENVELOPE.east);
  assert.ok(lat >= JAKARTA_ENVELOPE.south && lat <= JAKARTA_ENVELOPE.north);
});

test("correlates distinct news sources reporting via specific district and parent administrative region (e.g. Menteng & Jakpus)", () => {
  const detikReport = makeReport({
    report_revision_id: "rep-detik-menteng",
    source_id: "source-detik-news",
    canonical_url: "https://news.detik.com/berita/d-12345/kebakaran-menteng",
    permitted_text: "Kebakaran Rumah di Menteng Jaya Jakpus, 20 Unit Damkar Dikerahkan",
    published_at: "2026-10-28T02:00:00.000Z",
    chunks: [
      {
        chunk_index: 0,
        text: "Kebakaran Rumah di Menteng Jaya Jakpus, 20 Unit Damkar Dikerahkan",
        span_start: 0,
        span_end: 65,
      },
    ],
  });

  const cnnReport = makeReport({
    report_revision_id: "rep-cnn-jakpus",
    source_id: "source-cnn-nasional",
    canonical_url: "https://www.cnnindonesia.com/nasional/20261028-kebakaran-jakpus",
    permitted_text: "Kebakaran Permukiman Padat di Jakpus, 31 Mobil Damkar Dikerahkan",
    published_at: "2026-10-28T02:30:00.000Z",
    chunks: [
      {
        chunk_index: 0,
        text: "Kebakaran Permukiman Padat di Jakpus, 31 Mobil Damkar Dikerahkan",
        span_start: 0,
        span_end: 64,
      },
    ],
  });

  const clusters = correlateSourceReports([detikReport, cnnReport]);
  assert.equal(clusters.length, 1, "Must correlate into 1 cluster via administrative hierarchy");
  const cluster = clusters[0]!;
  assert.equal(cluster.is_multi_source, true);
  assert.equal(cluster.sources.length, 2);
  assert.equal(cluster.location_label, "Menteng, Jakarta Pusat");

  const proposal = generateCorrelatedProposal(cluster);
  assert.equal(proposal.is_multi_source, true);
  assert.equal(proposal.source_count, 2);
  assert.equal(proposal.claims.length, 2);
  for (const claim of proposal.claims) {
    assert.equal(claim.is_corroborated, true);
  }
});
