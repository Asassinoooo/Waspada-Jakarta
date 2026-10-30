import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  IncidentCorrelationSchema,
  correlateIncident,
  type CorrelateIncidentInput,
} from "../src/agents/incident-correlation-agent.js";
import type { CandidateIncidentMatch } from "../src/services/semantic-retrieval-service.js";

describe("Mastra Incident Correlation Agent", () => {
  const activeFloodMatch: CandidateIncidentMatch = {
    incident: {
      incidentId: "inc-cawang-001",
      datasetKind: "synthetic",
      title: "Banjir Luapan Cawang",
      description: "Genangan air 50cm di Jl DI Panjaitan",
      incidentType: "genangan banjir jalan raya",
      status: "active",
      severity: "medium",
      locationLabel: "Cawang, Jakarta Timur",
      coordinates: [106.871, -6.244],
      eventTime: { value: "2026-10-30T10:00:00.000Z" },
      firstObservedAt: "2026-10-30T10:00:00.000Z",
      lastUpdatedAt: "2026-10-30T10:30:00.000Z",
      discrepancies: [],
      uncertaintyNotes: [],
      recordJson: {},
      createdAt: "2026-10-30T10:00:00.000Z",
    },
    similarityScore: 0.92,
    matchedChunkId: "chk-cawang-01",
    matchedText: "Jalan DI Panjaitan Cawang terendam air 50cm",
  };

  it("validates correlation schema for same_incident with contradictory evidence", () => {
    const raw = {
      decision: "same_incident",
      candidateIncidentId: "inc-cawang-001",
      reasoning: "Kedua laporan merujuk pada genangan di ruas Cawang pada waktu yang berdekatan.",
      supportingEvidence: [
        {
          reportRevisionId: "rev-002",
          quote: "Air merendam Cawang",
          relevance: "Lokasi identik",
        },
      ],
      contradictoryEvidence: [
        {
          field: "water_height",
          claimA: "50 cm",
          claimB: "30 cm",
        },
      ],
      distinctions: [],
      unresolvedQuestions: [],
      uncertainty: ["Perbedaan tinggi genangan antara warga dan petugas"],
    };

    const parsed = IncidentCorrelationSchema.parse(raw);
    assert.equal(parsed.decision, "same_incident");
    assert.equal(parsed.candidateIncidentId, "inc-cawang-001");
    assert.equal(parsed.contradictoryEvidence.length, 1);
    assert.equal(parsed.contradictoryEvidence[0].field, "water_height");
  });

  it("decides new_incident when candidate incidents list is empty", async () => {
    const input: CorrelateIncidentInput = {
      incomingReportRevisionId: "rev-new-001",
      incomingReportText: "Pohon tumbang di Kebayoran Baru menghalangi jalur TransJakarta.",
      incomingInterpretation: {
        summary: "Pohon tumbang di Kebayoran Baru",
        incidentType: "pohon tumbang",
        location: { label: "Kebayoran Baru", approximateCoordinates: [106.8, -6.24], precision: "approximate" },
        eventTime: { value: "2026-10-30T15:00:00.000Z", precision: "exact" },
        entities: [],
        impacts: ["Jalur TransJakarta terhalang"],
        operationalStatus: "active",
        evidence: [],
        conflictingInfo: [],
        uncertaintyNotes: [],
        confidence: "high",
      },
      candidateIncidents: [],
    };

    const result = await correlateIncident(input, { fallbackMock: true });
    assert.equal(result.decision, "new_incident");
    assert.equal(result.candidateIncidentId, null);
  });

  it("decides same_incident on high semantic similarity match in fallback mode", async () => {
    const input: CorrelateIncidentInput = {
      incomingReportRevisionId: "rev-cawang-002",
      incomingReportText: "Akses Cawang arah Tanjung Priok lumpuh total karena air setinggi paha orang dewasa.",
      incomingInterpretation: {
        summary: "Cawang arah Tanjung Priok terendam air",
        incidentType: "genangan banjir jalan raya",
        location: { label: "Cawang", approximateCoordinates: [106.871, -6.244], precision: "approximate" },
        eventTime: { value: "2026-10-30T10:15:00.000Z", precision: "exact" },
        entities: [],
        impacts: ["Akses jalan lumpuh"],
        operationalStatus: "active",
        evidence: [],
        conflictingInfo: [],
        uncertaintyNotes: [],
        confidence: "high",
      },
      candidateIncidents: [activeFloodMatch],
    };

    const result = await correlateIncident(input, { fallbackMock: true });
    assert.equal(result.decision, "same_incident");
    assert.equal(result.candidateIncidentId, "inc-cawang-001");
  });
});
