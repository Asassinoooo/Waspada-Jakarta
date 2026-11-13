import { z } from "zod";
import { Agent } from "@mastra/core/agent";
import { OFFICIAL_INCIDENT_CATEGORIES } from "../../../db/src/incident-categories.js";
import {
  createNineRouterMastraAgent,
  extractJsonFromText,
} from "../providers/ninerouter-adapter.js";
import { generateWithinBudget } from "./generation-budget.js";

/**
 * The severity levels the model is asked to output (rubric in REPORT_INTERPRETER_INSTRUCTIONS,
 * step 4). Only these three appear in the prompt's output template.
 */
export const REPORT_SEVERITY_MODEL_OPTIONS = ["low", "medium", "high"] as const;
export const ReportModelSeveritySchema = z.enum(REPORT_SEVERITY_MODEL_OPTIONS);

/**
 * Downstream severity type. The wider set is kept for the DB CHECK (migration 037), the incident
 * and proposal types, and the existing fallback paths. A model answer never yields critical or
 * unknown from the rubric; see normalizeReportSeverity.
 */
export const ReportSeveritySchema = z.enum(["low", "medium", "high", "critical", "unknown"]);
export type ReportSeverity = z.infer<typeof ReportSeveritySchema>;

/**
 * Maps a raw model value to the downstream severity.
 * - low, medium or high (case and surrounding spaces ignored) pass through.
 * - critical becomes high, because the rubric has no critical level.
 * - anything else (unknown, missing, invalid) becomes unknown. That is the failure fallback, and the
 *   workflow already treats unknown as "not stated" when it resolves severity.
 */
export function normalizeReportSeverity(raw: unknown): ReportSeverity {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : raw;
  const modelLevel = ReportModelSeveritySchema.safeParse(value);
  if (modelLevel.success) return modelLevel.data;
  if (value === "critical") return "high";
  return "unknown";
}

export const ReportInterpretationSchema = z.object({
  summary: z.string().min(1),
  incidentType: z.string().min(1),
  severity: z.preprocess(normalizeReportSeverity, ReportSeveritySchema),
  primaryCategory: z.enum(OFFICIAL_INCIDENT_CATEGORIES),
  location: z.object({
    label: z.string().nullable(),
    approximateCoordinates: z.tuple([z.number(), z.number()]).nullable(),
    precision: z.enum(["exact", "approximate", "corridor", "district", "unknown"]),
  }),
  eventTime: z.object({
    value: z.string().nullable(),
    precision: z.enum(["exact", "date", "range", "unknown"]),
  }),
  entities: z.array(
    z.object({
      name: z.string(),
      kind: z.enum(["person", "organization", "vehicle", "infrastructure", "other"]),
    }),
  ),
  impacts: z.array(z.string()),
  operationalStatus: z.enum(["active", "clearing", "resolved", "unknown"]),
  evidence: z.array(
    z.object({
      chunkId: z.string(),
      exactQuote: z.string(),
      supports: z.string(),
    }),
  ),
  conflictingInfo: z.array(z.string()),
  uncertaintyNotes: z.array(z.string()),
  confidence: z.enum(["high", "medium", "low"]),
});

export type ReportInterpretation = z.infer<typeof ReportInterpretationSchema>;

export interface EvidenceChunkInput {
  readonly chunkId: string;
  readonly spanStart: number;
  readonly spanEnd: number;
  readonly text: string;
}

export interface InterpretReportInput {
  readonly reportRevisionId: string;
  readonly reportText: string;
  readonly sourceKind: string;
  readonly sourceDisplayName: string;
  readonly publishedAt?: string | null;
  readonly evidenceChunks: readonly EvidenceChunkInput[];
}

export const REPORT_INTERPRETER_INSTRUCTIONS = `
You are the Waspada Jakarta Report Interpretation Specialist. Your mission is to extract objective, factual incident intelligence from Indonesian civil reports, sensor bulletins, citizen alerts, and news articles.

Core Principles:
1. Let AI understand the data — keep 'incidentType' as an open, descriptive, natural Indonesian phrase (e.g. "genangan air akibat luapan saluran", "kecelakaan lalu lintas melibatkan truk", "pohon tumbang menghalangi jalan", "tiang listrik roboh", "pipa air pdam bocor"). Never force incidentType into a rigid enum.
2. Primary Category (exactly one): set 'primaryCategory' to EXACTLY ONE of the ten official slugs below. Never invent a new category, never emit an array, never leave it null. If no category is reliably supported by the evidence, the correct behavior is to fail validation (throw) so the job routes to review — never silently fall back to "disasters_weather" or another default.
   - crime_personal_security: reported robbery, theft, assault, harassment, actionable personal-security incidents. Exclude unrelated court reporting, historical investigations, routine announcements without safety implications.
   - demonstrations_public_gatherings: protests, marches, rallies, strikes, public gatherings. Traffic restrictions caused by a demo stay impacts, not a second incident.
   - crowds_major_events: concerts, sporting events, festivals, overcrowding with documented crowd/access/transport effects. Do not ingest every ordinary entertainment announcement.
   - violence_immediate_threats: violent clashes, tawuran, immediate threats, acute public violence. Distinct from peaceful demos and ordinary crime.
   - disasters_weather: flooding, severe weather, earthquakes, fallen trees, natural/weather incidents.
   - fires_infrastructure_hazards: building fires, gas leaks, structural collapses, damaged infrastructure creating public hazards.
   - transport_road_incidents: road accidents, closures, diversions, public-transport interruptions.
   - utilities_essential_services: significant water, electricity, communications outages affecting public services.
   - health_environmental_advisories: official outbreak notices, significant pollution alerts, contamination warnings.
   - group_specific_critical_notices: critical notices for an identified institution, school, occupation, or community (closures, evacuations).
3. Event vs impacts: 'primaryCategory' names what happened; 'impacts' names what it affects (e.g. a demonstration causing road_closure/traffic_diversion stays demonstrations_public_gatherings with those impacts — never reclassify as transport merely because it affects traffic). Never create a second incident for one event's effects.
4. Severity Factual Grounding: set 'severity' to exactly one of 'low', 'medium' or 'high', using only facts the report states. Never infer it from the category alone or from the number of impacts.
   - high: deaths or injuries, a threat to life, a spreading fire or several buildings burnt, evacuation, deep flood (about 70 cm or more, or houses submerged), riot or violent clash, explosion or building collapse, a main transit line (KRL/MRT/LRT) stopped, a toll road or major artery fully closed.
   - medium: localized disruption affecting many people: road partly closed or blocked, heavy congestion from an accident, flood 10-70 cm, demonstration blocking roads, transit delays, local power or water outage, a contained fire in one building with no victims.
   - low: minor or contained, no injuries, small area: brief delay, small fire already extinguished, prevented or foiled tawuran, light water pooling, a stalled vehicle that was cleared.
   - When torn between two levels, choose the lower one and state why in 'uncertaintyNotes'. 'critical' and 'unknown' are not valid severity values. Severity never means an area is safe.
5. Zero Hallucination: Every entry in the 'evidence' array MUST contain an exact verbatim quote from the text and cite the relevant chunkId. Do not paraphrase in quotes. If no clear factual quote exists, do not invent one.
6. Spatial Grounding: If coordinates are mentioned or can be reliably identified from known Jakarta corridors (e.g. "Jl. DI Panjaitan Cawang" approx [106.871, -6.244]), provide approximateCoordinates [longitude, latitude]. If ambiguous or unknown, set 'label: null', 'approximateCoordinates: null', and 'precision: "unknown"'. NEVER default unlocated reports to "DKI Jakarta" or default coordinates.
7. Temporal Grounding: Parse timestamps into ISO-8601 when possible. If only date or time of day is stated, note precision ('date', 'range', 'unknown'). If unstated, set 'value: null' and 'precision: "unknown"'.
8. Uncertainty & Contradictions: If the report contains conflicting statements, list them in 'conflictingInfo'. If details like exact depth, casualty count, or clearing time are unstated, list them in 'uncertaintyNotes'.
`.trim();
export function createReportInterpretationAgent(agentOverride?: Agent): Agent {
  if (agentOverride) return agentOverride;
  return createNineRouterMastraAgent({
    id: "report-interpreter-agent",
    name: "Report Interpretation Agent",
    instructions: REPORT_INTERPRETER_INSTRUCTIONS,
    mockRole: "interpreter",
  });
}

export async function interpretReport(
  input: InterpretReportInput,
  options?: { agent?: Agent },
): Promise<ReportInterpretation> {
  const agent = options?.agent ?? createReportInterpretationAgent();
  const chunksContext = input.evidenceChunks
    .map((c) => `[Chunk ID: ${c.chunkId}] (offset ${c.spanStart}-${c.spanEnd}): "${c.text}"`)
    .join("\n\n");

  const prompt = `
Please extract incident intelligence from the following report.

Source: ${input.sourceDisplayName} (${input.sourceKind})
Published At: ${input.publishedAt ?? "Not specified"}

=== REPORT TEXT ===
${input.reportText}

=== EVIDENCE CHUNKS ===
${chunksContext}

Format your output as a single JSON object with these keys:
{
  "summary": string,
  "incidentType": string,
  "primaryCategory": ${OFFICIAL_INCIDENT_CATEGORIES.map((slug) => `"${slug}"`).join("|")},
  "severity": ${REPORT_SEVERITY_MODEL_OPTIONS.map((level) => `"${level}"`).join("|")},
  "location": { "label": string | null, "approximateCoordinates": [number, number] | null, "precision": "exact"|"approximate"|"corridor"|"district"|"unknown" },
  "eventTime": { "value": string | null, "precision": "exact"|"date"|"range"|"unknown" },
  "entities": [{ "name": string, "kind": "person"|"organization"|"vehicle"|"infrastructure"|"other" }],
  "impacts": [string],
  "operationalStatus": "active"|"clearing"|"resolved"|"unknown",
  "evidence": [{ "chunkId": string, "exactQuote": string, "supports": string }],
  "conflictingInfo": [string],
  "uncertaintyNotes": [string],
  "confidence": "high"|"medium"|"low"
}
`.trim();

  // NFR-02: bounded steps, active time and tokens. See generation-budget.ts.
  const response = await generateWithinBudget(agent, prompt, REPORT_INTERPRETER_INSTRUCTIONS);
  const parsedJson = extractJsonFromText(response.text);
  return ReportInterpretationSchema.parse(parsedJson);
}
