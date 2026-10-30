import { Agent } from "@mastra/core/agent";

export interface NineRouterConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly chatModel: string;
  readonly embeddingModel: string;
  readonly embeddingDimensions: number;
}

export function getNineRouterConfig(): NineRouterConfig {
  const rawUrl = process.env.NINEROUTER_URL?.trim() || "http://127.0.0.1:9090";
  const baseUrl = rawUrl.replace(/\/+$/, "");
  const apiKey = process.env.NINEROUTER_KEY?.trim() || "";
  const chatModel = process.env.NINEROUTER_CHAT_MODEL?.trim() || "ag/gemini-3.8-flash";
  const embeddingModel = process.env.NINEROUTER_EMBEDDING_MODEL?.trim() || "gemini/gemini-embedding-2-preview";

  return {
    baseUrl,
    apiKey,
    chatModel,
    embeddingModel,
    embeddingDimensions: 768,
  };
}

let fetchPatched = false;
export function patchGlobalFetchForNineRouter(): void {
  if (fetchPatched) return;
  fetchPatched = true;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function (input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (urlStr.includes("/chat/completions") && init?.body && typeof init.body === "string") {
      try {
        const parsed = JSON.parse(init.body);
        if (parsed.stream === undefined || parsed.stream === true) {
          parsed.stream = false;
          init = { ...init, body: JSON.stringify(parsed) };
        }
      } catch {
        // Leave unparsed if not JSON
      }
    }

    return originalFetch(input, init);
  };
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

  // Offline / deterministic fallback for test suites without NineRouter credentials
  if (!config.baseUrl || !config.apiKey || config.baseUrl.includes("127.0.0.1:9090")) {
    return generateMockVector(text, dimensions);
  }

  const endpoint = `${config.baseUrl}/v1/embeddings`;
  const response = await fetch(endpoint, {
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

  if (!data?.data?.[0]?.embedding) {
    throw new Error("Invalid embedding response structure from NineRouter");
  }

  return data.data[0].embedding;
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
}): Agent {
  patchGlobalFetchForNineRouter();
  const config = getNineRouterConfig();
  const chatModel = params.modelOverride || config.chatModel;
  const agentId = params.id || params.name.toLowerCase().replace(/[^a-z0-9_-]/g, "-");

  return new Agent({
    id: agentId,
    name: params.name,
    instructions: params.instructions,
    model: {
      providerId: "openai",
      modelId: chatModel,
      url: `${config.baseUrl}/v1`,
      apiKey: config.apiKey || "mock-key",
      api: "chat",
    },
  });
}
