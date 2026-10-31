import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateCorrelationDecision,
  CorrelationValidationError,
  EvidenceProvenanceError,
  type CorrelateIncidentInput,
  type IncidentCorrelation,
} from "../src/agents/incident-correlation-agent.js";

describe("Correlation Decision & Provenance Validation", () => {
  const baseInput: CorrelateIncidentInput = {
    incomingReportRevisionId: "rev-incoming-001",
    incomingReportText: "Banjir setinggi 60cm merendam Jalan Rasuna Said depan Kemenkes pada pukul 14.30.",
    incomingInterpretation: {
      summary: "Banjir 60cm di Jl Rasuna Said",
      incidentType: "flood",
      severity: "high",
      location: { label: "Jl Rasuna Said", approximateCoordinates: [106.83, -6.22], precision: "exact" },
      eventTime: { precision: "exact", value: "2026-10-31T14:30:00Z" },
      entities: [],
      impacts: ["traffic_disruption"],
      operationalStatus: "active",
      evidence: [],
      conflictingInfo: [],
      uncertaintyNotes: [],
      confidence: "high",
    },
    candidateIncidents: [
      {
        incident: {
          incidentId: "inc-existing-999",
          datasetKind: "synthetic",
          title: "Banjir Kuningan",
          description: "Genangan air di kawasan Kuningan Rasuna Said",
          incidentType: "flood",
          status: "active",
          severity: "high",
          locationLabel: "Kuningan",
          coordinates: [106.83, -6.22],
          eventTime: {},
          firstObservedAt: "2026-10-31T14:00:00Z",
          lastUpdatedAt: "2026-10-31T14:00:00Z",
          discrepancies: [],
          uncertaintyNotes: [],
          recordJson: {},
          createdAt: "2026-10-31T14:00:00Z",
        },
        similarityScore: 0.88,
        matchedChunkId: "chk-existing-1",
        matchedText: "Genangan air di kawasan Kuningan Rasuna Said setinggi 50cm",
        matchedReportRevisionId: "rev-hist-999",
      },
    ],
  };

  it("accepts valid same_incident decision with retrieved candidate and verbatim quote", () => {
    const correlation: IncidentCorrelation = {
      decision: "same_incident",
      candidateIncidentId: "inc-existing-999",
      reasoning: "Same physical location and timeframe",
      supportingEvidence: [
        {
          reportRevisionId: "rev-incoming-001",
          quote: "Banjir setinggi 60cm merendam Jalan Rasuna Said",
          relevance: "Location and water level",
        },
        {
          reportRevisionId: "rev-hist-999",
          quote: "Genangan air di kawasan Kuningan Rasuna Said",
          relevance: "Historical location",
        },
      ],
      contradictoryEvidence: [],
      distinctions: [],
      unresolvedQuestions: [],
      uncertainty: [],
    };

    assert.doesNotThrow(() => validateCorrelationDecision(correlation, baseInput));
  });

  it("rejects same_incident when candidateIncidentId is null", () => {
    const correlation: IncidentCorrelation = {
      decision: "same_incident",
      candidateIncidentId: null,
      reasoning: "Correlated without candidate",
      supportingEvidence: [],
      contradictoryEvidence: [],
      distinctions: [],
      unresolvedQuestions: [],
      uncertainty: [],
    };

    assert.throws(
      () => validateCorrelationDecision(correlation, baseInput),
      CorrelationValidationError,
    );
  });

  it("rejects same_incident with unretrieved candidate ID", () => {
    const correlation: IncidentCorrelation = {
      decision: "same_incident",
      candidateIncidentId: "inc-unretrieved-000",
      reasoning: "Hallucinated candidate",
      supportingEvidence: [],
      contradictoryEvidence: [],
      distinctions: [],
      unresolvedQuestions: [],
      uncertainty: [],
    };

    assert.throws(
      () => validateCorrelationDecision(correlation, baseInput),
      CorrelationValidationError,
    );
  });

  it("rejects new_incident when referencing an existing candidate", () => {
    const correlation: IncidentCorrelation = {
      decision: "new_incident",
      candidateIncidentId: "inc-existing-999",
      reasoning: "Invalid state: new incident cannot reference existing",
      supportingEvidence: [],
      contradictoryEvidence: [],
      distinctions: [],
      unresolvedQuestions: [],
      uncertainty: [],
    };

    assert.throws(
      () => validateCorrelationDecision(correlation, baseInput),
      CorrelationValidationError,
    );
  });

  it("rejects fabricated evidence quotes not in incoming report", () => {
    const correlation: IncidentCorrelation = {
      decision: "same_incident",
      candidateIncidentId: "inc-existing-999",
      reasoning: "Matching incident",
      supportingEvidence: [
        {
          reportRevisionId: "rev-incoming-001",
          quote: "Jalan Sudirman lumpuh total akibat pohon tumbang", // fabricated, not in incoming text
          relevance: "Fabricated quote",
        },
      ],
      contradictoryEvidence: [],
      distinctions: [],
      unresolvedQuestions: [],
      uncertainty: [],
    };

    assert.throws(
      () => validateCorrelationDecision(correlation, baseInput),
      EvidenceProvenanceError,
    );
  });

  it("rejects evidence quoting an unknown report revision", () => {
    const correlation: IncidentCorrelation = {
      decision: "same_incident",
      candidateIncidentId: "inc-existing-999",
      reasoning: "Matching incident",
      supportingEvidence: [
        {
          reportRevisionId: "rev-ghost-404",
          quote: "Some quote",
          relevance: "Unreferenced report",
        },
      ],
      contradictoryEvidence: [],
      distinctions: [],
      unresolvedQuestions: [],
      uncertainty: [],
    };

    assert.throws(
      () => validateCorrelationDecision(correlation, baseInput),
      EvidenceProvenanceError,
    );
  });
});
