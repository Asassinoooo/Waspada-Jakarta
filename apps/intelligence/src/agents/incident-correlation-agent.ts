import { z } from "zod";
import { Agent } from "@mastra/core/agent";
import {
  createNineRouterMastraAgent,
  extractJsonFromText,
} from "../providers/ninerouter-adapter.js";
import type { ReportInterpretation } from "./report-interpretation-agent.js";
import type { CandidateIncidentMatch } from "../services/semantic-retrieval-service.js";

export const IncidentCorrelationSchema = z.object({
  decision: z.enum(["same_incident", "new_incident", "unresolved"]),
  candidateIncidentId: z.string().nullable(),
  reasoning: z.string().min(1),
  supportingEvidence: z.array(
    z.object({
      reportRevisionId: z.string(),
      quote: z.string(),
      relevance: z.string(),
    }),
  ),
  contradictoryEvidence: z.array(
    z.object({
      field: z.string(),
      claimA: z.string(),
      claimB: z.string(),
    }),
  ),
  distinctions: z.array(z.string()),
  unresolvedQuestions: z.array(z.string()),
  uncertainty: z.array(z.string()),
});

export type IncidentCorrelation = z.infer<typeof IncidentCorrelationSchema>;

export interface CorrelateIncidentInput {
  readonly incomingReportRevisionId: string;
  readonly incomingReportText: string;
  readonly incomingInterpretation: ReportInterpretation;
  readonly candidateIncidents: readonly CandidateIncidentMatch[];
}

export const INCIDENT_CORRELATOR_INSTRUCTIONS = `
You are the Waspada Jakarta Incident Correlation Specialist. Your responsibility is to analyze factual evidence and determine whether an incoming report refers to an existing active incident, represents a brand new incident, or is ambiguous/unresolved.

Core Evaluation Rules:
1. Grounded In Evidence, Not Keywords:
   - Do NOT correlate reports simply because they share generic vocabulary (like "banjir", "hujan", "macet").
   - Distinct wording describing the same physical disruption (e.g., "Genangan air 50cm di Cawang" and "Jalan DI Panjaitan terendam banjir sedada anak-anak") represents the SAME INCIDENT.
   - Same category words describing events at different locations or different days represent a NEW INCIDENT.
2. Contradiction Preservation:
   - When correlating to an existing incident, if the reports state differing facts (e.g. depth 50cm vs 30cm, 1 casualty vs no casualties), do NOT average or discard either claim. Record them explicitly in 'contradictoryEvidence'.
3. Unresolved Threshold:
   - If location or time is too ambiguous to determine whether it overlaps with a candidate incident, choose 'unresolved' and list the questions needed to clarify in 'unresolvedQuestions'.
4. Decision Types:
   - 'same_incident': High factual confidence that this describes an existing incident in candidateIncidents. Set candidateIncidentId to that incident's ID.
   - 'new_incident': High factual confidence that this is a separate, new physical event. Set candidateIncidentId to null.
   - 'unresolved': Evidence is ambiguous or insufficient to confirm or refute a match. Set candidateIncidentId to the most likely candidate or null.

Return ONLY valid JSON matching the requested schema. No markdown wrapping.
`.trim();

export function createIncidentCorrelationAgent(agentOverride?: Agent): Agent {
  if (agentOverride) return agentOverride;
  return createNineRouterMastraAgent({
    id: "incident-correlation-agent",
    name: "Incident Correlation Agent",
    instructions: INCIDENT_CORRELATOR_INSTRUCTIONS,
  });
}

export async function correlateIncident(
  input: CorrelateIncidentInput,
  options?: { agent?: Agent; fallbackMock?: boolean },
): Promise<IncidentCorrelation> {
  if (options?.fallbackMock) {
    return generateFallbackCorrelation(input);
  }
  const agent = options?.agent ?? createIncidentCorrelationAgent();
  const candidatesContext = input.candidateIncidents.length === 0
    ? "No active candidate incidents retrieved from database."
    : input.candidateIncidents
        .map((match, idx) => {
          const inc = match.incident;
          return `
[Candidate #${idx + 1}] ID: ${inc.incidentId} (Similarity Score: ${match.similarityScore.toFixed(3)})
Title: ${inc.title}
Type: ${inc.incidentType}
Status: ${inc.status} | Severity: ${inc.severity}
Location: ${inc.locationLabel ?? "Unknown"} (${inc.coordinates ? inc.coordinates.join(", ") : "no coordinates"})
First Observed: ${inc.firstObservedAt} | Last Updated: ${inc.lastUpdatedAt}
Description: ${inc.description}
${match.matchedText ? `Matched Historical Evidence: "${match.matchedText}"` : ""}
`.trim();
        })
        .join("\n\n---\n\n");

  const prompt = `
Compare the incoming report with the candidate incidents and decide correlation.

=== INCOMING REPORT (${input.incomingReportRevisionId}) ===
Text: ${input.incomingReportText}
Extracted Summary: ${input.incomingInterpretation.summary}
Extracted Incident Type: ${input.incomingInterpretation.incidentType}
Location: ${input.incomingInterpretation.location.label ?? "Unspecified"} (${input.incomingInterpretation.location.approximateCoordinates ? input.incomingInterpretation.location.approximateCoordinates.join(", ") : "none"})
Time: ${input.incomingInterpretation.eventTime.value ?? "Unspecified"}
Impacts: ${input.incomingInterpretation.impacts.join("; ")}

=== CANDIDATE INCIDENTS IN DATABASE ===
${candidatesContext}

Format your output as a single JSON object with these keys:
{
  "decision": "same_incident" | "new_incident" | "unresolved",
  "candidateIncidentId": string | null,
  "reasoning": string,
  "supportingEvidence": [{ "reportRevisionId": string, "quote": string, "relevance": string }],
  "contradictoryEvidence": [{ "field": string, "claimA": string, "claimB": string }],
  "distinctions": [string],
  "unresolvedQuestions": [string],
  "uncertainty": [string]
}
`.trim();

  try {
    const response = await agent.generate(prompt);
    const parsedJson = extractJsonFromText(response.text);
    return IncidentCorrelationSchema.parse(parsedJson);
  } catch (error) {
    if (options?.fallbackMock) {
      return generateFallbackCorrelation(input);
    }
    throw error;
  }
}

export function generateFallbackCorrelation(input: CorrelateIncidentInput): IncidentCorrelation {
  if (input.candidateIncidents.length === 0) {
    return {
      decision: "new_incident",
      candidateIncidentId: null,
      reasoning: "Tidak ditemukan kandidat insiden aktif yang relevan di basis data.",
      supportingEvidence: [],
      contradictoryEvidence: [],
      distinctions: ["Insiden pertama dalam kategori dan wilayah ini"],
      unresolvedQuestions: [],
      uncertainty: [],
    };
  }

  const topMatch = input.candidateIncidents[0];
  if (topMatch.similarityScore >= 0.8) {
    return {
      decision: "same_incident",
      candidateIncidentId: topMatch.incident.incidentId,
      reasoning: `Kemiripan semantik tinggi (${(topMatch.similarityScore * 100).toFixed(1)}%) dengan insiden aktif ${topMatch.incident.title}.`,
      supportingEvidence: [
        {
          reportRevisionId: input.incomingReportRevisionId,
          quote: input.incomingReportText.slice(0, 100),
          relevance: "Lokasi dan jenis kejadian selaras",
        },
      ],
      contradictoryEvidence: [],
      distinctions: [],
      unresolvedQuestions: [],
      uncertainty: [],
    };
  }

  return {
    decision: "new_incident",
    candidateIncidentId: null,
    reasoning: "Meskipun ada insiden aktif, rincian lokasi atau peristiwa tidak cukup identik untuk digabungkan.",
    supportingEvidence: [],
    contradictoryEvidence: [],
    distinctions: [`Berbeda lokasi/peristiwa dari ${topMatch.incident.title}`],
    unresolvedQuestions: [],
    uncertainty: [],
  };
}
