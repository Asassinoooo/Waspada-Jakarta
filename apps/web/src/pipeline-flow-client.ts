/**
 * FLOW-VIS-01 read client for the moderator flow view. Same-origin only, with cookies. Responses
 * are checked for the `pipeline-flow-v1` shape before use; anything else is an error, not data.
 */
import type {
  PipelineFlowItemsDto,
  PipelineFlowNodeId,
  PipelineFlowSnapshotDto,
} from "@waspada/worker/pipeline-flow-contracts";

export class PipelineFlowHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`pipeline flow request failed with HTTP ${status}`);
    this.name = "PipelineFlowHttpError";
    this.status = status;
  }
}

const JSON_ACCEPT = { accept: "application/json" } as const;

async function readJson<Body>(response: Response, isBody: (value: unknown) => value is Body): Promise<Body> {
  if (!response.ok) throw new PipelineFlowHttpError(response.status);
  const parsed: unknown = await response.json();
  if (!isBody(parsed)) throw new PipelineFlowHttpError(502);
  return parsed;
}

function isSnapshot(value: unknown): value is PipelineFlowSnapshotDto {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<PipelineFlowSnapshotDto>;
  return candidate.schema_version === "pipeline-flow-v1"
    && typeof candidate.generated_at === "string"
    && (candidate.dataset_mode === "live" || candidate.dataset_mode === "demo")
    && Array.isArray(candidate.nodes)
    && Array.isArray(candidate.edges);
}

function isItems(value: unknown): value is PipelineFlowItemsDto {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<PipelineFlowItemsDto>;
  return candidate.schema_version === "pipeline-flow-v1" && Array.isArray(candidate.items);
}

export async function fetchPipelineFlowSnapshot(signal?: AbortSignal): Promise<PipelineFlowSnapshotDto> {
  const response = await fetch("/api/v1/pipeline/flow", { headers: JSON_ACCEPT, credentials: "same-origin", cache: "no-store", signal });
  return readJson(response, isSnapshot);
}

export async function fetchPipelineFlowItems(nodeId: PipelineFlowNodeId, limit = 20, signal?: AbortSignal): Promise<PipelineFlowItemsDto> {
  const response = await fetch(`/api/v1/pipeline/flow/nodes/${encodeURIComponent(nodeId)}/items?limit=${limit}`, {
    headers: JSON_ACCEPT,
    credentials: "same-origin",
    cache: "no-store",
    signal,
  });
  return readJson(response, isItems);
}
