import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CATEGORIES as L2_CATEGORIES,
  type EvidenceRelation as L2EvidenceRelation,
} from "../../apps/worker/src/layers/l2-model-grounding/contracts.js";
import {
  CATEGORIES,
  EVIDENCE_RELATIONS,
  SCENARIO_TAGS,
  evaluateReleaseReadiness,
  validateCasebook,
  type CasebookIssueCode,
  type ReadinessReasonCode,
} from "./casebook.js";

interface TestReport {
  report_id: string;
  revision_id: string;
  source_id: string;
  content_hash: string;
  origin_group_id: string | null;
  content_ref: string;
}

interface TestReview {
  reviewer_id: string;
  reviewer_kind: string;
  reviewed_at: string;
  labels: unknown;
  [key: string]: unknown;
}

interface TestCase {
  case_id: string;
  split: string;
  scenario_tags: string[];
  reports: TestReport[];
  independent_reviews: TestReview[];
  adjudication: Record<string, unknown> | null;
}

interface TestCasebook {
  schema_version: string;
  casebook_id: string;
  dataset_kind: string;
  sources: Array<{ source_id: string; evaluation_use_rights: string; permission_ref: string | null }>;
  held_out_freeze: { state: string; frozen_at: string | null };
  cases: TestCase[];
}

const syntheticFixture = JSON.parse(
  readFileSync(new URL("../../docs/evaluation/fixtures/synthetic-casebook.json", import.meta.url), "utf8"),
) as TestCasebook;
const casebookSchema = JSON.parse(
  readFileSync(new URL("../../docs/evaluation/casebook.schema.json", import.meta.url), "utf8"),
) as {
  $schema: string;
  $id: string;
  additionalProperties: boolean;
  properties: { schema_version: { const: string }; dataset_kind: { enum: string[] } };
  $defs: {
    labels: { properties: { category: { allOf: [unknown, { properties: { value: { enum: string[] } } }] } } };
    reportAssessment: { properties: { evidence_relations: { allOf: [unknown, { properties: { value: { items: { enum: string[] } } } }] } } };
    case: { properties: { scenario_tags: { items: { enum: string[] } } } };
  };
};

type MissingL2EvidenceRelations = Exclude<L2EvidenceRelation, (typeof EVIDENCE_RELATIONS)[number]>;
const evidenceRelationParity: MissingL2EvidenceRelations extends never ? true : never = true;
void evidenceRelationParity;

function placeholderLabels(reportIds: readonly string[], category?: (typeof CATEGORIES)[number]) {
  return {
    incident_identity: { status: "unknown" },
    category: category === undefined ? { status: "unknown" } : { status: "labeled", value: category },
    event_time: { status: "unknown" },
    scope: { status: "unknown" },
    expected_publication_disposition: { status: "unknown" },
    report_assessments: reportIds.map((report_id) => ({
      report_id,
      observation_time: { status: "unknown" },
      evidence_relations: { status: "unknown" },
      source_origin_dependence: { status: "unknown" },
    })),
  };
}

/**
 * Validator-only shape generator. Every identifier and value is invented in
 * memory; it represents no report, permission decision, human judgment, or
 * ground truth. Rights stay pending in every generated historical-shaped case.
 */
function makeStructureOnlyCasebook(options: {
  caseCount?: number;
  reportsPerCase?: number;
  extraReports?: number;
  reviewerCount?: number;
  missingAdjudication?: boolean;
  includeHeldOut?: boolean;
  frozen?: boolean;
} = {}): TestCasebook {
  const {
    caseCount = 12,
    reportsPerCase = 4,
    extraReports = 0,
    reviewerCount = 2,
    missingAdjudication = false,
    includeHeldOut = true,
    frozen = true,
  } = options;
  let reportCounter = 0;
  const sourceId = "validator-only-source";
  const cases: TestCase[] = Array.from({ length: caseCount }, (_, caseIndex) => {
    const caseId = `validator-case-${caseIndex + 1}`;
    const count = reportsPerCase + (caseIndex === 0 ? extraReports : 0);
    const reports = Array.from({ length: count }, () => {
      reportCounter += 1;
      const reportId = `validator-report-${reportCounter}`;
      return {
        report_id: reportId,
        revision_id: `validator-revision-${reportCounter}`,
        source_id: sourceId,
        content_hash: reportCounter.toString(16).padStart(64, "0"),
        origin_group_id: `validator-origin-${caseIndex + 1}`,
        content_ref: `permission-ref:validator-only-${reportCounter}`,
      };
    });
    const independent_reviews: TestReview[] = Array.from({ length: reviewerCount }, (_, reviewerIndex) => ({
      reviewer_id: `validator-placeholder-reviewer-${reviewerIndex + 1}`,
      reviewer_kind: "human",
      reviewed_at: "2026-01-01T00:00:00Z",
      labels: placeholderLabels(reports.map((report) => report.report_id)),
    }));
    const isHeldOut = includeHeldOut && caseIndex === caseCount - 1;
    const adjudication = missingAdjudication && caseIndex === 0
      ? null
      : {
          status: "reconciled",
          adjudicator_id: "validator-placeholder-adjudicator",
          adjudicator_kind: "human",
          adjudicated_at: "2026-01-02T00:00:00Z",
          labels: placeholderLabels(reports.map((report) => report.report_id)),
        };
    return {
      case_id: caseId,
      split: isHeldOut ? "held_out" : caseIndex % 2 === 0 ? "development" : "validation",
      scenario_tags: [SCENARIO_TAGS[caseIndex % SCENARIO_TAGS.length]],
      reports,
      independent_reviews,
      adjudication: adjudication === null
        ? null
        : {
            ...adjudication,
            labels: placeholderLabels(
              reports.map((report) => report.report_id),
              caseIndex < CATEGORIES.length ? CATEGORIES[caseIndex] : undefined,
            ),
          },
    };
  });

  return {
    schema_version: "1.0",
    casebook_id: "validator-only-structure",
    dataset_kind: "historical",
    sources: [{ source_id: sourceId, evaluation_use_rights: "pending", permission_ref: null }],
    held_out_freeze: frozen
      ? { state: "frozen", frozen_at: "2026-01-03T00:00:00Z" }
      : { state: "not_frozen", frozen_at: null },
    cases,
  };
}

function cloneFixture(): TestCasebook {
  return structuredClone(syntheticFixture);
}

function codesOf<T extends string>(codes: readonly T[]): Set<string> {
  return new Set(codes);
}

function assertIssue(book: unknown, code: CasebookIssueCode): void {
  const result = validateCasebook(book);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === code), `expected ${code}; got ${result.issues.map((issue) => issue.code).join(", ")}`);
}

function assertReadinessReason(book: unknown, code: ReadinessReasonCode): Set<string> {
  const result = evaluateReleaseReadiness(book);
  assert.equal(result.ready, false);
  const codes = codesOf(result.reasonCodes);
  assert.ok(codes.has(code), `expected ${code}; got ${[...codes].join(", ")}`);
  return codes;
}

test("authored synthetic fixture is structurally valid and never release-ready", () => {
  assert.equal(syntheticFixture.dataset_kind, "synthetic");
  assert.equal(validateCasebook(syntheticFixture).valid, true);
  const result = evaluateReleaseReadiness(syntheticFixture);
  assert.equal(result.ready, false);
  assert.ok(result.reasonCodes.includes("DATASET_NOT_HISTORICAL"));
  assert.ok(result.reasonCodes.includes("SOURCE_RIGHTS_NOT_APPROVED"));
  assert.ok(result.reasonCodes.includes("HUMAN_REVIEWERS_BELOW_MINIMUM"));
});

test("published contract is closed, versioned, and excludes live data", () => {
  assert.equal(casebookSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(casebookSchema.$id, "urn:waspada-jakarta:evaluation:casebook:1.0");
  assert.equal(casebookSchema.properties.schema_version.const, "1.0");
  assert.deepEqual(casebookSchema.properties.dataset_kind.enum, ["historical", "synthetic"]);
  assert.equal(casebookSchema.additionalProperties, false);
  assert.deepEqual(CATEGORIES, L2_CATEGORIES);
  assert.deepEqual(casebookSchema.$defs.labels.properties.category.allOf[1].properties.value.enum, L2_CATEGORIES);
  assert.deepEqual(casebookSchema.$defs.reportAssessment.properties.evidence_relations.allOf[1].properties.value.items.enum, EVIDENCE_RELATIONS);
  assert.deepEqual(casebookSchema.$defs.case.properties.scenario_tags.items.enum, SCENARIO_TAGS);
});

test("case scenario tags are required, closed, and unique curator metadata", () => {
  const missing = cloneFixture();
  delete (missing.cases[0] as unknown as Record<string, unknown>).scenario_tags;
  assertIssue(missing, "MISSING_FIELD");

  const unknown = cloneFixture();
  unknown.cases[0].scenario_tags = ["invented_scenario"];
  assertIssue(unknown, "INVALID_VALUE");

  const duplicate = cloneFixture();
  duplicate.cases[0].scenario_tags = [SCENARIO_TAGS[0], SCENARIO_TAGS[0]];
  assertIssue(duplicate, "INVALID_VALUE");
});

test("closed metadata shape rejects embedded source text and credential-like URLs", () => {
  const withBody = cloneFixture();
  (withBody.cases[0].reports[0] as unknown as Record<string, unknown>).body = "invented text, forbidden in casebook metadata";
  assertIssue(withBody, "UNKNOWN_FIELD");

  const withUrl = cloneFixture();
  withUrl.cases[0].reports[0].content_ref = "https://user:password@example.invalid/article?token=secret";
  assertIssue(withUrl, "INVALID_VALUE");
});

test("live datasets and non-human/model review fields are rejected", () => {
  const live = cloneFixture();
  live.dataset_kind = "live";
  assertIssue(live, "LIVE_DATASET_FORBIDDEN");

  const machineReviewer = cloneFixture();
  machineReviewer.cases[0].independent_reviews.push({
    reviewer_id: "model-output-1",
    reviewer_kind: "model",
    reviewed_at: "2026-01-01T00:00:00Z",
    labels: placeholderLabels(["synthetic-report-01"]),
  });
  assertIssue(machineReviewer, "NON_HUMAN_REVIEWER");

  const embeddedModelOutput = makeStructureOnlyCasebook({ caseCount: 1, reportsPerCase: 1, includeHeldOut: false });
  const review = embeddedModelOutput.cases[0].independent_reviews[0] as unknown as Record<string, unknown>;
  review.model_output = { category: "disasters_weather" };
  assertIssue(embeddedModelOutput, "MODEL_OUTPUT_FIELD_FORBIDDEN");

  const machineAdjudicator = makeStructureOnlyCasebook({ caseCount: 1, reportsPerCase: 1, includeHeldOut: false });
  machineAdjudicator.cases[0].adjudication!.adjudicator_kind = "model";
  assertIssue(machineAdjudicator, "NON_HUMAN_ADJUDICATOR");
});

test("reviewer IDs are unique per case, while missing adjudication remains explicit and valid", () => {
  const repeatedReviewer = makeStructureOnlyCasebook({ caseCount: 1, reportsPerCase: 1, includeHeldOut: false });
  repeatedReviewer.cases[0].independent_reviews[1].reviewer_id = repeatedReviewer.cases[0].independent_reviews[0].reviewer_id;
  assertIssue(repeatedReviewer, "DUPLICATE_REVIEWER_ID");

  const noAdjudication = cloneFixture();
  noAdjudication.cases[0].adjudication = null;
  assert.equal(validateCasebook(noAdjudication).valid, true);
  assertReadinessReason(noAdjudication, "ADJUDICATION_MISSING");
});

test("every human record explicitly assesses every report in its case", () => {
  const missing = makeStructureOnlyCasebook({ caseCount: 1, reportsPerCase: 1, includeHeldOut: false });
  const reviewLabels = missing.cases[0].independent_reviews[0].labels as { report_assessments: unknown[] };
  reviewLabels.report_assessments.splice(0, 1);
  assertIssue(missing, "REPORT_ASSESSMENT_MISSING");

  const duplicate = makeStructureOnlyCasebook({ caseCount: 1, reportsPerCase: 2, includeHeldOut: false });
  const duplicateLabels = duplicate.cases[0].independent_reviews[0].labels as { report_assessments: Array<{ report_id: string }> };
  duplicateLabels.report_assessments[1].report_id = duplicateLabels.report_assessments[0].report_id;
  assertIssue(duplicate, "DUPLICATE_REPORT_ASSESSMENT");
});

test("timestamps reject impossible calendar dates while accepting explicit offsets", () => {
  const impossibleDate = makeStructureOnlyCasebook({ caseCount: 1, reportsPerCase: 1, includeHeldOut: false });
  impossibleDate.cases[0].independent_reviews[0].reviewed_at = "2026-02-30T00:00:00Z";
  assertIssue(impossibleDate, "INVALID_VALUE");

  const validOffset = makeStructureOnlyCasebook({ caseCount: 1, reportsPerCase: 1, includeHeldOut: false });
  validOffset.cases[0].independent_reviews[0].reviewed_at = "2026-02-28T23:59:59+07:00";
  assert.equal(validateCasebook(validOffset).valid, true);
});

test("inherited object properties do not satisfy required JSON fields", () => {
  const inherited = Object.assign(Object.create({ dataset_kind: "synthetic" }) as Record<string, unknown>, cloneFixture());
  Reflect.deleteProperty(inherited, "dataset_kind");
  const result = validateCasebook(inherited);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "MISSING_FIELD" && issue.path === "$.dataset_kind"));

  const labeled = makeStructureOnlyCasebook({ caseCount: 1, reportsPerCase: 1, includeHeldOut: false });
  const labels = labeled.cases[0].independent_reviews[0].labels as Record<string, unknown>;
  labels.category = Object.assign(Object.create({ value: "disasters_weather" }) as Record<string, unknown>, { status: "labeled" });
  const missingOwnValue = validateCasebook(labeled);
  assert.ok(missingOwnValue.issues.some((issue) => issue.code === "MISSING_FIELD" && issue.path.endsWith("labels.category.value")));

  labels.category = Object.assign(Object.create({ value: "disasters_weather" }) as Record<string, unknown>, { status: "unknown" });
  assert.equal(validateCasebook(labeled).valid, true);
});

test("duplicate report identity and revision/origin/content leakage across cases are rejected", () => {
  const duplicateInCase = makeStructureOnlyCasebook({ caseCount: 1, reportsPerCase: 2, includeHeldOut: false });
  duplicateInCase.cases[0].reports[1].report_id = duplicateInCase.cases[0].reports[0].report_id;
  assertIssue(duplicateInCase, "DUPLICATE_REPORT_ID");

  const duplicateReport = makeStructureOnlyCasebook({ caseCount: 2, reportsPerCase: 1 });
  duplicateReport.cases[1].reports[0].report_id = duplicateReport.cases[0].reports[0].report_id;
  assertIssue(duplicateReport, "REPORT_ID_LEAKAGE");
  assertIssue(duplicateReport, "SPLIT_LEAKAGE");

  const revisionLeak = makeStructureOnlyCasebook({ caseCount: 2, reportsPerCase: 1 });
  revisionLeak.cases[1].reports[0].revision_id = revisionLeak.cases[0].reports[0].revision_id;
  assertIssue(revisionLeak, "REVISION_LEAKAGE");
  assertIssue(revisionLeak, "SPLIT_LEAKAGE");

  const originLeak = makeStructureOnlyCasebook({ caseCount: 2, reportsPerCase: 1 });
  originLeak.cases[1].reports[0].origin_group_id = originLeak.cases[0].reports[0].origin_group_id;
  assertIssue(originLeak, "ORIGIN_GROUP_LEAKAGE");
  assertIssue(originLeak, "SPLIT_LEAKAGE");

  const sameSplitOriginLeak = makeStructureOnlyCasebook({ caseCount: 2, reportsPerCase: 1 });
  sameSplitOriginLeak.cases[1].split = sameSplitOriginLeak.cases[0].split;
  sameSplitOriginLeak.cases[1].reports[0].origin_group_id = sameSplitOriginLeak.cases[0].reports[0].origin_group_id;
  assertIssue(sameSplitOriginLeak, "ORIGIN_GROUP_LEAKAGE");
  assert.equal(validateCasebook(sameSplitOriginLeak).issues.some((issue) => issue.code === "SPLIT_LEAKAGE"), false);

  const hashLeak = makeStructureOnlyCasebook({ caseCount: 2, reportsPerCase: 1 });
  hashLeak.cases[1].reports[0].content_hash = hashLeak.cases[0].reports[0].content_hash;
  assertIssue(hashLeak, "CONTENT_HASH_LEAKAGE");
  assertIssue(hashLeak, "SPLIT_LEAKAGE");
});

test("known origin and content may repeat within one incident case", () => {
  const sameCase = makeStructureOnlyCasebook({ caseCount: 1, reportsPerCase: 2, includeHeldOut: false });
  sameCase.cases[0].reports[1].origin_group_id = sameCase.cases[0].reports[0].origin_group_id;
  sameCase.cases[0].reports[1].content_hash = sameCase.cases[0].reports[0].content_hash;
  assert.equal(validateCasebook(sameCase).valid, true);
});

test("readiness gates use separate stable reasons on in-memory structure-only shapes", () => {
  const baseline = makeStructureOnlyCasebook();
  const baselineReasons = assertReadinessReason(baseline, "SOURCE_RIGHTS_NOT_APPROVED");
  assert.deepEqual([...baselineReasons], ["SOURCE_RIGHTS_NOT_APPROVED"]);
  assert.equal(baselineReasons.has("REPORT_COUNT_BELOW_MINIMUM"), false);
  assert.equal(baselineReasons.has("CASE_COUNT_BELOW_MINIMUM"), false);
  assert.equal(baselineReasons.has("REPORTS_PER_CASE_BELOW_MINIMUM"), false);
  assert.equal(baselineReasons.has("HUMAN_REVIEWERS_BELOW_MINIMUM"), false);
  assert.equal(baselineReasons.has("ADJUDICATION_MISSING"), false);
  assert.equal(baselineReasons.has("CATEGORY_COVERAGE_INCOMPLETE"), false);
  assert.equal(baselineReasons.has("SCENARIO_COVERAGE_INCOMPLETE"), false);
  assert.equal(baselineReasons.has("HELD_OUT_NOT_FROZEN"), false);

  const missingCategory = makeStructureOnlyCasebook();
  const firstCategory = missingCategory.cases[0].adjudication!.labels as { category: Record<string, unknown> };
  firstCategory.category = { status: "unknown" };
  const categoryReasons = assertReadinessReason(missingCategory, "CATEGORY_COVERAGE_INCOMPLETE");
  assert.equal(categoryReasons.has("SCENARIO_COVERAGE_INCOMPLETE"), false);

  for (const status of ["disputed", "not_applicable"]) {
    const nonLabeledCategory = makeStructureOnlyCasebook();
    const labels = nonLabeledCategory.cases[0].adjudication!.labels as { category: Record<string, unknown> };
    labels.category = { status };
    assertReadinessReason(nonLabeledCategory, "CATEGORY_COVERAGE_INCOMPLETE");
  }

  const pendingAdjudication = makeStructureOnlyCasebook();
  pendingAdjudication.cases[0].adjudication!.status = "pending";
  const pendingCategoryReasons = assertReadinessReason(pendingAdjudication, "CATEGORY_COVERAGE_INCOMPLETE");
  assert.equal(pendingCategoryReasons.has("SCENARIO_COVERAGE_INCOMPLETE"), false);

  const missingScenario = makeStructureOnlyCasebook();
  const omittedScenario = SCENARIO_TAGS[0];
  for (const item of missingScenario.cases) item.scenario_tags = item.scenario_tags.filter((tag) => tag !== omittedScenario);
  const scenarioReasons = assertReadinessReason(missingScenario, "SCENARIO_COVERAGE_INCOMPLETE");
  assert.equal(scenarioReasons.has("CATEGORY_COVERAGE_INCOMPLETE"), false);

  const tooFewReports = makeStructureOnlyCasebook({ reportsPerCase: 3, extraReports: 3 });
  const reportReasons = assertReadinessReason(tooFewReports, "REPORT_COUNT_BELOW_MINIMUM");
  assert.equal(reportReasons.has("REPORTS_PER_CASE_BELOW_MINIMUM"), false);

  const tooFewCases = makeStructureOnlyCasebook({ caseCount: 11 });
  assertReadinessReason(tooFewCases, "CASE_COUNT_BELOW_MINIMUM");

  const tooFewInOneCase = makeStructureOnlyCasebook();
  const removedReportIds = new Set(tooFewInOneCase.cases[0].reports.splice(0, 2).map((report) => report.report_id));
  for (const review of tooFewInOneCase.cases[0].independent_reviews) {
    const labels = review.labels as { report_assessments: Array<{ report_id: string }> };
    labels.report_assessments = labels.report_assessments.filter((assessment) => !removedReportIds.has(assessment.report_id));
  }
  const adjudicationLabels = tooFewInOneCase.cases[0].adjudication!.labels as { report_assessments: Array<{ report_id: string }> };
  adjudicationLabels.report_assessments = adjudicationLabels.report_assessments.filter((assessment) => !removedReportIds.has(assessment.report_id));
  assertReadinessReason(tooFewInOneCase, "REPORTS_PER_CASE_BELOW_MINIMUM");

  const tooFewReviewers = makeStructureOnlyCasebook({ reviewerCount: 1 });
  assertReadinessReason(tooFewReviewers, "HUMAN_REVIEWERS_BELOW_MINIMUM");

  const missingAdjudication = makeStructureOnlyCasebook({ missingAdjudication: true });
  assertReadinessReason(missingAdjudication, "ADJUDICATION_MISSING");

  const noHeldOut = makeStructureOnlyCasebook({ includeHeldOut: false });
  assertReadinessReason(noHeldOut, "HELD_OUT_SPLIT_MISSING");

  const notFrozen = makeStructureOnlyCasebook({ frozen: false });
  assertReadinessReason(notFrozen, "HELD_OUT_NOT_FROZEN");
});
