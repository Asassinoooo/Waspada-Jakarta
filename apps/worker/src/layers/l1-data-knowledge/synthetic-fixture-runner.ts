import {
  processSyntheticFixtureJob,
  type FixtureJobRecord,
  type FixturePipelinePorts,
  type SyntheticFixtureCatalog,
  type SyntheticFixturePipelineResult,
} from "./synthetic-fixture-pipeline.js";

export interface SyntheticFixtureClaimPort {
  /** The repository applies both fixture scope predicates before leasing a row. */
  claimDueSyntheticModeratorSubmission(now: string): Promise<FixtureJobRecord | null>;
}

export interface RunSyntheticFixtureJobInput {
  readonly now: string;
  readonly queue: SyntheticFixtureClaimPort;
  readonly catalog: SyntheticFixtureCatalog;
  readonly pipelinePorts: FixturePipelinePorts;
}

type PipelineFailureCode = Extract<
  SyntheticFixturePipelineResult,
  { readonly outcome: "failed" }
>["code"];

export type SyntheticFixtureRunnerResult =
  | { readonly outcome: "idle" }
  | Extract<SyntheticFixturePipelineResult, { readonly outcome: "completed" }>
  | Extract<SyntheticFixturePipelineResult, { readonly outcome: "not_eligible" }>
  | Extract<SyntheticFixturePipelineResult, { readonly outcome: "lost_lease" }>
  | {
      readonly outcome: "failed";
      readonly code:
        | PipelineFailureCode
        | "invalid_timestamp"
        | "queue_claim_failed"
        | "runner_failed";
      readonly queueOutcome: "not_claimed" | "retry" | "terminal" | "not_acknowledged";
    };

const PIPELINE_FAILURE_CODES: ReadonlySet<PipelineFailureCode> = new Set([
  "fixture_not_found",
  "fixture_catalog_failed",
  "fixture_payload_invalid",
  "fixture_manifest_invalid",
  "fixture_source_invalid",
  "fixture_text_invalid",
  "fixture_persistence_failed",
  "queue_acknowledgement_failed",
]);

/** Claim and process at most one due fixture job, using only caller-supplied time. */
export async function runSyntheticFixtureJob(
  input: RunSyntheticFixtureJobInput,
): Promise<SyntheticFixtureRunnerResult> {
  const now = (input as RunSyntheticFixtureJobInput | null | undefined)?.now;
  if (!isRfc3339Timestamp(now)) {
    return { outcome: "failed", code: "invalid_timestamp", queueOutcome: "not_claimed" };
  }

  let job: FixtureJobRecord | null;
  try {
    job = await input.queue.claimDueSyntheticModeratorSubmission(now);
  } catch {
    return { outcome: "failed", code: "queue_claim_failed", queueOutcome: "not_claimed" };
  }
  if (job === null) return { outcome: "idle" };

  try {
    return safePipelineResult(await processSyntheticFixtureJob({
      job,
      catalog: input.catalog,
      ports: input.pipelinePorts,
      transitionAt: now,
    }));
  } catch {
    return { outcome: "failed", code: "runner_failed", queueOutcome: "not_acknowledged" };
  }
}

function safePipelineResult(result: SyntheticFixturePipelineResult): SyntheticFixtureRunnerResult {
  switch (result.outcome) {
    case "completed":
      return {
        outcome: "completed",
        empty: result.empty,
        reportCount: result.reportCount,
        evidenceReferenceCount: result.evidenceReferenceCount,
        chunkCount: result.chunkCount,
        geometryCount: result.geometryCount,
      };
    case "not_eligible":
      return { outcome: "not_eligible", code: "job_not_eligible" };
    case "lost_lease":
      return { outcome: "lost_lease", code: "lease_not_owned" };
    case "failed":
      return {
        outcome: "failed",
        code: PIPELINE_FAILURE_CODES.has(result.code) ? result.code : "runner_failed",
        queueOutcome: result.queueOutcome,
      };
  }
}

function isRfc3339Timestamp(value: unknown): value is string {
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
