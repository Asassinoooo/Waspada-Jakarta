import assert from "node:assert/strict";
import test from "node:test";
import {
  correlateSourceReports,
  type StoredReportRevision,
  type StoredEvidenceChunk,
  type CorrelatedIncidentCluster,
} from "../src/layers/l1-data-knowledge/multisource-correlator.js";
import {
  detectIncidentDiscrepancies,
  generateCorrelatedProposal,
  type EventProposalDto,
  type IncidentDiscrepancy,
} from "../src/layers/l2-model-grounding/correlated-proposal-engine.js";

function makeReport(overrides: Partial<StoredReportRevision> = {}): StoredReportRevision {
  const report_revision_id = overrides.report_revision_id ?? "rep-test-001";
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
    source_id: overrides.source_id ?? "petabencana",
    canonical_url: overrides.canonical_url ?? `https://petabencana.id/report/${report_revision_id}`,
    permitted_text,
    permitted_text_hash: `hash-${report_revision_id}-${permitted_text.length}`,
    published_at: overrides.published_at ?? "2026-10-26T08:00:00.000Z",
    retrieved_at: overrides.retrieved_at ?? "2026-10-26T08:05:00.000Z",
    revision_status: "unreviewed",
    chunks,
    ...overrides,
  };
}

function makeCluster(
  reports: readonly StoredReportRevision[],
  overrides: Partial<CorrelatedIncidentCluster> = {},
): CorrelatedIncidentCluster {
  const sources = Array.from(new Set(reports.map((r) => r.source_id)));
  return {
    cluster_id: overrides.cluster_id ?? "cluster-test-001",
    primary_category: overrides.primary_category ?? "flood",
    location_label: overrides.location_label ?? "Mampang Prapatan, Jakarta Selatan",
    coordinates: overrides.coordinates ?? [106.825, -6.25],
    reports,
    is_multi_source: sources.length >= 2,
    sources,
    ...overrides,
  };
}

test("detectIncidentDiscrepancies returns empty array for empty, single, or same-source reports", () => {
  assert.deepEqual(detectIncidentDiscrepancies([]), []);

  const rep1 = makeReport({ source_id: "source-a" });
  assert.deepEqual(detectIncidentDiscrepancies([rep1]), []);

  const rep2 = makeReport({
    report_revision_id: "rep-2",
    source_id: "source-a",
    permitted_text: "Banjir 100 cm di Mampang Prapatan.",
  });
  // Same source ID should not trigger cross-source discrepancy
  assert.deepEqual(detectIncidentDiscrepancies([rep1, rep2]), []);
});

test("water_depth discrepancy: detects divergence when depths differ by >= 30 cm", () => {
  const citizenReport = makeReport({
    report_revision_id: "rep-citizen-01",
    source_id: "petabencana-warga",
    permitted_text: "Genangan air setinggi 40 cm dilaporkan warga di jalan Mampang Prapatan.",
  });

  const newsReport = makeReport({
    report_revision_id: "rep-news-01",
    source_id: "source-antara-news",
    permitted_text: "Banjir di Mampang Prapatan dilaporkan mencapai ketinggian 100 cm.",
  });

  const discrepancies = detectIncidentDiscrepancies([citizenReport, newsReport]);
  assert.equal(discrepancies.length, 1);
  const d = discrepancies[0]!;
  assert.equal(d.kind, "water_depth");
  assert.ok(d.description.includes("40 cm"));
  assert.ok(d.description.includes("100 cm"));
  assert.ok(d.description.includes("60 cm") || d.description.includes("selisih"));
  assert.equal(d.source_a.source_id, "petabencana-warga");
  assert.equal(d.source_b.source_id, "source-antara-news");
  assert.ok(d.source_a.claim_text.includes("40 cm"));
  assert.ok(d.source_b.claim_text.includes("100 cm"));
});

test("water_depth discrepancy: correctly parses meters and handles unit conversion", () => {
  const repA = makeReport({
    report_revision_id: "rep-meter-a",
    source_id: "source-sensor-iot",
    permitted_text: "Tinggi muka air sungai 0.5 m terpantau di pos pengamatan.",
  });

  const repB = makeReport({
    report_revision_id: "rep-meter-b",
    source_id: "source-detik-news",
    permitted_text: "Ketinggian banjir mencapai 1.5 meter merendam pemukiman warga bantaran kali.",
  });

  // 0.5 m = 50 cm vs 1.5 m = 150 cm -> difference = 100 cm >= 30 cm
  const discrepancies = detectIncidentDiscrepancies([repA, repB]);
  assert.equal(discrepancies.length, 1);
  assert.equal(discrepancies[0]!.kind, "water_depth");
  assert.ok(discrepancies[0]!.description.includes("50 cm"));
  assert.ok(discrepancies[0]!.description.includes("150 cm"));
});

test("water_depth discrepancy: ignores differences < 30 cm", () => {
  const repA = makeReport({
    report_revision_id: "rep-close-a",
    source_id: "source-warga",
    permitted_text: "Air tergenang setinggi 40 cm di badan jalan.",
  });

  const repB = makeReport({
    report_revision_id: "rep-close-b",
    source_id: "source-radio-elshinta",
    permitted_text: "Genangan air setinggi 50 cm dilaporkan terjadi di lokasi.",
  });

  // 50 cm - 40 cm = 10 cm < 30 cm -> no discrepancy
  const discrepancies = detectIncidentDiscrepancies([repA, repB]);
  assert.equal(discrepancies.length, 0);
});

test("casualty_count discrepancy: detects conflict when one source reports 0/nihil and another reports >= 1", () => {
  const repOfficial = makeReport({
    report_revision_id: "rep-bpbd-01",
    source_id: "source-bpbd-jakarta",
    permitted_text: "Kebakaran ruko di Pasar Senen berhasil dilokalisir, dipastikan korban jiwa nihil.",
  });

  const repNews = makeReport({
    report_revision_id: "rep-tribun-01",
    source_id: "source-tribun-news",
    permitted_text: "Kebakaran di Senen menyebabkan 2 orang korban meninggal dunia dilarikan ke rumah sakit.",
  });

  const discrepancies = detectIncidentDiscrepancies([repOfficial, repNews]);
  assert.equal(discrepancies.length, 1);
  const d = discrepancies[0]!;
  assert.equal(d.kind, "casualty_count");
  assert.ok(d.description.includes("nihil") || d.description.includes("0"));
  assert.ok(d.description.includes("2 korban"));
  assert.equal(d.source_a.source_id, "source-bpbd-jakarta");
  assert.equal(d.source_b.source_id, "source-tribun-news");
  assert.ok(d.source_a.claim_text.includes("nihil"));
  assert.ok(d.source_b.claim_text.includes("2 orang korban"));
});

test("casualty_count discrepancy: detects conflicting positive counts", () => {
  const repA = makeReport({
    report_revision_id: "rep-cas-1",
    source_id: "source-antara-news",
    permitted_text: "Insiden tabrakan beruntun menyebabkan 1 orang korban luka ringan.",
  });

  const repB = makeReport({
    report_revision_id: "rep-cas-2",
    source_id: "source-kompas-com",
    permitted_text: "Petugas melaporkan 5 orang korban luka dalam tabrakan beruntun.",
  });

  const discrepancies = detectIncidentDiscrepancies([repA, repB]);
  assert.equal(discrepancies.length, 1);
  assert.equal(discrepancies[0]!.kind, "casualty_count");
  assert.ok(discrepancies[0]!.description.includes("1 korban"));
  assert.ok(discrepancies[0]!.description.includes("5 korban"));
});

test("operational_status discrepancy: detects conflict between subsided and still flooded", () => {
  const repCitizen = makeReport({
    report_revision_id: "rep-status-cit",
    source_id: "petabencana",
    permitted_text: "Banjir di Rawajati sudah surut dan warga mulai membersihkan endapan lumpur.",
  });

  const repNews = makeReport({
    report_revision_id: "rep-status-news",
    source_id: "source-cnn-indonesia",
    permitted_text: "Permukiman di Rawajati masih tergenang banjir setinggi lutut orang dewasa.",
  });

  const discrepancies = detectIncidentDiscrepancies([repCitizen, repNews]);
  assert.equal(discrepancies.length, 1);
  const d = discrepancies[0]!;
  assert.equal(d.kind, "operational_status");
  assert.ok(d.description.includes("sudah surut"));
  assert.ok(d.description.includes("masih tergenang"));
  assert.ok(d.source_a.claim_text.includes("sudah surut"));
  assert.ok(d.source_b.claim_text.includes("masih tergenang"));
});

test("operational_status discrepancy: detects conflict between traffic flowing and road closed/gridlocked", () => {
  const repTmc = makeReport({
    report_revision_id: "rep-tmc-flow",
    source_id: "source-tmc-polda-metro",
    permitted_text: "Penanganan pohon tumbang selesai, jalur Gatot Subroto arus lancar terkendali.",
  });

  const repCitizen = makeReport({
    report_revision_id: "rep-citizen-stuck",
    source_id: "source-warga-jakarta",
    permitted_text: "Lalu lintas di Gatot Subroto macet total dan jalan ditutup oleh petugas kepolisian.",
  });

  const discrepancies = detectIncidentDiscrepancies([repTmc, repCitizen]);
  assert.equal(discrepancies.length, 1);
  const d = discrepancies[0]!;
  assert.equal(d.kind, "operational_status");
  assert.ok(d.description.includes("arus lancar"));
  assert.ok(d.description.includes("macet total"));
});

test("operational_status discrepancy: detects fire extinguished vs still burning", () => {
  const repDamkar = makeReport({
    report_revision_id: "rep-damkar-done",
    source_id: "source-damkar-dki",
    permitted_text: "Api di pemukiman Tambora sudah padam dan proses pendinginan selesai.",
  });

  const repWarga = makeReport({
    report_revision_id: "rep-warga-flame",
    source_id: "source-lapor-warga",
    permitted_text: "Warga melaporkan api masih berkobar di bagian belakang komplek ruko.",
  });

  const discrepancies = detectIncidentDiscrepancies([repDamkar, repWarga]);
  assert.equal(discrepancies.length, 1);
  assert.equal(discrepancies[0]!.kind, "operational_status");
  const desc = discrepancies[0]!.description.toLowerCase();
  assert.ok(desc.includes("sudah padam") && desc.includes("api masih berkobar"));
});

test("severity_assessment discrepancy: flags divergence between critical and low reports", () => {
  const repA = makeReport({
    report_revision_id: "rep-low",
    source_id: "source-warga",
    permitted_text: "Genangan tipis di jalan, nihil korban dan kendaraan dapat dilalui dengan lancar.",
  });

  const repB = makeReport({
    report_revision_id: "rep-crit",
    source_id: "source-news",
    permitted_text: "Kebakaran hebat melahap ratusan rumah hangus terbakar dan rata dengan tanah.",
  });

  const discrepancies = detectIncidentDiscrepancies([repA, repB]);
  assert.ok(discrepancies.length >= 1);
  assert.ok(discrepancies.some((d) => d.kind === "severity_assessment"));
});

test("generateCorrelatedProposal integration: generates proposal with has_discrepancy true and structured details", () => {
  const citizenReport = makeReport({
    report_revision_id: "rep-cit-001",
    source_id: "petabencana",
    permitted_text: "Laporan banjir di Mampang Prapatan setinggi 40 cm. Genangan air masuk ke teras rumah warga.",
    chunks: [
      {
        chunk_index: 0,
        text: "Laporan banjir di Mampang Prapatan setinggi 40 cm. Genangan air masuk ke teras rumah warga.",
        span_start: 0,
        span_end: 90,
      },
    ],
  });

  const newsReport = makeReport({
    report_revision_id: "rep-news-001",
    source_id: "source-antara-news",
    permitted_text: "Banjir parah melanda Mampang Prapatan dengan ketinggian mencapai 100 cm setelah hujan deras.",
    chunks: [
      {
        chunk_index: 0,
        text: "Banjir parah melanda Mampang Prapatan dengan ketinggian mencapai 100 cm setelah hujan deras.",
        span_start: 0,
        span_end: 92,
      },
    ],
  });

  const cluster = makeCluster([citizenReport, newsReport]);
  const proposal: EventProposalDto = generateCorrelatedProposal(cluster);

  assert.equal(proposal.schema_version, "2.0");
  assert.equal(proposal.is_multi_source, true);
  assert.equal(proposal.source_count, 2);
  assert.equal(proposal.has_discrepancy, true);
  assert.ok(proposal.discrepancies && proposal.discrepancies.length > 0);

  const depthDisc = proposal.discrepancies.find((d) => d.kind === "water_depth");
  assert.ok(depthDisc !== undefined, "Must contain water_depth discrepancy");
  assert.equal(depthDisc.source_a.source_id, "petabencana");
  assert.equal(depthDisc.source_b.source_id, "source-antara-news");
  assert.ok(depthDisc.source_a.claim_text.includes("40 cm"));
  assert.ok(depthDisc.source_b.claim_text.includes("100 cm"));

  // Check caveats
  assert.ok(proposal.caveats && proposal.caveats.length > 0);
  assert.ok(proposal.caveats[0]!.includes("Perbedaan keterangan sumber"));

  // Check claim synthesis
  assert.ok(proposal.claims.length >= 2);
  const newsClaim = proposal.claims.find((c) => c.evidence_ref_id.includes("rep-news-001"));
  const citClaim = proposal.claims.find((c) => c.evidence_ref_id.includes("rep-cit-001"));
  assert.ok(newsClaim !== undefined);
  assert.ok(citClaim !== undefined);
  assert.ok(newsClaim.claim_text.includes("pemantauan media") || newsClaim.claim_text.includes("perbedaan data"));
  assert.ok(citClaim.claim_text.includes("observasi warga") || citClaim.claim_text.includes("perbedaan data"));
});

test("generateCorrelatedProposal integration: consistent multi-source reports output has_discrepancy false", () => {
  const rep1 = makeReport({
    report_revision_id: "rep-consist-1",
    source_id: "petabencana",
    permitted_text: "Genangan banjir setinggi 40 cm di Kebon Baru Tebet Jakarta Selatan.",
    chunks: [
      {
        chunk_index: 0,
        text: "Genangan banjir setinggi 40 cm di Kebon Baru Tebet Jakarta Selatan.",
        span_start: 0,
        span_end: 67,
      },
    ],
  });

  const rep2 = makeReport({
    report_revision_id: "rep-consist-2",
    source_id: "source-detik-news",
    permitted_text: "Banjir genangan air setinggi 50 cm terjadi di kawasan Tebet Jakarta Selatan.",
    chunks: [
      {
        chunk_index: 0,
        text: "Banjir genangan air setinggi 50 cm terjadi di kawasan Tebet Jakarta Selatan.",
        span_start: 0,
        span_end: 75,
      },
    ],
  });

  const cluster = makeCluster([rep1, rep2], {
    location_label: "Tebet, Jakarta Selatan",
  });

  const proposal = generateCorrelatedProposal(cluster);
  assert.equal(proposal.is_multi_source, true);
  assert.equal(proposal.source_count, 2);
  assert.equal(proposal.has_discrepancy, false);
  assert.deepEqual(proposal.discrepancies, []);
  for (const claim of proposal.claims) {
    assert.equal(claim.is_corroborated, true);
  }
});

test("end-to-end: correlateSourceReports produces cluster with discrepancy flagged in proposal", () => {
  const cit = makeReport({
    report_revision_id: "rep-e2e-cit",
    source_id: "petabencana",
    permitted_text: "Banjir setinggi 40 cm merendam kawasan Mampang Prapatan.",
  });
  const news = makeReport({
    report_revision_id: "rep-e2e-news",
    source_id: "source-antara-news",
    permitted_text: "Banjir di Mampang Prapatan mencapai ketinggian 100 cm.",
  });
  const clusters = correlateSourceReports([cit, news]);
  assert.equal(clusters.length, 1);
  const proposal = generateCorrelatedProposal(clusters[0]!);
  assert.equal(proposal.has_discrepancy, true);
  assert.ok(proposal.discrepancies && proposal.discrepancies.length > 0);
  const disc: IncidentDiscrepancy = proposal.discrepancies[0]!;
  assert.equal(disc.kind, "water_depth");
});
