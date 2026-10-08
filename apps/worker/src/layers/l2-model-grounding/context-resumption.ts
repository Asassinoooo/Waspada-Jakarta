import type {
  GroundingContextReadRepository,
  GroundingContextRecord,
  GroundingEvidenceReference,
} from "../../../../db/src/grounding-contexts.js";
import {
  ExactEvidenceSpanReadError,
  MAX_EXACT_EVIDENCE_SPAN_CODE_POINTS,
  type ExactEvidenceReferenceIdentity,
  type ExactEvidenceReferenceReader,
  type ExactEvidenceReferenceSnapshot,
  type ExactEvidenceSpanReader,
  type ExactEvidenceSpanRequest,
} from "../../../../db/src/evidence-retrieval.js";
import type { DatasetKind, EvidenceRelation, ReasoningRequest, RevisionStatus } from "./contracts.js";
import { validateReasoningRequest } from "./validation.js";

export interface GroundingContextResumer {
  resume(datasetKind: DatasetKind, contextId: string): Promise<ReasoningRequest | null>;
}

export interface GroundingContextResumerDependencies {
  /** The exact refs-only context read; this boundary never writes. */
  readonly contexts: Pick<GroundingContextReadRepository, "findById">;
  readonly evidenceReferences: ExactEvidenceReferenceReader;
  readonly exactSpans: ExactEvidenceSpanReader;
}

export type GroundingContextResumptionErrorCode =
  | "invalid_resume_key"
  | "context_read_failed"
  | "invalid_context"
  | "revision_state_mismatch"
  | "evidence_read_failed"
  | "reference_not_found"
  | "duplicate_reference"
  | "evidence_identity_mismatch"
  | "evidence_invalid"
  | "source_ineligible"
  | "source_invalidated"
  | "span_too_large"
  | "excerpt_read_failed"
  | "excerpt_invalid"
  | "request_validation_failed";

/** Fixed, content-free failures raised while resuming a persisted context. */
export class GroundingContextResumptionError extends Error {
  constructor(readonly code: GroundingContextResumptionErrorCode) {
    super(code);
    this.name = "GroundingContextResumptionError";
  }
}

const DATASET_KINDS = new Set<DatasetKind>(["live", "historical", "synthetic"]);
const REVISION_STATUSES = new Set<RevisionStatus>([
  "unreviewed", "eligible", "quarantined", "superseded", "retracted",
]);
const EVIDENCE_RELATIONS = new Set<EvidenceRelation>(["supports", "contradicts", "updates", "context"]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const CONTEXT_FIELDS = [
  "schema_version", "trace_id", "record_type", "dataset_kind", "context_id", "candidate_id",
  "evidence", "revision_states", "candidate_events", "prior_decision_ids", "missing_fields",
  "conflicts", "retrieval_version", "index_version", "sufficient",
] as const;
const EVIDENCE_FIELDS = [
  "report_revision_id", "permitted_text_hash", "span_start", "span_end", "offset_unit", "relation",
] as const;

/**
 * Creates the Layer 2 restart boundary. The caller supplies only the exact
 * dataset and context key; all evidence and metadata are re-read from storage.
 */
export function createGroundingContextResumer(
  dependencies: GroundingContextResumerDependencies,
): GroundingContextResumer {
  return {
    async resume(datasetKind: DatasetKind, contextId: string): Promise<ReasoningRequest | null> {
      if (!DATASET_KINDS.has(datasetKind) || typeof contextId !== "string" || !ID_PATTERN.test(contextId)) {
        throw new GroundingContextResumptionError("invalid_resume_key");
      }

      let persisted: GroundingContextRecord | null;
      try {
        persisted = await dependencies.contexts.findById(datasetKind, contextId);
      } catch {
        throw new GroundingContextResumptionError("context_read_failed");
      }
      if (persisted === null) return null;

      const record = validateResumeRecord(persisted, datasetKind, contextId);
      const savedRevisionStates = revisionStateMap(record);
      const evidenceRevisionIds = new Set(record.evidence.map((reference) => reference.report_revision_id));
      if (savedRevisionStates.size !== evidenceRevisionIds.size
        || [...evidenceRevisionIds].some((revisionId) => !savedRevisionStates.has(revisionId))) {
        throw new GroundingContextResumptionError("revision_state_mismatch");
      }

      const identities = record.evidence.map(toReferenceIdentity);
      let snapshots: readonly ExactEvidenceReferenceSnapshot[];
      try {
        snapshots = await dependencies.evidenceReferences.readExactReferences({
          datasetKind: record.dataset_kind,
          candidateId: record.candidate_id,
          references: identities,
        });
      } catch {
        throw new GroundingContextResumptionError("evidence_read_failed");
      }

      const resolved = resolveSnapshots(record, identities, snapshots, savedRevisionStates);
      const evidence = [];
      for (const reference of record.evidence) {
        const snapshot = resolved.get(referenceIdentityKey(reference));
        if (!snapshot) throw new GroundingContextResumptionError("reference_not_found");
        if (reference.span_end - reference.span_start > MAX_EXACT_EVIDENCE_SPAN_CODE_POINTS) {
          throw new GroundingContextResumptionError("span_too_large");
        }
        const spanRequest: ExactEvidenceSpanRequest = {
          datasetKind: record.dataset_kind,
          candidateId: record.candidate_id,
          evidenceReferenceId: snapshot.evidenceReferenceId,
          reportRevisionId: reference.report_revision_id,
          permittedTextHash: reference.permitted_text_hash,
          spanStart: reference.span_start,
          spanEnd: reference.span_end,
          offsetUnit: reference.offset_unit,
          relation: reference.relation,
          revisionStatus: snapshot.revisionStatus,
        };
        let span: Awaited<ReturnType<ExactEvidenceSpanReader["readExactSpan"]>>;
        try {
          span = await dependencies.exactSpans.readExactSpan(spanRequest);
        } catch (error) {
          if (error instanceof ExactEvidenceSpanReadError && error.code === "source_invalidated") {
            throw new GroundingContextResumptionError("source_invalidated");
          }
          if (error instanceof ExactEvidenceSpanReadError && error.code === "span_too_large") {
            throw new GroundingContextResumptionError("span_too_large");
          }
          throw new GroundingContextResumptionError("excerpt_read_failed");
        }
        if (!sameExactSpan(span, spanRequest)
          || typeof span.text !== "string"
          || Array.from(span.text).length !== reference.span_end - reference.span_start
          || Array.from(span.text).length > MAX_EXACT_EVIDENCE_SPAN_CODE_POINTS) {
          throw new GroundingContextResumptionError("excerpt_invalid");
        }

        evidence.push({
          reference: {
            reportRevisionId: reference.report_revision_id,
            permittedTextHash: reference.permitted_text_hash,
            spanStart: reference.span_start,
            spanEnd: reference.span_end,
            offsetUnit: reference.offset_unit,
            relation: reference.relation,
          },
          text: span.text,
          sourceId: snapshot.sourceId,
          revisionStatus: snapshot.revisionStatus,
          publishedAt: snapshot.publishedAt,
          observedAt: snapshot.observedAt,
          retrievedAt: snapshot.retrievedAt,
          origins: snapshot.origins.map((origin) => ({
            originId: origin.originId,
            independenceStatus: origin.independenceStatus,
            dependsOnOriginIds: [...origin.dependsOnOriginIds],
          })),
        });
      }

      const untrustedRequest = {
        data: {
          groundingContext: {
            schemaVersion: record.schema_version,
            recordType: record.record_type,
            datasetKind: record.dataset_kind,
            traceId: record.trace_id,
            contextId: record.context_id,
            candidateId: record.candidate_id,
            evidence,
            revisionStates: record.revision_states.map((state) => ({
              reportRevisionId: state.report_revision_id,
              revisionStatus: state.revision_status,
            })),
            candidateEvents: record.candidate_events.map((event) => ({
              eventId: event.event_id,
              eventVersion: event.event_version,
            })),
            priorDecisionIds: [...record.prior_decision_ids],
            missingFields: [...record.missing_fields],
            conflicts: [...record.conflicts],
            retrievalVersion: record.retrieval_version,
            indexVersion: record.index_version,
            sufficient: record.sufficient,
          },
        },
      };
      try {
        return await validateReasoningRequest(untrustedRequest);
      } catch {
        throw new GroundingContextResumptionError("request_validation_failed");
      }
    },
  };
}

function resolveSnapshots(
  record: GroundingContextRecord,
  identities: readonly ExactEvidenceReferenceIdentity[],
  snapshots: readonly ExactEvidenceReferenceSnapshot[],
  revisionStates: ReadonlyMap<string, RevisionStatus>,
): ReadonlyMap<string, ExactEvidenceReferenceSnapshot> {
  if (!Array.isArray(snapshots) || snapshots.length > identities.length * 2) {
    throw new GroundingContextResumptionError("evidence_invalid");
  }
  const expectedKeys = new Set(identities.map(referenceIdentityKey));
  const grouped = new Map<string, ExactEvidenceReferenceSnapshot[]>();
  for (const snapshot of snapshots) {
    if (!isValidSnapshot(snapshot)) throw new GroundingContextResumptionError("evidence_invalid");
    if (snapshot.datasetKind !== record.dataset_kind || snapshot.candidateId !== record.candidate_id) {
      throw new GroundingContextResumptionError("evidence_identity_mismatch");
    }
    const key = referenceIdentityKey(snapshot);
    if (!expectedKeys.has(key)) throw new GroundingContextResumptionError("evidence_identity_mismatch");
    const matches = grouped.get(key) ?? [];
    matches.push(snapshot);
    grouped.set(key, matches);
  }

  const resolved = new Map<string, ExactEvidenceReferenceSnapshot>();
  for (const identity of identities) {
    const key = referenceIdentityKey(identity);
    const matches = grouped.get(key) ?? [];
    if (matches.length === 0) throw new GroundingContextResumptionError("reference_not_found");
    if (matches.length !== 1) throw new GroundingContextResumptionError("duplicate_reference");
    const snapshot = matches[0]!;
    if (snapshot.revisionStatus !== revisionStates.get(identity.reportRevisionId)) {
      throw new GroundingContextResumptionError("revision_state_mismatch");
    }
    if (snapshot.registryStatus !== "active" || snapshot.approvalStatus !== "approved") {
      throw new GroundingContextResumptionError("source_ineligible");
    }
    resolved.set(key, snapshot);
  }
  return resolved;
}

function validateResumeRecord(
  input: GroundingContextRecord,
  datasetKind: DatasetKind,
  contextId: string,
): GroundingContextRecord {
  const record = exactRecord(input, CONTEXT_FIELDS);
  if (record.schema_version !== "2.0" || record.record_type !== "GroundingContext"
    || record.dataset_kind !== datasetKind || record.context_id !== contextId
    || !isId(record.trace_id) || !isId(record.candidate_id)
    || !Array.isArray(record.evidence) || record.evidence.length > 8
    || !Array.isArray(record.revision_states) || record.revision_states.length > 8
    || !Array.isArray(record.candidate_events)
    || record.candidate_events.length > 20
    || !Array.isArray(record.prior_decision_ids) || !Array.isArray(record.missing_fields)
    || !Array.isArray(record.conflicts) || typeof record.retrieval_version !== "string"
    || !isId(record.retrieval_version) || typeof record.index_version !== "string"
    || !isId(record.index_version) || typeof record.sufficient !== "boolean") {
    throw new GroundingContextResumptionError("invalid_context");
  }

  const evidence = record.evidence.map((reference) => {
    const value = exactRecord(reference, EVIDENCE_FIELDS);
    if (!isId(value.report_revision_id) || typeof value.permitted_text_hash !== "string"
      || !HASH_PATTERN.test(value.permitted_text_hash)
      || !Number.isSafeInteger(value.span_start) || (value.span_start as number) < 0
      || !Number.isSafeInteger(value.span_end) || (value.span_end as number) <= (value.span_start as number)
      || (value.span_end as number) > 10_000_000 || value.offset_unit !== "unicode_code_points"
      || typeof value.relation !== "string" || !EVIDENCE_RELATIONS.has(value.relation as EvidenceRelation)) {
      throw new GroundingContextResumptionError("invalid_context");
    }
    return {
      report_revision_id: value.report_revision_id as string,
      permitted_text_hash: value.permitted_text_hash,
      span_start: value.span_start as number,
      span_end: value.span_end as number,
      offset_unit: "unicode_code_points" as const,
      relation: value.relation as EvidenceRelation,
    } satisfies GroundingEvidenceReference;
  });
  const identities = new Set<string>();
  for (const reference of evidence) {
    const key = referenceIdentityKey(reference);
    if (identities.has(key)) throw new GroundingContextResumptionError("duplicate_reference");
    identities.add(key);
  }

  const revisionStates = record.revision_states.map((state) => {
    const value = exactRecord(state, ["report_revision_id", "revision_status"]);
    if (!isId(value.report_revision_id) || typeof value.revision_status !== "string"
      || !REVISION_STATUSES.has(value.revision_status as RevisionStatus)) {
      throw new GroundingContextResumptionError("invalid_context");
    }
    return {
      report_revision_id: value.report_revision_id,
      revision_status: value.revision_status as RevisionStatus,
    };
  });
  const revisionIds = new Set<string>();
  for (const state of revisionStates) {
    if (revisionIds.has(state.report_revision_id)) {
      throw new GroundingContextResumptionError("revision_state_mismatch");
    }
    revisionIds.add(state.report_revision_id);
  }

  const candidateEvents = record.candidate_events.map((event) => {
    const value = exactRecord(event, ["event_id", "event_version"]);
    if (!isId(value.event_id) || !Number.isSafeInteger(value.event_version)
      || (value.event_version as number) < 1 || (value.event_version as number) > 2_147_483_647) {
      throw new GroundingContextResumptionError("invalid_context");
    }
    return { event_id: value.event_id, event_version: value.event_version as number };
  });

  const priorDecisionIds = checkedUniqueStrings(record.prior_decision_ids, 100, true);
  const missingFields = checkedUniqueStrings(record.missing_fields, 100, false);
  const conflicts = checkedUniqueStrings(record.conflicts, 100, false);
  return {
    schema_version: "2.0",
    trace_id: record.trace_id as string,
    record_type: "GroundingContext",
    dataset_kind: datasetKind,
    context_id: contextId,
    candidate_id: record.candidate_id as string,
    evidence,
    revision_states: revisionStates,
    candidate_events: candidateEvents,
    prior_decision_ids: priorDecisionIds,
    missing_fields: missingFields,
    conflicts,
    retrieval_version: record.retrieval_version as string,
    index_version: record.index_version as string,
    sufficient: record.sufficient,
  };
}

function revisionStateMap(record: GroundingContextRecord): ReadonlyMap<string, RevisionStatus> {
  return new Map(record.revision_states.map(({ report_revision_id, revision_status }) => [
    report_revision_id, revision_status,
  ]));
}

function toReferenceIdentity(reference: GroundingEvidenceReference): ExactEvidenceReferenceIdentity {
  return {
    reportRevisionId: reference.report_revision_id,
    permittedTextHash: reference.permitted_text_hash,
    spanStart: reference.span_start,
    spanEnd: reference.span_end,
    offsetUnit: reference.offset_unit,
    relation: reference.relation,
  };
}

function referenceIdentityKey(reference: {
  readonly report_revision_id?: string;
  readonly permitted_text_hash?: string;
  readonly span_start?: number;
  readonly span_end?: number;
  readonly offset_unit?: string;
  readonly relation?: string;
  readonly reportRevisionId?: string;
  readonly permittedTextHash?: string;
  readonly spanStart?: number;
  readonly spanEnd?: number;
  readonly offsetUnit?: string;
}): string {
  return JSON.stringify([
    reference.report_revision_id ?? reference.reportRevisionId,
    reference.permitted_text_hash ?? reference.permittedTextHash,
    reference.span_start ?? reference.spanStart,
    reference.span_end ?? reference.spanEnd,
    reference.offset_unit ?? reference.offsetUnit,
    reference.relation,
  ]);
}

function isValidSnapshot(value: unknown): value is ExactEvidenceReferenceSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as ExactEvidenceReferenceSnapshot;
  return typeof snapshot.evidenceReferenceId === "string" && /^[1-9][0-9]{0,18}$/.test(snapshot.evidenceReferenceId)
    && isId(snapshot.reportRevisionId) && typeof snapshot.permittedTextHash === "string"
    && HASH_PATTERN.test(snapshot.permittedTextHash)
    && Number.isSafeInteger(snapshot.spanStart) && snapshot.spanStart >= 0
    && Number.isSafeInteger(snapshot.spanEnd) && snapshot.spanEnd > snapshot.spanStart
    && snapshot.offsetUnit === "unicode_code_points"
    && typeof snapshot.relation === "string" && EVIDENCE_RELATIONS.has(snapshot.relation)
    && REVISION_STATUSES.has(snapshot.revisionStatus)
    && isId(snapshot.sourceId)
    && ["active", "paused", "retired"].includes(snapshot.registryStatus)
    && ["pending", "approved", "suspended", "revoked"].includes(snapshot.approvalStatus)
    && ["unknown", "healthy", "degraded", "unavailable"].includes(snapshot.healthStatus)
    && (snapshot.publishedAt === null || typeof snapshot.publishedAt === "string")
    && (snapshot.observedAt === null || typeof snapshot.observedAt === "string")
    && typeof snapshot.retrievedAt === "string"
    && Array.isArray(snapshot.origins)
    && snapshot.origins.every((origin) => origin !== null && typeof origin === "object"
      && isId(origin.originId)
      && ["established", "dependent", "unknown"].includes(origin.independenceStatus)
      && Array.isArray(origin.dependsOnOriginIds) && origin.dependsOnOriginIds.every(isId));
}

function sameExactSpan(
  actual: Awaited<ReturnType<ExactEvidenceSpanReader["readExactSpan"]>>,
  expected: ExactEvidenceSpanRequest,
): boolean {
  return actual.datasetKind === expected.datasetKind
    && actual.candidateId === expected.candidateId
    && actual.evidenceReferenceId === expected.evidenceReferenceId
    && actual.reportRevisionId === expected.reportRevisionId
    && actual.permittedTextHash === expected.permittedTextHash
    && actual.spanStart === expected.spanStart
    && actual.spanEnd === expected.spanEnd
    && actual.offsetUnit === expected.offsetUnit
    && actual.relation === expected.relation
    && actual.revisionStatus === expected.revisionStatus;
}

function exactRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new GroundingContextResumptionError("invalid_context");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new GroundingContextResumptionError("invalid_context");
  }
  const keys = Reflect.ownKeys(value);
  const expected = new Set(fields);
  if (keys.some((key) => typeof key !== "string" || !expected.has(key))
    || fields.some((field) => !Object.prototype.hasOwnProperty.call(value, field))) {
    throw new GroundingContextResumptionError("invalid_context");
  }
  return value as Record<string, unknown>;
}

function checkedUniqueStrings(value: unknown, maximumItems: number, idsOnly: boolean): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new GroundingContextResumptionError("invalid_context");
  }
  const result = value.map((entry) => {
    if (typeof entry !== "string" || Array.from(entry).length === 0 || Array.from(entry).length > 500
      || (idsOnly && !isId(entry))) {
      throw new GroundingContextResumptionError("invalid_context");
    }
    return entry;
  });
  if (new Set(result).size !== result.length) throw new GroundingContextResumptionError("invalid_context");
  return result;
}

function isId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}
