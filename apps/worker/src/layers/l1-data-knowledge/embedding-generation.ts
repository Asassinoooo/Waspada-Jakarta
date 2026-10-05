import type {
  EmbeddingRequest,
  EmbeddingResult,
  ModelCapabilityAdapter,
} from "../l2-model-grounding/contracts.js";
import type { EmbeddingRunRecord, EmbeddingRunRepository } from "../../../../db/src/embedding-runs.js";
import type { DatasetKind } from "../../../../db/src/ports.js";
import type { EvidenceChunkInput as L1EvidenceChunkInput } from "./evidence-chunking.js";

export interface EmbeddingGenerationRequest {
  readonly datasetKind: DatasetKind;
  /** Stable caller-supplied trace and retry identities. */
  readonly traceId: string;
  readonly embeddingRunId: string;
  /** The caller must reuse this exact instant on a retry. */
  readonly createdAt: string;
  readonly chunk: L1EvidenceChunkInput;
}

export type EmbeddingGenerationOutcome =
  | { readonly status: "created" | "replayed" }
  | {
      readonly status: "not_configured";
      readonly reason: "provider_not_configured" | "capability_not_configured";
    }
  | { readonly status: "invalid_request" }
  | { readonly status: "provider_error" }
  | { readonly status: "invalid_output" }
  | { readonly status: "unavailable" }
  | { readonly status: "conflict" }
  | {
      readonly status: "persistence_error";
      readonly reason: "integrity_error" | "persistence_failed" | "unexpected_failure";
    };

export interface EmbeddingGenerationRunnerDependencies {
  readonly modelAdapter: Pick<ModelCapabilityAdapter, "embed">;
  readonly embeddingRuns: EmbeddingRunRepository;
}

/**
 * Compose one validated L2 embedding call with the existing atomic L1 writer.
 * Provider work finishes before the repository can begin a transaction.
 */
export function createEmbeddingGenerationRunner(
  dependencies: EmbeddingGenerationRunnerDependencies,
): (request: EmbeddingGenerationRequest) => Promise<EmbeddingGenerationOutcome> {
  return async (requestInput) => {
    const request = snapshotRequest(requestInput);
    if (!request) return { status: "invalid_request" };

    let outcome;
    try {
      // The explicit projection drops L1-only chunker metadata from the L2 contract.
      const embeddingRequest: EmbeddingRequest = { data: { chunk: request.chunk } };
      outcome = await dependencies.modelAdapter.embed(embeddingRequest);
    } catch {
      return { status: "provider_error" };
    }

    if (!outcome || outcome.capability !== "embedding") return { status: "provider_error" };
    if (outcome.status === "not_configured") {
      return {
        status: "not_configured",
        reason: outcome.reason === "capability_not_configured"
          ? "capability_not_configured"
          : "provider_not_configured",
      };
    }
    if (outcome.status === "invalid_request") return { status: "invalid_request" };
    if (outcome.status === "provider_error") return { status: "provider_error" };
    if (outcome.status === "invalid_output") return { status: "invalid_output" };
    if (outcome.status !== "succeeded" || !matchesRequestedChunk(outcome.value, request.chunk)) {
      return { status: "invalid_output" };
    }

    const record: EmbeddingRunRecord = {
      schema_version: "2.0",
      trace_id: request.traceId,
      record_type: "EmbeddingRun",
      dataset_kind: request.datasetKind,
      embedding_run_id: request.embeddingRunId,
      chunk_id: request.chunk.chunkId,
      capability: "embedding",
      provider: outcome.value.provider,
      model_version: outcome.value.modelVersion,
      dimensions: outcome.value.dimensions,
      distance_metric: outcome.value.distanceMetric,
      vector_index_version: outcome.value.vectorIndexVersion,
      input_text_hash: request.chunk.chunkTextHash,
      status: "available",
      created_at: request.createdAt,
    };

    try {
      const persisted = await dependencies.embeddingRuns.createOrVerify(record, outcome.value.vector);
      if (persisted === "created" || persisted === "replayed") return { status: persisted };
      if (persisted === "unavailable") return { status: "unavailable" };
      return { status: "persistence_error", reason: "unexpected_failure" };
    } catch (error) {
      return mapRepositoryFailure(error);
    }
  };
}

interface SnapshotRequest {
  readonly datasetKind: DatasetKind;
  readonly traceId: string;
  readonly embeddingRunId: string;
  readonly createdAt: string;
  readonly chunk: EmbeddingRequest["data"]["chunk"];
}

const REQUEST_FIELDS = ["datasetKind", "traceId", "embeddingRunId", "createdAt", "chunk"] as const;
const L1_CHUNK_FIELDS = [
  "chunkId", "reportRevisionId", "permittedTextHash", "normalizationVersion",
  "spanStart", "spanEnd", "offsetUnit", "chunkTextHash", "text", "chunkerVersion",
] as const;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const CREATED_AT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/;

function snapshotRequest(value: unknown): SnapshotRequest | null {
  try {
    const request = closedDataRecord(value, REQUEST_FIELDS);
    if (!request || !isDatasetKind(request.datasetKind)
      || !isId(request.traceId) || !isId(request.embeddingRunId)
      || typeof request.createdAt !== "string" || !isValidCreatedAt(request.createdAt)) {
      return null;
    }

    const chunk = closedDataRecord(request.chunk, L1_CHUNK_FIELDS);
    if (!chunk || !isId(chunk.chunkId) || !isId(chunk.reportRevisionId)
      || !isId(chunk.normalizationVersion) || !isId(chunk.chunkerVersion)
      || !isHash(chunk.permittedTextHash) || !isHash(chunk.chunkTextHash)
      || typeof chunk.spanStart !== "number" || !Number.isInteger(chunk.spanStart)
      || typeof chunk.spanEnd !== "number" || !Number.isInteger(chunk.spanEnd)
      || chunk.spanStart < 0 || chunk.spanEnd <= chunk.spanStart
      || chunk.offsetUnit !== "unicode_code_points" || typeof chunk.text !== "string") {
      return null;
    }

    // Snapshot only the fields admitted by the L2 embedding request contract.
    return {
      datasetKind: request.datasetKind,
      traceId: request.traceId,
      embeddingRunId: request.embeddingRunId,
      createdAt: request.createdAt,
      chunk: {
        chunkId: chunk.chunkId,
        reportRevisionId: chunk.reportRevisionId,
        permittedTextHash: chunk.permittedTextHash,
        normalizationVersion: chunk.normalizationVersion,
        spanStart: chunk.spanStart,
        spanEnd: chunk.spanEnd,
        offsetUnit: "unicode_code_points",
        chunkTextHash: chunk.chunkTextHash,
        text: chunk.text,
      },
    };
  } catch {
    return null;
  }
}

function closedDataRecord(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length
    || keys.some((key) => typeof key !== "string" || !fields.includes(key))) return null;

  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !("value" in descriptor)) return null;
    snapshot[field] = descriptor.value;
  }
  return snapshot;
}

function matchesRequestedChunk(value: EmbeddingResult, chunk: EmbeddingRequest["data"]["chunk"]): boolean {
  return value.capability === "embedding"
    && value.chunkId === chunk.chunkId
    && value.reportRevisionId === chunk.reportRevisionId
    && value.permittedTextHash === chunk.permittedTextHash
    && value.spanStart === chunk.spanStart
    && value.spanEnd === chunk.spanEnd
    && value.offsetUnit === chunk.offsetUnit
    && value.inputTextHash === chunk.chunkTextHash
    && Number.isInteger(value.dimensions)
    && value.dimensions > 0
    && value.dimensions <= 2_048
    && Array.isArray(value.vector)
    && value.vector.length === value.dimensions
    && value.vector.every((component) => typeof component === "number" && Number.isFinite(component));
}

function mapRepositoryFailure(error: unknown): EmbeddingGenerationOutcome {
  const code = fixedRepositoryCode(error);
  switch (code) {
    case "invalid_embedding_run":
      return { status: "invalid_request" };
    case "embedding_run_reference_not_found":
    case "embedding_run_lineage_mismatch":
    case "embedding_run_unavailable":
      return { status: "unavailable" };
    case "embedding_run_conflict":
      return { status: "conflict" };
    case "embedding_run_integrity_error":
      return { status: "persistence_error", reason: "integrity_error" };
    case "embedding_run_persistence_failed":
      return { status: "persistence_error", reason: "persistence_failed" };
    default:
      return { status: "persistence_error", reason: "unexpected_failure" };
  }
}

function fixedRepositoryCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") return null;
    switch (descriptor.value) {
      case "invalid_embedding_run":
      case "embedding_run_reference_not_found":
      case "embedding_run_lineage_mismatch":
      case "embedding_run_conflict":
      case "embedding_run_unavailable":
      case "embedding_run_integrity_error":
      case "embedding_run_persistence_failed":
        return descriptor.value;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function isValidCreatedAt(value: string): boolean {
  const parts = CREATED_AT_PATTERN.exec(value);
  if (!parts) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText,
    fractionText = "", zone, offsetSign, offsetHourText, offsetMinuteText] = parts;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const daysInMonth = month === 2
    ? isLeapYear(year) ? 29 : 28
    : [4, 6, 9, 11].includes(month) ? 30 : 31;
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth
    || hour > 23 || minute > 59 || second > 59) return false;

  let offsetMinutes = 0;
  if (zone !== "Z") {
    const offsetHour = Number(offsetHourText);
    const offsetMinute = Number(offsetMinuteText);
    if (offsetHour > 23 || offsetMinute > 59) return false;
    offsetMinutes = (offsetSign === "+" ? 1 : -1) * (offsetHour * 60 + offsetMinute);
  }

  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, 0);
  const utcMilliseconds = local.getTime() - offsetMinutes * 60_000;
  const utcYear = new Date(utcMilliseconds).getUTCFullYear();
  // Fractional digits are constrained to the repository's microsecond precision.
  void fractionText;
  return Number.isFinite(utcMilliseconds) && utcYear >= 1 && utcYear <= 9_999;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isDatasetKind(value: unknown): value is DatasetKind {
  return value === "live" || value === "historical" || value === "synthetic";
}

function isId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH_PATTERN.test(value);
}
