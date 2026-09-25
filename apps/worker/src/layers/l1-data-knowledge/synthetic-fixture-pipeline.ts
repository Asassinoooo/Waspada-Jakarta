import {
  parsePetabencanaGeoJson,
  type GeoJsonPosition,
  type PetabencanaGeometry,
  type ProviderIdentifier,
} from "./petabencana-geojson.js";
import { chunkPreparedText, type EvidenceChunkInput } from "./evidence-chunking.js";
import { preparePermittedText } from "./text-preparation.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

export interface FixtureSupportSpan {
  readonly spanStart: number;
  readonly spanEnd: number;
}

export interface SyntheticGeometryManifest {
  readonly geometryId: string;
  readonly role:
    | "incident_scene" | "affected_area" | "warning_boundary" | "route_segment"
    | "service_stop" | "facility" | "venue" | "service_area" | "approximate_place";
  readonly precisionM: number | null;
  readonly precisionBasis:
    | "source_supplied" | "provider_accuracy" | "gazetteer_match"
    | "moderator_generalization" | "unknown";
  readonly displayLabel: string | null;
  readonly supportSpans: readonly FixtureSupportSpan[];
}

export interface SyntheticReportManifest {
  /** Stable, caller-authored schema 2.0 identity; never derived from the provider feature ID. */
  readonly reportRevisionId: string;
  readonly sourceId: string;
  readonly canonicalUrl: string;
  readonly sourceRevisionKey?: string | null;
  readonly contentHash: string;
  readonly permittedText: string;
  readonly publishedAt: string | null;
  readonly observedAt: string | null;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
  readonly supersedesId: string | null;
  /** Explicit exact end-exclusive Unicode code-point ranges into prepared text. */
  readonly supportSpans: readonly FixtureSupportSpan[];
  readonly geometry?: SyntheticGeometryManifest;
}

export interface SyntheticFixture {
  /** Exact URL key. This is authored fixture metadata, never a fetched URL. */
  readonly url: string;
  /** Already-buffered GeoJSON source text. */
  readonly geoJson: string;
  readonly retrievedAt: string;
  readonly sourceId: string;
  readonly manifests: ReadonlyMap<ProviderIdentifier, SyntheticReportManifest>;
}

export interface SyntheticFixtureCatalog {
  lookupExact(url: string): SyntheticFixture | null;
}

/** A tiny exact-key catalog suitable for authored synthetic fixtures. */
export class InMemorySyntheticFixtureCatalog implements SyntheticFixtureCatalog {
  private readonly fixturesByUrl: ReadonlyMap<string, SyntheticFixture>;

  constructor(fixtures: readonly SyntheticFixture[]) {
    const byUrl = new Map<string, SyntheticFixture>();
    for (const fixture of fixtures) {
      if (byUrl.has(fixture.url)) throw new Error("Duplicate synthetic fixture URL");
      byUrl.set(fixture.url, fixture);
    }
    this.fixturesByUrl = byUrl;
  }

  lookupExact(url: string): SyntheticFixture | null {
    return this.fixturesByUrl.get(url) ?? null;
  }
}

export interface FixtureJobRecord {
  readonly jobId: string;
  readonly datasetKind: string;
  readonly jobKind: string;
  readonly traceId: string;
  readonly sourceId: string | null;
  readonly submittedUrl: string | null;
  readonly status: string;
  readonly leaseToken: string | null;
}

export interface FixtureSourceRecord {
  readonly accessMethod: string;
  readonly approvalStatus: string;
  readonly autoAcquisitionEnabled: boolean;
  readonly autoPublicationPolicy: string;
}

export interface FixtureRevisionInput {
  readonly datasetKind: "synthetic";
  readonly reportRevisionId: string;
  readonly traceId: string;
  readonly sourceId: string;
  readonly canonicalUrl: string;
  readonly sourceRevisionKey: string | null;
  readonly contentHash: string;
  readonly permittedText: string;
  readonly permittedTextHash: string;
  readonly normalizationVersion: string;
  readonly publishedAt: string | null;
  readonly observedAt: string | null;
  readonly retrievedAt: string;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
  readonly supersedesId: string | null;
  readonly revisionStatus: "unreviewed";
  readonly recordJson: Readonly<Record<string, unknown>>;
}

export interface FixtureEvidenceReferenceInput {
  readonly datasetKind: "synthetic";
  readonly traceId: string;
  readonly reportRevisionId: string;
  readonly permittedTextHash: string;
  readonly spanStart: number;
  readonly spanEnd: number;
  readonly relation: "supports";
}

export interface FixtureJobRepository {
  complete(datasetKind: "synthetic", jobId: string, leaseToken: string, now: string): Promise<{ readonly outcome: "updated" | "not_owned" }>;
  fail(
    datasetKind: "synthetic",
    jobId: string,
    leaseToken: string,
    input: { readonly failureCode: string; readonly disposition: "retryable" | "permanent"; readonly now: string },
  ): Promise<{ readonly outcome: "updated" | "not_owned"; readonly job?: { readonly status: string } }>;
}

export interface FixturePipelinePorts {
  readonly acquisitionJobs: FixtureJobRepository;
  readonly sourceRegistry: { findById(sourceId: string): Promise<FixtureSourceRecord | null> };
  readonly reportRevisions: {
    create(input: FixtureRevisionInput): Promise<void>;
    createEvidenceReference(input: FixtureEvidenceReferenceInput): Promise<string>;
  };
  readonly evidenceChunks: {
    persist(input: {
      readonly datasetKind: "synthetic";
      readonly traceId: string;
      readonly reportRevisionId: string;
      readonly permittedTextHash: string;
      readonly normalizationVersion: string;
      readonly chunks: readonly EvidenceChunkInput[];
    }): Promise<unknown>;
  };
  readonly geometryWriter: { persist(input: unknown): Promise<unknown> };
}

export type SyntheticFixtureFailureCode =
  | "fixture_not_found"
  | "fixture_catalog_failed"
  | "fixture_payload_invalid"
  | "fixture_manifest_invalid"
  | "fixture_source_invalid"
  | "fixture_text_invalid"
  | "fixture_persistence_failed"
  | "queue_acknowledgement_failed";

export type SyntheticFixturePipelineResult =
  | {
      readonly outcome: "completed";
      readonly empty: boolean;
      readonly reportCount: number;
      readonly evidenceReferenceCount: number;
      readonly chunkCount: number;
      readonly geometryCount: number;
    }
  | { readonly outcome: "not_eligible"; readonly code: "job_not_eligible" }
  | { readonly outcome: "lost_lease"; readonly code: "lease_not_owned" }
  | {
      readonly outcome: "failed";
      readonly code: SyntheticFixtureFailureCode;
      readonly queueOutcome: "retry" | "terminal" | "not_acknowledged";
    };

interface PipelineFailure {
  readonly code: SyntheticFixtureFailureCode;
  readonly disposition: "retryable" | "permanent";
}

class FixtureFailure extends Error implements PipelineFailure {
  constructor(readonly code: SyntheticFixtureFailureCode, readonly disposition: PipelineFailure["disposition"]) {
    super(code);
  }
}

export interface ProcessSyntheticFixtureInput {
  readonly job: FixtureJobRecord;
  readonly catalog: SyntheticFixtureCatalog;
  readonly ports: FixturePipelinePorts;
  /** Caller-supplied timestamp used for the lease transition; no clock is read here. */
  readonly transitionAt: string;
}

/** Process an already-leased synthetic moderator submission from an exact in-memory fixture. */
export async function processSyntheticFixtureJob(
  input: ProcessSyntheticFixtureInput,
): Promise<SyntheticFixturePipelineResult> {
  const { job, ports } = input;
  const leaseToken = job.leaseToken;
  if (job.status !== "leased" || job.datasetKind !== "synthetic"
    || job.jobKind !== "moderator_submission" || job.sourceId !== null
    || typeof job.submittedUrl !== "string" || !job.submittedUrl
    || typeof leaseToken !== "string" || !leaseToken.trim()
    || !isTimestamp(input.transitionAt)) {
    return { outcome: "not_eligible", code: "job_not_eligible" };
  }

  try {
    let fixture: SyntheticFixture | null;
    try {
      fixture = input.catalog.lookupExact(job.submittedUrl);
    } catch {
      throw new FixtureFailure("fixture_catalog_failed", "retryable");
    }
    if (!fixture) throw new FixtureFailure("fixture_not_found", "permanent");
    if (fixture.url !== job.submittedUrl) throw new FixtureFailure("fixture_not_found", "permanent");
    const parsed = parsePetabencanaGeoJson(fixture.geoJson, fixture.retrievedAt);
    if (parsed.kind === "error") throw new FixtureFailure("fixture_payload_invalid", "permanent");
    if (parsed.kind === "empty") {
      if (fixture.manifests.size !== 0) throw new FixtureFailure("fixture_manifest_invalid", "permanent");
      return complete(input, { empty: true, reportCount: 0, evidenceReferenceCount: 0, chunkCount: 0, geometryCount: 0 });
    }

    if (parsed.reports.some((report) => report.featureId === null)
      || parsed.reports.length !== fixture.manifests.size) {
      throw new FixtureFailure("fixture_manifest_invalid", "permanent");
    }

    let evidenceReferenceCount = 0;
    let chunkCount = 0;
    let geometryCount = 0;
    for (const report of parsed.reports) {
      const manifest = fixture.manifests.get(report.featureId!);
      if (!manifest || !isValidManifest(manifest, fixture)) {
        throw new FixtureFailure("fixture_manifest_invalid", "permanent");
      }
      const prepared = await preparePermittedText(manifest.permittedText)
        .catch(() => { throw new FixtureFailure("fixture_text_invalid", "permanent"); });
      if (!prepared.permittedText || !validSpans(manifest.supportSpans, prepared.permittedText)) {
        throw new FixtureFailure("fixture_manifest_invalid", "permanent");
      }
      const geometryManifest = manifest.geometry;
      if (geometryManifest && (!report.geometry
        || !validSpans(geometryManifest.supportSpans, prepared.permittedText)
        || !roleMatchesGeometry(geometryManifest.role, report.geometry))) {
        throw new FixtureFailure("fixture_manifest_invalid", "permanent");
      }
      if (report.geometry && geometryManifest && has3dPosition(report.geometry)) {
        throw new FixtureFailure("fixture_manifest_invalid", "permanent");
      }

      const source = await ports.sourceRegistry.findById(manifest.sourceId)
        .catch(() => { throw new FixtureFailure("fixture_persistence_failed", "retryable"); });
      if (!source || source.accessMethod !== "manual_fixture" || source.approvalStatus !== "approved"
        || source.autoAcquisitionEnabled !== false || source.autoPublicationPolicy !== "never") {
        throw new FixtureFailure("fixture_source_invalid", "permanent");
      }

      const revisionInput = makeRevisionInput(job, fixture, manifest, prepared);
      const chunks = await chunkPreparedText("synthetic", manifest.reportRevisionId, prepared)
        .catch(() => { throw new FixtureFailure("fixture_text_invalid", "permanent"); });

      try {
        await ports.reportRevisions.create(revisionInput);
        const allSpans = uniqueSpans([
          ...manifest.supportSpans,
          ...(geometryManifest?.supportSpans ?? []),
        ]);
        for (const span of allSpans) {
          await ports.reportRevisions.createEvidenceReference({
            datasetKind: "synthetic",
            traceId: job.traceId,
            reportRevisionId: manifest.reportRevisionId,
            permittedTextHash: prepared.permittedTextHash,
            spanStart: span.spanStart,
            spanEnd: span.spanEnd,
            relation: "supports",
          });
          evidenceReferenceCount += 1;
        }
        await ports.evidenceChunks.persist({
          datasetKind: "synthetic",
          traceId: job.traceId,
          reportRevisionId: manifest.reportRevisionId,
          permittedTextHash: prepared.permittedTextHash,
          normalizationVersion: prepared.normalizationVersion,
          chunks,
        });
        chunkCount += chunks.length;
        if (geometryManifest && report.geometry) {
          await ports.geometryWriter.persist(makeGeometryRecord(
            job, manifest, geometryManifest, report.geometry, prepared.permittedTextHash,
          ));
          geometryCount += 1;
        }
      } catch {
        throw new FixtureFailure("fixture_persistence_failed", "retryable");
      }
    }

    return complete(input, {
      empty: false,
      reportCount: parsed.reports.length,
      evidenceReferenceCount,
      chunkCount,
      geometryCount,
    });
  } catch (error) {
    const failure: PipelineFailure = error instanceof FixtureFailure
      ? error
      : { code: "fixture_persistence_failed", disposition: "retryable" };
    try {
      const transition = await ports.acquisitionJobs.fail("synthetic", job.jobId, leaseToken, {
        failureCode: failure.code,
        disposition: failure.disposition,
        now: input.transitionAt,
      });
      if (transition.outcome === "not_owned") return { outcome: "lost_lease", code: "lease_not_owned" };
      return {
        outcome: "failed",
        code: failure.code,
        queueOutcome: transition.job?.status === "terminal" ? "terminal" : "retry",
      };
    } catch {
      return { outcome: "failed", code: failure.code, queueOutcome: "not_acknowledged" };
    }
  }
}

async function complete(
  input: ProcessSyntheticFixtureInput,
  counts: Omit<Extract<SyntheticFixturePipelineResult, { outcome: "completed" }>, "outcome">,
): Promise<SyntheticFixturePipelineResult> {
  let transition: Awaited<ReturnType<FixtureJobRepository["complete"]>>;
  try {
    transition = await input.ports.acquisitionJobs.complete(
      "synthetic", input.job.jobId, input.job.leaseToken!, input.transitionAt,
    );
  } catch {
    // A thrown acknowledgement may have committed before the connection failed.
    // Do not issue a second transition against that uncertain state.
    return { outcome: "failed", code: "queue_acknowledgement_failed", queueOutcome: "not_acknowledged" };
  }
  if (transition.outcome === "not_owned") return { outcome: "lost_lease", code: "lease_not_owned" };
  return { outcome: "completed", ...counts };
}

function makeRevisionInput(
  job: FixtureJobRecord,
  fixture: SyntheticFixture,
  manifest: SyntheticReportManifest,
  prepared: Awaited<ReturnType<typeof preparePermittedText>>,
): FixtureRevisionInput {
  const recordJson = {
    schema_version: "2.0",
    trace_id: job.traceId,
    record_type: "ReportRevision",
    dataset_kind: "synthetic",
    report_revision_id: manifest.reportRevisionId,
    source_id: manifest.sourceId,
    canonical_url: manifest.canonicalUrl,
    source_revision_key: manifest.sourceRevisionKey ?? null,
    content_hash: manifest.contentHash,
    permitted_text: prepared.permittedText,
    permitted_text_hash: prepared.permittedTextHash,
    normalization_version: prepared.normalizationVersion,
    published_at: manifest.publishedAt,
    observed_at: manifest.observedAt,
    retrieved_at: fixture.retrievedAt,
    validity: { valid_from: manifest.validFrom, valid_until: manifest.validUntil },
    supersedes_id: manifest.supersedesId,
    revision_status: "unreviewed",
  };
  return {
    datasetKind: "synthetic",
    reportRevisionId: manifest.reportRevisionId,
    traceId: job.traceId,
    sourceId: manifest.sourceId,
    canonicalUrl: manifest.canonicalUrl,
    sourceRevisionKey: manifest.sourceRevisionKey ?? null,
    contentHash: manifest.contentHash,
    permittedText: prepared.permittedText,
    permittedTextHash: prepared.permittedTextHash,
    normalizationVersion: prepared.normalizationVersion,
    publishedAt: manifest.publishedAt,
    observedAt: manifest.observedAt,
    retrievedAt: fixture.retrievedAt,
    validFrom: manifest.validFrom,
    validUntil: manifest.validUntil,
    supersedesId: manifest.supersedesId,
    revisionStatus: "unreviewed",
    recordJson,
  };
}

function makeGeometryRecord(
  job: FixtureJobRecord,
  manifest: SyntheticReportManifest,
  geometryManifest: SyntheticGeometryManifest,
  geometry: PetabencanaGeometry,
  permittedTextHash: string,
): Readonly<Record<string, unknown>> {
  return {
    schema_version: "2.0",
    trace_id: job.traceId,
    record_type: "Geometry",
    dataset_kind: "synthetic",
    geometry_id: geometryManifest.geometryId,
    role: geometryManifest.role,
    geojson: to2dGeometry(geometry),
    coordinate_reference_system: "OGC:CRS84",
    precision_m: geometryManifest.precisionM,
    precision_basis: geometryManifest.precisionBasis,
    display_label: geometryManifest.displayLabel,
    source_evidence: geometryManifest.supportSpans.map((span) => ({
      report_revision_id: manifest.reportRevisionId,
      permitted_text_hash: permittedTextHash,
      span_start: span.spanStart,
      span_end: span.spanEnd,
      offset_unit: "unicode_code_points",
      relation: "supports",
    })),
  };
}

function to2dGeometry(geometry: PetabencanaGeometry): Readonly<Record<string, unknown>> {
  const mapPosition = (position: GeoJsonPosition): readonly [number, number] => {
    if (position.length !== 2) throw new FixtureFailure("fixture_manifest_invalid", "permanent");
    return [position[0], position[1]];
  };
  switch (geometry.type) {
    case "Point": return { type: geometry.type, coordinates: mapPosition(geometry.coordinates) };
    case "MultiPoint":
    case "LineString": return { type: geometry.type, coordinates: geometry.coordinates.map(mapPosition) };
    case "MultiLineString":
    case "Polygon": return {
      type: geometry.type,
      coordinates: geometry.coordinates.map((line) => line.map(mapPosition)),
    };
    case "MultiPolygon": return {
      type: geometry.type,
      coordinates: geometry.coordinates.map((polygon) => polygon.map((ring) => ring.map(mapPosition))),
    };
  }
}

function isValidManifest(manifest: SyntheticReportManifest, fixture: SyntheticFixture): boolean {
  return isId(manifest.reportRevisionId)
    && manifest.sourceId === fixture.sourceId && isId(manifest.sourceId)
    && manifest.canonicalUrl === fixture.url
    && (manifest.sourceRevisionKey === undefined || manifest.sourceRevisionKey === null
      || (typeof manifest.sourceRevisionKey === "string" && manifest.sourceRevisionKey.length <= 256))
    && isHash(manifest.contentHash)
    && typeof manifest.permittedText === "string"
    && validOptionalTimestamp(manifest.publishedAt)
    && validOptionalTimestamp(manifest.observedAt)
    && validOptionalTimestamp(manifest.validFrom)
    && validOptionalTimestamp(manifest.validUntil)
    && (manifest.supersedesId === null || isId(manifest.supersedesId))
    && Array.isArray(manifest.supportSpans) && manifest.supportSpans.length > 0
    && (!manifest.geometry || isValidGeometryManifest(manifest.geometry));
}

function isValidGeometryManifest(value: SyntheticGeometryManifest): boolean {
  return isId(value.geometryId)
    && ["incident_scene", "affected_area", "warning_boundary", "route_segment", "service_stop",
      "facility", "venue", "service_area", "approximate_place"].includes(value.role)
    && (value.precisionM === null || (Number.isFinite(value.precisionM) && value.precisionM >= 0 && value.precisionM <= 10_000_000))
    && ["source_supplied", "provider_accuracy", "gazetteer_match", "moderator_generalization", "unknown"]
      .includes(value.precisionBasis)
    && (value.displayLabel === null || (typeof value.displayLabel === "string" && value.displayLabel.length <= 200))
    && Array.isArray(value.supportSpans) && value.supportSpans.length > 0;
}

function validSpans(spans: readonly FixtureSupportSpan[], text: string): boolean {
  const length = Array.from(text).length;
  return spans.length > 0 && spans.every((span) => Number.isInteger(span.spanStart)
    && Number.isInteger(span.spanEnd) && span.spanStart >= 0
    && span.spanEnd > span.spanStart && span.spanEnd <= length);
}

function uniqueSpans(spans: readonly FixtureSupportSpan[]): readonly FixtureSupportSpan[] {
  const result = new Map<string, FixtureSupportSpan>();
  for (const span of spans) result.set(`${span.spanStart}:${span.spanEnd}`, span);
  return [...result.values()];
}

function roleMatchesGeometry(role: SyntheticGeometryManifest["role"], geometry: PetabencanaGeometry): boolean {
  const point = ["incident_scene", "service_stop", "facility", "venue", "approximate_place"].includes(role);
  const line = role === "route_segment";
  const area = ["affected_area", "warning_boundary", "service_area"].includes(role);
  return point ? geometry.type === "Point" || geometry.type === "MultiPoint"
    : line ? geometry.type === "LineString" || geometry.type === "MultiLineString"
      : area ? geometry.type === "Polygon" || geometry.type === "MultiPolygon" : false;
}

function has3dPosition(geometry: PetabencanaGeometry): boolean {
  const positions: GeoJsonPosition[] = [];
  switch (geometry.type) {
    case "Point": positions.push(geometry.coordinates); break;
    case "MultiPoint":
    case "LineString": positions.push(...geometry.coordinates); break;
    case "MultiLineString":
    case "Polygon": for (const line of geometry.coordinates) positions.push(...line); break;
    case "MultiPolygon": for (const polygon of geometry.coordinates) for (const ring of polygon) positions.push(...ring); break;
  }
  return positions.some((position) => position.length !== 2);
}

function validOptionalTimestamp(value: string | null): boolean {
  return value === null || isTimestamp(value);
}

function isTimestamp(value: string): boolean {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysPerMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > daysPerMonth[month - 1]!) return false;
  const offset = match[7]!;
  if (offset !== "Z" && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4, 6)) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}

function isId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH_PATTERN.test(value);
}
