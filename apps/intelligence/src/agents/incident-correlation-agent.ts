import { z } from "zod";
import { Agent } from "@mastra/core/agent";
import { createNineRouterMastraAgent } from "../providers/ninerouter-adapter.js";
import { generateWithinBudget } from "./generation-budget.js";
import { parseModelOutput } from "./model-output.js";
import type { ReportInterpretation } from "./report-interpretation-agent.js";
import type { CandidateIncidentMatch } from "../services/semantic-retrieval-service.js";
import { PETABENCANA_SOURCE_LABEL } from "../structured-interpretation.js";
import { neutraliseSourceText, quoteAppearsInSource } from "./source-text-isolation.js";

/**
 * AI-RPM-01: a retrieved candidate only reaches the correlation model when its
 * similarity is at least this value. It equals the retrieval default
 * (`candidateThreshold` distance 0.40, i.e. similarity 0.60), so the workflow
 * never sends the model a candidate that retrieval itself would not accept.
 */
export const CORRELATION_MIN_SIMILARITY = 0.6;

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
  /**
   * MERGE-REVIEW-01: true when the reports state conflicting facts. The
   * same model call decides it, so there is no extra RPM. The L4 gate sends any
   * discrepancy to a moderator.
   */
  has_discrepancy: z.boolean(),
  /** Bahasa Indonesia, naming the conflicting reports. Required when has_discrepancy is true. */
  discrepancy_summary: z.string().nullable(),
});

export type IncidentCorrelation = z.infer<typeof IncidentCorrelationSchema>;
export class CorrelationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorrelationValidationError";
  }
}

/** Enforces the discrepancy contract: a flagged discrepancy must be explained. */
export function validateDiscrepancyFields(correlation: IncidentCorrelation): void {
  if (correlation.has_discrepancy && (correlation.discrepancy_summary === null || correlation.discrepancy_summary.trim().length === 0)) {
    throw new CorrelationValidationError("has_discrepancy requires a non-empty discrepancy_summary");
  }
}

/**
 * HOSTED-20: the validation errors in this module carry fixed codes as their messages. A message never holds a
 * quote, a model-supplied ID or other model text, because Mastra logs a failed step's message.
 */
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
      throw new CorrelationValidationError("same_incident_candidate_missing");
    }
    const candidate = input.candidateIncidents.find(
      (c) => c.incident.incidentId === correlation.candidateIncidentId,
    );
    if (!candidate) {
      throw new CorrelationValidationError("candidate_incident_unknown");
    }
  } else if (correlation.decision === "new_incident") {
    if (correlation.candidateIncidentId !== null) {
      throw new CorrelationValidationError("new_incident_candidate_set");
    }
  } else if (correlation.decision === "unresolved") {
    if (correlation.candidateIncidentId !== null) {
      const candidate = input.candidateIncidents.find(
        (c) => c.incident.incidentId === correlation.candidateIncidentId,
      );
      if (!candidate) {
        throw new CorrelationValidationError("unresolved_candidate_unknown");
      }
    }
  }

  // 2. Validate Evidence Provenance
  for (const ev of correlation.supportingEvidence) {
    const quote = ev.quote.trim();
    if (!quote) continue;

    if (ev.reportRevisionId === input.incomingReportRevisionId) {
      if (!quoteAppearsInSource(input.incomingReportText, quote)) {
        throw new EvidenceProvenanceError("evidence_quote_not_in_incoming_report");
      }
    } else {
      const candidate = input.candidateIncidents.find(
        (c) => c.matchedReportRevisionId === ev.reportRevisionId,
      );
      if (!candidate) {
        throw new EvidenceProvenanceError("evidence_report_revision_unknown");
      }
      const matchedText = candidate.matchedText ?? "";
      const incDesc = candidate.incident.description ?? "";
      if (!quoteAppearsInSource(matchedText, quote) && !quoteAppearsInSource(incDesc, quote)) {
        throw new EvidenceProvenanceError("evidence_quote_not_in_candidate");
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

5. Discrepancies (has_discrepancy / discrepancy_summary):
   - Set has_discrepancy to true only when the reports state facts that conflict with each other (for example a different depth, count, time, place, casualty figure or status). A missing detail is not a discrepancy.
   - When has_discrepancy is true, discrepancy_summary is one or two sentences in Bahasa Indonesia that name the conflicting reports by their reportRevisionId and say what differs. Otherwise discrepancy_summary is null.
   - Never resolve a discrepancy by choosing one side. Keep both in contradictoryEvidence.
6. Bahasa Indonesia Output (HOSTED-35a): write reasoning, distinctions, unresolvedQuestions, uncertainty, discrepancy_summary and every other free text in Bahasa Indonesia. Keep every quote in supportingEvidence and contradictoryEvidence verbatim from the report text.

Return ONLY valid JSON matching the requested schema. No markdown wrapping.
`.trim();

/**
 * AI-RPM-01: correlation with no candidate at or above CORRELATION_MIN_SIMILARITY,
 * decided without a model call. It follows the prompt rule for empty candidates:
 * a report that names a location is a new incident; a report without a location
 * stays unresolved. A blanket new_incident would skip that rule.
 */
export function correlateWithoutCandidates(interpretation: ReportInterpretation): IncidentCorrelation {
  const basis = `Deterministic correlation, no model call: no candidate incident reached similarity ${CORRELATION_MIN_SIMILARITY.toFixed(2)}.`;
  // HOSTED-17: the fixed PetaBencana source label names no place, so it does not make a report "name a location".
  const namesPlace = interpretation.location.label !== null && interpretation.location.label !== PETABENCANA_SOURCE_LABEL;
  const hasLocation = namesPlace || interpretation.location.approximateCoordinates !== null;
  if (hasLocation) {
    return {
      decision: "new_incident",
      candidateIncidentId: null,
      reasoning: `${basis} The report names a location, so it is recorded as a new incident.`,
      supportingEvidence: [],
      contradictoryEvidence: [],
      distinctions: [],
      unresolvedQuestions: [],
      uncertainty: [],
      has_discrepancy: false,
      discrepancy_summary: null,
    };
  }
  return {
    decision: "unresolved",
    candidateIncidentId: null,
    reasoning: `${basis} The report names no concrete location, so it stays unresolved for review.`,
    supportingEvidence: [],
    contradictoryEvidence: [],
    distinctions: [],
    unresolvedQuestions: ["Lokasi kejadian tidak dinyatakan dalam laporan."],
    uncertainty: [],
    has_discrepancy: false,
    discrepancy_summary: null,
  };
}

export function createIncidentCorrelationAgent(agentOverride?: Agent): Agent {
  if (agentOverride) return agentOverride;
  return createNineRouterMastraAgent({
    id: "incident-correlation-agent",
    name: "Incident Correlation Agent",
    instructions: INCIDENT_CORRELATOR_INSTRUCTIONS,
    mockRole: "correlator",
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
Title: ${neutraliseSourceText(inc.title)}
Type: ${neutraliseSourceText(inc.incidentType)}
Status: ${inc.status} | Severity: ${inc.severity}
Location: ${neutraliseSourceText(inc.locationLabel ?? "Unknown")} (${inc.coordinates ? inc.coordinates.join(", ") : "no coordinates"})
First Observed: ${inc.firstObservedAt ?? "unknown"} | Last Updated: ${inc.lastUpdatedAt}
Description: ${neutraliseSourceText(inc.description)}
${match.matchedReportRevisionId ? `Evidence Report Revision ID: ${match.matchedReportRevisionId}` : ""}
${match.matchedText ? `Matched Historical Evidence: "${neutraliseSourceText(match.matchedText)}"` : ""}
`.trim();
        })
        .join("\n\n---\n\n");

  const prompt = `
Compare the incoming report with the candidate incidents and decide correlation.

=== INCOMING REPORT (${input.incomingReportRevisionId}) ===
Text: ${neutraliseSourceText(input.incomingReportText)}
Extracted Summary: ${neutraliseSourceText(input.incomingInterpretation.summary)}
Extracted Incident Type: ${neutraliseSourceText(input.incomingInterpretation.incidentType)}
Severity: ${input.incomingInterpretation.severity}
Location: ${neutraliseSourceText(input.incomingInterpretation.location.label ?? "Unspecified")} (${input.incomingInterpretation.location.approximateCoordinates ? input.incomingInterpretation.location.approximateCoordinates.join(", ") : "none"})
Time: ${neutraliseSourceText(input.incomingInterpretation.eventTime.value ?? "Unspecified")}
Impacts: ${input.incomingInterpretation.impacts.map((impact) => neutraliseSourceText(impact)).join("; ")}

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
  "uncertainty": [string],
  "has_discrepancy": boolean,
  "discrepancy_summary": string | null
}
`.trim();

  // NFR-02: bounded steps, active time and tokens. See generation-budget.ts.
  const response = await generateWithinBudget(agent, prompt, INCIDENT_CORRELATOR_INSTRUCTIONS);
  const correlation = parseModelOutput(response.text, IncidentCorrelationSchema);
  validateCorrelationDecision(correlation, input);
  validateDiscrepancyFields(correlation);
  return correlation;
}
