import {
  CATEGORIES,
  type CandidateEventVersion,
  type CapabilityInvocation,
  type ClassificationRequest,
  type ClassificationResult,
  type DatasetKind,
  type DistanceMetric,
  type EmbeddingIdentity,
  type EmbeddingRequest,
  type EmbeddingResult,
  type EvidenceReference,
  type ExtractionRequest,
  type ExtractionResult,
  type GroundingContext,
  type ModelIdentity,
  type ModelRun,
  type ProposedClaim,
  type ReasoningRequest,
  type ReasoningResult,
  type ReportRevisionText,
  type RevisionState,
  type RevisionStatus,
  type Scope,
  type SupportAssessment,
  type Tag,
  type TimeScope,
  type TokenUsage,
  type ValidityPeriod,
} from "./contracts.js";

export const MAX_REPORT_CODE_POINTS = 200_000;
export const MAX_CHUNK_CODE_POINTS = 40_000;
export const MAX_EMBEDDING_DIMENSIONS = 8_192;
export const MAX_MODEL_TOKENS_PER_CALL = 12_000;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const REVISION_STATUSES = ["unreviewed", "eligible", "quarantined", "superseded", "retracted"] as const;
const RELATIONS = ["supports", "contradicts", "updates", "context"] as const;
const DISTANCE_METRICS = ["cosine", "dot_product", "euclidean"] as const;
const DATASET_KINDS = ["live", "historical", "synthetic"] as const;
const TAG_NAMESPACES = ["topic", "service", "audience", "hazard", "transport_mode", "place_type"] as const;

export class ContractValidationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "ContractValidationError";
    this.code = code;
  }
}

function reject(code: string): never {
  throw new ContractValidationError(code);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactRecord(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (!isPlainRecord(value)) reject(`${path}:expected_object`);
  const actualKeys = Reflect.ownKeys(value);
  if (actualKeys.some((key) => typeof key !== "string")) reject(`${path}:unexpected_key`);
  const expected = new Set(keys);
  const actual = new Set(actualKeys as string[]);
  for (const key of keys) if (!actual.has(key)) reject(`${path}:missing_${key}`);
  for (const key of actual) if (!expected.has(key)) reject(`${path}:unexpected_${key}`);
  return value;
}

function boundedArray(value: unknown, maximum: number, path: string, minimum = 0): readonly unknown[] {
  if (!Array.isArray(value)) reject(`${path}:expected_array`);
  if (value.length < minimum || value.length > maximum) reject(`${path}:invalid_length`);
  return value;
}

function boundedString(value: unknown, path: string, maximum: number, minimum = 1): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    reject(`${path}:invalid_string`);
  }
  return value;
}

function id(value: unknown, path: string): string {
  const parsed = boundedString(value, path, 128);
  if (!ID_PATTERN.test(parsed)) reject(`${path}:invalid_id`);
  return parsed;
}

function hash(value: unknown, path: string): string {
  const parsed = boundedString(value, path, 64);
  if (!HASH_PATTERN.test(parsed)) reject(`${path}:invalid_sha256`);
  return parsed;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], path: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) reject(`${path}:invalid_value`);
  return value as T;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") reject(`${path}:expected_boolean`);
  return value;
}

function integer(value: unknown, path: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    reject(`${path}:invalid_integer`);
  }
  return value;
}

function uniqueStrings(value: unknown, path: string, maximumItems: number, maxLength: number): readonly string[] {
  const entries = boundedArray(value, maximumItems, path);
  const seen = new Set<string>();
  return entries.map((entry, index) => {
    const parsed = boundedString(entry, `${path}[${index}]`, maxLength);
    if (seen.has(parsed)) reject(`${path}:duplicate_value`);
    seen.add(parsed);
    return parsed;
  });
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function validDateOnly(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validDateTime(value: string): boolean {
  const match = DATETIME_PATTERN.exec(value);
  if (!match || !validDateOnly(`${match[1]}-${match[2]}-${match[3]}`)) return false;
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const zone = match[7];
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (zone !== "Z") {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }
  return Number.isFinite(Date.parse(value));
}

function nullableDateTime(value: unknown, path: string): string | null {
  if (value === null) return null;
  const parsed = boundedString(value, path, 40);
  if (!validDateTime(parsed)) reject(`${path}:invalid_datetime`);
  return parsed;
}

function dateOrDateTime(value: unknown, path: string): string {
  const parsed = boundedString(value, path, 40);
  if (!validDateOnly(parsed) && !validDateTime(parsed)) reject(`${path}:invalid_date_or_datetime`);
  return parsed;
}

function instant(value: string): number {
  return DATE_PATTERN.test(value) ? Date.parse(`${value}T00:00:00Z`) : Date.parse(value);
}

function parseTimeScope(value: unknown, path: string): TimeScope {
  const record = exactRecord(value, ["start", "end", "precision"], path);
  const precision = enumValue(record.precision, ["exact", "date", "range", "unknown"] as const, `${path}.precision`);
  if (precision === "unknown") {
    if (record.start !== null || record.end !== null) reject(`${path}:unknown_time_must_be_null`);
    return { start: null, end: null, precision };
  }
  if (precision === "exact") {
    const start = nullableDateTime(record.start, `${path}.start`);
    const end = nullableDateTime(record.end, `${path}.end`);
    if (start === null) reject(`${path}:exact_start_required`);
    if (end !== null && instant(end) < instant(start)) reject(`${path}:reversed_interval`);
    return { start, end, precision };
  }
  if (precision === "date") {
    const start = boundedString(record.start, `${path}.start`, 10);
    if (!validDateOnly(start)) reject(`${path}.start:invalid_date`);
    const end = record.end === null ? null : boundedString(record.end, `${path}.end`, 10);
    if (end !== null && (!validDateOnly(end) || instant(end) < instant(start))) reject(`${path}.end:invalid_date_or_interval`);
    return { start, end, precision };
  }
  const start = dateOrDateTime(record.start, `${path}.start`);
  const end = dateOrDateTime(record.end, `${path}.end`);
  if (instant(end) < instant(start)) reject(`${path}:reversed_interval`);
  return { start, end, precision };
}

function parseValidity(value: unknown, path: string): ValidityPeriod {
  const record = exactRecord(value, ["validFrom", "validUntil"], path);
  const validFrom = nullableDateTime(record.validFrom, `${path}.validFrom`);
  const validUntil = nullableDateTime(record.validUntil, `${path}.validUntil`);
  if (validFrom !== null && validUntil !== null && instant(validFrom) >= instant(validUntil)) {
    reject(`${path}:invalid_validity_interval`);
  }
  return { validFrom, validUntil };
}

function parseScope(value: unknown, path: string): Scope {
  const record = exactRecord(value, ["placeIds", "serviceIds", "institutionIds", "audienceIds", "geometryIds"], path);
  return {
    placeIds: uniqueStrings(record.placeIds, `${path}.placeIds`, 256, 128).map((entry, index) => id(entry, `${path}.placeIds[${index}]`)),
    serviceIds: uniqueStrings(record.serviceIds, `${path}.serviceIds`, 256, 128).map((entry, index) => id(entry, `${path}.serviceIds[${index}]`)),
    institutionIds: uniqueStrings(record.institutionIds, `${path}.institutionIds`, 256, 128).map((entry, index) => id(entry, `${path}.institutionIds[${index}]`)),
    audienceIds: uniqueStrings(record.audienceIds, `${path}.audienceIds`, 256, 128).map((entry, index) => id(entry, `${path}.audienceIds[${index}]`)),
    geometryIds: uniqueStrings(record.geometryIds, `${path}.geometryIds`, 256, 128).map((entry, index) => id(entry, `${path}.geometryIds[${index}]`)),
  };
}

function parseTag(value: unknown, path: string): Tag {
  const record = exactRecord(value, ["namespace", "value"], path);
  const namespace = enumValue(record.namespace, TAG_NAMESPACES, `${path}.namespace`);
  const tagValue = boundedString(record.value, `${path}.value`, 64);
  if (!/^[a-z][a-z0-9_]*$/.test(tagValue)) reject(`${path}.value:invalid_tag`);
  return { namespace, value: tagValue };
}

function parseTags(value: unknown, path: string): readonly Tag[] {
  const tags = boundedArray(value, 100, path).map((entry, index) => parseTag(entry, `${path}[${index}]`));
  const keys = new Set<string>();
  for (const tag of tags) {
    const key = `${tag.namespace}:${tag.value}`;
    if (keys.has(key)) reject(`${path}:duplicate_tag`);
    keys.add(key);
  }
  return tags;
}

export function parseEvidenceReference(value: unknown, path = "evidence"): EvidenceReference {
  const record = exactRecord(value, ["reportRevisionId", "permittedTextHash", "spanStart", "spanEnd", "offsetUnit", "relation"], path);
  const reportRevisionId = id(record.reportRevisionId, `${path}.reportRevisionId`);
  const permittedTextHash = hash(record.permittedTextHash, `${path}.permittedTextHash`);
  const spanStart = integer(record.spanStart, `${path}.spanStart`, 0, 10_000_000);
  const spanEnd = integer(record.spanEnd, `${path}.spanEnd`, 1, 10_000_000);
  if (spanEnd <= spanStart) reject(`${path}:empty_or_reversed_span`);
  if (record.offsetUnit !== "unicode_code_points") reject(`${path}.offsetUnit:invalid_offset_unit`);
  const relation = enumValue(record.relation, RELATIONS, `${path}.relation`);
  return { reportRevisionId, permittedTextHash, spanStart, spanEnd, offsetUnit: "unicode_code_points", relation };
}

function evidenceArray(value: unknown, path: string, maximum = 128): readonly EvidenceReference[] {
  return boundedArray(value, maximum, path).map((entry, index) => parseEvidenceReference(entry, `${path}[${index}]`));
}

async function awaitSha256(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) reject("crypto_unavailable");
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function validatedReport(value: unknown, path = "request.data.report"): Promise<ReportRevisionText> {
  const record = exactRecord(value, ["reportRevisionId", "permittedTextHash", "normalizationVersion", "permittedText"], path);
  const reportRevisionId = id(record.reportRevisionId, `${path}.reportRevisionId`);
  const permittedTextHash = hash(record.permittedTextHash, `${path}.permittedTextHash`);
  const normalizationVersion = id(record.normalizationVersion, `${path}.normalizationVersion`);
  const permittedText = boundedString(record.permittedText, `${path}.permittedText`, MAX_REPORT_CODE_POINTS * 2);
  if (codePointLength(permittedText) > MAX_REPORT_CODE_POINTS) reject(`${path}.permittedText:too_large`);
  if (await awaitSha256(permittedText) !== permittedTextHash) reject(`${path}.permittedTextHash:hash_mismatch`);
  return { reportRevisionId, permittedTextHash, normalizationVersion, permittedText };
}

export async function validateClassificationRequest(value: unknown): Promise<ClassificationRequest> {
  const request = exactRecord(value, ["data"], "request");
  const data = exactRecord(request.data, ["report"], "request.data");
  const report = await validatedReport(data.report);
  return { data: { report } };
}

export async function validateExtractionRequest(value: unknown): Promise<ExtractionRequest> {
  const request = exactRecord(value, ["data"], "request");
  const data = exactRecord(request.data, ["candidateId", "report"], "request.data");
  const candidateId = id(data.candidateId, "request.data.candidateId");
  const report = await validatedReport(data.report);
  return { data: { candidateId, report } };
}

function validateEvidenceAgainstReport(reference: EvidenceReference, report: ReportRevisionText): EvidenceReference {
  if (reference.reportRevisionId !== report.reportRevisionId || reference.permittedTextHash !== report.permittedTextHash) {
    reject("evidence:report_revision_or_hash_mismatch");
  }
  if (reference.spanEnd > codePointLength(report.permittedText)) reject("evidence:span_out_of_bounds");
  return reference;
}

function validateProviderEnvelope(value: unknown, path: string): { output: unknown; usage: TokenUsage } {
  const record = exactRecord(value, ["output", "usage"], path);
  const usageRecord = exactRecord(record.usage, ["inputTokens", "outputTokens"], `${path}.usage`);
  const inputTokens = integer(usageRecord.inputTokens, `${path}.usage.inputTokens`, 0, MAX_MODEL_TOKENS_PER_CALL);
  const outputTokens = integer(usageRecord.outputTokens, `${path}.usage.outputTokens`, 0, MAX_MODEL_TOKENS_PER_CALL);
  if (inputTokens + outputTokens > MAX_MODEL_TOKENS_PER_CALL) reject(`${path}.usage:token_budget_exceeded`);
  return { output: record.output, usage: { inputTokens, outputTokens } };
}

function validateModelIdentity(value: ModelIdentity, path: string): ModelIdentity {
  const record = exactRecord(value, ["provider", "modelVersion", "promptVersion"], path);
  return {
    provider: boundedString(record.provider, `${path}.provider`, 120),
    modelVersion: boundedString(record.modelVersion, `${path}.modelVersion`, 200),
    promptVersion: boundedString(record.promptVersion, `${path}.promptVersion`, 128),
  };
}

function parseUnknownFields(value: unknown, path: string): readonly string[] {
  return uniqueStrings(value, path, 100, 500);
}

function parseCategory(value: unknown, path: string) {
  return value === null ? null : enumValue(value, CATEGORIES, path);
}

export async function parseClassificationOutput(
  raw: unknown,
  request: ClassificationRequest,
  identity: ModelIdentity,
): Promise<ClassificationResult> {
  const envelope = validateProviderEnvelope(raw, "provider.classification");
  const output = exactRecord(envelope.output, ["category", "evidence", "unknownFields"], "provider.classification.output");
  const category = parseCategory(output.category, "provider.classification.output.category");
  const evidence = evidenceArray(output.evidence, "provider.classification.output.evidence", 64)
    .map((reference) => validateEvidenceAgainstReport(reference, request.data.report));
  const unknownFields = parseUnknownFields(output.unknownFields, "provider.classification.output.unknownFields");
  if (category === null && !unknownFields.includes("category")) reject("provider.classification:missing_category_unknown");
  if (category !== null && !evidence.some((reference) => reference.relation === "supports")) {
    reject("provider.classification:category_without_support");
  }
  const model = validateModelIdentity(identity, "configuration.classification");
  const invocation: CapabilityInvocation<"classification"> = {
    capability: "classification",
    ...model,
    ...envelope.usage,
  };
  return {
    reportRevisionId: request.data.report.reportRevisionId,
    permittedTextHash: request.data.report.permittedTextHash,
    category,
    evidence,
    unknownFields,
    invocation,
  };
}

function parseScopeWithPath(value: unknown, path: string): Scope {
  return parseScope(value, path);
}

export async function parseExtractionOutput(
  raw: unknown,
  request: ExtractionRequest,
  identity: ModelIdentity,
): Promise<ExtractionResult> {
  const envelope = validateProviderEnvelope(raw, "provider.extraction");
  const output = exactRecord(
    envelope.output,
    ["category", "tags", "eventTime", "scope", "evidence", "unknownFields"],
    "provider.extraction.output",
  );
  const category = parseCategory(output.category, "provider.extraction.output.category");
  const tags = parseTags(output.tags, "provider.extraction.output.tags");
  const eventTime = parseTimeScope(output.eventTime, "provider.extraction.output.eventTime");
  const scope = parseScopeWithPath(output.scope, "provider.extraction.output.scope");
  const evidence = evidenceArray(output.evidence, "provider.extraction.output.evidence", 64)
    .map((reference) => validateEvidenceAgainstReport(reference, request.data.report));
  const unknownFields = parseUnknownFields(output.unknownFields, "provider.extraction.output.unknownFields");
  if (category === null && !unknownFields.includes("category")) reject("provider.extraction:missing_category_unknown");
  if (eventTime.precision === "unknown" && !unknownFields.includes("event_time")) reject("provider.extraction:missing_event_time_unknown");
  const scopeHasValue = Object.values(scope).some((values) => values.length > 0);
  const hasProposedField = category !== null || tags.length > 0 || eventTime.precision !== "unknown" || scopeHasValue;
  if (hasProposedField && !evidence.some((reference) => reference.relation === "supports")) {
    reject("provider.extraction:fields_without_support");
  }
  const model = validateModelIdentity(identity, "configuration.extraction");
  const modelRun: ModelRun<"extraction"> = {
    capability: "extraction",
    modelVersion: model.modelVersion,
    promptVersion: model.promptVersion,
    ...envelope.usage,
  };
  return {
    candidateId: request.data.candidateId,
    reportRevisionId: request.data.report.reportRevisionId,
    permittedTextHash: request.data.report.permittedTextHash,
    category,
    tags,
    eventTime,
    scope,
    evidence,
    unknownFields,
    modelRun,
    provider: model.provider,
  };
}

function validChunkInput(value: unknown): EvidenceChunkInputValue {
  const record = exactRecord(
    value,
    ["chunkId", "reportRevisionId", "permittedTextHash", "normalizationVersion", "spanStart", "spanEnd", "offsetUnit", "chunkTextHash", "text"],
    "request.data.chunk",
  );
  const chunkId = id(record.chunkId, "request.data.chunk.chunkId");
  const reportRevisionId = id(record.reportRevisionId, "request.data.chunk.reportRevisionId");
  const permittedTextHash = hash(record.permittedTextHash, "request.data.chunk.permittedTextHash");
  const normalizationVersion = id(record.normalizationVersion, "request.data.chunk.normalizationVersion");
  const spanStart = integer(record.spanStart, "request.data.chunk.spanStart", 0, 10_000_000);
  const spanEnd = integer(record.spanEnd, "request.data.chunk.spanEnd", 1, 10_000_000);
  if (spanEnd <= spanStart) reject("request.data.chunk:empty_or_reversed_span");
  if (record.offsetUnit !== "unicode_code_points") reject("request.data.chunk.offsetUnit:invalid_offset_unit");
  const chunkTextHash = hash(record.chunkTextHash, "request.data.chunk.chunkTextHash");
  const text = boundedString(record.text, "request.data.chunk.text", MAX_CHUNK_CODE_POINTS * 2);
  const textLength = codePointLength(text);
  if (textLength > MAX_CHUNK_CODE_POINTS) reject("request.data.chunk.text:too_large");
  if (spanEnd - spanStart !== textLength) reject("request.data.chunk:span_length_mismatch");
  return {
    chunkId,
    reportRevisionId,
    permittedTextHash,
    normalizationVersion,
    spanStart,
    spanEnd,
    offsetUnit: "unicode_code_points",
    chunkTextHash,
    text,
  };
}

interface EvidenceChunkInputValue {
  readonly chunkId: string;
  readonly reportRevisionId: string;
  readonly permittedTextHash: string;
  readonly normalizationVersion: string;
  readonly spanStart: number;
  readonly spanEnd: number;
  readonly offsetUnit: "unicode_code_points";
  readonly chunkTextHash: string;
  readonly text: string;
}

export async function validateEmbeddingRequest(value: unknown): Promise<EmbeddingRequest> {
  const request = exactRecord(value, ["data"], "request");
  const data = exactRecord(request.data, ["chunk"], "request.data");
  const chunk = validChunkInput(data.chunk);
  if (await awaitSha256(chunk.text) !== chunk.chunkTextHash) reject("request.data.chunk.chunkTextHash:hash_mismatch");
  return { data: { chunk } };
}

function parseEmbeddingIdentity(value: EmbeddingIdentity): EmbeddingIdentity {
  const record = exactRecord(value, ["provider", "modelVersion", "dimensions", "distanceMetric", "vectorIndexVersion"], "configuration.embedding");
  const dimensions = integer(record.dimensions, "configuration.embedding.dimensions", 1, MAX_EMBEDDING_DIMENSIONS);
  return {
    provider: boundedString(record.provider, "configuration.embedding.provider", 120),
    modelVersion: boundedString(record.modelVersion, "configuration.embedding.modelVersion", 200),
    dimensions,
    distanceMetric: enumValue(record.distanceMetric, DISTANCE_METRICS, "configuration.embedding.distanceMetric") as DistanceMetric,
    vectorIndexVersion: id(record.vectorIndexVersion, "configuration.embedding.vectorIndexVersion"),
  };
}

export async function parseEmbeddingOutput(
  raw: unknown,
  request: EmbeddingRequest,
  identity: EmbeddingIdentity,
): Promise<EmbeddingResult> {
  const output = exactRecord(raw, ["vector"], "provider.embedding");
  const model = parseEmbeddingIdentity(identity);
  const values = boundedArray(output.vector, MAX_EMBEDDING_DIMENSIONS, "provider.embedding.vector", 1);
  if (values.length !== model.dimensions) reject("provider.embedding.vector:dimension_mismatch");
  const vector = values.map((value, index) => {
    if (typeof value !== "number" || !Number.isFinite(value)) reject(`provider.embedding.vector[${index}]:non_finite`);
    return value;
  });
  const chunk = request.data.chunk;
  return {
    capability: "embedding",
    chunkId: chunk.chunkId,
    reportRevisionId: chunk.reportRevisionId,
    permittedTextHash: chunk.permittedTextHash,
    spanStart: chunk.spanStart,
    spanEnd: chunk.spanEnd,
    offsetUnit: "unicode_code_points",
    provider: model.provider,
    modelVersion: model.modelVersion,
    dimensions: model.dimensions,
    distanceMetric: model.distanceMetric,
    vectorIndexVersion: model.vectorIndexVersion,
    inputTextHash: chunk.chunkTextHash,
    vector,
  };
}

function parseRevisionStatus(value: unknown, path: string): RevisionStatus {
  return enumValue(value, REVISION_STATUSES, path);
}

function parseRevisionState(value: unknown, path: string): RevisionState {
  const record = exactRecord(value, ["reportRevisionId", "revisionStatus"], path);
  return {
    reportRevisionId: id(record.reportRevisionId, `${path}.reportRevisionId`),
    revisionStatus: parseRevisionStatus(record.revisionStatus, `${path}.revisionStatus`),
  };
}

function parseCandidateEvent(value: unknown, path: string): CandidateEventVersion {
  const record = exactRecord(value, ["eventId", "eventVersion"], path);
  return {
    eventId: id(record.eventId, `${path}.eventId`),
    eventVersion: integer(record.eventVersion, `${path}.eventVersion`, 1, 2_147_483_647),
  };
}

function parseOrigin(value: unknown, path: string) {
  const record = exactRecord(value, ["originId", "independenceStatus", "dependsOnOriginIds"], path);
  return {
    originId: id(record.originId, `${path}.originId`),
    independenceStatus: enumValue(record.independenceStatus, ["established", "dependent", "unknown"] as const, `${path}.independenceStatus`),
    dependsOnOriginIds: uniqueStrings(record.dependsOnOriginIds, `${path}.dependsOnOriginIds`, 64, 128)
      .map((entry, index) => id(entry, `${path}.dependsOnOriginIds[${index}]`)),
  };
}

function referenceKey(reference: EvidenceReference): string {
  return [reference.reportRevisionId, reference.permittedTextHash, reference.spanStart, reference.spanEnd, reference.offsetUnit, reference.relation].join("\u0000");
}

async function parseRetrievedEvidence(value: unknown, path: string) {
  const record = exactRecord(value, ["reference", "text", "sourceId", "revisionStatus", "publishedAt", "observedAt", "retrievedAt", "origins"], path);
  const reference = parseEvidenceReference(record.reference, `${path}.reference`);
  const text = boundedString(record.text, `${path}.text`, MAX_CHUNK_CODE_POINTS * 2);
  if (codePointLength(text) > MAX_CHUNK_CODE_POINTS) reject(`${path}.text:too_large`);
  if (reference.spanEnd - reference.spanStart !== codePointLength(text)) reject(`${path}:excerpt_span_length_mismatch`);
  const sourceId = id(record.sourceId, `${path}.sourceId`);
  const revisionStatus = parseRevisionStatus(record.revisionStatus, `${path}.revisionStatus`);
  const publishedAt = nullableDateTime(record.publishedAt, `${path}.publishedAt`);
  const observedAt = nullableDateTime(record.observedAt, `${path}.observedAt`);
  const retrievedAt = boundedString(record.retrievedAt, `${path}.retrievedAt`, 40);
  if (!validDateTime(retrievedAt)) reject(`${path}.retrievedAt:invalid_datetime`);
  const origins = boundedArray(record.origins, 32, `${path}.origins`).map((origin, index) => parseOrigin(origin, `${path}.origins[${index}]`));
  const originIds = new Set<string>();
  for (const origin of origins) {
    if (originIds.has(origin.originId)) reject(`${path}.origins:duplicate_origin`);
    originIds.add(origin.originId);
  }
  return { reference, text, sourceId, revisionStatus, publishedAt, observedAt, retrievedAt, origins };
}

export async function validateReasoningRequest(value: unknown): Promise<ReasoningRequest> {
  const request = exactRecord(value, ["data"], "request");
  const data = exactRecord(request.data, ["groundingContext"], "request.data");
  const record = exactRecord(
    data.groundingContext,
    ["schemaVersion", "recordType", "datasetKind", "traceId", "contextId", "candidateId", "evidence", "revisionStates", "candidateEvents", "priorDecisionIds", "missingFields", "conflicts", "retrievalVersion", "indexVersion", "sufficient"],
    "request.data.groundingContext",
  );
  if (record.schemaVersion !== "2.0" || record.recordType !== "GroundingContext") reject("request.data.groundingContext:unsupported_version_or_type");
  const datasetKind = enumValue(record.datasetKind, DATASET_KINDS, "request.data.groundingContext.datasetKind") as DatasetKind;
  const traceId = id(record.traceId, "request.data.groundingContext.traceId");
  const contextId = id(record.contextId, "request.data.groundingContext.contextId");
  const candidateId = id(record.candidateId, "request.data.groundingContext.candidateId");
  const evidence = await Promise.all(
    boundedArray(record.evidence, 8, "request.data.groundingContext.evidence")
      .map((entry, index) => parseRetrievedEvidence(entry, `request.data.groundingContext.evidence[${index}]`)),
  );
  const evidenceKeys = new Set<string>();
  for (const entry of evidence) {
    const key = referenceKey(entry.reference);
    if (evidenceKeys.has(key)) reject("request.data.groundingContext.evidence:duplicate_reference");
    evidenceKeys.add(key);
  }
  const revisionStates = boundedArray(record.revisionStates, 128, "request.data.groundingContext.revisionStates")
    .map((entry, index) => parseRevisionState(entry, `request.data.groundingContext.revisionStates[${index}]`));
  const revisionMap = new Map<string, RevisionStatus>();
  for (const state of revisionStates) {
    if (revisionMap.has(state.reportRevisionId)) reject("request.data.groundingContext.revisionStates:duplicate_revision");
    revisionMap.set(state.reportRevisionId, state.revisionStatus);
  }
  for (const entry of evidence) {
    if (revisionMap.get(entry.reference.reportRevisionId) !== entry.revisionStatus) {
      reject("request.data.groundingContext:evidence_revision_state_mismatch");
    }
  }
  const candidateEvents = boundedArray(record.candidateEvents, 20, "request.data.groundingContext.candidateEvents")
    .map((entry, index) => parseCandidateEvent(entry, `request.data.groundingContext.candidateEvents[${index}]`));
  const eventIds = new Set<string>();
  for (const event of candidateEvents) {
    if (eventIds.has(event.eventId)) reject("request.data.groundingContext.candidateEvents:duplicate_event");
    eventIds.add(event.eventId);
  }
  const priorDecisionIds = uniqueStrings(record.priorDecisionIds, "request.data.groundingContext.priorDecisionIds", 100, 128)
    .map((entry, index) => id(entry, `request.data.groundingContext.priorDecisionIds[${index}]`));
  const missingFields = uniqueStrings(record.missingFields, "request.data.groundingContext.missingFields", 100, 500);
  const conflicts = uniqueStrings(record.conflicts, "request.data.groundingContext.conflicts", 100, 500);
  const retrievalVersion = id(record.retrievalVersion, "request.data.groundingContext.retrievalVersion");
  const indexVersion = id(record.indexVersion, "request.data.groundingContext.indexVersion");
  const sufficient = booleanValue(record.sufficient, "request.data.groundingContext.sufficient");
  const groundingContext: GroundingContext = {
    schemaVersion: "2.0",
    recordType: "GroundingContext",
    datasetKind,
    traceId,
    contextId,
    candidateId,
    evidence,
    revisionStates,
    candidateEvents,
    priorDecisionIds,
    missingFields,
    conflicts,
    retrievalVersion,
    indexVersion,
    sufficient,
  };
  return { data: { groundingContext } };
}

function parseReferenceSet(value: unknown, path: string, relation: EvidenceReference["relation"], allowed: ReadonlySet<string>): readonly EvidenceReference[] {
  const refs = evidenceArray(value, path, 8);
  for (const reference of refs) {
    if (reference.relation !== relation && !(relation === "updates" && reference.relation === "context")) {
      reject(`${path}:invalid_relation`);
    }
    if (!allowed.has(referenceKey(reference))) reject(`${path}:reference_not_in_context`);
  }
  const seen = new Set<string>();
  for (const reference of refs) {
    const key = referenceKey(reference);
    if (seen.has(key)) reject(`${path}:duplicate_reference`);
    seen.add(key);
  }
  return refs;
}

function parseProposedClaim(value: unknown, path: string, allowedEvidence: ReadonlySet<string>): ProposedClaim {
  const record = exactRecord(value, ["text", "eventTime", "validity", "scope", "qualifiers", "support", "contradictions", "contextEvidence", "supportAssessment"], path);
  const text = boundedString(record.text, `${path}.text`, 4_000);
  const eventTime = parseTimeScope(record.eventTime, `${path}.eventTime`);
  const validity = parseValidity(record.validity, `${path}.validity`);
  const scope = parseScope(record.scope, `${path}.scope`);
  const qualifiers = uniqueStrings(record.qualifiers, `${path}.qualifiers`, 100, 500);
  const support = parseReferenceSet(record.support, `${path}.support`, "supports", allowedEvidence);
  if (support.length === 0) reject(`${path}:claim_without_support`);
  const contradictions = parseReferenceSet(record.contradictions, `${path}.contradictions`, "contradicts", allowedEvidence);
  const contextEvidence = parseReferenceSet(record.contextEvidence, `${path}.contextEvidence`, "updates", allowedEvidence);
  const supportAssessment = enumValue(record.supportAssessment, ["supported", "uncertain", "disputed"] as const, `${path}.supportAssessment`) as SupportAssessment;
  if (contradictions.length > 0 && supportAssessment === "supported") {
    reject(`${path}:contradiction_cannot_be_marked_supported`);
  }
  return { text, eventTime, validity, scope, qualifiers, support, contradictions, contextEvidence, supportAssessment };
}

export async function parseReasoningOutput(
  raw: unknown,
  request: ReasoningRequest,
  identity: ModelIdentity,
): Promise<ReasoningResult> {
  const envelope = validateProviderEnvelope(raw, "provider.reasoning");
  const output = exactRecord(envelope.output, ["outcome", "claims", "unresolvedFields"], "provider.reasoning.output");
  const outcome = enumValue(output.outcome, ["proposed", "abstained"] as const, "provider.reasoning.output.outcome");
  const context = request.data.groundingContext;
  const modelUnresolvedFields = uniqueStrings(output.unresolvedFields, "provider.reasoning.output.unresolvedFields", 100, 500);
  const unresolvedFields = [...new Set([...modelUnresolvedFields, ...context.missingFields])];
  const allowedEvidence = new Set(context.evidence.map((entry) => referenceKey(entry.reference)));
  const claims = boundedArray(output.claims, 20, "provider.reasoning.output.claims")
    .map((claim, index) => parseProposedClaim(claim, `provider.reasoning.output.claims[${index}]`, allowedEvidence));
  if (outcome === "proposed" && claims.length === 0) reject("provider.reasoning:proposal_without_claims");
  if (outcome === "abstained" && (claims.length !== 0 || unresolvedFields.length === 0)) {
    reject("provider.reasoning:invalid_abstention");
  }
  const model = validateModelIdentity(identity, "configuration.reasoning");
  const modelRun: ModelRun<"reasoning"> = {
    capability: "reasoning",
    modelVersion: model.modelVersion,
    promptVersion: model.promptVersion,
    ...envelope.usage,
  };
  return { outcome, claims, unresolvedFields, conflicts: context.conflicts, modelRun, provider: model.provider };
}

/** Hash helper for trusted L1 callers and contract fixtures. */
export async function sha256Text(value: string): Promise<string> {
  return await awaitSha256(value);
}
