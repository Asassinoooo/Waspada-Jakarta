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
export class CorrelationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorrelationValidationError";
  }
}

export class EvidenceProvenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceProvenanceError";
  }
}

export function validateCorrelationDecision(
  correlation: IncidentCorrelation,
  input: CorrelateIncidentInput,
): void {
  // 1. Validate Decision Contract
  if (correlation.decision === "same_incident") {
    if (!correlation.candidateIncidentId) {
      throw new CorrelationValidationError(
        "Decision 'same_incident' requires a non-null candidateIncidentId",
      );
    }
    const candidate = input.candidateIncidents.find(
      (c) => c.incident.incidentId === correlation.candidateIncidentId,
    );
    if (!candidate) {
      throw new CorrelationValidationError(
        `Candidate incident '${correlation.candidateIncidentId}' does not exist in the retrieved candidate set`,
      );
    }
  } else if (correlation.decision === "new_incident") {
    if (correlation.candidateIncidentId !== null) {
      throw new CorrelationValidationError(
        `Decision 'new_incident' must not reference candidate incident '${correlation.candidateIncidentId}'; candidateIncidentId must be null`,
      );
    }
  } else if (correlation.decision === "unresolved") {
    if (correlation.candidateIncidentId !== null) {
      const candidate = input.candidateIncidents.find(
        (c) => c.incident.incidentId === correlation.candidateIncidentId,
      );
      if (!candidate) {
        throw new CorrelationValidationError(
          `Unresolved candidate incident '${correlation.candidateIncidentId}' does not exist in the retrieved candidate set`,
        );
      }
    }
  }

  // 2. Validate Evidence Provenance
  for (const ev of correlation.supportingEvidence) {
    const quote = ev.quote.trim();
    if (!quote) continue;

    if (ev.reportRevisionId === input.incomingReportRevisionId) {
      if (!input.incomingReportText.includes(quote)) {
        throw new EvidenceProvenanceError(
          `Supporting quote "${quote}" does not exist verbatim in incoming report revision '${input.incomingReportRevisionId}'`,
        );
      }
    } else {
      const candidate = input.candidateIncidents.find(
        (c) => c.matchedReportRevisionId === ev.reportRevisionId,
      );
      if (!candidate) {
        throw new EvidenceProvenanceError(
          `Supporting evidence references unknown report revision '${ev.reportRevisionId}' not in retrieved candidate evidence`,
        );
      }
      const matchedText = candidate.matchedText ?? "";
      const incDesc = candidate.incident.description ?? "";
      if (!matchedText.includes(quote) && !incDesc.includes(quote)) {
        throw new EvidenceProvenanceError(
          `Supporting quote "${quote}" does not exist verbatim in candidate evidence for revision '${ev.reportRevisionId}'`,
        );
      }
    }
  }
}

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
3. Substantive Evaluation of Candidates:
   - When candidate incidents are empty, do NOT automatically assume it is a new incident. Evaluate if the incoming report contains sufficient concrete, verifiable facts (location, timing, physical event) to establish a distinct incident ('new_incident').
   - If the report is too vague, fragmented, or ambiguous (e.g., "ada kejadian di jalan"), choose 'unresolved'.
4. Decision Types:
   - 'same_incident': High factual confidence that this describes an existing incident in candidateIncidents. Set candidateIncidentId to that incident's ID.
   - 'new_incident': High factual confidence that this report contains sufficient concrete facts to establish a distinct new physical event. Set candidateIncidentId to null.
   - 'unresolved': Evidence is ambiguous, fragmented, or insufficient to confirm or refute a match. Set candidateIncidentId to the most likely candidate or null.

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
  options?: { agent?: Agent },
): Promise<IncidentCorrelation> {
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
${match.matchedReportRevisionId ? `Evidence Report Revision ID: ${match.matchedReportRevisionId}` : ""}
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
Severity: ${input.incomingInterpretation.severity}
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

  const response = await agent.generate(prompt);
  const parsedJson = extractJsonFromText(response.text);
  const correlation = IncidentCorrelationSchema.parse(parsedJson);
  validateCorrelationDecision(correlation, input);
  return correlation;
}
