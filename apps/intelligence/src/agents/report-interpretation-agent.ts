import { z } from "zod";
import { Agent } from "@mastra/core/agent";
import {
  createNineRouterMastraAgent,
  extractJsonFromText,
} from "../providers/ninerouter-adapter.js";

export const ReportInterpretationSchema = z.object({
  summary: z.string().min(1),
  incidentType: z.string().min(1),
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
1. Let AI understand the data — do not force facts into rigid keyword taxonomies or narrow 6-category enums. Use open, descriptive, natural Indonesian incident types (e.g. "genangan air akibat luapan saluran", "kecelakaan lalu lintas melibatkan truk", "pohon tumbang menghalangi jalan").
2. Zero Hallucination: Every entry in the 'evidence' array MUST contain an exact verbatim quote from the text and cite the relevant chunkId. Do not paraphrase in quotes.
3. Spatial Grounding: If coordinates are mentioned or can be reliably identified from known Jakarta corridors (e.g. "Jl. DI Panjaitan Cawang" approx [106.871, -6.244]), provide approximateCoordinates [longitude, latitude]. If ambiguous or only district level, set precision to 'corridor', 'district', or 'unknown' and coordinates to null.
4. Temporal Grounding: Parse timestamps into ISO-8601 when possible. If only date or time of day is stated, note precision ('date', 'range', 'unknown').
5. Uncertainty & Contradictions: If the report contains conflicting statements, list them in 'conflictingInfo'. If details like exact depth, casualty count, or clearing time are unstated, list them in 'uncertaintyNotes'.

Return ONLY valid JSON matching the requested schema. No markdown wrapping or conversational commentary.
`.trim();

export function createReportInterpretationAgent(agentOverride?: Agent): Agent {
  if (agentOverride) return agentOverride;
  return createNineRouterMastraAgent({
    id: "report-interpreter-agent",
    name: "Report Interpretation Agent",
    instructions: REPORT_INTERPRETER_INSTRUCTIONS,
  });
}

export async function interpretReport(
  input: InterpretReportInput,
  options?: { agent?: Agent; fallbackMock?: boolean },
): Promise<ReportInterpretation> {
  if (options?.fallbackMock) {
    return generateFallbackInterpretation(input);
  }
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

  try {
    const response = await agent.generate(prompt);
    const parsedJson = extractJsonFromText(response.text);
    return ReportInterpretationSchema.parse(parsedJson);
  } catch (error) {
    if (options?.fallbackMock) {
      return generateFallbackInterpretation(input);
    }
    throw error;
  }
}

export function generateFallbackInterpretation(input: InterpretReportInput): ReportInterpretation {
  const firstChunk = input.evidenceChunks[0];
  const quote = firstChunk?.text.slice(0, 100) || input.reportText.slice(0, 100);
  const textLower = input.reportText.toLowerCase();
  let incidentType = "kejadian lalu lintas / lingkungan";
  if (textLower.includes("banjir") || textLower.includes("genangan")) {
    incidentType = "genangan air / banjir";
  } else if (textLower.includes("kebakaran")) {
    incidentType = "kebakaran";
  } else if (textLower.includes("kecelakaan") || textLower.includes("tabrakan")) {
    incidentType = "kecelakaan lalu lintas";
  } else if (textLower.includes("pohon tumbang")) {
    incidentType = "pohon tumbang";
  }

  return {
    summary: input.reportText.slice(0, 200).trim(),
    incidentType,
    location: {
      label: "DKI Jakarta",
      approximateCoordinates: [106.8456, -6.2088],
      precision: "approximate",
    },
    eventTime: {
      value: input.publishedAt ?? new Date().toISOString(),
      precision: input.publishedAt ? "exact" : "unknown",
    },
    entities: [],
    impacts: ["Gangguan lalu lintas terdeteksi"],
    operationalStatus: "active",
    evidence: [
      {
        chunkId: firstChunk?.chunkId || "chunk-0",
        exactQuote: quote,
        supports: "summary",
      },
    ],
    conflictingInfo: [],
    uncertaintyNotes: ["Interpretasi dihasilkan secara deterministik"],
    confidence: "medium",
  };
}
