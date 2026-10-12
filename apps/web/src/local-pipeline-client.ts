import {
  LOCAL_PIPELINE_PREVIEW_PATH,
  LOCAL_PIPELINE_PREVIEW_SCHEMA,
  type LocalPipelinePreview,
  type LocalPreviewClaim,
  type LocalPreviewEvidence,
  type LocalPreviewJob,
  type LocalPreviewReport,
} from "../../worker/src/contracts/local-pipeline-preview.js";

export type {
  LocalPipelinePreview,
  LocalPreviewClaim,
  LocalPreviewEvidence,
  LocalPreviewJob,
  LocalPreviewReport,
};

const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_REPORTS = 20;
const MAX_CLAIMS_PER_REPORT = 20;
const MAX_EVIDENCE_PER_CLAIM = 24;
const MAX_EVIDENCE_PER_RELATION = 8;
const MAX_TEXT_CODE_POINTS = 4_096;
const MAX_TITLE_CODE_POINTS = 300;
const MAX_CLAIM_CODE_POINTS = 4_000;
const MAX_UNRESOLVED_COUNT = 200;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_COUNT = 1_000_000;
const JOB_STATUSES = ["pending", "leased", "retry", "completed", "terminal"] as const;
const FAILURE_CODES = [
  "l1_failed",
  "prerequisite_pending",
  "model_timeout",
  "model_failed",
  "invalid_output",
  "context_insufficient",
  "persistence_failed",
  "lease_expired",
] as const;
const STAGES = ["extraction", "embedding", "grounding", "reasoning", "proposal"] as const;
const RELATIONS = ["supports", "contradicts", "updates", "context"] as const;
const ASSESSMENTS = ["supported", "uncertain", "disputed"] as const;
const SCHEDULER_STATUSES = ["idle", "running", "completed", "failed"] as const;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const STATUS_KEYS = ["pending", "leased", "retry", "completed", "terminal"] as const;
const TOP_LEVEL_KEYS = [
  "schemaVersion", "datasetKind", "publicationEnabled", "generatedAt", "sourceId", "models",
  "scheduler", "summary", "reports", "truncated",
] as const;
const SCHEDULER_KEYS = ["status", "polls", "collectionFailures"] as const;
const SUMMARY_KEYS = ["snapshots", "ingestion", "ai", "proposals"] as const;
const JOB_KEYS = ["status", "attempts", "availableAt", "failure"] as const;
const REPORT_KEYS = [
  "reportId", "version", "title", "publishedAt", "observedAt", "capturedAt",
  "reportRevisionId", "supersedesId", "contentHash", "permittedText", "permittedTextHash",
  "ingestion", "ai", "stages", "proposal",
] as const;
const PROPOSAL_KEYS = ["proposalId", "proposedAt", "claims", "unresolvedCount"] as const;
const CLAIM_KEYS = ["claimId", "text", "assessment", "evidence"] as const;
const EVIDENCE_KEYS = ["reportRevisionId", "permittedTextHash", "spanStart", "spanEnd", "relation"] as const;

export class LocalPipelinePreviewError extends Error {
  constructor() {
    super("Pratinjau pipeline lokal tidak dapat dibaca.");
    this.name = "LocalPipelinePreviewError";
  }
}

function fail(): never {
  throw new LocalPipelinePreviewError();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isMember<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function isSafeText(value: unknown, maximum: number, allowEmpty = false, allowLineBreaks = false): value is string {
  const forbiddenControls = allowLineBreaks
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u
    : /[\u0000-\u001f\u007f-\u009f]/u;
  return typeof value === "string"
    && (allowEmpty || value.length > 0)
    && codePointLength(value) <= maximum
    && !forbiddenControls.test(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_IDENTIFIER_LENGTH && IDENTIFIER_PATTERN.test(value);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

function isInstant(value: unknown): value is string {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  const second = Number(value.slice(17, 19));
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(0, 0, 0, 0);
  return calendar.getUTCFullYear() === year
    && calendar.getUTCMonth() === month - 1
    && calendar.getUTCDate() === day
    && hour <= 23 && minute <= 59 && second <= 59;
}

function isNullableInstant(value: unknown): value is string | null {
  return value === null || isInstant(value);
}

function isBoundedCount(value: unknown, maximum = MAX_COUNT): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function parseJob(value: unknown): LocalPreviewJob {
  if (!isObject(value) || !hasExactKeys(value, JOB_KEYS)
    || !isMember(value.status, JOB_STATUSES)
    || !isBoundedCount(value.attempts, 10_000)
    || !isInstant(value.availableAt)
    || !(value.failure === null || isMember(value.failure, FAILURE_CODES))) {
    return fail();
  }
  return {
    status: value.status,
    attempts: value.attempts,
    availableAt: value.availableAt,
    failure: value.failure,
  };
}

function parseEvidence(value: unknown): LocalPreviewEvidence {
  if (!isObject(value) || !hasExactKeys(value, EVIDENCE_KEYS)
    || !isIdentifier(value.reportRevisionId)
    || !isHash(value.permittedTextHash)
    || !isBoundedCount(value.spanStart, MAX_TEXT_CODE_POINTS)
    || !isBoundedCount(value.spanEnd, MAX_TEXT_CODE_POINTS)
    || value.spanEnd <= value.spanStart
    || !isMember(value.relation, RELATIONS)) {
    return fail();
  }
  return {
    reportRevisionId: value.reportRevisionId,
    permittedTextHash: value.permittedTextHash,
    spanStart: value.spanStart,
    spanEnd: value.spanEnd,
    relation: value.relation,
  };
}

function parseClaim(value: unknown): LocalPreviewClaim {
  if (!isObject(value) || !hasExactKeys(value, CLAIM_KEYS)
    || !isIdentifier(value.claimId)
    || !isSafeText(value.text, MAX_CLAIM_CODE_POINTS, false, true)
    || !isMember(value.assessment, ASSESSMENTS)
    || !Array.isArray(value.evidence)
    || value.evidence.length > MAX_EVIDENCE_PER_CLAIM) {
    return fail();
  }
  const evidence = value.evidence.map(parseEvidence);
  const relationCounts = new Map<(typeof RELATIONS)[number], number>();
  for (const item of evidence) {
    const count = (relationCounts.get(item.relation) ?? 0) + 1;
    if (count > MAX_EVIDENCE_PER_RELATION) return fail();
    relationCounts.set(item.relation, count);
  }
  return {
    claimId: value.claimId,
    text: value.text,
    assessment: value.assessment,
    evidence,
  };
}

function parseProposal(value: unknown, generatedAt: string): LocalPreviewReport["proposal"] {
  if (value === null) return null;
  if (!isObject(value) || !hasExactKeys(value, PROPOSAL_KEYS)
    || !isIdentifier(value.proposalId)
    || !isInstant(value.proposedAt)
    || Date.parse(value.proposedAt) > Date.parse(generatedAt)
    || !Array.isArray(value.claims)
    || value.claims.length > MAX_CLAIMS_PER_REPORT
    || !isBoundedCount(value.unresolvedCount, MAX_UNRESOLVED_COUNT)) {
    return fail();
  }
  const claims = value.claims.map(parseClaim);
  if (new Set(claims.map((claim) => claim.claimId)).size !== claims.length) return fail();
  return {
    proposalId: value.proposalId,
    proposedAt: value.proposedAt,
    claims,
    unresolvedCount: value.unresolvedCount,
  };
}

function parseReport(value: unknown, generatedAt: string): LocalPreviewReport {
  if (!isObject(value) || !hasExactKeys(value, REPORT_KEYS)
    || !isIdentifier(value.reportId)
    || !isBoundedCount(value.version, 1_000_000) || value.version < 1
    || !isSafeText(value.title, MAX_TITLE_CODE_POINTS)
    || !isNullableInstant(value.publishedAt)
    || !isNullableInstant(value.observedAt)
    || !isInstant(value.capturedAt)
    || Date.parse(value.capturedAt) > Date.parse(generatedAt)
    || !isIdentifier(value.reportRevisionId)
    || !(value.supersedesId === null || isIdentifier(value.supersedesId))
    || !isHash(value.contentHash)
    || !(value.permittedText === null || isSafeText(value.permittedText, MAX_TEXT_CODE_POINTS, false, true))
    || !(value.permittedTextHash === null || isHash(value.permittedTextHash))
    || ((value.permittedText === null) !== (value.permittedTextHash === null))
    || !Array.isArray(value.stages) || value.stages.length > STAGES.length
    || value.stages.some((stage) => !isMember(stage, STAGES))
    || new Set(value.stages).size !== value.stages.length) {
    return fail();
  }
  const ingestion = parseJob(value.ingestion);
  const ai = value.ai === null ? null : parseJob(value.ai);
  const proposal = parseProposal(value.proposal, generatedAt);
  if (proposal !== null && !value.stages.includes("proposal")) return fail();

  return {
    reportId: value.reportId,
    version: value.version,
    title: value.title,
    publishedAt: value.publishedAt,
    observedAt: value.observedAt,
    capturedAt: value.capturedAt,
    reportRevisionId: value.reportRevisionId,
    supersedesId: value.supersedesId,
    contentHash: value.contentHash,
    permittedText: value.permittedText,
    permittedTextHash: value.permittedTextHash,
    ingestion,
    ai,
    stages: value.stages.map((stage) => stage as LocalPreviewReport["stages"][number]),
    proposal,
  };
}

function parseCounts(value: unknown): Record<(typeof STATUS_KEYS)[number], number> {
  if (!isObject(value) || !hasExactKeys(value, STATUS_KEYS)
    || STATUS_KEYS.some((key) => !isBoundedCount(value[key]))) {
    return fail();
  }
  return {
    pending: value.pending as number,
    leased: value.leased as number,
    retry: value.retry as number,
    completed: value.completed as number,
    terminal: value.terminal as number,
  };
}

function parseSummary(value: unknown) {
  if (!isObject(value) || !hasExactKeys(value, SUMMARY_KEYS)
    || !isBoundedCount(value.snapshots)
    || !isBoundedCount(value.proposals)
    || value.snapshots < 0) {
    return fail();
  }
  return {
    snapshots: value.snapshots as number,
    ingestion: parseCounts(value.ingestion),
    ai: parseCounts(value.ai),
    proposals: value.proposals as number,
  };
}

/** Validates a closed, synthetic-only local preview DTO and returns a detached projection. */
export function validateLocalPipelinePreviewPayload(value: unknown): LocalPipelinePreview {
  if (!isObject(value) || !hasExactKeys(value, TOP_LEVEL_KEYS)
    || value.schemaVersion !== LOCAL_PIPELINE_PREVIEW_SCHEMA
    || value.datasetKind !== "synthetic"
    || value.publicationEnabled !== false
    || !isInstant(value.generatedAt)
    || value.sourceId !== "local-authored-api"
    || !isMember(value.models, ["mock", "opt_in_gateway"] as const)
    || !isObject(value.scheduler) || !hasExactKeys(value.scheduler, SCHEDULER_KEYS)
    || !isMember(value.scheduler.status, SCHEDULER_STATUSES)
    || !isBoundedCount(value.scheduler.polls, 10_000)
    || !isBoundedCount(value.scheduler.collectionFailures, 10_000)
    || !isBoundedCount(value.summary && isObject(value.summary) ? value.summary.snapshots : undefined)
    || !Array.isArray(value.reports) || value.reports.length > MAX_REPORTS
    || typeof value.truncated !== "boolean") {
    return fail();
  }
  const summary = parseSummary(value.summary);
  const scheduler = {
    status: value.scheduler.status,
    polls: value.scheduler.polls,
    collectionFailures: value.scheduler.collectionFailures,
  } as const;
  const reports = value.reports.map((report) => parseReport(report, value.generatedAt as string));
  const reportKeys = reports.map((report) => report.reportId + ":" + report.version);
  const revisions = reports.map((report) => report.reportRevisionId);
  if (new Set(reportKeys).size !== reportKeys.length || new Set(revisions).size !== revisions.length) return fail();

  const reportsByRevision = new Map(reports.map((report) => [report.reportRevisionId, report]));
  for (const report of reports) {
    for (const claim of report.proposal?.claims ?? []) {
      for (const evidence of claim.evidence) {
        const source = reportsByRevision.get(evidence.reportRevisionId);
        if (source && source.permittedTextHash !== evidence.permittedTextHash) return fail();
        if (source?.permittedText !== null && source?.permittedText !== undefined
          && evidence.spanEnd > codePointLength(source.permittedText)) {
          return fail();
        }
      }
    }
  }
  if (summary.snapshots < reports.length
    || summary.proposals < reports.filter((report) => report.proposal !== null).length) {
    return fail();
  }

  return {
    schemaVersion: LOCAL_PIPELINE_PREVIEW_SCHEMA,
    datasetKind: "synthetic",
    publicationEnabled: false,
    generatedAt: value.generatedAt,
    sourceId: "local-authored-api",
    models: value.models,
    scheduler,
    summary,
    reports,
    truncated: value.truncated,
  };
}

async function readBoundedBody(response: Response): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/u.test(contentLength) && Number(contentLength) > MAX_RESPONSE_BYTES) return fail();
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json" || response.body === null) return fail();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      totalBytes += result.value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return fail();
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text) as unknown;
}

export async function getLocalPipelinePreview(options: {
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
} = {}): Promise<LocalPipelinePreview> {
  try {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") return fail();
    const response = await fetchImpl(LOCAL_PIPELINE_PREVIEW_PATH, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      credentials: "same-origin",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.ok) return fail();
    const body = await readBoundedBody(response);
    return validateLocalPipelinePreviewPayload(body);
  } catch (error) {
    if (error instanceof LocalPipelinePreviewError) throw error;
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new LocalPipelinePreviewError();
  }
}
