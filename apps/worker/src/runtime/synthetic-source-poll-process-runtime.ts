import { createRepositoryPorts } from "../../../db/src/ports.js";
import { withPostgresTransactionalSqlExecutor } from "../../../db/src/postgres-sql-executor.js";
import type { TransactionalSqlExecutor } from "../../../db/src/sql.js";
import { createSqlGeometryWriter } from "../../../db/src/geometry-writer.js";
import {
  type ModelCapabilityAdapter,
} from "../layers/l2-model-grounding/contracts.js";
import {
  type SyntheticSourcePollFixtureCatalog,
} from "../layers/l1-data-knowledge/synthetic-fixture-pipeline.js";
import {
  runSyntheticSourcePollJob,
  type SyntheticSourcePollRunnerResult,
} from "../layers/l1-data-knowledge/synthetic-source-poll-runner.js";
import { isValidHyperdriveConnectionString } from "./public-event-list-runtime.js";

export interface SyntheticSourcePollProcessRuntimeConfiguration {
  readonly datasetMode?: string;
  readonly processorEnabled?: string;
  readonly l1ConnectionString?: string;
}

export type SyntheticSourcePollProcessSqlExecutorRunner = <Result>(
  connectionString: string,
  operation: (executor: TransactionalSqlExecutor) => Promise<Result>,
) => Promise<Result>;

export interface SyntheticSourcePollProcessRuntimeDependencies {
  /** The exact-source-ID catalog is supplied by an authorized in-memory composition. */
  readonly catalog?: SyntheticSourcePollFixtureCatalog;
  /** Only L2 extraction is exposed to this L1 runner. */
  readonly modelAdapter?: Pick<ModelCapabilityAdapter, "extract">;
  /** Test seam; production uses one request-scoped transactional PostgreSQL client. */
  readonly withTransactionalSqlExecutor?: SyntheticSourcePollProcessSqlExecutorRunner;
}

export interface SyntheticSourcePollProcessRuntime {
  process(scheduledTime: number): Promise<SyntheticSourcePollRunnerResult>;
}

export type SyntheticSourcePollProcessRuntimeErrorCode =
  | "INVALID_SCHEDULED_TIME"
  | "PROCESS_FAILED";

/** Fixed messages keep connection, driver, fixture, and source details out of failures. */
export class SyntheticSourcePollProcessRuntimeError extends Error {
  constructor(readonly code: SyntheticSourcePollProcessRuntimeErrorCode) {
    super(code === "INVALID_SCHEDULED_TIME"
      ? "The scheduled synthetic poll timestamp is invalid."
      : "The synthetic source poll could not be completed.");
    this.name = "SyntheticSourcePollProcessRuntimeError";
  }
}

/**
 * Builds the opt-in demo processor only when its database and both injected
 * processing capabilities are available. No SQL client is opened here.
 */
export function createSyntheticSourcePollProcessRuntime(
  configuration: SyntheticSourcePollProcessRuntimeConfiguration,
  dependencies: SyntheticSourcePollProcessRuntimeDependencies = {},
): SyntheticSourcePollProcessRuntime | undefined {
  if (configuration.datasetMode !== "demo"
    || configuration.processorEnabled !== "true"
    || !isValidHyperdriveConnectionString(configuration.l1ConnectionString)
    || !isSyntheticSourcePollFixtureCatalog(dependencies.catalog)
    || !isExtractionAdapter(dependencies.modelAdapter)) {
    return undefined;
  }

  const connectionString = configuration.l1ConnectionString;
  const catalog = dependencies.catalog;
  const modelAdapter = dependencies.modelAdapter;
  const withTransactionalSqlExecutor = dependencies.withTransactionalSqlExecutor
    ?? withPostgresTransactionalSqlExecutor;

  return {
    async process(scheduledTime) {
      const now = formatScheduledInstant(scheduledTime);
      let boundedRunnerFailure: SyntheticSourcePollRunnerResult | undefined;

      try {
        return await withTransactionalSqlExecutor(connectionString, async (executor) => {
          let result: SyntheticSourcePollRunnerResult | undefined;
          let runtimeFailure = false;

          try {
            await executor.execute("SET ROLE waspada_l1_pipeline");
            const ports = createRepositoryPorts(executor);
            result = await runSyntheticSourcePollJob({
              now,
              queue: ports.acquisitionJobs,
              catalog,
              pipelinePorts: {
                acquisitionJobs: ports.acquisitionJobs,
                sourceRegistry: ports.sourceRegistry,
                modelAdapter,
                reportRevisions: ports.reportRevisions,
                extractionResults: ports.extractionResults,
                evidenceChunks: ports.evidenceChunks,
                geometryWriter: createSqlGeometryWriter(executor),
              },
            });
          } catch {
            runtimeFailure = true;
          }

          let roleResetFailed = false;
          try {
            await executor.execute("RESET ROLE");
          } catch {
            roleResetFailed = true;
          }

          if (runtimeFailure || result === undefined) {
            throw new SyntheticSourcePollProcessRuntimeError("PROCESS_FAILED");
          }

          // The runner result is already bounded and redacted. Preserve it if
          // cleanup also fails; the request-scoped connection is then closed.
          if (roleResetFailed && result.outcome !== "failed") {
            throw new SyntheticSourcePollProcessRuntimeError("PROCESS_FAILED");
          }

          if (result.outcome === "failed") boundedRunnerFailure = result;
          return result;
        });
      } catch (error) {
        if (boundedRunnerFailure !== undefined) return boundedRunnerFailure;
        if (error instanceof SyntheticSourcePollProcessRuntimeError) throw error;
        throw new SyntheticSourcePollProcessRuntimeError("PROCESS_FAILED");
      }
    },
  };
}

function formatScheduledInstant(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)
    || !Number.isSafeInteger(value) || value < 0) {
    throw new SyntheticSourcePollProcessRuntimeError("INVALID_SCHEDULED_TIME");
  }

  try {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() > 9999) {
      throw new Error("invalid platform timestamp");
    }
    const instant = date.toISOString();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(instant)) {
      throw new Error("invalid platform timestamp");
    }
    return instant;
  } catch {
    throw new SyntheticSourcePollProcessRuntimeError("INVALID_SCHEDULED_TIME");
  }
}

function isSyntheticSourcePollFixtureCatalog(
  value: unknown,
): value is SyntheticSourcePollFixtureCatalog {
  return typeof value === "object" && value !== null
    && typeof (value as { readonly lookupExactSourceId?: unknown }).lookupExactSourceId === "function";
}

function isExtractionAdapter(
  value: unknown,
): value is Pick<ModelCapabilityAdapter, "extract"> {
  return typeof value === "object" && value !== null
    && typeof (value as { readonly extract?: unknown }).extract === "function";
}
