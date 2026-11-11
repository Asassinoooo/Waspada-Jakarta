// INTEL-02: deterministic local chat model for NINEROUTER_MODE=mock. It is a LanguageModel object
// (spec v2) that Mastra agents accept in place of a gateway config, so mock mode makes no
// gateway request. It is not a quality model: it returns schema-valid output built from the prompt.
// The output is never inferred from a missing key. It needs NINEROUTER_MODE=mock explicitly.

export type MockChatRole = "interpreter" | "correlator";

export const MOCK_CHAT_PROVIDER = "waspada-mock";

const CATEGORY_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/kebakaran|api\b|hangus/i, "fires_infrastructure_hazards"],
  [/kecelakaan|tabrakan|lalu lintas|macet/i, "transport_road_incidents"],
  [/demo|unjuk rasa|aksi massa/i, "demonstrations_public_gatherings"],
  [/tawuran|bentrok|kekerasan/i, "violence_immediate_threats"],
  [/begal|curi|rampok|penipuan/i, "crime_personal_security"],
  [/listrik|pdam|air bersih|telekomunikasi/i, "utilities_essential_services"],
];

interface MockChunk {
  readonly chunkId: string;
  readonly text: string;
}

function promptText(prompt: unknown): string {
  if (!Array.isArray(prompt)) return "";
  const parts: string[] = [];
  for (const message of prompt as Array<{ content?: unknown }>) {
    if (typeof message.content === "string") {
      parts.push(message.content);
    } else if (Array.isArray(message.content)) {
      for (const part of message.content as Array<{ type?: unknown; text?: unknown }>) {
        if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
      }
    }
  }
  return parts.join("\n");
}

/** Text between a start marker and the next end marker, or "" when either is missing. */
function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  if (from < 0) return "";
  const body = text.slice(from + start.length);
  const to = body.indexOf(end);
  return (to < 0 ? body : body.slice(0, to)).trim();
}

function parseChunks(prompt: string): MockChunk[] {
  const section = between(prompt, "=== EVIDENCE CHUNKS ===", "Format your output");
  const chunks: MockChunk[] = [];
  const pattern = /\[Chunk ID: ([^\]]+)\] \(offset \d+-\d+\): "([\s\S]*?)"(?=\s*\[Chunk ID:|\s*$)/g;
  for (const match of section.matchAll(pattern)) {
    chunks.push({ chunkId: match[1]!, text: match[2]! });
  }
  return chunks;
}

function interpretation(prompt: string): Record<string, unknown> {
  const reportText = between(prompt, "=== REPORT TEXT ===", "=== EVIDENCE CHUNKS ===");
  const firstLine = reportText.split(/\n/)[0]?.trim() ?? "";
  const summary = (firstLine || "Laporan tanpa ringkasan").slice(0, 200);
  const category = CATEGORY_RULES.find(([pattern]) => pattern.test(reportText))?.[1] ?? "disasters_weather";
  const isFlood = /banjir|genangan/i.test(reportText);
  const street = reportText.match(/\b(?:Jl\.|Jalan)\s+[^,.\n]{2,60}/);
  return {
    summary,
    incidentType: isFlood ? "genangan air" : "kejadian lapangan",
    severity: "unknown",
    primaryCategory: category,
    location: {
      label: street ? street[0].trim() : null,
      approximateCoordinates: null,
      precision: street ? "approximate" : "unknown",
    },
    eventTime: { value: null, precision: "unknown" },
    entities: [],
    impacts: [],
    operationalStatus: "unknown",
    evidence: parseChunks(prompt).map((chunk) => ({
      chunkId: chunk.chunkId,
      exactQuote: chunk.text.slice(0, 160),
      supports: "Kutipan dari teks laporan (mock)",
    })),
    conflictingInfo: [],
    uncertaintyNotes: ["Interpretasi mock deterministik: tanpa model bahasa."],
    confidence: "medium",
  };
}

function correlation(prompt: string): Record<string, unknown> {
  // Candidates reach the correlator only at or above the similarity threshold. The first one is the match.
  const candidate = prompt.match(/\[Candidate #\d+\] ID: (\S+) \(Similarity Score/);
  const base = {
    contradictoryEvidence: [],
    distinctions: [],
    unresolvedQuestions: [],
    uncertainty: ["Keputusan mock deterministik: tanpa model bahasa."],
    supportingEvidence: [],
  };
  if (candidate) {
    return {
      ...base,
      decision: "same_incident",
      candidateIncidentId: candidate[1],
      reasoning: "Keputusan mock: kandidat pertama melampaui ambang kemiripan.",
    };
  }
  return {
    ...base,
    decision: "new_incident",
    candidateIncidentId: null,
    reasoning: "Keputusan mock: tidak ada kandidat aktif.",
  };
}

/** The text a mock model answers with. Exported for tests. */
export function mockChatAnswer(role: MockChatRole, prompt: string): string {
  return JSON.stringify(role === "interpreter" ? interpretation(prompt) : correlation(prompt));
}

/** A LanguageModel (spec v2) that answers from the prompt. It makes no network request. */
export function createMockChatModel(role: MockChatRole) {
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  return {
    specificationVersion: "v2" as const,
    provider: MOCK_CHAT_PROVIDER,
    modelId: `waspada-mock-${role}`,
    supportedUrls: {} as Record<string, RegExp[]>,
    async doGenerate(options: { prompt: unknown }) {
      const text = mockChatAnswer(role, promptText(options.prompt));
      return {
        content: [{ type: "text" as const, text }],
        finishReason: "stop" as const,
        usage,
        warnings: [] as unknown[],
      };
    },
    async doStream(options: { prompt: unknown }) {
      const text = mockChatAnswer(role, promptText(options.prompt));
      const parts = [
        { type: "stream-start" as const, warnings: [] as unknown[] },
        { type: "text-start" as const, id: "mock-text-1" },
        { type: "text-delta" as const, id: "mock-text-1", delta: text },
        { type: "text-end" as const, id: "mock-text-1" },
        { type: "finish" as const, finishReason: "stop" as const, usage },
      ];
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  };
}
