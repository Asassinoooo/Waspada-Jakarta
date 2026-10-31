import assert from "node:assert/strict";
import test from "node:test";
import {
  generateProposalFromReport,
  type StoredReportRevision,
  type StoredEvidenceChunk,
  JAKARTA_ENVELOPE,
} from "../src/layers/l2-model-grounding/proposal-engine.js";

function makeReport(overrides: Partial<StoredReportRevision> = {}): StoredReportRevision {
  const permitted_text = overrides.permitted_text ?? "Banjir merendam kawasan Rawamangun Jakarta Timur dengan ketinggian air mencapai 60 cm.";
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
    report_revision_id: "rev-test-001",
    source_id: "source-antara-metro",
    canonical_url: "https://www.antaranews.com/berita/1001/insiden-jakarta",
    permitted_text,
    permitted_text_hash: "a".repeat(64),
    published_at: "2026-10-26T03:30:00.000Z",
    retrieved_at: "2026-10-26T03:35:00.000Z",
    revision_status: "unreviewed",
    chunks,
    ...overrides,
  };
}

test("generates valid schema 2.0 flood proposal from report", () => {
  const report = makeReport({
    report_revision_id: "rev-flood-101",
    permitted_text:
      "Banjir tergenang setinggi 60 cm di kawasan Rawamangun Jakarta Timur akibat hujan deras. " +
      "Arus lalu lintas di lokasi dilaporkan tersendat dan warga diimbau waspada.",
    chunks: [
      {
        chunk_index: 0,
        text: "Banjir tergenang setinggi 60 cm di kawasan Rawamangun Jakarta Timur akibat hujan deras.",
        span_start: 0,
        span_end: 86,
      },
      {
        chunk_index: 1,
        text: "Arus lalu lintas di lokasi dilaporkan tersendat dan warga diimbau waspada.",
        span_start: 87,
        span_end: 161,
      },
    ],
  });

  const proposal = generateProposalFromReport(report);
  assert.ok(proposal !== null, "proposal should not be null");
  assert.equal(proposal.schema_version, "2.0");
  assert.equal(proposal.proposal_id, "prop-rev-flood-101");
  assert.equal(proposal.incident_type, "flood");
  assert.equal(proposal.severity, "medium");
  assert.ok(proposal.title.includes("Banjir"), `Expected title to contain Banjir, got ${proposal.title}`);
  assert.ok(proposal.title.includes("Rawamangun"), `Expected title to contain Rawamangun, got ${proposal.title}`);
  assert.equal(proposal.location_label, "Rawamangun, Jakarta Timur");

  // Coordinates validation
  assert.ok(proposal.coordinates !== null);
  const [lng, lat] = proposal.coordinates;
  assert.ok(lng >= JAKARTA_ENVELOPE.west && lng <= JAKARTA_ENVELOPE.east);
  assert.ok(lat >= JAKARTA_ENVELOPE.south && lat <= JAKARTA_ENVELOPE.north);

  // Claims validation
  assert.ok(proposal.claims.length >= 1 && proposal.claims.length <= 3);
  for (const claim of proposal.claims) {
    assert.equal(claim.evidence_label, "under_review");
    assert.equal(claim.support_assessment, "supported");
    assert.ok(claim.claim_id.startsWith("claim-"));
    assert.ok(claim.evidence_ref_id.startsWith("ref-rev-flood-101-"));

    // Verify exact substring citation without hallucination
    const chunkIndex = Number(claim.evidence_ref_id.split("-").pop());
    const sourceChunk = report.chunks[chunkIndex];
    assert.ok(sourceChunk !== undefined, `Referenced chunk ${chunkIndex} must exist`);
    assert.ok(
      sourceChunk.text.includes(claim.quote_text),
      `quote_text "${claim.quote_text}" must be an exact substring of chunk "${sourceChunk.text}"`,
    );
  }
});

test("generates valid schema 2.0 fire proposal with critical severity", () => {
  const report = makeReport({
    report_revision_id: "rev-fire-202",
    permitted_text:
      "Kebakaran hebat hanguskan puluhan rumah di kawasan Johar Baru Jakarta Pusat pada Senin dini hari. " +
      "Petugas pemadam kebakaran damkar diterjunkan ke lokasi, dilaporkan dua orang meninggal dunia.",
    chunks: [
      {
        chunk_index: 0,
        text: "Kebakaran hebat hanguskan puluhan rumah di kawasan Johar Baru Jakarta Pusat pada Senin dini hari.",
        span_start: 0,
        span_end: 97,
      },
      {
        chunk_index: 1,
        text: "Petugas pemadam kebakaran damkar diterjunkan ke lokasi, dilaporkan dua orang meninggal dunia.",
        span_start: 98,
        span_end: 191,
      },
    ],
  });

  const proposal = generateProposalFromReport(report);
  assert.ok(proposal !== null);
  assert.equal(proposal.incident_type, "fire");
  assert.equal(proposal.severity, "critical", "Casualty or massive fire should trigger critical severity");
  assert.equal(proposal.location_label, "Johar Baru, Jakarta Pusat");
  assert.ok(proposal.title.includes("Kebakaran"));
  assert.ok(proposal.title.includes("Johar Baru"));

  assert.ok(proposal.coordinates !== null);
  const [lng, lat] = proposal.coordinates;
  assert.equal(lng, 106.8580);
  assert.equal(lat, -6.1850);

  assert.ok(proposal.claims.length >= 1);
  for (const claim of proposal.claims) {
    assert.equal(claim.evidence_label, "under_review");
    assert.equal(claim.support_assessment, "supported");
    const chunkIdx = Number(claim.evidence_ref_id.split("-").pop());
    const chunk = report.chunks[chunkIdx]!;
    assert.ok(chunk.text.includes(claim.quote_text));
  }
});

test("generates valid schema 2.0 accident proposal from report", () => {
  const report = makeReport({
    report_revision_id: "rev-acc-303",
    permitted_text:
      "Kecelakaan lalu lintas truk terguling terjadi di Tol Cawang Jakarta Timur pada pukul 14.30 WIB. " +
      "Tabrakan beruntun mengakibatkan arus kendaraan padat merayap dan proses evakuasi sedang berlangsung.",
    published_at: "2026-10-26T07:30:00.000Z",
    chunks: [
      {
        chunk_index: 0,
        text: "Kecelakaan lalu lintas truk terguling terjadi di Tol Cawang Jakarta Timur pada pukul 14.30 WIB.",
        span_start: 0,
        span_end: 95,
      },
      {
        chunk_index: 1,
        text: "Tabrakan beruntun mengakibatkan arus kendaraan padat merayap dan proses evakuasi sedang berlangsung.",
        span_start: 96,
        span_end: 198,
      },
    ],
  });

  const proposal = generateProposalFromReport(report);
  assert.ok(proposal !== null);
  assert.equal(proposal.incident_type, "accident");
  assert.equal(proposal.location_label, "Cawang, Jakarta Timur");
  assert.ok(proposal.title.includes("Kecelakaan Lalu Lintas"));
  assert.ok(proposal.title.includes("Cawang"));

  // Check event time extraction
  assert.equal(proposal.event_time.precision, "exact");
  assert.ok(proposal.event_time.value?.includes("14:30:00+07:00"));

  assert.ok(proposal.claims.length >= 1);
  for (const claim of proposal.claims) {
    assert.equal(claim.evidence_label, "under_review");
    assert.equal(claim.support_assessment, "supported");
    const chunkIdx = Number(claim.evidence_ref_id.split("-").pop());
    const chunk = report.chunks[chunkIdx]!;
    assert.ok(chunk.text.includes(claim.quote_text));
  }
});

test("generates valid schema 2.0 tree_fall proposal from report", () => {
  const report = makeReport({
    report_revision_id: "rev-tree-404",
    permitted_text:
      "Pohon tumbang timpa mobil di Jalan Thamrin Menteng Jakarta Pusat saat hujan lebat. " +
      "Petugas telah berada di lokasi untuk memotong dahan dan tidak ada korban jiwa dalam kejadian ini.",
    chunks: [
      {
        chunk_index: 0,
        text: "Pohon tumbang timpa mobil di Jalan Thamrin Menteng Jakarta Pusat saat hujan lebat.",
        span_start: 0,
        span_end: 82,
      },
    ],
  });

  const proposal = generateProposalFromReport(report);
  assert.ok(proposal !== null);
  assert.equal(proposal.incident_type, "tree_fall");
  assert.ok(proposal.location_label?.includes("Jakarta Pusat"));
  assert.ok(proposal.title.includes("Pohon Tumbang"));
  assert.ok(proposal.claims.length >= 1);
  assert.ok(report.chunks[0]!.text.includes(proposal.claims[0]!.quote_text));
});

test("generates valid schema 2.0 weather and crime proposals", () => {
  // Weather
  const weatherReport = makeReport({
    report_revision_id: "rev-weather-505",
    permitted_text: "Angin kencang dan cuaca ekstrem melanda kawasan Kelapa Gading Jakarta Utara sore ini.",
  });
  const weatherProposal = generateProposalFromReport(weatherReport);
  assert.ok(weatherProposal !== null);
  assert.equal(weatherProposal.incident_type, "weather");
  assert.equal(weatherProposal.location_label, "Kelapa Gading, Jakarta Utara");

  // Crime
  const crimeReport = makeReport({
    report_revision_id: "rev-crime-606",
    permitted_text: "Aksi tawuran pemuda terjadi di kawasan Kemayoran Jakarta Pusat, polisi amankan senjata tajam.",
  });
  const crimeProposal = generateProposalFromReport(crimeReport);
  assert.ok(crimeProposal !== null);
  assert.equal(crimeProposal.incident_type, "crime");
  assert.equal(crimeProposal.location_label, "Kemayoran, Jakarta Pusat");
});

test("rejects non-incident news items and returns null", () => {
  // Financial news
  const financeReport = makeReport({
    permitted_text: "IHSG ditutup menguat 0,5 persen pada perdagangan awal pekan di Bursa Efek Indonesia Jakarta.",
  });
  assert.equal(generateProposalFromReport(financeReport), null);

  // Political / scholarship announcement
  const policyReport = makeReport({
    permitted_text: "Pemerintah Provinsi DKI Jakarta membuka pendaftaran program beasiswa kuliah berprestasi bagi siswa berprestasi.",
  });
  assert.equal(generateProposalFromReport(policyReport), null);

  // Sports news
  const sportReport = makeReport({
    permitted_text: "Persija Jakarta menggelar latihan intensif di Senayan menjelang pertandingan lanjutan kompetisi Liga 1.",
  });
  assert.equal(generateProposalFromReport(sportReport), null);
});

test("rejects incidents happening outside DKI Jakarta jurisdiction", () => {
  // Flood in Padang
  const padangReport = makeReport({
    permitted_text: "Banjir bandang terjang ratusan rumah warga di Padang Pariaman akibat luapan sungai deras.",
  });
  assert.equal(generateProposalFromReport(padangReport), null);

  // Fire in Bandung
  const bandungReport = makeReport({
    permitted_text: "Kebakaran hanguskan puluhan kios pasar tradisional di Kota Bandung Jawa Barat pada malam hari.",
  });
  assert.equal(generateProposalFromReport(bandungReport), null);

  // Accident in Surabaya
  const surabayaReport = makeReport({
    permitted_text: "Kecelakaan lalu lintas bus terguling terjadi di Tol Surabaya Jawa Timur.",
  });
  assert.equal(generateProposalFromReport(surabayaReport), null);
});

test("handles single chunk and multi-chunk reports gracefully", () => {
  // 3-chunk report
  const multiReport = makeReport({
    report_revision_id: "rev-multi-707",
    permitted_text:
      "Banjir merendam kawasan Kebon Jeruk Jakarta Barat setinggi 70 cm. " +
      "Genangan air menyebabkan kemacetan panjang di jalan utama. " +
      "Petugas pompa mobile dikerahkan untuk mempercepat surutnya air.",
    chunks: [
      {
        chunk_index: 0,
        text: "Banjir merendam kawasan Kebon Jeruk Jakarta Barat setinggi 70 cm.",
        span_start: 0,
        span_end: 65,
      },
      {
        chunk_index: 1,
        text: "Genangan air menyebabkan kemacetan panjang di jalan utama.",
        span_start: 66,
        span_end: 124,
      },
      {
        chunk_index: 2,
        text: "Petugas pompa mobile dikerahkan untuk mempercepat surutnya air.",
        span_start: 125,
        span_end: 188,
      },
    ],
  });

  const proposal = generateProposalFromReport(multiReport);
  assert.ok(proposal !== null);
  assert.equal(proposal.claims.length, 3);
  assert.equal(proposal.claims[0]!.evidence_ref_id, "ref-rev-multi-707-0");
  assert.equal(proposal.claims[1]!.evidence_ref_id, "ref-rev-multi-707-1");
  assert.equal(proposal.claims[2]!.evidence_ref_id, "ref-rev-multi-707-2");

  for (let i = 0; i < 3; i++) {
    const claim = proposal.claims[i]!;
    const chunk = multiReport.chunks[i]!;
    assert.ok(chunk.text.includes(claim.quote_text));
  }
});

test("respects explicit coordinates in text when within Jakarta bounds", () => {
  const report = makeReport({
    report_revision_id: "rev-geo-808",
    permitted_text:
      "Laporan banjir genangan air setinggi 40 cm di kawasan Senen dengan koordinat [106.8450, -6.1820].",
    chunks: [
      {
        chunk_index: 0,
        text: "Laporan banjir genangan air setinggi 40 cm di kawasan Senen dengan koordinat [106.8450, -6.1820].",
        span_start: 0,
        span_end: 98,
      },
    ],
  });

  const proposal = generateProposalFromReport(report);
  assert.ok(proposal !== null);
  assert.ok(proposal.coordinates !== null);
  assert.equal(proposal.coordinates[0], 106.8450);
  assert.equal(proposal.coordinates[1], -6.1820);
});

test("handles empty or malformed inputs returning null", () => {
  assert.equal(generateProposalFromReport(null as unknown as StoredReportRevision), null);
  assert.equal(generateProposalFromReport(undefined as unknown as StoredReportRevision), null);
  assert.equal(generateProposalFromReport({} as StoredReportRevision), null);
  assert.equal(generateProposalFromReport(makeReport({ permitted_text: "   ", chunks: [] })), null);
});
