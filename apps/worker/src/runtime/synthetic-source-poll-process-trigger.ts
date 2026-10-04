import {
  createSyntheticSourcePollProcessRuntime,
  type SyntheticSourcePollProcessRuntime,
  type SyntheticSourcePollProcessRuntimeConfiguration,
  type SyntheticSourcePollProcessRuntimeDependencies,
} from "./synthetic-source-poll-process-runtime.js";
import type { SyntheticSourcePollRunnerResult } from "../layers/l1-data-knowledge/synthetic-source-poll-runner.js";
import type { WorkerEnvironment } from "../layers/l4-application-integration/api.js";

export type SyntheticSourcePollProcessRuntimeFactory = (
  configuration: SyntheticSourcePollProcessRuntimeConfiguration,
  dependencies: SyntheticSourcePollProcessRuntimeDependencies,
) => SyntheticSourcePollProcessRuntime | undefined;

/** Adapts the platform scheduled event without exposing source or dataset choice. */
export async function handleSyntheticSourcePollProcessTrigger(
  scheduledTime: number,
  environment: WorkerEnvironment,
  dependencies: SyntheticSourcePollProcessRuntimeDependencies = {},
  createRuntime: SyntheticSourcePollProcessRuntimeFactory = createSyntheticSourcePollProcessRuntime,
): Promise<SyntheticSourcePollRunnerResult | undefined> {
  const runtime = createRuntime({
    datasetMode: environment.DATASET_MODE,
    processorEnabled: environment.SYNTHETIC_POLL_PROCESSOR_ENABLED,
    l1ConnectionString: environment.L1_HYPERDRIVE?.connectionString,
  }, dependencies);
  if (runtime === undefined) return undefined;
  return runtime.process(scheduledTime);
}
