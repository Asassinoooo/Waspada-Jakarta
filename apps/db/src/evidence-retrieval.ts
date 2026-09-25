import type { DatasetKind, EvidenceRelation } from './ports.js';
import type { SqlExecutor } from './sql.js';

export type EvidenceRetrievalDistanceMetric = 'cosine' | 'dot_product' | 'euclidean';
export type EvidenceRetrievalRevisionStatus = 'unreviewed' | 'eligible' | 'quarantined' | 'superseded' | 'retracted';
export type EvidenceRetrievalRegistryStatus = 'active' | 'paused' | 'retired';
export type EvidenceRetrievalApprovalStatus = 'pending' | 'approved' | 'suspended' | 'revoked';
export type EvidenceRetrievalHealthStatus = 'unknown' | 'healthy' | 'degraded' | 'unavailable';

export interface EvidenceRetrievalIdentifier {
  readonly kind: 'candidate' | 'report_revision' | 'source';
  readonly value: string;
}

export interface EvidenceRetrievalTimeBounds {
  readonly from?: string;
  readonly until?: string;
}

export interface EvidenceRetrievalEmbeddingIdentity {
  readonly provider: string;
  readonly modelVersion: string;
  readonly dimensions: number;
  readonly distanceMetric: EvidenceRetrievalDistanceMetric;
  readonly vectorIndexVersion: string;
}

export interface EvidenceRetrievalSemanticRequest {
  readonly identity: EvidenceRetrievalEmbeddingIdentity;
  /** A vector computed by a caller. Retrieval never invokes an embedder. */
  readonly queryVector?: readonly number[];
}

export type Crs84Geometry =
  | { readonly type: 'Point'; readonly coordinates: readonly number[] }
  | { readonly type: 'MultiPoint' | 'LineString'; readonly coordinates: readonly (readonly number[])[] }
  | { readonly type: 'MultiLineString' | 'Polygon'; readonly coordinates: readonly (readonly (readonly number[])[])[] }
  | { readonly type: 'MultiPolygon'; readonly coordinates: readonly (readonly (readonly (readonly number[])[])[])[] };

export interface EvidenceRetrievalFilters {
  readonly revisionStatuses?: readonly EvidenceRetrievalRevisionStatus[];
  readonly registryStatuses?: readonly EvidenceRetrievalRegistryStatus[];
  readonly approvalStatuses?: readonly EvidenceRetrievalApprovalStatus[];
  readonly healthStatuses?: readonly EvidenceRetrievalHealthStatus[];
}

export interface EvidenceRetrievalQuery {
  readonly datasetKind: DatasetKind;
  readonly identifiers?: readonly EvidenceRetrievalIdentifier[];
  /** Literal, case-sensitive substrings searched in immutable permitted text. */
  readonly exactTerms?: readonly string[];
  readonly reportTime?: EvidenceRetrievalTimeBounds;
  readonly eventTime?: EvidenceRetrievalTimeBounds;
  /** Caller-supplied, source-supported GeoJSON in CRS84. No buffer is applied. */
  readonly geometry?: Crs84Geometry;
  readonly semantic?: EvidenceRetrievalSemanticRequest;
  readonly filters?: EvidenceRetrievalFilters;
  readonly maxResults?: number;
  readonly maxRowsExamined?: number;
  readonly maxSpanTextCodePoints?: number;
}

export interface EvidenceRetrievalOrigin {
  readonly originId: string;
  readonly originKind: string;
  readonly sourceId: string | null;
  readonly lineageRelation: string;
  readonly independenceStatus: 'established' | 'dependent' | 'unknown';
  readonly dependsOnOriginIds: readonly string[];
}

export interface EvidenceRetrievalGeometryMatch {
  readonly geometryId: string;
  readonly role: string;
  readonly precisionM: number | null;
  readonly precisionBasis: string;
  readonly displayLabel: string | null;
}

export interface EvidenceRetrievalChunk {
  readonly chunkId: string;
  readonly permittedTextHash: string;
  readonly chunkTextHash: string;
  readonly spanStart: number;
  readonly spanEnd: number;
  readonly chunkerVersion: string;
  readonly embeddingStatus: 'matched' | 'no_compatible_embedding' | 'query_vector_missing';
  readonly embeddingRunId: string | null;
  readonly embeddingProvider: string | null;
  readonly embeddingModelVersion: string | null;
  readonly embeddingDimensions: number | null;
  readonly embeddingDistanceMetric: EvidenceRetrievalDistanceMetric | null;
  readonly embeddingIndexVersion: string | null;
  readonly semanticDistance: number | null;
}

export interface EvidenceRetrievalCandidate {
  readonly datasetKind: DatasetKind;
  readonly candidateId: string;
  readonly reportRevisionId: string;
  readonly permittedTextHash: string;
  readonly evidenceReferenceId: string;
  readonly spanStart: number;
  readonly spanEnd: number;
  readonly offsetUnit: 'unicode_code_points';
  readonly relation: EvidenceRelation;
  /** Exact prefix excerpt; excerpt offsets remain separate from the full reference offsets. */
  readonly spanText: string;
  readonly spanTextStart: number;
  readonly spanTextEnd: number;
  readonly spanTextTruncated: boolean;
  readonly revisionStatus: EvidenceRetrievalRevisionStatus;
  readonly source: {
    readonly sourceId: string;
    readonly displayName: string;
    readonly sourceKind: string;
    readonly publisherGroupId: string | null;
    readonly registryStatus: EvidenceRetrievalRegistryStatus;
    readonly approvalStatus: EvidenceRetrievalApprovalStatus;
    readonly healthStatus: EvidenceRetrievalHealthStatus;
  };
  readonly publishedAt: string | null;
  readonly observedAt: string | null;
  readonly retrievedAt: string;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
  readonly eventTime: {
    readonly start: string | null;
    readonly end: string | null;
    readonly precision: string | null;
    readonly status: 'valid' | 'unknown' | 'invalid';
  };
  readonly origins: readonly EvidenceRetrievalOrigin[];
  /** No recorded origins remain unknown; no independence is manufactured. */
  readonly originLineageStatus: 'recorded' | 'unknown';
  readonly geometryMatches: readonly EvidenceRetrievalGeometryMatch[];
  readonly chunk: EvidenceRetrievalChunk | null;
  readonly matchFacets: {
    readonly identifiers: readonly EvidenceRetrievalIdentifier[];
    readonly exactTerms: readonly string[];
    readonly reportTimeFields: readonly ('published_at' | 'observed_at' | 'retrieved_at')[];
    readonly eventTime: boolean;
    readonly geometry: boolean;
    readonly semanticDistance: number | null;
  };
}

export interface EvidenceRetrievalResult {
  readonly datasetKind: DatasetKind;
  readonly retrievalVersion: 'hybrid-evidence-v1';
  readonly indexVersion: string | null;
  readonly candidates: readonly EvidenceRetrievalCandidate[];
  readonly rowsExamined: number;
  readonly filteredRowsOmitted: number;
  readonly invalidSpanRowsOmitted: number;
  readonly scanTruncated: boolean;
  readonly resultTruncated: boolean;
  readonly semanticStatus: 'not_requested' | 'query_vector_missing' | 'matched' | 'no_compatible_vector';
}

export interface EvidenceRetrievalRepository {
  search(query: EvidenceRetrievalQuery): Promise<EvidenceRetrievalResult>;
}

const RETRIEVAL_VERSION = 'hybrid-evidence-v1' as const;
const MAX_IDENTIFIERS = 20;
const MAX_EXACT_TERMS = 20;
const MAX_TERM_CODE_POINTS = 128;
const MAX_IDENTIFIER_CODE_POINTS = 128;
const MAX_QUERY_STRING_CODE_POINTS = 128;
const MAX_GEOMETRY_VERTICES = 256;
const MAX_VECTOR_DIMENSIONS = 2_048;
const MAX_ROWS_EXAMINED = 250;
const DEFAULT_ROWS_EXAMINED = 100;
const MAX_RESULTS = 50;
const DEFAULT_RESULTS = 20;
const MAX_SPAN_TEXT_CODE_POINTS = 2_048;
const DEFAULT_SPAN_TEXT_CODE_POINTS = 512;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function createSqlEvidenceRetrievalRepository(executor: SqlExecutor): EvidenceRetrievalRepository {
  return new SqlEvidenceRetrievalRepository(executor);
}

class SqlEvidenceRetrievalRepository implements EvidenceRetrievalRepository {
  constructor(private readonly executor: SqlExecutor) {}

  async search(query: EvidenceRetrievalQuery): Promise<EvidenceRetrievalResult> {
    const normalized = validateAndNormalizeQuery(query);
    const semanticStatus = normalized.semantic
      ? normalized.semantic.queryVector ? 'no_compatible_vector' : 'query_vector_missing'
      : 'not_requested';
    if (!hasSearchFacet(normalized)) {
      return emptyResult(query.datasetKind, normalized.semantic ? 'query_vector_missing' : 'not_requested');
    }

    const queryConfig = {
      exactTerms: normalized.exactTerms,
      geometry: normalized.geometry ?? null,
      semantic: normalized.semantic?.queryVector
        ? {
            identity: normalized.semantic.identity,
            vector: normalized.semantic.queryVector,
          }
        : null,
    };
    const sql = buildRetrievalSql(Boolean(normalized.semantic?.queryVector), normalized.semantic?.identity.distanceMetric ?? 'cosine', Boolean(normalized.geometry));
    const raw = await this.executor.query<EvidenceRetrievalRow>(sql, [
      query.datasetKind,
      normalized.maxRowsExamined + 1,
      normalized.maxRowsExamined,
      normalized.maxSpanTextCodePoints,
      JSON.stringify(queryConfig),
    ]);
    const scanTruncated = raw.rows.some((row) => row.scan_truncated);
    const rowsExamined = Math.min(raw.rows.length, normalized.maxRowsExamined);
    const candidates: EvidenceRetrievalCandidate[] = [];
    let filteredRowsOmitted = 0;
    let invalidSpanRowsOmitted = 0;
    let anySemanticMatch = false;

    for (const row of raw.rows) {
      if (row.scan_position > normalized.maxRowsExamined) continue;
      if (!passesStateFilters(row, normalized.filters)) {
        filteredRowsOmitted += 1;
        continue;
      }
      const spanLength = row.span_end - row.span_start;
      if (!Number.isInteger(row.span_start) || !Number.isInteger(row.span_end)
        || row.span_start < 0 || spanLength < 1 || row.span_end > row.report_code_points
        || row.offset_unit !== 'unicode_code_points') {
        invalidSpanRowsOmitted += 1;
        continue;
      }

      const exactIdentifiers = matchedIdentifiers(row, normalized.identifiers);
      const exactTerms = row.exact_terms ?? [];
      const reportTimeFields = matchingReportTimeFields(row, normalized.reportTime);
      const eventTime = parseEventTime(row.event_time_json);
      const eventTimeMatched = matchesEventTime(eventTime, normalized.eventTime);
      const geometryMatches = parseJsonArray<EvidenceRetrievalGeometryMatch>(row.geometry_matches);
      const origins = parseJsonArray<EvidenceRetrievalOrigin>(row.origins);
      const chunk = mapChunk(row, normalized.semantic?.queryVector ? 'no_compatible_embedding'
        : normalized.semantic ? 'query_vector_missing' : 'no_compatible_embedding');
      const semanticDistance = chunk?.semanticDistance ?? null;
      const semanticMatched = semanticDistance !== null && Number.isFinite(semanticDistance);
      if (semanticMatched) anySemanticMatch = true;

      if (exactIdentifiers.length === 0 && exactTerms.length === 0
        && reportTimeFields.length === 0 && !eventTimeMatched
        && geometryMatches.length === 0 && !semanticMatched) continue;

      candidates.push({
        datasetKind: row.dataset_kind,
        candidateId: row.candidate_id,
        reportRevisionId: row.report_revision_id,
        permittedTextHash: row.permitted_text_hash,
        evidenceReferenceId: String(row.evidence_ref_id),
        spanStart: row.span_start,
        spanEnd: row.span_end,
        offsetUnit: 'unicode_code_points',
        relation: row.relation,
        spanText: row.span_text,
        spanTextStart: row.span_start,
        spanTextEnd: row.span_start + codePointCount(row.span_text),
        spanTextTruncated: spanLength > normalized.maxSpanTextCodePoints,
        revisionStatus: row.revision_status,
        source: {
          sourceId: row.source_id,
          displayName: row.source_display_name,
          sourceKind: row.source_kind,
          publisherGroupId: row.publisher_group_id,
          registryStatus: row.registry_status,
          approvalStatus: row.approval_status,
          healthStatus: row.health_status,
        },
        publishedAt: row.published_at,
        observedAt: row.observed_at,
        retrievedAt: row.retrieved_at,
        validFrom: row.valid_from,
        validUntil: row.valid_until,
        eventTime,
        origins,
        originLineageStatus: origins.length > 0 ? 'recorded' : 'unknown',
        geometryMatches,
        chunk: chunk && row.chunk_id ? { ...chunk, embeddingStatus: semanticMatched ? 'matched'
          : normalized.semantic?.queryVector ? 'no_compatible_embedding'
            : normalized.semantic ? 'query_vector_missing' : 'no_compatible_embedding' } : null,
        matchFacets: {
          identifiers: exactIdentifiers,
          exactTerms,
          reportTimeFields,
          eventTime: eventTimeMatched,
          geometry: geometryMatches.length > 0,
          semanticDistance: semanticMatched ? semanticDistance : null,
        },
      });
    }

    candidates.sort(compareCandidates);
    const resultTruncated = candidates.length > normalized.maxResults;
    const resultCandidates = candidates.slice(0, normalized.maxResults);
    return {
      datasetKind: query.datasetKind,
      retrievalVersion: RETRIEVAL_VERSION,
      indexVersion: normalized.semantic?.queryVector ? normalized.semantic.identity.vectorIndexVersion : null,
      candidates: resultCandidates,
      rowsExamined,
      filteredRowsOmitted,
      invalidSpanRowsOmitted,
      scanTruncated,
      resultTruncated,
      semanticStatus: normalized.semantic
        ? normalized.semantic.queryVector
          ? anySemanticMatch ? 'matched' : 'no_compatible_vector'
          : 'query_vector_missing'
        : semanticStatus,
    };
  }
}

interface NormalizedQuery {
  readonly identifiers: readonly EvidenceRetrievalIdentifier[];
  readonly exactTerms: readonly string[];
  readonly reportTime: ParsedTimeBounds | null;
  readonly eventTime: ParsedTimeBounds | null;
  readonly geometry: Crs84Geometry | null;
  readonly semantic: { readonly identity: EvidenceRetrievalEmbeddingIdentity; readonly queryVector: readonly number[] | null } | null;
  readonly filters: EvidenceRetrievalFilters;
  readonly maxResults: number;
  readonly maxRowsExamined: number;
  readonly maxSpanTextCodePoints: number;
}

interface ParsedTimeBounds {
  readonly from: ParsedTimeValue | null;
  readonly until: ParsedTimeValue | null;
}

interface ParsedTimeValue {
  readonly raw: string;
  readonly startMs: number;
  readonly endMs: number;
}

function validateAndNormalizeQuery(query: EvidenceRetrievalQuery): NormalizedQuery {
  if (!query || !['live', 'historical', 'synthetic'].includes(query.datasetKind)) {
    throw new Error('Evidence retrieval requires a supported dataset kind');
  }
  const identifiers = query.identifiers ?? [];
  if (identifiers.length > MAX_IDENTIFIERS) throw new Error('Evidence retrieval identifier count exceeds its bound');
  for (const identifier of identifiers) {
    if (!['candidate', 'report_revision', 'source'].includes(identifier.kind)
      || !ID_PATTERN.test(identifier.value) || codePointCount(identifier.value) > MAX_IDENTIFIER_CODE_POINTS) {
      throw new Error('Evidence retrieval identifiers must use a supported kind and bounded identifier');
    }
  }
  const exactTerms = query.exactTerms ?? [];
  if (exactTerms.length > MAX_EXACT_TERMS || exactTerms.some((term) => !term.trim()
    || codePointCount(term) > MAX_TERM_CODE_POINTS || term.includes('\u0000'))) {
    throw new Error('Evidence retrieval exact terms exceed their count or text bound');
  }
  const maxResults = boundedInteger(query.maxResults, DEFAULT_RESULTS, 1, MAX_RESULTS, 'maxResults');
  const maxRowsExamined = boundedInteger(query.maxRowsExamined, DEFAULT_ROWS_EXAMINED, 1,
    MAX_ROWS_EXAMINED, 'maxRowsExamined');
  const maxSpanTextCodePoints = boundedInteger(query.maxSpanTextCodePoints, DEFAULT_SPAN_TEXT_CODE_POINTS,
    1, MAX_SPAN_TEXT_CODE_POINTS, 'maxSpanTextCodePoints');
  const geometry = query.geometry ? validateGeometry(query.geometry) : null;
  let semantic: NormalizedQuery['semantic'] = null;
  if (query.semantic) {
    const { identity, queryVector } = query.semantic;
    validateEmbeddingIdentity(identity);
    if (queryVector && (queryVector.length !== identity.dimensions
      || queryVector.some((value) => !Number.isFinite(value)))) {
      throw new Error('Evidence retrieval query vector must be finite and match the requested embedding dimensions');
    }
    if (queryVector && identity.distanceMetric === 'cosine' && queryVector.every((value) => value === 0)) {
      throw new Error('Cosine retrieval does not accept a zero-length query vector');
    }
    semantic = { identity, queryVector: queryVector ? [...queryVector] : null };
  }
  return {
    identifiers: dedupeIdentifiers(identifiers),
    exactTerms: [...new Set(exactTerms)],
    reportTime: parseTimeBounds(query.reportTime, 'reportTime'),
    eventTime: parseTimeBounds(query.eventTime, 'eventTime'),
    geometry,
    semantic,
    filters: validateFilters(query.filters ?? {}),
    maxResults,
    maxRowsExamined,
    maxSpanTextCodePoints,
  };
}

function dedupeIdentifiers(identifiers: readonly EvidenceRetrievalIdentifier[]): EvidenceRetrievalIdentifier[] {
  const seen = new Set<string>();
  return identifiers.filter((identifier) => {
    const key = `${identifier.kind}:${identifier.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function validateEmbeddingIdentity(identity: EvidenceRetrievalEmbeddingIdentity): void {
  if (!identity || !['cosine', 'dot_product', 'euclidean'].includes(identity.distanceMetric)
    || !Number.isInteger(identity.dimensions) || identity.dimensions < 1 || identity.dimensions > MAX_VECTOR_DIMENSIONS
    || !boundedString(identity.provider, 120) || identity.provider.includes('\u0000')
    || !boundedString(identity.modelVersion, 200) || identity.modelVersion.includes('\u0000')
    || !boundedString(identity.vectorIndexVersion, 200) || identity.vectorIndexVersion.includes('\u0000')) {
    throw new Error('Evidence retrieval embedding identity is invalid or exceeds its bounds');
  }
}

function parseTimeBounds(input: EvidenceRetrievalTimeBounds | undefined, name: string): ParsedTimeBounds | null {
  if (!input) return null;
  const from = input.from === undefined ? null : parseTimeValue(input.from, `${name}.from`);
  const until = input.until === undefined ? null : parseTimeValue(input.until, `${name}.until`);
  if (!from && !until) throw new Error(`${name} requires a lower or upper bound`);
  if (from && until && from.startMs > until.endMs) throw new Error(`${name} lower bound must not exceed its upper bound`);
  return { from, until };
}

function parseTimeValue(value: string, name: string): ParsedTimeValue {
  if (codePointCount(value) > MAX_QUERY_STRING_CODE_POINTS
    || (!DATE_PATTERN.test(value) && !RFC3339_PATTERN.test(value))) {
    throw new Error(`${name} must be a date or RFC 3339 timestamp with an explicit UTC offset`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${name} is not a valid date or timestamp`);
  if (DATE_PATTERN.test(value)) {
    const dayStart = Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10)));
    const check = new Date(dayStart).toISOString().slice(0, 10);
    if (check !== value) throw new Error(`${name} is not a valid calendar date`);
    return { raw: value, startMs: dayStart, endMs: dayStart + 86_400_000 - 1 };
  }
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!parts) throw new Error(`${name} has an unsupported timestamp form`);
  const [, year, month, day, hour, minute, second, zone, , offsetHour, offsetMinute] = parts;
  const dateStart = Date.UTC(Number(year), Number(month) - 1, Number(day));
  if (new Date(dateStart).toISOString().slice(0, 10) !== `${year}-${month}-${day}`
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59
    || (zone !== 'Z' && (Number(offsetHour) > 23 || Number(offsetMinute) > 59))) {
    throw new Error(`${name} is not a valid timestamp`);
  }
  return { raw: value, startMs: timestamp, endMs: timestamp };
}

function validateGeometry(geometry: Crs84Geometry): Crs84Geometry {
  if (!geometry || typeof geometry !== 'object' || !['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'].includes(geometry.type)) {
    throw new Error('Evidence retrieval geometry must use a supported GeoJSON geometry type');
  }
  if (Object.keys(geometry).length !== 2 || !Object.hasOwn(geometry, 'coordinates') || !Object.hasOwn(geometry, 'type')) {
    throw new Error('Evidence retrieval geometry must contain only GeoJSON type and coordinates in CRS84');
  }
  let vertices = 0;
  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) throw new Error('Evidence retrieval geometry coordinates are malformed');
    if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
      if (value.length !== 2 || !Number.isFinite(value[0]) || !Number.isFinite(value[1])
        || value[0] < -180 || value[0] > 180 || value[1] < -90 || value[1] > 90) {
        throw new Error('Evidence retrieval coordinates must be bounded two-dimensional CRS84 positions');
      }
      vertices += 1;
      return;
    }
    for (const child of value) visit(child);
  };
  visit(geometry.coordinates);
  if (vertices < 1 || vertices > MAX_GEOMETRY_VERTICES) {
    throw new Error('Evidence retrieval geometry vertex count is outside its bound');
  }
  validateGeometryStructure(geometry);
  return geometry;
}

function validateGeometryStructure(geometry: Crs84Geometry): void {
  const isPosition = (value: readonly number[]): boolean => Array.isArray(value)
    && value.length === 2 && typeof value[0] === 'number' && typeof value[1] === 'number';
  const line = (value: readonly (readonly number[])[]): void => {
    if (value.length < 2 || !value.every(isPosition)) {
      throw new Error('Evidence retrieval lines require at least two CRS84 positions');
    }
  };
  const ring = (value: readonly (readonly number[])[]): void => {
    if (value.length < 4 || !value.every(isPosition)) {
      throw new Error('Evidence retrieval polygon rings require at least four CRS84 positions');
    }
    const first = value[0]!;
    const last = value[value.length - 1]!;
    if (first[0] !== last[0] || first[1] !== last[1]) {
      throw new Error('Evidence retrieval polygon rings must be closed');
    }
  };
  if (geometry.type === 'Point' && !isPosition(geometry.coordinates)) {
    throw new Error('Evidence retrieval points require one two-dimensional position');
  }
  if (geometry.type === 'MultiPoint' && (geometry.coordinates.length < 1 || !geometry.coordinates.every(isPosition))) {
    throw new Error('Evidence retrieval multipoints require at least one position');
  }
  if (geometry.type === 'LineString') line(geometry.coordinates);
  if (geometry.type === 'MultiLineString') {
    if (geometry.coordinates.length < 1) throw new Error('Evidence retrieval multilines require at least one line');
    geometry.coordinates.forEach(line);
  }
  if (geometry.type === 'Polygon') {
    if (geometry.coordinates.length < 1) throw new Error('Evidence retrieval polygons require at least one ring');
    geometry.coordinates.forEach(ring);
  }
  if (geometry.type === 'MultiPolygon') {
    if (geometry.coordinates.length < 1) throw new Error('Evidence retrieval multipolygons require at least one polygon');
    for (const polygon of geometry.coordinates) {
      if (polygon.length < 1) throw new Error('Evidence retrieval polygons require at least one ring');
      polygon.forEach(ring);
    }
  }
}

function validateFilters(filters: EvidenceRetrievalFilters): EvidenceRetrievalFilters {
  const enumValues: readonly (keyof EvidenceRetrievalFilters)[] = [
    'revisionStatuses', 'registryStatuses', 'approvalStatuses', 'healthStatuses',
  ];
  for (const field of enumValues) {
    const values = filters[field];
    if (values && (values.length < 1 || values.length > 5 || values.some((value) => typeof value !== 'string'))) {
      throw new Error(`Evidence retrieval ${field} filter is invalid`);
    }
  }
  const allowed = {
    revisionStatuses: ['unreviewed', 'eligible', 'quarantined', 'superseded', 'retracted'],
    registryStatuses: ['active', 'paused', 'retired'],
    approvalStatuses: ['pending', 'approved', 'suspended', 'revoked'],
    healthStatuses: ['unknown', 'healthy', 'degraded', 'unavailable'],
  } as const;
  for (const field of enumValues) {
    const values = filters[field] as readonly string[] | undefined;
    if (values?.some((value) => !(allowed[field] as readonly string[]).includes(value))) {
      throw new Error(`Evidence retrieval ${field} filter contains an unsupported state`);
    }
  }
  return filters;
}

function hasSearchFacet(query: NormalizedQuery): boolean {
  return query.identifiers.length > 0 || query.exactTerms.length > 0 || query.reportTime !== null
    || query.eventTime !== null || query.geometry !== null || Boolean(query.semantic?.queryVector);
}

function buildRetrievalSql(hasSemanticVector: boolean, distanceMetric: EvidenceRetrievalDistanceMetric, hasGeometry: boolean): string {
  const distanceOperator = distanceMetric === 'cosine' ? '<=>' : distanceMetric === 'euclidean' ? '<->' : '<#>';
  const chunkOrdering = hasSemanticVector
    ? 'semantic.semantic_distance ASC NULLS LAST, (LEAST(chunk_base.span_end, evidence_chunks.span_end) - GREATEST(chunk_base.span_start, evidence_chunks.span_start)) DESC, chunk_base.chunk_id'
    : '(LEAST(chunk_base.span_end, evidence_chunks.span_end) - GREATEST(chunk_base.span_start, evidence_chunks.span_start)) DESC, chunk_base.chunk_id';
  const semanticColumns = hasSemanticVector ? `semantic.embedding_run_id,
          semantic.provider AS embedding_provider, semantic.model_version AS embedding_model_version,
          semantic.dimensions AS embedding_dimensions,
          semantic.distance_metric AS embedding_distance_metric,
          semantic.vector_index_version AS embedding_index_version, semantic.semantic_distance` : `NULL::text AS embedding_run_id,
          NULL::text AS embedding_provider, NULL::text AS embedding_model_version,
          NULL::integer AS embedding_dimensions, NULL::text AS embedding_distance_metric,
          NULL::text AS embedding_index_version, NULL::double precision AS semantic_distance`;
  const semanticFilter = hasSemanticVector ? `
        AND run.provider = $5::jsonb #>> '{semantic,identity,provider}'
        AND run.model_version = $5::jsonb #>> '{semantic,identity,modelVersion}'
        AND run.dimensions = (($5::jsonb #>> '{semantic,identity,dimensions}')::integer)
        AND embedding.dimensions = run.dimensions
        AND vector_dims(embedding.embedding) = run.dimensions
        AND run.distance_metric = $5::jsonb #>> '{semantic,identity,distanceMetric}'
        AND run.vector_index_version = $5::jsonb #>> '{semantic,identity,vectorIndexVersion}'` : '';
  const semanticLookup = hasSemanticVector ? `
      LEFT JOIN LATERAL (
        SELECT run.embedding_run_id, run.provider, run.model_version, run.dimensions,
               run.distance_metric, run.vector_index_version,
               (embedding.embedding ${distanceOperator} (($5::jsonb #>> '{semantic,vector}')::vector))::double precision AS semantic_distance
        FROM waspada.embedding_runs AS run
        JOIN waspada.embedding_vectors AS embedding
          ON embedding.dataset_kind = run.dataset_kind
         AND embedding.embedding_run_id = run.embedding_run_id
        WHERE run.dataset_kind = chunk_base.dataset_kind
          AND run.chunk_id = chunk_base.chunk_id
          AND run.capability = 'embedding'
          AND run.status = 'available'
          AND run.input_text_hash = chunk_base.chunk_text_hash
          ${semanticFilter}
        ORDER BY semantic_distance ASC, run.created_at DESC, run.embedding_run_id
        LIMIT 1
      ) AS semantic ON true` : '';
  const termExpression = `ARRAY(
      SELECT term.value
      FROM jsonb_array_elements_text($5::jsonb -> 'exactTerms') WITH ORDINALITY AS term(value, ordinal)
      WHERE strpos(substring(base.permitted_text FROM base.span_start + 1 FOR base.span_end - base.span_start), term.value) > 0
      ORDER BY term.ordinal
    ) AS exact_terms`;
  const geometryExpression = hasGeometry ? `COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'geometryId', geometry.geometry_id,
        'role', geometry.role,
        'precisionM', geometry.precision_m,
        'precisionBasis', geometry.precision_basis,
        'displayLabel', geometry.display_label
      ) ORDER BY geometry.geometry_id)
      FROM waspada.geometry_evidence AS relation
      JOIN waspada.geometries AS geometry
        ON geometry.dataset_kind = relation.dataset_kind AND geometry.geometry_id = relation.geometry_id
      WHERE relation.dataset_kind = base.dataset_kind
        AND relation.evidence_ref_id = base.evidence_ref_id
        AND ST_Intersects(geometry.shape,
          ST_SetSRID(ST_GeomFromGeoJSON(($5::jsonb -> 'geometry')::text), 4326))
    ), '[]'::jsonb) AS geometry_matches` : `'[]'::jsonb AS geometry_matches`;
  const originsExpression = `COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'originId', origin.origin_id,
        'originKind', origin.origin_kind,
        'sourceId', origin.source_id,
        'lineageRelation', origin.lineage_relation,
        'independenceStatus', origin.independence_status,
        'dependsOnOriginIds', ARRAY(
          SELECT dependency.depends_on_origin_id
          FROM waspada.origin_dependencies AS dependency
          WHERE dependency.dataset_kind = origin.dataset_kind
            AND dependency.origin_id = origin.origin_id
          ORDER BY dependency.depends_on_origin_id
        )
      ) ORDER BY origin.origin_id)
      FROM waspada.origin_evidence AS origin_link
      JOIN waspada.evidence_origins AS origin
        ON origin.dataset_kind = origin_link.dataset_kind AND origin.origin_id = origin_link.origin_id
      WHERE origin_link.dataset_kind = base.dataset_kind
        AND origin_link.evidence_ref_id = base.evidence_ref_id
    ), '[]'::jsonb) AS origins`;

  return `
    WITH selected AS MATERIALIZED (
      SELECT extraction.dataset_kind, extraction.candidate_id,
             extraction.record_json -> 'event_time' AS event_time_json,
             reference.evidence_ref_id, reference.report_revision_id, reference.permitted_text_hash,
             reference.span_start, reference.span_end, reference.offset_unit, reference.relation,
             revision.permitted_text, revision.revision_status, revision.source_id,
             revision.published_at::text AS published_at, revision.observed_at::text AS observed_at,
             revision.retrieved_at::text AS retrieved_at, revision.valid_from::text AS valid_from,
             revision.valid_until::text AS valid_until, char_length(revision.permitted_text) AS report_code_points,
             source.display_name AS source_display_name, source.source_kind, source.publisher_group_id,
             source.registry_status, source.approval_status, source.health_status,
             row_number() OVER (ORDER BY revision.retrieved_at DESC, extraction.candidate_id,
               revision.report_revision_id, reference.evidence_ref_id) AS scan_position
      FROM waspada.extraction_evidence AS extraction_link
      JOIN waspada.extraction_results AS extraction
        ON extraction.dataset_kind = extraction_link.dataset_kind
       AND extraction.candidate_id = extraction_link.candidate_id
      JOIN waspada.evidence_references AS reference
        ON reference.dataset_kind = extraction_link.dataset_kind
       AND reference.evidence_ref_id = extraction_link.evidence_ref_id
      JOIN waspada.report_revisions AS revision
        ON revision.dataset_kind = reference.dataset_kind
       AND revision.report_revision_id = reference.report_revision_id
       AND revision.permitted_text_hash = reference.permitted_text_hash
      JOIN waspada.source_registry AS source ON source.source_id = revision.source_id
      WHERE extraction.dataset_kind = $1
      ORDER BY revision.retrieved_at DESC, extraction.candidate_id,
        revision.report_revision_id, reference.evidence_ref_id
      LIMIT $2
    ),
    scan_metadata AS (SELECT count(*)::integer > $3 AS scan_truncated FROM selected),
    base AS MATERIALIZED (
      SELECT * FROM selected WHERE scan_position <= $3
    ),
    evidence_chunks AS MATERIALIZED (
      SELECT base.*, substring(base.permitted_text FROM base.span_start + 1 FOR $4) AS span_text,
             ${termExpression}, ${geometryExpression}, ${originsExpression}
      FROM base
    )
    SELECT evidence_chunks.dataset_kind, evidence_chunks.candidate_id,
           evidence_chunks.report_revision_id, evidence_chunks.permitted_text_hash,
           evidence_chunks.evidence_ref_id, evidence_chunks.span_start, evidence_chunks.span_end,
           evidence_chunks.offset_unit, evidence_chunks.relation, evidence_chunks.span_text,
           evidence_chunks.revision_status, evidence_chunks.source_id, evidence_chunks.registry_status,
           evidence_chunks.approval_status, evidence_chunks.health_status,
           evidence_chunks.published_at, evidence_chunks.observed_at, evidence_chunks.retrieved_at,
           evidence_chunks.valid_from, evidence_chunks.valid_until, evidence_chunks.report_code_points,
           evidence_chunks.event_time_json, evidence_chunks.exact_terms, evidence_chunks.geometry_matches,
           evidence_chunks.origins, scan_metadata.scan_truncated, evidence_chunks.scan_position,
           chunk_result.chunk_id, chunk_result.chunk_text_hash, chunk_result.chunk_span_start,
           chunk_result.chunk_span_end, chunk_result.chunker_version, chunk_result.embedding_run_id,
           chunk_result.embedding_provider, chunk_result.embedding_model_version,
           chunk_result.embedding_dimensions, chunk_result.embedding_distance_metric,
           chunk_result.embedding_index_version, chunk_result.semantic_distance
    FROM evidence_chunks
    CROSS JOIN scan_metadata
    LEFT JOIN LATERAL (
      SELECT chunk_base.chunk_id, chunk_base.chunk_text_hash,
             chunk_base.span_start AS chunk_span_start, chunk_base.span_end AS chunk_span_end,
             chunk_base.chunker_version, ${semanticColumns}
      FROM waspada.evidence_chunks AS chunk_base
      ${semanticLookup}
      WHERE chunk_base.dataset_kind = evidence_chunks.dataset_kind
        AND chunk_base.report_revision_id = evidence_chunks.report_revision_id
        AND chunk_base.permitted_text_hash = evidence_chunks.permitted_text_hash
        AND chunk_base.status = 'active'
        AND chunk_base.span_start < evidence_chunks.span_end
        AND chunk_base.span_end > evidence_chunks.span_start
      ORDER BY ${chunkOrdering}
      LIMIT 1
    ) AS chunk_result ON true
    ORDER BY evidence_chunks.scan_position`;
}

interface EvidenceRetrievalRow {
  dataset_kind: DatasetKind;
  candidate_id: string;
  report_revision_id: string;
  permitted_text_hash: string;
  evidence_ref_id: string | number | bigint;
  span_start: number;
  span_end: number;
  offset_unit: string;
  relation: EvidenceRelation;
  span_text: string;
  revision_status: EvidenceRetrievalRevisionStatus;
  source_id: string;
  source_display_name: string;
  source_kind: string;
  publisher_group_id: string | null;
  registry_status: EvidenceRetrievalRegistryStatus;
  approval_status: EvidenceRetrievalApprovalStatus;
  health_status: EvidenceRetrievalHealthStatus;
  published_at: string | null;
  observed_at: string | null;
  retrieved_at: string;
  valid_from: string | null;
  valid_until: string | null;
  report_code_points: number;
  event_time_json: unknown;
  exact_terms: string[];
  geometry_matches: unknown;
  origins: unknown;
  scan_truncated: boolean;
  scan_position: number;
  chunk_id: string | null;
  chunk_text_hash: string | null;
  chunk_span_start: number | null;
  chunk_span_end: number | null;
  chunker_version: string | null;
  embedding_run_id: string | null;
  embedding_provider: string | null;
  embedding_model_version: string | null;
  embedding_dimensions: number | null;
  embedding_distance_metric: EvidenceRetrievalDistanceMetric | null;
  embedding_index_version: string | null;
  semantic_distance: number | null;
}

function parseEventTime(input: unknown): EvidenceRetrievalCandidate['eventTime'] {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { start: null, end: null, precision: null, status: 'unknown' };
  }
  const value = input as { start?: unknown; end?: unknown; precision?: unknown };
  if ((value.start !== null && typeof value.start !== 'string')
    || (value.end !== null && typeof value.end !== 'string')
    || !['exact', 'date', 'range', 'unknown'].includes(String(value.precision))) {
    return { start: null, end: null, precision: null, status: 'invalid' };
  }
  const start = typeof value.start === 'string' ? value.start : null;
  const end = typeof value.end === 'string' ? value.end : null;
  try {
    const parsedStart = start === null ? null : parseTimeValue(start, 'stored event_time.start');
    const parsedEnd = end === null ? null : parseTimeValue(end, 'stored event_time.end');
    if (parsedStart && parsedEnd && parsedStart.startMs > parsedEnd.endMs) {
      return { start, end, precision: String(value.precision), status: 'invalid' };
    }
    if (value.precision === 'unknown' || (!start && !end)) {
      return { start, end, precision: String(value.precision), status: 'unknown' };
    }
    return { start, end, precision: String(value.precision), status: 'valid' };
  } catch {
    return { start, end, precision: String(value.precision), status: 'invalid' };
  }
}

function matchingReportTimeFields(row: EvidenceRetrievalRow, bounds: ParsedTimeBounds | null): ('published_at' | 'observed_at' | 'retrieved_at')[] {
  if (!bounds) return [];
  const fields: readonly ['published_at' | 'observed_at' | 'retrieved_at', string | null][] = [
    ['published_at', row.published_at], ['observed_at', row.observed_at], ['retrieved_at', row.retrieved_at],
  ];
  return fields.flatMap(([field, value]) => value && instantMatches(value, bounds) ? [field] : []);
}

function instantMatches(value: string, bounds: ParsedTimeBounds): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    && (bounds.from === null || parsed >= bounds.from.startMs)
    && (bounds.until === null || parsed <= bounds.until.endMs);
}

function matchesEventTime(eventTime: EvidenceRetrievalCandidate['eventTime'], bounds: ParsedTimeBounds | null): boolean {
  if (!bounds || eventTime.status !== 'valid' || (!eventTime.start && !eventTime.end)) return false;
  try {
    const eventStart = eventTime.start ? parseTimeValue(eventTime.start, 'stored event_time.start') : null;
    const eventEnd = eventTime.end ? parseTimeValue(eventTime.end, 'stored event_time.end') : null;
    const lower = eventStart?.startMs ?? Number.NEGATIVE_INFINITY;
    const upper = eventEnd?.endMs ?? Number.POSITIVE_INFINITY;
    return (bounds.until === null || lower <= bounds.until.endMs)
      && (bounds.from === null || upper >= bounds.from.startMs);
  } catch {
    return false;
  }
}

function matchedIdentifiers(row: EvidenceRetrievalRow, identifiers: readonly EvidenceRetrievalIdentifier[]): EvidenceRetrievalIdentifier[] {
  return identifiers.filter((identifier) => {
    if (identifier.kind === 'candidate') return identifier.value === row.candidate_id;
    if (identifier.kind === 'report_revision') return identifier.value === row.report_revision_id;
    return identifier.value === row.source_id;
  });
}

function passesStateFilters(row: EvidenceRetrievalRow, filters: EvidenceRetrievalFilters): boolean {
  return (!filters.revisionStatuses || filters.revisionStatuses.includes(row.revision_status))
    && (!filters.registryStatuses || filters.registryStatuses.includes(row.registry_status))
    && (!filters.approvalStatuses || filters.approvalStatuses.includes(row.approval_status))
    && (!filters.healthStatuses || filters.healthStatuses.includes(row.health_status));
}

function mapChunk(row: EvidenceRetrievalRow, missingStatus: EvidenceRetrievalChunk['embeddingStatus']): EvidenceRetrievalChunk | null {
  if (!row.chunk_id || row.chunk_span_start === null || row.chunk_span_end === null
    || !row.chunk_text_hash || !row.chunker_version) return null;
  const embeddingStatus = row.embedding_run_id ? 'matched' : missingStatus;
  return {
    chunkId: row.chunk_id,
    permittedTextHash: row.permitted_text_hash,
    chunkTextHash: row.chunk_text_hash,
    spanStart: row.chunk_span_start,
    spanEnd: row.chunk_span_end,
    chunkerVersion: row.chunker_version,
    embeddingStatus,
    embeddingRunId: row.embedding_run_id,
    embeddingProvider: row.embedding_provider,
    embeddingModelVersion: row.embedding_model_version,
    embeddingDimensions: row.embedding_dimensions,
    embeddingDistanceMetric: row.embedding_distance_metric,
    embeddingIndexVersion: row.embedding_index_version,
    semanticDistance: row.semantic_distance === null ? null : Number(row.semantic_distance),
  };
}

function parseJsonArray<T>(input: unknown): T[] {
  if (Array.isArray(input)) return input as T[];
  if (typeof input === 'string') {
    try {
      const parsed: unknown = JSON.parse(input);
      return Array.isArray(parsed) ? parsed as T[] : [];
    } catch {
      return [];
    }
  }
  return [];
}

function compareCandidates(left: EvidenceRetrievalCandidate, right: EvidenceRetrievalCandidate): number {
  const identifierDelta = right.matchFacets.identifiers.length - left.matchFacets.identifiers.length;
  if (identifierDelta !== 0) return identifierDelta;
  const termDelta = right.matchFacets.exactTerms.length - left.matchFacets.exactTerms.length;
  if (termDelta !== 0) return termDelta;
  const leftTime = left.matchFacets.reportTimeFields.length > 0 || left.matchFacets.eventTime;
  const rightTime = right.matchFacets.reportTimeFields.length > 0 || right.matchFacets.eventTime;
  if (leftTime !== rightTime) return rightTime ? 1 : -1;
  if (left.matchFacets.geometry !== right.matchFacets.geometry) return left.matchFacets.geometry ? -1 : 1;
  const leftDistance = left.matchFacets.semanticDistance;
  const rightDistance = right.matchFacets.semanticDistance;
  if (leftDistance !== null || rightDistance !== null) {
    if (leftDistance === null) return 1;
    if (rightDistance === null) return -1;
    if (leftDistance !== rightDistance) return leftDistance - rightDistance;
  }
  return (Date.parse(right.retrievedAt) - Date.parse(left.retrievedAt))
    || left.candidateId.localeCompare(right.candidateId)
    || left.reportRevisionId.localeCompare(right.reportRevisionId)
    || left.evidenceReferenceId.localeCompare(right.evidenceReferenceId);
}

function emptyResult(datasetKind: DatasetKind, semanticStatus: EvidenceRetrievalResult['semanticStatus']): EvidenceRetrievalResult {
  return {
    datasetKind,
    retrievalVersion: RETRIEVAL_VERSION,
    indexVersion: null,
    candidates: [],
    rowsExamined: 0,
    filteredRowsOmitted: 0,
    invalidSpanRowsOmitted: 0,
    scanTruncated: false,
    resultTruncated: false,
    semanticStatus,
  };
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    throw new Error(`Evidence retrieval ${name} is outside its hard bound`);
  }
  return result;
}

function boundedString(value: string, maximumCodePoints: number): boolean {
  return typeof value === 'string' && value.trim().length > 0 && codePointCount(value) <= maximumCodePoints;
}

function codePointCount(value: string): number {
  return Array.from(value).length;
}
