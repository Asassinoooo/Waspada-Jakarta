import {
  createSyntheticPollScheduleRuntime,
  type SyntheticPollScheduleRuntime,
  type SyntheticPollScheduleRuntimeConfiguration,
} from "./synthetic-poll-schedule-runtime.js";
import type { SourcePollScheduleSummary } from "../../../db/src/source-poll-scheduler.js";
import type { WorkerEnvironment } from "../layers/l4-application-integration/api.js";

export type SyntheticPollScheduleRuntimeFactory = (
  configuration: SyntheticPollScheduleRuntimeConfiguration,
) => SyntheticPollScheduleRuntime | undefined;

/** Adapts the platform timer event without exposing connection or dataset choice. */
export async function handleSyntheticPollScheduleTrigger(
  scheduledTime: number,
  environment: WorkerEnvironment,
  createRuntime: SyntheticPollScheduleRuntimeFactory = createSyntheticPollScheduleRuntime,
): Promise<SourcePollScheduleSummary | undefined> {
  const runtime = createRuntime({
    datasetMode: environment.DATASET_MODE,
    schedulerEnabled: environment.SYNTHETIC_POLL_SCHEDULER_ENABLED,
    l1ConnectionString: environment.L1_HYPERDRIVE?.connectionString,
  });
  if (runtime === undefined) return undefined;
  return runtime.schedule(scheduledTime);
}
