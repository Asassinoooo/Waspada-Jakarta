import {
  processSyntheticFixtureJob,
  type FixtureJobRecord,
  type FixturePipelinePorts,
  type SyntheticFixtureCatalog,
  type SyntheticFixturePipelineResult,
} from "./synthetic-fixture-pipeline.js";
import {
  L1_SYNTHETIC_FIXTURE_JOB_EVENT_NAME,
  L1_SYNTHETIC_FIXTURE_TELEMETRY_MAX_COUNT,
  noOpTelemetry,
  type L1SyntheticFixtureJobTelemetryRecord,
  type TelemetrySink,
} from "../l5-evaluation-monitoring/telemetry.js";

export interface SyntheticFixtureClaimPort {
  /** The repository applies both fixture scope predicates before leasing a row. */
  claimDueSyntheticModeratorSubmission(now: string): Promise<FixtureJobRecord | null>;
}

export interface RunSyntheticFixtureJobInput {
  readonly now: string;
  readonly queue: SyntheticFixtureClaimPort;
  readonly catalog: SyntheticFixtureCatalog;
  readonly pipelinePorts: FixturePipelinePorts;
  readonly telemetry?: TelemetrySink;
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
  const startedAt = monotonicNow();
  let result: SyntheticFixtureRunnerResult;
  try {
    result = await runSyntheticFixtureJobWithoutTelemetry(input);
  } catch {
    result = { outcome: "failed", code: "runner_failed", queueOutcome: "not_acknowledged" };
  }

  recordRunnerTelemetry(input, result, elapsedSince(startedAt));
  return result;
}

async function runSyntheticFixtureJobWithoutTelemetry(
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

function recordRunnerTelemetry(
  input: RunSyntheticFixtureJobInput,
  result: SyntheticFixtureRunnerResult,
  durationMs: number,
): void {
  const record = makeTelemetryRecord(result, durationMs);
  let sink: unknown;
  try {
    sink = input?.telemetry ?? noOpTelemetry;
  } catch {
    sink = noOpTelemetry;
  }

  let recordMethod: unknown;
  try {
    recordMethod = (sink as TelemetrySink).record;
  } catch {
    return;
  }
  if (typeof recordMethod !== "function") return;

  try {
    recordMethod.call(sink, record);
  } catch {
    // Telemetry is best-effort and must never affect the runner result.
  }
}

function makeTelemetryRecord(
  result: SyntheticFixtureRunnerResult,
  durationMs: number,
): L1SyntheticFixtureJobTelemetryRecord {
  if (result.outcome !== "completed") {
    return {
      eventName: L1_SYNTHETIC_FIXTURE_JOB_EVENT_NAME,
      outcome: result.outcome,
      durationMs,
    };
  }

  return {
    eventName: L1_SYNTHETIC_FIXTURE_JOB_EVENT_NAME,
    outcome: "completed",
    durationMs,
    empty: result.empty,
    reportCount: boundedCount(result.reportCount),
    evidenceReferenceCount: boundedCount(result.evidenceReferenceCount),
    chunkCount: boundedCount(result.chunkCount),
    geometryCount: boundedCount(result.geometryCount),
  };
}

function boundedCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) return 0;
  return Math.min(value, L1_SYNTHETIC_FIXTURE_TELEMETRY_MAX_COUNT);
}

function monotonicNow(): number | null {
  try {
    const value = globalThis.performance?.now();
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

function elapsedSince(startedAt: number | null): number {
  if (startedAt === null) return 0;
  const endedAt = monotonicNow();
  if (endedAt === null || endedAt < startedAt) return 0;
  const durationMs = endedAt - startedAt;
  return Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
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
