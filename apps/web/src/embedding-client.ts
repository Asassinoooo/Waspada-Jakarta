/**
 * Client for fetching embedding chunk vectors and metadata from the Worker API.
 */

export interface EmbeddingChunkItem {
  readonly embeddingRunId: string;
  readonly chunkId: string;
  readonly reportRevisionId: string;
  readonly sourceId: string;
  readonly canonicalUrl: string | null;
  readonly title: string;
  readonly chunkText: string;
  readonly createdAt: string;
  readonly vector: readonly number[];
}

export interface EmbeddingVisualizationPayload {
  readonly total: number;
  readonly dimensions: number;
  readonly datasetKind: string;
  readonly items: readonly EmbeddingChunkItem[];
}

export class EmbeddingClientError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "EmbeddingClientError";
  }
}

export async function fetchEmbeddingVisualizationData(options: {
  limit?: number;
  datasetKind?: string;
  signal?: AbortSignal;
} = {}): Promise<EmbeddingVisualizationPayload> {
  const params = new URLSearchParams();
  if (options.limit !== undefined) {
    params.set("limit", String(options.limit));
  }
  if (options.datasetKind !== undefined) {
    params.set("dataset_kind", options.datasetKind);
  }

  const query = params.toString();
  const url = "/api/v1/embeddings/visualization" + (query.length > 0 ? "?" + query : "");

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
      signal: options.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw err;
    }
    throw new EmbeddingClientError(
      "Gagal terhubung ke layanan embedding: " + (err instanceof Error ? err.message : String(err)),
    );
  }

  if (!response.ok) {
    throw new EmbeddingClientError(
      `Permintaan embedding gagal dengan status ${response.status}`,
      response.status,
    );
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new EmbeddingClientError("Format balasan embedding tidak valid (bukan JSON)");
  }

  if (!data || typeof data !== "object") {
    throw new EmbeddingClientError("Format balasan embedding tidak sesuai kontrak");
  }

  const raw = data as Record<string, unknown>;
  const total = typeof raw.total === "number" ? raw.total : 0;
  const dimensions = typeof raw.dimensions === "number" ? raw.dimensions : 768;
  const datasetKind = typeof raw.datasetKind === "string" ? raw.datasetKind : "synthetic";

  const rawItems = Array.isArray(raw.items) ? raw.items : [];
  const items: EmbeddingChunkItem[] = [];

  for (const it of rawItems) {
    if (!it || typeof it !== "object") continue;
    const itemObj = it as Record<string, unknown>;
    const vectorRaw = Array.isArray(itemObj.vector) ? itemObj.vector : [];
    const vector: number[] = new Array(vectorRaw.length);
    for (let i = 0; i < vectorRaw.length; i++) {
      const v = typeof vectorRaw[i] === "number" ? vectorRaw[i] : Number.parseFloat(String(vectorRaw[i]));
      vector[i] = Number.isFinite(v) ? v : 0;
    }

    items.push({
      embeddingRunId: String(itemObj.embeddingRunId || ""),
      chunkId: String(itemObj.chunkId || ""),
      reportRevisionId: String(itemObj.reportRevisionId || ""),
      sourceId: String(itemObj.sourceId || "unknown"),
      canonicalUrl: typeof itemObj.canonicalUrl === "string" ? itemObj.canonicalUrl : null,
      title: String(itemObj.title || "Tanpa Judul"),
      chunkText: String(itemObj.chunkText || ""),
      createdAt: typeof itemObj.createdAt === "string" ? itemObj.createdAt : new Date().toISOString(),
      vector,
    });
  }

  return {
    total: items.length || total,
    dimensions,
    datasetKind,
    items,
  };
}
