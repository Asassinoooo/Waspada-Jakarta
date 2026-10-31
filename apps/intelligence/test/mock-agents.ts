import type { Agent } from "@mastra/core/agent";
import type { ReportInterpretation } from "../src/agents/report-interpretation-agent.js";
import type { IncidentCorrelation } from "../src/agents/incident-correlation-agent.js";

export function createMockInterpreterAgent(overrides?: Partial<ReportInterpretation>): Agent {
  const defaultInterpretation: ReportInterpretation = {
    summary: "Banjir setinggi 50 cm merendam Jalan DI Panjaitan, Cawang",
    incidentType: "genangan_air_luapan_saluran",
    severity: "medium",
    location: {
      label: "Jl. DI Panjaitan, Cawang, Jakarta Timur",
      approximateCoordinates: [106.871, -6.244],
      precision: "approximate",
    },
    eventTime: {
      value: "2026-10-30T16:00:00.000Z",
      precision: "exact",
    },
    entities: [],
    impacts: ["Gangguan lalu lintas", "Genangan air 50 cm"],
    operationalStatus: "active",
    evidence: [
      {
        chunkId: "chk-001",
        exactQuote: "Banjir setinggi 50 cm merendam Jalan DI Panjaitan",
        supports: "Kedalaman air dan lokasi",
      },
    ],
    conflictingInfo: [],
    uncertaintyNotes: [],
    confidence: "high",
    ...overrides,
  };

  return {
    generate: async () => ({
      text: JSON.stringify(defaultInterpretation),
    }),
  } as unknown as Agent;
}

export function createMockCorrelatorAgent(overrides?: Partial<IncidentCorrelation>): Agent {
  const defaultCorrelation: IncidentCorrelation = {
    decision: "new_incident",
    candidateIncidentId: null,
    reasoning: "Tidak ditemukan korelasi dengan kandidat aktif di area ini.",
    supportingEvidence: [],
    contradictoryEvidence: [],
    distinctions: ["Insiden baru di koridor ini"],
    unresolvedQuestions: [],
    uncertainty: [],
    ...overrides,
  };

  return {
    generate: async () => ({
      text: JSON.stringify(defaultCorrelation),
    }),
  } as unknown as Agent;
}

export function createFailingAgent(error: Error): Agent {
  return {
    generate: async () => {
      throw error;
    },
  } as unknown as Agent;
}
