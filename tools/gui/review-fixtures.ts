/**
 * GUI-05: synthetic moderation proposals for report screenshots of the review screen. The same shapes as the
 * fixtures in apps/web/test/moderator-review.test.tsx; nothing here comes from a real source.
 */
const claim = (id: string, text: string, quote: string, ref: string) => ({
  claim_id: id, claim_text: text, evidence_label: "under_review", support_assessment: "supported", quote_text: quote, evidence_ref_id: ref,
});

export const REVIEW_PROPOSALS = [
  {
    schema_version: "2.0", proposal_id: "proposal-flood-001", title: "Banjir 50 cm di Kampung Melayu Jakarta Timur",
    incident_type: "flood", severity: "high", event_time: { precision: "exact", value: "2026-10-26T07:00:00.000Z" },
    location_label: "Kampung Melayu, Jatinegara, Jakarta Timur", coordinates: [106.865, -6.228],
    claims: [
      claim("claim-001", "Banjir setinggi 50 cm merendam permukiman Kampung Melayu.", "banjir setinggi 50 cm merendam kawasan Kampung Melayu", "chunk-0"),
      claim("claim-002", "Penyebab banjir adalah luapan Kali Ciliwung pada Senin pagi.", "luapan Kali Ciliwung pada Senin pagi", "chunk-0"),
      claim("claim-003", "Petugas gabungan dikerahkan untuk evakuasi warga rentan.", "Petugas gabungan telah dikerahkan ke lokasi untuk evakuasi warga rentan", "chunk-1"),
    ],
    proposed_at: "2026-10-26T07:15:00.000Z",
  },
  {
    schema_version: "2.0", proposal_id: "proposal-fire-002", title: "Kebakaran Ruko di Pasar Pagi Mangga Dua",
    incident_type: "fire", severity: "critical", event_time: { precision: "exact", value: "2026-10-26T08:30:00.000Z" },
    location_label: "Pasar Pagi Mangga Dua, Jakarta Utara", coordinates: [106.822, -6.136],
    claims: [claim("claim-101", "Api membakar deretan ruko di Pasar Pagi Mangga Dua.", "api membakar deretan ruko", "chunk-0")],
    proposed_at: "2026-10-26T08:40:00.000Z",
  },
];

export const REVIEW_CHUNKS: Record<string, Array<{ chunk_index: number; text: string; span_start: number; span_end: number }>> = {
  "proposal-flood-001": [
    { chunk_index: 0, text: "BPBD DKI Jakarta melaporkan banjir setinggi 50 cm merendam kawasan Kampung Melayu Jakarta Timur akibat luapan Kali Ciliwung pada Senin pagi.", span_start: 0, span_end: 140 },
    { chunk_index: 1, text: "Petugas gabungan telah dikerahkan ke lokasi untuk evakuasi warga rentan dan penyedotan genangan air.", span_start: 141, span_end: 241 },
  ],
  "proposal-fire-002": [
    { chunk_index: 0, text: "Warga melihat api membakar deretan ruko di Pasar Pagi Mangga Dua sejak pukul 15.20 WIB.", span_start: 0, span_end: 88 },
  ],
};
