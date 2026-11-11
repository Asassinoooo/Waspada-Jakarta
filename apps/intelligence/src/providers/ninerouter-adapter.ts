import { Agent } from "@mastra/core/agent";
import { getNineRouterRateGate } from "../../../db/src/ninerouter-rate-gate.js";
import { createMockChatModel, type MockChatRole } from "./mock-chat-model.js";

export type NineRouterExecutionMode = "live" | "mock";

export class NineRouterConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NineRouterConfigError";
  }
}

export interface NineRouterConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly chatModel: string;
  readonly embeddingModel: string;
  readonly embeddingDimensions: number;
  readonly executionMode: NineRouterExecutionMode;
  /**
   * INTEL-02: true only when NINEROUTER_MODE=mock is set explicitly. Agents then use the
   * deterministic local chat model and make no gateway call. A missing key does not set it,
   * so a live run without credentials fails instead of writing mock interpretations.
   */
  readonly explicitMock?: boolean;
}
export function getNineRouterConfig(): NineRouterConfig {
  const rawUrl = process.env.NINEROUTER_URL?.trim() || "http://127.0.0.1:9090";
  const baseUrl = rawUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  const apiKey = process.env.NINEROUTER_KEY?.trim() || "";
  const chatModel = process.env.NINEROUTER_CHAT_MODEL?.trim() || "Waspada-Jakarta";
  const embeddingModel = process.env.NINEROUTER_EMBEDDING_MODEL?.trim() || "gemini/gemini-embedding-2-preview";
  const rawMode = process.env.NINEROUTER_MODE?.trim().toLowerCase();
  const executionMode: NineRouterExecutionMode =
    rawMode === "mock" ? "mock" : rawMode === "live" ? "live" : (apiKey ? "live" : "mock");

  return {
    baseUrl,
    apiKey,
    chatModel,
    embeddingModel,
    embeddingDimensions: 768,
    executionMode,
    explicitMock: rawMode === "mock",
  };
}

let fetchPatched = false;
/**
 * Routes process-wide fetch through the NineRouter rate gate (AI-RATE-01) and
 * forces non-streaming chat, which the job runner depends on. Mastra's
 * provider reads globalThis.fetch at call time, so this also paces agent calls.
 * Idempotent; serve:live and the job runner call it before any model call.
 */
export function patchGlobalFetchForNineRouter(): void {
  if (fetchPatched) return;
  fetchPatched = true;

  getNineRouterRateGate().installGlobalFetch((urlStr, init) => {
    if (urlStr.includes("/chat/completions") && init?.body && typeof init.body === "string") {
      try {
        const parsed = JSON.parse(init.body);
        if (parsed.stream === undefined || parsed.stream === true) {
          parsed.stream = false;
          return { ...init, body: JSON.stringify(parsed) };
        }
      } catch {
        // Leave unparsed if not JSON
      }
    }
    return init;
  });
}

export function extractJsonFromText(text: string): unknown {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const clean = match ? match[1].trim() : trimmed;
  return JSON.parse(clean);
}

export async function generateNineRouterEmbedding(
  text: string,
  options?: { dimensions?: number; config?: NineRouterConfig },
): Promise<readonly number[]> {
  const config = options?.config ?? getNineRouterConfig();
  const dimensions = options?.dimensions ?? config.embeddingDimensions;
  if (config.executionMode === "mock") {
    return generateMockVector(text, dimensions);
  }

  if (!config.baseUrl || !config.apiKey || config.baseUrl.includes("127.0.0.1:9090")) {
    throw new NineRouterConfigError(
      "Live NineRouter provider credentials required: valid NINEROUTER_URL and NINEROUTER_KEY must be configured in live mode",
    );
  }
  const endpoint = `${config.baseUrl}/v1/embeddings`;
  // Gated: paced, and a 429 or rate-like 503 throws RateLimitedError (AI-RATE-01).
  const response = await getNineRouterRateGate().request(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.embeddingModel,
      input: text,
      dimensions,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`NineRouter embedding request failed (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as {
    data: Array<{ embedding: number[] }>;
  };

  const embedding = data?.data?.[0]?.embedding;
  if (!Array.isArray(embedding) || embedding.length !== dimensions) {
    throw new Error(
      `Invalid embedding response structure from NineRouter: expected ${dimensions} dimensions, got ${embedding?.length ?? 0}`,
    );
  }

  for (let i = 0; i < embedding.length; i++) {
    if (!Number.isFinite(embedding[i])) {
      throw new Error(`Invalid non-finite float at index ${i} in NineRouter embedding`);
    }
  }

  return embedding;
}

export function generateMockVector(text: string, dimensions: number = 768): readonly number[] {
  // Deterministic 768-dim float vector normalized to unit length for testing
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  const vector = new Float32Array(dimensions);
  let sumSq = 0;
  for (let i = 0; i < dimensions; i++) {
    hash = Math.imul(hash ^ (i * 31), 16777619);
    const val = ((hash & 0x7fffffff) / 0x7fffffff) * 2 - 1;
    vector[i] = val;
    sumSq += val * val;
  }

  const norm = Math.sqrt(sumSq) || 1;
  const result: number[] = new Array(dimensions);
  for (let i = 0; i < dimensions; i++) {
    result[i] = vector[i] / norm;
  }
  return result;
}

export function createNineRouterMastraAgent(params: {
  id?: string;
  name: string;
  instructions: string;
  modelOverride?: string;
  /** INTEL-02: which deterministic mock model answers in NINEROUTER_MODE=mock. */
  mockRole?: MockChatRole;
}): Agent {
  const config = getNineRouterConfig();
  const agentId = params.id || params.name.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  if (config.explicitMock) {
    if (!params.mockRole) {
      throw new NineRouterConfigError(`NINEROUTER_MODE=mock has no local model for agent ${agentId}`);
    }
    // Mock mode: no gateway request, so no fetch patch is needed here.
    return new Agent({
      id: agentId,
      name: params.name,
      instructions: params.instructions,
      maxRetries: 0,
      model: createMockChatModel(params.mockRole) as unknown as ConstructorParameters<typeof Agent>[0]["model"],
    });
  }
  patchGlobalFetchForNineRouter();
  const chatModel = params.modelOverride || config.chatModel;

  return new Agent({
    id: agentId,
    name: params.name,
    instructions: params.instructions,
    // AI-RATE-01: no in-process retries. A rate limit must reach the job queue
    // so the job is deferred, not hammered again inside Mastra.
    maxRetries: 0,
    model: {
      providerId: "openai",
      modelId: chatModel,
      url: `${config.baseUrl}/v1`,
      apiKey: config.apiKey || "mock-key",
      api: "chat",
    },
  });
}
