/**
 * Strict local validation for the EVAL-01 casebook contract.
 *
 * This module is deliberately independent of Worker runtime code and makes no
 * source, model, database, or network calls. It validates metadata only.
 */

import { CATEGORIES } from "../../apps/worker/src/layers/l2-model-grounding/contracts.js";
import type {
  Category as L2Category,
  EvidenceRelation as L2EvidenceRelation,
} from "../../apps/worker/src/layers/l2-model-grounding/contracts.js";

export const CASEBOOK_SCHEMA_VERSION = "1.0" as const;
export { CATEGORIES };

export const EVIDENCE_RELATIONS = ["supports", "contradicts", "updates", "context"] as const satisfies readonly L2EvidenceRelation[];
type MissingEvidenceRelations = Exclude<L2EvidenceRelation, (typeof EVIDENCE_RELATIONS)[number]>;
const evidenceRelationEnumIsComplete: MissingEvidenceRelations extends never ? true : never = true;
void evidenceRelationEnumIsComplete;
export const PUBLICATION_DISPOSITIONS = ["publish", "review", "reject", "retract"] as const;
export const CASEBOOK_SPLITS = ["development", "validation", "held_out"] as const;

export type Category = L2Category;
export type EvidenceRelation = L2EvidenceRelation;
export type PublicationDisposition = (typeof PUBLICATION_DISPOSITIONS)[number];
export type CasebookSplit = (typeof CASEBOOK_SPLITS)[number];
export type AssessmentStatus = "labeled" | "unknown" | "disputed" | "not_applicable";

export type Assessment<T> =
  | { readonly status: "labeled"; readonly value: T }
  | { readonly status: "unknown" | "disputed" | "not_applicable" };

export interface TimeScope {
  readonly start: string;
  readonly end: string | null;
  readonly precision: "exact" | "date" | "range";
}

export interface EvaluationScope {
  readonly place_ids: readonly string[];
  readonly service_ids: readonly string[];
  readonly institution_ids: readonly string[];
  readonly audience_ids: readonly string[];
  readonly geometry_ids: readonly string[];
}

export interface EvaluationLabels {
  readonly incident_identity: Assessment<"single_incident" | "multiple_incidents" | "not_an_incident">;
  readonly category: Assessment<Category>;
  readonly event_time: Assessment<TimeScope>;
  readonly scope: Assessment<EvaluationScope>;
  readonly expected_publication_disposition: Assessment<PublicationDisposition>;
  readonly report_assessments: readonly ReportAssessment[];
}

export interface ReportAssessment {
  readonly report_id: string;
  readonly observation_time: Assessment<TimeScope>;
  readonly evidence_relations: Assessment<readonly EvidenceRelation[]>;
  readonly source_origin_dependence: Assessment<"independent" | "dependent">;
}

export interface CasebookSource {
  readonly source_id: string;
  readonly evaluation_use_rights: "approved" | "pending" | "not_applicable";
  readonly permission_ref: string | null;
}

export interface CasebookReport {
  readonly report_id: string;
  readonly revision_id: string;
  readonly source_id: string;
  readonly content_hash: string;
  /** Null explicitly means that the source-origin group is unknown. */
  readonly origin_group_id: string | null;
  /** Opaque handle only; it grants no access and is not a URL or source content. */
  readonly content_ref: string;
}

export interface IndependentReview {
  readonly reviewer_id: string;
  readonly reviewer_kind: "human";
  readonly reviewed_at: string;
  readonly labels: EvaluationLabels;
}

export interface Adjudication {
  readonly status: "reconciled" | "pending";
  readonly adjudicator_id: string;
  readonly adjudicator_kind: "human";
  readonly adjudicated_at: string;
  readonly labels: EvaluationLabels;
}

export interface CasebookCase {
  readonly case_id: string;
  readonly split: CasebookSplit;
  readonly reports: readonly CasebookReport[];
  readonly independent_reviews: readonly IndependentReview[];
  readonly adjudication: Adjudication | null;
}

export interface Casebook {
  readonly schema_version: typeof CASEBOOK_SCHEMA_VERSION;
  readonly casebook_id: string;
  readonly dataset_kind: "historical" | "synthetic";
  readonly sources: readonly CasebookSource[];
  readonly held_out_freeze: {
    readonly state: "frozen" | "not_frozen";
    readonly frozen_at: string | null;
  };
  readonly cases: readonly CasebookCase[];
}

export type CasebookIssueCode =
  | "ROOT_NOT_OBJECT"
  | "UNKNOWN_FIELD"
  | "MODEL_OUTPUT_FIELD_FORBIDDEN"
  | "MISSING_FIELD"
  | "INVALID_VALUE"
  | "LIVE_DATASET_FORBIDDEN"
  | "DUPLICATE_CASE_ID"
  | "DUPLICATE_SOURCE_ID"
  | "DUPLICATE_REPORT_ID"
  | "REPORT_ID_LEAKAGE"
  | "DUPLICATE_REVISION_ID"
  | "REVISION_LEAKAGE"
  | "ORIGIN_GROUP_LEAKAGE"
  | "CONTENT_HASH_LEAKAGE"
  | "SPLIT_LEAKAGE"
  | "SOURCE_REFERENCE_MISSING"
  | "DUPLICATE_REVIEWER_ID"
  | "NON_HUMAN_REVIEWER"
  | "NON_HUMAN_ADJUDICATOR"
  | "DUPLICATE_REPORT_ASSESSMENT"
  | "UNKNOWN_REPORT_ASSESSMENT"
  | "REPORT_ASSESSMENT_MISSING";

export interface CasebookIssue {
  readonly code: CasebookIssueCode;
  readonly path: string;
}

export interface CasebookValidation {
  readonly valid: boolean;
  readonly issues: readonly CasebookIssue[];
}

export type ReadinessReasonCode =
  | "CASEBOOK_INVALID"
  | "DATASET_NOT_HISTORICAL"
  | "SOURCE_RIGHTS_NOT_APPROVED"
  | "REPORT_COUNT_BELOW_MINIMUM"
  | "CASE_COUNT_BELOW_MINIMUM"
  | "REPORTS_PER_CASE_BELOW_MINIMUM"
  | "HUMAN_REVIEWERS_BELOW_MINIMUM"
  | "ADJUDICATION_MISSING"
  | "HELD_OUT_SPLIT_MISSING"
  | "HELD_OUT_NOT_FROZEN";

export interface ReadinessResult {
  readonly ready: boolean;
  readonly reasonCodes: readonly ReadinessReasonCode[];
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const CONTENT_REF_PATTERN = /^(?:permission-ref|synthetic-ref):[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/;
const ASSESSMENT_STATUSES = ["labeled", "unknown", "disputed", "not_applicable"] as const;

type ObjectValue = Record<string, unknown>;

function isObject(value: unknown): value is ObjectValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthLengths = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= monthLengths[month - 1];
}

function isValidDateTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DATETIME_PATTERN.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, zone, , offsetHour, offsetMinute] = match;
  if (!isValidDate(`${year}-${month}-${day}`)) return false;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return false;
  if (zone !== "Z" && (Number(offsetHour) > 23 || Number(offsetMinute) > 59)) return false;
  return !Number.isNaN(Date.parse(value));
}

function isValidId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function isValidContentRef(value: unknown): value is string {
  return typeof value === "string" && CONTENT_REF_PATTERN.test(value);
}

function addIssue(issues: CasebookIssue[], code: CasebookIssueCode, path: string): void {
  issues.push({ code, path });
}

function readObject(
  value: unknown,
  path: string,
  allowed: readonly string[],
  required: readonly string[],
  issues: CasebookIssue[],
): ObjectValue | undefined {
  if (!isObject(value)) {
    addIssue(issues, path === "$" ? "ROOT_NOT_OBJECT" : "INVALID_VALUE", path);
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue;
    const code = /^(?:model|machine)(?:_|$)/i.test(key) ? "MODEL_OUTPUT_FIELD_FORBIDDEN" : "UNKNOWN_FIELD";
    addIssue(issues, code, `${path}.${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) addIssue(issues, "MISSING_FIELD", `${path}.${key}`);
  }
  return value;
}

function checkId(value: unknown, path: string, issues: CasebookIssue[]): void {
  if (!isValidId(value)) addIssue(issues, "INVALID_VALUE", path);
}

function checkDateTime(value: unknown, path: string, issues: CasebookIssue[]): void {
  if (!isValidDateTime(value)) addIssue(issues, "INVALID_VALUE", path);
}

function checkEnum<T extends string>(
  value: unknown,
  choices: readonly T[],
  path: string,
  issues: CasebookIssue[],
): value is T {
  if (typeof value !== "string" || !choices.includes(value as T)) {
    addIssue(issues, "INVALID_VALUE", path);
    return false;
  }
  return true;
}

function checkStringArray(value: unknown, path: string, issues: CasebookIssue[]): void {
  if (!Array.isArray(value)) {
    addIssue(issues, "INVALID_VALUE", path);
    return;
  }
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    if (!isValidId(entry)) addIssue(issues, "INVALID_VALUE", `${path}[${index}]`);
    if (typeof entry === "string" && seen.has(entry)) addIssue(issues, "INVALID_VALUE", `${path}[${index}]`);
    if (typeof entry === "string") seen.add(entry);
  });
}

function validateTimeScope(value: unknown, path: string, issues: CasebookIssue[]): void {
  const object = readObject(value, path, ["start", "end", "precision"], ["start", "end", "precision"], issues);
  if (!object) return;
  const precision = object.precision;
  if (precision === "exact") {
    checkDateTime(object.start, `${path}.start`, issues);
    if (object.end !== null) checkDateTime(object.end, `${path}.end`, issues);
    if (object.end !== null && isValidDateTime(object.start) && isValidDateTime(object.end) && Date.parse(object.end) < Date.parse(object.start)) {
      addIssue(issues, "INVALID_VALUE", `${path}.end`);
    }
  } else if (precision === "date") {
    if (!isValidDate(object.start)) addIssue(issues, "INVALID_VALUE", `${path}.start`);
    if (object.end !== null && !isValidDate(object.end)) addIssue(issues, "INVALID_VALUE", `${path}.end`);
    if (isValidDate(object.start) && isValidDate(object.end) && object.end < object.start) addIssue(issues, "INVALID_VALUE", `${path}.end`);
  } else if (precision === "range") {
    const startIsDate = isValidDate(object.start);
    const endIsDate = isValidDate(object.end);
    const startIsDateTime = isValidDateTime(object.start);
    const endIsDateTime = isValidDateTime(object.end);
    if (!(startIsDate && endIsDate) && !(startIsDateTime && endIsDateTime)) {
      addIssue(issues, "INVALID_VALUE", `${path}.start`);
      addIssue(issues, "INVALID_VALUE", `${path}.end`);
    } else if (startIsDate && endIsDate && typeof object.start === "string" && typeof object.end === "string" && object.end < object.start) {
      addIssue(issues, "INVALID_VALUE", `${path}.end`);
    } else if (startIsDateTime && endIsDateTime && Date.parse(object.end as string) < Date.parse(object.start as string)) {
      addIssue(issues, "INVALID_VALUE", `${path}.end`);
    }
  } else {
    addIssue(issues, "INVALID_VALUE", `${path}.precision`);
  }
}

function validateScope(value: unknown, path: string, issues: CasebookIssue[]): void {
  const fields = ["place_ids", "service_ids", "institution_ids", "audience_ids", "geometry_ids"] as const;
  const object = readObject(value, path, fields, fields, issues);
  if (!object) return;
  for (const field of fields) checkStringArray(object[field], `${path}.${field}`, issues);
}

function validateAssessment(
  value: unknown,
  path: string,
  validateLabeledValue: (value: unknown, valuePath: string, issues: CasebookIssue[]) => void,
  issues: CasebookIssue[],
): void {
  const object = readObject(value, path, ["status", "value"], ["status"], issues);
  if (!object) return;
  if (!checkEnum(object.status, ASSESSMENT_STATUSES, `${path}.status`, issues)) return;
  if (object.status === "labeled") {
    if (!Object.hasOwn(object, "value")) addIssue(issues, "MISSING_FIELD", `${path}.value`);
    else validateLabeledValue(object.value, `${path}.value`, issues);
  } else if (Object.hasOwn(object, "value")) {
    addIssue(issues, "INVALID_VALUE", `${path}.value`);
  }
}

function validateReportAssessment(value: unknown, path: string, issues: CasebookIssue[]): string | undefined {
  const fields = ["report_id", "observation_time", "evidence_relations", "source_origin_dependence"] as const;
  const object = readObject(value, path, fields, fields, issues);
  if (!object) return undefined;
  checkId(object.report_id, `${path}.report_id`, issues);
  validateAssessment(object.observation_time, `${path}.observation_time`, validateTimeScope, issues);
  validateAssessment(object.evidence_relations, `${path}.evidence_relations`, (entry, entryPath, target) => {
    if (!Array.isArray(entry) || entry.length === 0) {
      addIssue(target, "INVALID_VALUE", entryPath);
      return;
    }
    entry.forEach((relation, index) => checkEnum(relation, EVIDENCE_RELATIONS, `${entryPath}[${index}]`, target));
    if (new Set(entry).size !== entry.length) addIssue(target, "INVALID_VALUE", entryPath);
  }, issues);
  validateAssessment(object.source_origin_dependence, `${path}.source_origin_dependence`, (entry, entryPath, target) => {
    checkEnum(entry, ["independent", "dependent"], entryPath, target);
  }, issues);
  return typeof object.report_id === "string" ? object.report_id : undefined;
}

function validateReportAssessments(value: unknown, path: string, reportIds: ReadonlySet<string>, issues: CasebookIssue[]): void {
  if (!Array.isArray(value)) {
    addIssue(issues, "INVALID_VALUE", path);
    return;
  }
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    const reportId = validateReportAssessment(entry, `${path}[${index}]`, issues);
    if (reportId === undefined) return;
    if (seen.has(reportId)) addIssue(issues, "DUPLICATE_REPORT_ASSESSMENT", `${path}[${index}].report_id`);
    seen.add(reportId);
    if (!reportIds.has(reportId)) addIssue(issues, "UNKNOWN_REPORT_ASSESSMENT", `${path}[${index}].report_id`);
  });
  for (const reportId of reportIds) {
    if (!seen.has(reportId)) addIssue(issues, "REPORT_ASSESSMENT_MISSING", path);
  }
}

function validateLabels(value: unknown, path: string, reportIds: ReadonlySet<string>, issues: CasebookIssue[]): void {
  const fields = [
    "incident_identity",
    "category",
    "event_time",
    "scope",
    "expected_publication_disposition",
    "report_assessments",
  ] as const;
  const object = readObject(value, path, fields, fields, issues);
  if (!object) return;

  validateAssessment(object.incident_identity, `${path}.incident_identity`, (entry, entryPath, target) => {
    checkEnum(entry, ["single_incident", "multiple_incidents", "not_an_incident"], entryPath, target);
  }, issues);
  validateAssessment(object.category, `${path}.category`, (entry, entryPath, target) => {
    checkEnum(entry, CATEGORIES, entryPath, target);
  }, issues);
  validateAssessment(object.event_time, `${path}.event_time`, validateTimeScope, issues);
  validateAssessment(object.scope, `${path}.scope`, validateScope, issues);
  validateAssessment(object.expected_publication_disposition, `${path}.expected_publication_disposition`, (entry, entryPath, target) => {
    checkEnum(entry, PUBLICATION_DISPOSITIONS, entryPath, target);
  }, issues);
  validateReportAssessments(object.report_assessments, `${path}.report_assessments`, reportIds, issues);
}

function validateSource(value: unknown, path: string, issues: CasebookIssue[]): void {
  const object = readObject(value, path, ["source_id", "evaluation_use_rights", "permission_ref"], ["source_id", "evaluation_use_rights", "permission_ref"], issues);
  if (!object) return;
  checkId(object.source_id, `${path}.source_id`, issues);
  checkEnum(object.evaluation_use_rights, ["approved", "pending", "not_applicable"], `${path}.evaluation_use_rights`, issues);
  if (object.permission_ref !== null && !isValidContentRef(object.permission_ref)) addIssue(issues, "INVALID_VALUE", `${path}.permission_ref`);
  if (object.evaluation_use_rights === "approved" && (typeof object.permission_ref !== "string" || !object.permission_ref.startsWith("permission-ref:"))) {
    addIssue(issues, "INVALID_VALUE", `${path}.permission_ref`);
  }
  if (object.evaluation_use_rights !== "approved" && object.permission_ref !== null) addIssue(issues, "INVALID_VALUE", `${path}.permission_ref`);
}

function validateReport(value: unknown, path: string, datasetKind: unknown, issues: CasebookIssue[]): void {
  const fields = ["report_id", "revision_id", "source_id", "content_hash", "origin_group_id", "content_ref"] as const;
  const object = readObject(value, path, fields, fields, issues);
  if (!object) return;
  checkId(object.report_id, `${path}.report_id`, issues);
  checkId(object.revision_id, `${path}.revision_id`, issues);
  checkId(object.source_id, `${path}.source_id`, issues);
  if (typeof object.content_hash !== "string" || !HASH_PATTERN.test(object.content_hash)) addIssue(issues, "INVALID_VALUE", `${path}.content_hash`);
  if (object.origin_group_id !== null) checkId(object.origin_group_id, `${path}.origin_group_id`, issues);
  const expectedPrefix = datasetKind === "synthetic" ? "synthetic-ref:" : "permission-ref:";
  if (!isValidContentRef(object.content_ref) || !object.content_ref.startsWith(expectedPrefix)) addIssue(issues, "INVALID_VALUE", `${path}.content_ref`);
}

function validateReview(value: unknown, path: string, reportIds: ReadonlySet<string>, issues: CasebookIssue[]): void {
  const fields = ["reviewer_id", "reviewer_kind", "reviewed_at", "labels"] as const;
  const object = readObject(value, path, fields, fields, issues);
  if (!object) return;
  checkId(object.reviewer_id, `${path}.reviewer_id`, issues);
  if (object.reviewer_kind !== "human") addIssue(issues, "NON_HUMAN_REVIEWER", `${path}.reviewer_kind`);
  checkDateTime(object.reviewed_at, `${path}.reviewed_at`, issues);
  validateLabels(object.labels, `${path}.labels`, reportIds, issues);
}

function validateAdjudication(value: unknown, path: string, reportIds: ReadonlySet<string>, issues: CasebookIssue[]): void {
  const fields = ["status", "adjudicator_id", "adjudicator_kind", "adjudicated_at", "labels"] as const;
  const object = readObject(value, path, fields, fields, issues);
  if (!object) return;
  checkEnum(object.status, ["reconciled", "pending"], `${path}.status`, issues);
  checkId(object.adjudicator_id, `${path}.adjudicator_id`, issues);
  if (object.adjudicator_kind !== "human") addIssue(issues, "NON_HUMAN_ADJUDICATOR", `${path}.adjudicator_kind`);
  checkDateTime(object.adjudicated_at, `${path}.adjudicated_at`, issues);
  validateLabels(object.labels, `${path}.labels`, reportIds, issues);
}

function validateCase(value: unknown, path: string, datasetKind: unknown, issues: CasebookIssue[]): void {
  const fields = ["case_id", "split", "reports", "independent_reviews", "adjudication"] as const;
  const object = readObject(value, path, fields, fields, issues);
  if (!object) return;
  checkId(object.case_id, `${path}.case_id`, issues);
  checkEnum(object.split, CASEBOOK_SPLITS, `${path}.split`, issues);
  if (!Array.isArray(object.reports) || object.reports.length === 0) addIssue(issues, "INVALID_VALUE", `${path}.reports`);
  else object.reports.forEach((report, index) => validateReport(report, `${path}.reports[${index}]`, datasetKind, issues));
  const reportIds = new Set<string>(Array.isArray(object.reports)
    ? object.reports.flatMap((report) => isObject(report) && typeof report.report_id === "string" ? [report.report_id] : [])
    : []);
  if (!Array.isArray(object.independent_reviews)) addIssue(issues, "INVALID_VALUE", `${path}.independent_reviews`);
  else object.independent_reviews.forEach((review, index) => validateReview(review, `${path}.independent_reviews[${index}]`, reportIds, issues));
  if (object.adjudication !== null) validateAdjudication(object.adjudication, `${path}.adjudication`, reportIds, issues);
}

function validateIdentityBoundaries(value: ObjectValue, issues: CasebookIssue[]): void {
  if (!Array.isArray(value.cases)) return;
  const caseIds = new Set<string>();
  const sourceIds = new Set<string>();
  const reportIds = new Map<string, { caseId: string; split: string; path: string }>();
  const revisionIds = new Map<string, { caseId: string; split: string; path: string }>();
  const origins = new Map<string, { caseId: string; split: string; path: string }>();
  const hashes = new Map<string, { caseId: string; split: string; path: string }>();
  const sourceEntries: unknown[] = Array.isArray(value.sources) ? value.sources : [];

  sourceEntries.forEach((raw, index) => {
    if (!isObject(raw) || typeof raw.source_id !== "string") return;
    if (sourceIds.has(raw.source_id)) addIssue(issues, "DUPLICATE_SOURCE_ID", `$.sources[${index}].source_id`);
    sourceIds.add(raw.source_id);
  });

  value.cases.forEach((rawCase, caseIndex) => {
    if (!isObject(rawCase)) return;
    const caseId = typeof rawCase.case_id === "string" ? rawCase.case_id : `invalid-case-${caseIndex}`;
    const split = typeof rawCase.split === "string" ? rawCase.split : "invalid";
    const casePath = `$.cases[${caseIndex}]`;
    if (caseIds.has(caseId)) addIssue(issues, "DUPLICATE_CASE_ID", `${casePath}.case_id`);
    caseIds.add(caseId);

    if (Array.isArray(rawCase.independent_reviews)) {
      const reviewers = new Set<string>();
      rawCase.independent_reviews.forEach((rawReview, reviewIndex) => {
        if (!isObject(rawReview) || typeof rawReview.reviewer_id !== "string") return;
        if (reviewers.has(rawReview.reviewer_id)) addIssue(issues, "DUPLICATE_REVIEWER_ID", `${casePath}.independent_reviews[${reviewIndex}].reviewer_id`);
        reviewers.add(rawReview.reviewer_id);
      });
    }

    if (!Array.isArray(rawCase.reports)) return;
    rawCase.reports.forEach((rawReport, reportIndex) => {
      if (!isObject(rawReport)) return;
      const reportPath = `${casePath}.reports[${reportIndex}]`;
      if (typeof rawReport.source_id === "string" && !sourceIds.has(rawReport.source_id)) {
        // sourceIds is complete before the case loop; this check also works when a
        // source list was absent or malformed.
        addIssue(issues, "SOURCE_REFERENCE_MISSING", `${reportPath}.source_id`);
      }
      if (typeof rawReport.report_id === "string") {
        const prior = reportIds.get(rawReport.report_id);
        if (prior) {
          addIssue(issues, prior.caseId === caseId ? "DUPLICATE_REPORT_ID" : "REPORT_ID_LEAKAGE", `${reportPath}.report_id`);
          if (prior.split !== split) addIssue(issues, "SPLIT_LEAKAGE", `${reportPath}.report_id`);
        }
        else reportIds.set(rawReport.report_id, { caseId, split, path: reportPath });
      }
      if (typeof rawReport.revision_id === "string") {
        const prior = revisionIds.get(rawReport.revision_id);
        if (prior) {
          addIssue(issues, prior.caseId === caseId ? "DUPLICATE_REVISION_ID" : "REVISION_LEAKAGE", `${reportPath}.revision_id`);
          if (prior.split !== split) addIssue(issues, "SPLIT_LEAKAGE", `${reportPath}.revision_id`);
        } else revisionIds.set(rawReport.revision_id, { caseId, split, path: reportPath });
      }
      if (typeof rawReport.origin_group_id === "string") {
        const prior = origins.get(rawReport.origin_group_id);
        if (prior && prior.caseId !== caseId) {
          addIssue(issues, "ORIGIN_GROUP_LEAKAGE", `${reportPath}.origin_group_id`);
          if (prior.split !== split) addIssue(issues, "SPLIT_LEAKAGE", `${reportPath}.origin_group_id`);
        } else if (!prior) origins.set(rawReport.origin_group_id, { caseId, split, path: reportPath });
      }
      if (typeof rawReport.content_hash === "string") {
        const prior = hashes.get(rawReport.content_hash);
        if (prior && prior.caseId !== caseId) {
          addIssue(issues, "CONTENT_HASH_LEAKAGE", `${reportPath}.content_hash`);
          if (prior.split !== split) addIssue(issues, "SPLIT_LEAKAGE", `${reportPath}.content_hash`);
        } else if (!prior) hashes.set(rawReport.content_hash, { caseId, split, path: reportPath });
      }
    });
  });
}

/** Validate structure, closed fields, enums, human-review separation, and leakage. */
export function validateCasebook(input: unknown): CasebookValidation {
  const issues: CasebookIssue[] = [];
  const rootFields = ["schema_version", "casebook_id", "dataset_kind", "sources", "held_out_freeze", "cases"] as const;
  const root = readObject(input, "$", rootFields, rootFields, issues);
  if (!root) return { valid: false, issues };

  if (root.schema_version !== CASEBOOK_SCHEMA_VERSION) addIssue(issues, "INVALID_VALUE", "$.schema_version");
  checkId(root.casebook_id, "$.casebook_id", issues);
  if (root.dataset_kind === "live") addIssue(issues, "LIVE_DATASET_FORBIDDEN", "$.dataset_kind");
  else checkEnum(root.dataset_kind, ["historical", "synthetic"], "$.dataset_kind", issues);

  if (!Array.isArray(root.sources) || root.sources.length === 0) addIssue(issues, "INVALID_VALUE", "$.sources");
  else root.sources.forEach((source, index) => {
    validateSource(source, `$.sources[${index}]`, issues);
    if (root.dataset_kind === "synthetic" && isObject(source) && source.evaluation_use_rights !== "not_applicable") {
      addIssue(issues, "INVALID_VALUE", `$.sources[${index}].evaluation_use_rights`);
    }
  });

  const freeze = readObject(root.held_out_freeze, "$.held_out_freeze", ["state", "frozen_at"], ["state", "frozen_at"], issues);
  if (freeze) {
    checkEnum(freeze.state, ["frozen", "not_frozen"], "$.held_out_freeze.state", issues);
    if (freeze.frozen_at === null) {
      if (freeze.state === "frozen") addIssue(issues, "INVALID_VALUE", "$.held_out_freeze.frozen_at");
    } else {
      checkDateTime(freeze.frozen_at, "$.held_out_freeze.frozen_at", issues);
      if (freeze.state === "not_frozen") addIssue(issues, "INVALID_VALUE", "$.held_out_freeze.frozen_at");
    }
  }

  if (!Array.isArray(root.cases) || root.cases.length === 0) addIssue(issues, "INVALID_VALUE", "$.cases");
  else root.cases.forEach((item, index) => validateCase(item, `$.cases[${index}]`, root.dataset_kind, issues));
  validateIdentityBoundaries(root, issues);
  return { valid: issues.length === 0, issues };
}

/**
 * Check the structural release gate. A ready result is a metadata check only;
 * rights evidence, review authenticity, and freeze governance require review
 * outside this local validator. Synthetic data can never satisfy this gate.
 */
export function evaluateReleaseReadiness(input: unknown): ReadinessResult {
  const validation = validateCasebook(input);
  if (!validation.valid) return { ready: false, reasonCodes: ["CASEBOOK_INVALID"] };

  const casebook = input as Casebook;
  const reasons = new Set<ReadinessReasonCode>();
  if (casebook.dataset_kind !== "historical") reasons.add("DATASET_NOT_HISTORICAL");
  if (casebook.sources.some((source) => source.evaluation_use_rights !== "approved" || source.permission_ref === null)) {
    reasons.add("SOURCE_RIGHTS_NOT_APPROVED");
  }

  const reportCount = casebook.cases.reduce((total, item) => total + item.reports.length, 0);
  if (reportCount < 40) reasons.add("REPORT_COUNT_BELOW_MINIMUM");
  if (casebook.cases.length < 12) reasons.add("CASE_COUNT_BELOW_MINIMUM");
  if (casebook.cases.some((item) => item.reports.length < 3)) reasons.add("REPORTS_PER_CASE_BELOW_MINIMUM");
  if (casebook.cases.some((item) => new Set(item.independent_reviews.filter((review) => review.reviewer_kind === "human").map((review) => review.reviewer_id)).size < 2)) {
    reasons.add("HUMAN_REVIEWERS_BELOW_MINIMUM");
  }
  if (casebook.cases.some((item) => item.adjudication?.status !== "reconciled" || item.adjudication.adjudicator_kind !== "human")) {
    reasons.add("ADJUDICATION_MISSING");
  }
  const hasHeldOut = casebook.cases.some((item) => item.split === "held_out");
  if (!hasHeldOut) reasons.add("HELD_OUT_SPLIT_MISSING");
  if (casebook.held_out_freeze.state !== "frozen" || casebook.held_out_freeze.frozen_at === null) {
    reasons.add("HELD_OUT_NOT_FROZEN");
  }

  const reasonCodes = [...reasons];
  return { ready: reasonCodes.length === 0, reasonCodes };
}
