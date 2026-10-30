import assert from "node:assert/strict";
import test from "node:test";
import {
  webhookIngestHandler,
  convertInboundEventToRevision,
  validateInboundIncidentEvent,
  validateEnvelopeCoordinates,
  isWebhookIngestPath,
  type InboundIncidentEvent,
} from "../src/layers/l1-data-knowledge/webhook-ingest.js";
import { EventBroadcaster } from "../src/layers/l4-application-integration/event-broadcaster.js";
import type { StoredReportRevision } from "../src/layers/l2-model-grounding/proposal-engine.js";

async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
  const decoder = new TextDecoder();
  const { value, done } = await reader.read();
  if (done || !value) return "";
  return decoder.decode(value);
}

test("isWebhookIngestPath matches exact ingestion route", () => {
  assert.equal(isWebhookIngestPath("/api/v1/ingestion/events"), true);
  assert.equal(isWebhookIngestPath("/api/v1/ingestion/events/"), true);
  assert.equal(isWebhookIngestPath("/api/v1/events"), false);
  assert.equal(isWebhookIngestPath("/api/v1/moderation"), false);
});

test("validateEnvelopeCoordinates validates and normalizes Jakarta bounds", () => {
  // Valid Monas coordinates [lon, lat]
  const validMonas = validateEnvelopeCoordinates([106.8272, -6.1754]);
  assert.equal(validMonas.valid, true);
  assert.deepEqual(validMonas.normalized, [106.8272, -6.1754]);

  // Valid Semanggi coordinates with lat/lon inverted
  const validInverted = validateEnvelopeCoordinates([-6.2201, 106.8156]);
  assert.equal(validInverted.valid, true);
  assert.deepEqual(validInverted.normalized, [106.8156, -6.2201]);

  // Null or undefined coordinates are optional
  assert.equal(validateEnvelopeCoordinates(undefined).valid, true);
  assert.equal(validateEnvelopeCoordinates(null).valid, true);

  // Outside Jakarta: Bandung [107.61, -6.91]
  const outsideBandung = validateEnvelopeCoordinates([107.61, -6.91]);
  assert.equal(outsideBandung.valid, false);
  assert.match(outsideBandung.error ?? "", /DKI Jakarta bounding envelope/);

  // Invalid types
  assert.equal(validateEnvelopeCoordinates("106.82, -6.17").valid, false);
  assert.equal(validateEnvelopeCoordinates([106.82]).valid, false);
  assert.equal(validateEnvelopeCoordinates([Number.NaN, -6.17]).valid, false);
});

test("validateInboundIncidentEvent checks required fields and formats", () => {
  // Missing or empty source_id
  assert.equal(
    validateInboundIncidentEvent({ title: "Banjir", text: "Banjir setinggi 50cm merendam jalan" }).valid,
    false,
  );

  // Missing or empty title
  assert.equal(
    validateInboundIncidentEvent({
      source_id: "tmc-metro",
      title: "",
      text: "Banjir setinggi 50cm merendam jalan",
    }).valid,
    false,
  );

  // Text too short (< 8 chars)
  assert.equal(
    validateInboundIncidentEvent({
      source_id: "tmc-metro",
      title: "Banjir",
      text: "Pendek",
    }).valid,
    false,
  );

  // Invalid category
  assert.equal(
    validateInboundIncidentEvent({
      source_id: "tmc-metro",
      title: "Banjir",
      text: "Banjir setinggi 50cm merendam jalan",
      category: "invalid_category",
    }).valid,
    false,
  );

  // Invalid severity
  assert.equal(
    validateInboundIncidentEvent({
      source_id: "tmc-metro",
      title: "Banjir",
      text: "Banjir setinggi 50cm merendam jalan",
      severity: "ultra_high",
    }).valid,
    false,
  );

  // Valid event
  const valid = validateInboundIncidentEvent({
    source_id: "source-tmc-polda-metro",
    title: "Pohon Tumbang di Semanggi",
    text: "Pohon tumbang menutupi lajur lambat arah Blok M, evakuasi sedang berlangsung.",
    category: "tree_fall",
    severity: "medium",
    coordinates: [106.8156, -6.2201],
  });
  assert.equal(valid.valid, true);
  assert.equal(valid.event?.title, "Pohon Tumbang di Semanggi");
});

test("webhookIngestHandler rejects non-POST requests with 405 Method Not Allowed", async () => {
  const request = new Request("http://localhost/api/v1/ingestion/events", {
    method: "GET",
  });
  const response = await webhookIngestHandler(request);

  assert.equal(response.status, 405);
  const json = (await response.json()) as { ok: boolean; error: string };
  assert.equal(json.ok, false);
  assert.match(json.error, /Method not allowed/);
});

test("webhookIngestHandler rejects invalid JSON bodies with 400 Bad Request", async () => {
  const request = new Request("http://localhost/api/v1/ingestion/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "this is not json",
  });
  const response = await webhookIngestHandler(request);

  assert.equal(response.status, 400);
  const json = (await response.json()) as { ok: boolean; error: string };
  assert.equal(json.ok, false);
  assert.match(json.error, /Invalid JSON body/);
});

test("webhookIngestHandler rejects events outside Jakarta envelope with 400", async () => {
  const request = new Request("http://localhost/api/v1/ingestion/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source_id: "source-dishub",
      title: "Tanah Longsor di Puncak Bogor",
      text: "Tanah longsor terjadi di jalur Puncak kilometer 85, lalu lintas lumpuh total.",
      coordinates: [106.98, -6.71], // Outside Jakarta envelope
    }),
  });
  const response = await webhookIngestHandler(request);

  assert.equal(response.status, 400);
  const json = (await response.json()) as { ok: boolean; error: string };
  assert.equal(json.ok, false);
  assert.match(json.error, /DKI Jakarta bounding envelope/);
});

test("single inbound event push generates proposal and broadcasts to moderation SSE", async () => {
  const broadcaster = new EventBroadcaster({ pingIntervalMs: 0 });
  const sseReader = broadcaster.subscribeModeration().getReader();

  let capturedProposalId = "";
  const request = new Request("http://localhost/api/v1/ingestion/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source_id: "source-tmc-polda-metro",
      title: "Truk Terguling di Simpang Susun Semanggi",
      text: "Truk bermuatan besi terguling di Simpang Susun Semanggi arah Kuningan. Dua lajur tertutup dan macet parah.",
      category: "accident",
      severity: "high",
      coordinates: [106.8156, -6.2201],
      location_hint: "Simpang Susun Semanggi",
    }),
  });

  const response = await webhookIngestHandler(request, {
    broadcaster,
    onProposalCreated: (proposal) => {
      capturedProposalId = proposal.proposal_id;
    },
  });

  assert.equal(response.status, 201);
  const body = (await response.json()) as {
    ok: boolean;
    proposal_id: string;
    proposal: {
      schema_version: string;
      proposal_id: string;
      title: string;
      incident_type: string;
      severity: string;
      coordinates: [number, number];
      claims: readonly unknown[];
    };
    is_correlated: boolean;
  };

  assert.equal(body.ok, true);
  assert.ok(body.proposal_id.startsWith("prop-"));
  assert.equal(body.proposal.schema_version, "2.0");
  assert.equal(body.proposal.incident_type, "accident");
  assert.equal(body.proposal.severity, "high");
  assert.deepEqual(body.proposal.coordinates, [106.8156, -6.2201]);
  assert.ok(body.proposal.claims.length >= 1);
  assert.equal(capturedProposalId, body.proposal_id);

  // Verify SSE broadcaster delivered event
  const sseMessage = await readStreamChunk(sseReader);
  assert.ok(sseMessage.startsWith("event: proposal_created\ndata: "));
  assert.ok(sseMessage.includes(body.proposal_id));

  await sseReader.cancel().catch(() => {});
  broadcaster.close();
});

test("batch inbound event push validates all events and generates proposals", async () => {
  const broadcaster = new EventBroadcaster({ pingIntervalMs: 0 });

  const batchPayload = [
    {
      source_id: "source-dishub-jakarta",
      title: "Genangan Air di Underpass Dukuh Atas",
      text: "Genangan air setinggi 40 cm di Underpass Dukuh Atas, kendaraan dialihkan ke jalur atas.",
      category: "flood",
      severity: "medium",
      coordinates: [106.821, -6.201],
      location_hint: "Underpass Dukuh Atas",
    },
    {
      source_id: "source-tmc-polda-metro",
      title: "Kebakaran Kabel di Senen",
      text: "Asap pekat akibat kebakaran kabel utilitas di Senen Jakarta Pusat, petugas damkar di lokasi.",
      category: "fire",
      severity: "medium",
      coordinates: [106.843, -6.178],
      location_hint: "Senen Jakarta Pusat",
    },
  ];

  const request = new Request("http://localhost/api/v1/ingestion/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(batchPayload),
  });

  const response = await webhookIngestHandler(request, { broadcaster });
  assert.equal(response.status, 201);

  const result = (await response.json()) as {
    ok: boolean;
    count: number;
    proposals: readonly { proposal_id: string; title: string; incident_type: string }[];
  };

  assert.equal(result.ok, true);
  assert.equal(result.count, 2);
  assert.equal(result.proposals.length, 2);
  assert.equal(result.proposals[0]?.incident_type, "flood");
  assert.equal(result.proposals[1]?.incident_type, "fire");

  broadcaster.close();
});

test("batch push rejects entire batch if one event is invalid", async () => {
  const batchWithOneInvalid = [
    {
      source_id: "source-valid",
      title: "Valid Title",
      text: "Valid report text with enough characters.",
    },
    {
      source_id: "source-invalid",
      title: "",
      text: "Too short",
    },
  ];

  const request = new Request("http://localhost/api/v1/ingestion/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(batchWithOneInvalid),
  });

  const response = await webhookIngestHandler(request);
  assert.equal(response.status, 400);

  const json = (await response.json()) as { ok: boolean; error: string };
  assert.equal(json.ok, false);
  assert.match(json.error, /Event at index 1/);
});

test("convertInboundEventToRevision produces valid chunk span offsets", async () => {
  const event: InboundIncidentEvent = {
    source_id: "source-citizen-report",
    title: "Banjir di Kemang",
    text: "Banjir merendam perumahan Kemang setinggi 60 cm.\n\nWarga mulai mengungsi ke tempat aman.",
    category: "flood",
    severity: "high",
    coordinates: [106.815, -6.265],
  };

  const revision = await convertInboundEventToRevision(event, "2026-10-30T10:00:00Z");

  assert.ok(revision.report_revision_id.startsWith("webhook-source-citizen-report-"));
  assert.equal(revision.published_at, null);
  assert.equal(revision.retrieved_at, "2026-10-30T10:00:00Z");
  assert.equal(revision.revision_status, "unreviewed");
  assert.ok(revision.chunks.length >= 1);

  const codePoints = Array.from(revision.permitted_text);
  for (const chunk of revision.chunks) {
    assert.ok(chunk.span_start >= 0);
    assert.ok(chunk.span_end <= codePoints.length);
    assert.ok(chunk.span_end > chunk.span_start);
  }
});

test("inbound event correlates with active reports when spatial and temporal overlap matches", async () => {
  const broadcaster = new EventBroadcaster({ pingIntervalMs: 0 });

  // Simulate an existing report from ANTARA News in Kemang
  const existingKemangReport: StoredReportRevision = {
    report_revision_id: "antara-news-kemang-001",
    source_id: "source-antara-news",
    canonical_url: "https://antara.id/kemang",
    permitted_text: "Banjir di Kemang Raya Jakarta Selatan merendam jalanan dan pemukiman warga.",
    permitted_text_hash: "a".repeat(64),
    published_at: "2026-10-30T09:30:00Z",
    retrieved_at: "2026-10-30T09:30:00Z",
    revision_status: "unreviewed",
    chunks: [
      {
        chunk_index: 0,
        text: "Banjir di Kemang Raya Jakarta Selatan merendam jalanan dan pemukiman warga.",
        span_start: 0,
        span_end: 75,
      },
    ],
  };

  // Push incoming citizen/TMC report on the same event in Kemang
  const request = new Request("http://localhost/api/v1/ingestion/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source_id: "source-tmc-polda-metro",
      title: "Genangan di Kemang",
      text: "Genangan air setinggi 60 cm di Kemang Raya Jakarta Selatan, lalu lintas dialihkan.",
      category: "flood",
      severity: "medium",
      coordinates: [106.815, -6.265],
      location_hint: "Kemang Raya",
    }),
  });

  const response = await webhookIngestHandler(request, {
    broadcaster,
    activeReports: [existingKemangReport],
  });

  assert.equal(response.status, 201);
  const data = (await response.json()) as {
    ok: boolean;
    is_correlated: boolean;
    proposal: {
      is_multi_source?: boolean;
      source_count?: number;
      claims: readonly { is_corroborated?: boolean }[];
    };
  };

  assert.equal(data.ok, true);
  assert.equal(data.is_correlated, true);
  assert.equal(data.proposal.is_multi_source, true);
  assert.ok((data.proposal.source_count ?? 0) >= 2);

  broadcaster.close();
});
