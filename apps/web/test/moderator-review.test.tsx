import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

if (!("React" in globalThis)) {
  Object.defineProperty(globalThis, "React", { value: React, configurable: true, writable: true });
}
import {
  advanceProposalQueue,
  fetchModerationProposals,
  fetchProposalDetail,
  incidentTypeLabel,
  ModeratorReview,
  ModeratorReviewQueue,
  publishModerationDecision,
  renderHighlightedText,
  severityLabel,
  type EventProposalDto,
  type ModeratorDecisionCommand,
  type StoredEvidenceChunk,
} from "../src/ModeratorReview.js";

const sampleChunk1: StoredEvidenceChunk = {
  chunk_index: 0,
  text: "BPBD DKI Jakarta melaporkan banjir setinggi 50 cm merendam kawasan Kampung Melayu Jakarta Timur akibat luapan Kali Ciliwung pada Senin pagi.",
  span_start: 0,
  span_end: 140,
};

const sampleChunk2: StoredEvidenceChunk = {
  chunk_index: 1,
  text: "Petugas gabungan telah dikerahkan ke lokasi untuk evakuasi warga rentan dan penyedotan genangan air.",
  span_start: 141,
  span_end: 241,
};

const sampleProposal1: EventProposalDto = {
  schema_version: "2.0",
  proposal_id: "proposal-flood-001",
  title: "Banjir 50 cm di Kampung Melayu Jakarta Timur",
  incident_type: "flood",
  severity: "high",
  event_time: { precision: "exact", value: "2026-10-26T07:00:00.000Z" },
  location_label: "Kampung Melayu, Jatinegara, Jakarta Timur",
  coordinates: [106.865, -6.228],
  claims: [
    {
      claim_id: "claim-001",
      claim_text: "Banjir setinggi 50 cm merendam permukiman Kampung Melayu.",
      evidence_label: "under_review",
      support_assessment: "supported",
      quote_text: "banjir setinggi 50 cm merendam kawasan Kampung Melayu",
      evidence_ref_id: "chunk-0",
    },
    {
      claim_id: "claim-002",
      claim_text: "Penyebab banjir adalah luapan Kali Ciliwung pada Senin pagi.",
      evidence_label: "under_review",
      support_assessment: "supported",
      quote_text: "luapan Kali Ciliwung pada Senin pagi",
      evidence_ref_id: "chunk-0",
    },
  ],
  proposed_at: "2026-10-26T07:15:00.000Z",
};

const sampleProposal2: EventProposalDto = {
  schema_version: "2.0",
  proposal_id: "proposal-fire-002",
  title: "Kebakaran Ruko di Pasar Pagi Mangga Dua",
  incident_type: "fire",
  severity: "critical",
  event_time: { precision: "exact", value: "2026-10-26T08:30:00.000Z" },
  location_label: "Pasar Pagi Mangga Dua, Jakarta Utara",
  coordinates: [106.822, -6.136],
  claims: [
    {
      claim_id: "claim-fire-001",
      claim_text: "Sebanyak 15 unit pemadam dikerahkan memadamkan kebakaran ruko.",
      evidence_label: "under_review",
      support_assessment: "supported",
      quote_text: "15 unit pemadam dikerahkan memadamkan kebakaran ruko",
      evidence_ref_id: "chunk-fire-0",
    },
  ],
  proposed_at: "2026-10-26T08:45:00.000Z",
};

test("incidentTypeLabel and severityLabel map all enum values correctly", () => {
  assert.equal(incidentTypeLabel("flood"), "Banjir");
  assert.equal(incidentTypeLabel("fire"), "Kebakaran");
  assert.equal(incidentTypeLabel("accident"), "Kecelakaan");
  assert.equal(incidentTypeLabel("tree_fall"), "Pohon Tumbang");
  assert.equal(incidentTypeLabel("crime"), "Kriminalitas");
  assert.equal(incidentTypeLabel("weather"), "Cuaca Ekstrem");
  assert.equal(incidentTypeLabel("unknown_type"), "unknown_type");

  assert.equal(severityLabel("critical"), "Kritis");
  assert.equal(severityLabel("high"), "Tinggi");
  assert.equal(severityLabel("medium"), "Sedang");
  assert.equal(severityLabel("low"), "Rendah");
  assert.equal(severityLabel("unknown"), "unknown");
});

test("renderHighlightedText wraps matching quotes in mark tags with highlight class", () => {
  const text = "Hujan deras menyebabkan banjir di Cawang dan genangan di Tebet.";
  const quotes = ["banjir di Cawang", "genangan di Tebet"];
  const rendered = renderToStaticMarkup(createElement("div", null, renderHighlightedText(text, quotes)));

  assert.match(rendered, /<mark class="evidence-quote-highlight">banjir di Cawang<\/mark>/);
  assert.match(rendered, /<mark class="evidence-quote-highlight">genangan di Tebet<\/mark>/);
  assert.match(rendered, /Hujan deras menyebabkan /);
});

test("renderHighlightedText handles case-insensitivity and empty quotes gracefully", () => {
  const text = "Laporan Kebakaran di Petamburan";
  const quotes = ["kebakaran"];
  const rendered = renderToStaticMarkup(createElement("div", null, renderHighlightedText(text, quotes)));
  assert.match(rendered, /<mark class="evidence-quote-highlight">Kebakaran<\/mark>/);

  const emptyResult = renderHighlightedText(text, ["", "   "]);
  assert.deepEqual(emptyResult, [text]);

  const nullResult = renderHighlightedText("", ["test"]);
  assert.deepEqual(nullResult, [""]);
});

test("proposal queue renders cards with incident badges, severity chips, location, and time", () => {
  const html = renderToStaticMarkup(
    createElement(ModeratorReviewQueue, {
      proposals: [sampleProposal1, sampleProposal2],
      initialChunks: { "proposal-flood-001": [sampleChunk1, sampleChunk2] },
    })
  );

  // Left column queue list
  assert.match(html, /2 menunggu/);
  assert.match(html, /incident-badge--flood/);
  assert.match(html, /Banjir/);
  assert.match(html, /severity-chip--high/);
  assert.match(html, /Tinggi/);
  assert.match(html, /Banjir 50 cm di Kampung Melayu Jakarta Timur/);
  assert.match(html, /Kampung Melayu, Jatinegara, Jakarta Timur/);
  assert.match(html, /2026-10-26T07:00:00\.000Z/);

  assert.match(html, /incident-badge--fire/);
  assert.match(html, /Kebakaran/);
  assert.match(html, /severity-chip--critical/);
  assert.match(html, /Kritis/);
  assert.match(html, /Kebakaran Ruko di Pasar Pagi Mangga Dua/);

  // Default first proposal is selected
  assert.match(html, /aria-selected="true"/);
  assert.match(html, /proposal-card-btn--selected/);
});

test("selected proposal displays detailed metadata, coordinates, and claims", () => {
  const html = renderToStaticMarkup(
    createElement(ModeratorReviewQueue, {
      proposals: [sampleProposal1, sampleProposal2],
      initialSelectedId: "proposal-flood-001",
      initialChunks: { "proposal-flood-001": [sampleChunk1] },
    })
  );

  // Details section
  assert.match(html, /proposal-flood-001/);
  assert.match(html, /106\.8650, -6\.2280/);
  assert.match(html, /Daftar Klaim \(2\)/);
  assert.match(html, /claim-001/);
  assert.match(html, /Banjir setinggi 50 cm merendam permukiman Kampung Melayu\./);
  assert.match(html, /claim-002/);
  assert.match(html, /Penyebab banjir adalah luapan Kali Ciliwung pada Senin pagi\./);
  assert.match(html, /under_review/);
});

test("evidence reader highlights exact quotes inside chunk text", () => {
  const html = renderToStaticMarkup(
    createElement(ModeratorReviewQueue, {
      proposals: [sampleProposal1],
      initialChunks: { "proposal-flood-001": [sampleChunk1, sampleChunk2] },
    })
  );

  assert.match(html, /Pembaca Bukti Sumber/);
  assert.match(html, /Chunk #1/);
  assert.match(html, /kode poin 0–140/i);
  assert.match(
    html,
    /<mark class="evidence-quote-highlight">banjir setinggi 50 cm merendam kawasan Kampung Melayu<\/mark>/
  );
  assert.match(
    html,
    /<mark class="evidence-quote-highlight">luapan Kali Ciliwung pada Senin pagi<\/mark>/
  );
});

test("evidence reader falls back to direct claim quotes when chunks are not loaded", () => {
  const html = renderToStaticMarkup(
    createElement(ModeratorReviewQueue, {
      proposals: [sampleProposal1],
      initialChunks: {},
    })
  );

  assert.match(html, /Kutipan bukti langsung yang diekstraksi dari dokumen sumber/);
  assert.match(html, /Ref: chunk-0/);
  assert.match(html, /<mark class="evidence-quote-highlight">banjir setinggi 50 cm merendam kawasan Kampung Melayu<\/mark>/);
});

test("action buttons Setujui & Terbitkan, Tolak, and Minta Bukti render correctly", () => {
  const html = renderToStaticMarkup(
    createElement(ModeratorReviewQueue, {
      proposals: [sampleProposal1],
    })
  );

  assert.match(html, /data-action="approve"/);
  assert.match(html, /Setujui &amp; Terbitkan|Setujui & Terbitkan/);
  assert.match(html, /data-action="reject"/);
  assert.match(html, /Tolak/);
  assert.match(html, /data-action="investigate"/);
  assert.match(html, /Minta Bukti/);
});

test("approval modal renders radio choices for attributed_report and crowdsourced_observation", () => {
  const html = renderToStaticMarkup(
    createElement(ModeratorReviewQueue, {
      proposals: [sampleProposal1],
      initialModalOpen: true,
    })
  );

  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /Pilih Klasifikasi Label Bukti/);
  assert.match(html, /value="attributed_report"/);
  assert.match(html, /Laporan Teratribusi \(attributed_report\)/);
  assert.match(html, /value="crowdsourced_observation"/);
  assert.match(html, /Observasi Warga \(crowdsourced_observation\)/);
  assert.match(html, /data-action="modal-confirm"/);
  assert.match(html, /Konfirmasi &amp; Terbitkan|Konfirmasi & Terbitkan/);
  assert.match(html, /data-action="modal-cancel"/);
  assert.match(html, /Batal/);
  assert.match(html, /id="decision-reason-input"/);
});

test("feedback banner displays success and error notifications", () => {
  const successHtml = renderToStaticMarkup(
    createElement(ModeratorReviewQueue, {
      proposals: [sampleProposal1],
      initialFeedback: {
        type: "success",
        message: 'Proposal "Banjir 50 cm" berhasil disetujui dan diterbitkan.',
      },
    })
  );
  assert.match(successHtml, /feedback-banner--success/);
  assert.match(successHtml, /Proposal &quot;Banjir 50 cm&quot; berhasil disetujui/);

  const errorHtml = renderToStaticMarkup(
    createElement(ModeratorReviewQueue, {
      proposals: [sampleProposal1],
      initialFeedback: {
        type: "error",
        message: "Gagal memproses proposal: HTTP 403 Forbidden",
      },
    })
  );
  assert.match(errorHtml, /feedback-banner--error/);
  assert.match(errorHtml, /Gagal memproses proposal: HTTP 403 Forbidden/);
});

test("empty queue state renders clear completion guidance", () => {
  const html = renderToStaticMarkup(
    createElement(ModeratorReviewQueue, {
      proposals: [],
    })
  );

  assert.match(html, /Semua proposal telah ditinjau/);
  assert.match(html, /Tidak ada proposal insiden yang menunggu dalam antrean moderasi saat ini/);
  assert.match(html, /Kembali ke jelajah/);
});

test("advanceProposalQueue removes completed item and selects next available", () => {
  // Case 1: Multiple items, first item completed -> advances to second item
  const step1 = advanceProposalQueue([sampleProposal1, sampleProposal2], "proposal-flood-001");
  assert.equal(step1.remaining.length, 1);
  assert.equal(step1.remaining[0]?.proposal_id, "proposal-fire-002");
  assert.equal(step1.nextSelectedId, "proposal-fire-002");

  // Case 2: Only item completed -> queue empty, nextSelectedId null
  const step2 = advanceProposalQueue([sampleProposal2], "proposal-fire-002");
  assert.equal(step2.remaining.length, 0);
  assert.equal(step2.nextSelectedId, null);
});

test("fetchModerationProposals requests GET /api/v1/moderation/proposals and returns list", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const mockFetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ proposals: [sampleProposal1, sampleProposal2] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const results = await fetchModerationProposals({ fetcher: mockFetcher });
  assert.equal(results.length, 2);
  assert.equal(results[0]?.proposal_id, "proposal-flood-001");
  assert.equal(calls[0]?.url, "/api/v1/moderation/proposals");
});

test("fetchProposalDetail requests GET /api/v1/moderation/proposals/:id", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const mockFetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(
      JSON.stringify({ proposal: sampleProposal1, chunks: [sampleChunk1, sampleChunk2] }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  const result = await fetchProposalDetail("proposal-flood-001", { fetcher: mockFetcher });
  assert.equal(result.proposal.proposal_id, "proposal-flood-001");
  assert.equal(result.chunks.length, 2);
  assert.equal(calls[0]?.url, "/api/v1/moderation/proposals/proposal-flood-001");
});

test("publishModerationDecision sends POST with CSRF header and command payload", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const mockFetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ ok: true, status: "written" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const command: ModeratorDecisionCommand = {
    proposal_id: "proposal-flood-001",
    action: "publish",
    evidence_label: "attributed_report",
    reason: "Terverifikasi dari laporan resmi BPBD DKI",
  };

  const result = await publishModerationDecision("proposal-flood-001", command, {
    fetcher: mockFetcher,
    csrfToken: "mock-csrf-token-12345678",
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "written");
  assert.equal(calls[0]?.url, "/api/v1/moderation/proposals/proposal-flood-001/publish");
  assert.equal(calls[0]?.init?.method, "POST");

  const headers = calls[0]?.init?.headers as Record<string, string>;
  assert.equal(headers["X-CSRF-Token"], "mock-csrf-token-12345678");

  const body = JSON.parse(String(calls[0]?.init?.body)) as ModeratorDecisionCommand;
  assert.equal(body.proposal_id, "proposal-flood-001");
  assert.equal(body.action, "publish");
  assert.equal(body.evidence_label, "attributed_report");
  assert.equal(body.reason, "Terverifikasi dari laporan resmi BPBD DKI");
});

test("publishModerationDecision throws on HTTP error response", async () => {
  const mockFetcher: typeof fetch = async () => {
    return new Response(JSON.stringify({ error: "Unauthorized access" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  };

  const command: ModeratorDecisionCommand = {
    proposal_id: "proposal-flood-001",
    action: "publish",
    evidence_label: "attributed_report",
  };

  await assert.rejects(
    async () => {
      await publishModerationDecision("proposal-flood-001", command, { fetcher: mockFetcher });
    },
    /HTTP 403: Unauthorized access/
  );
});

test("ModeratorReview retains backward compatibility for fixture presentation in SSR", () => {
  const fixtureMarkup = renderToStaticMarkup(<ModeratorReview mode="fixture" />);
  assert.match(fixtureMarkup, /Bukan antrean moderator/);
  assert.match(fixtureMarkup, /Pratinjau baca saja/);
  assert.doesNotMatch(fixtureMarkup, /<button/);

  // Calling without props in Node SSR defaults to fixture to keep ui.test.tsx passing
  const defaultMarkup = renderToStaticMarkup(<ModeratorReview />);
  assert.match(defaultMarkup, /Bukan antrean moderator/);
  assert.match(defaultMarkup, /Pratinjau baca saja/);
});
