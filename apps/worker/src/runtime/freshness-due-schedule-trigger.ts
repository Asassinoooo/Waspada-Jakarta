import {
  createFreshnessDueScheduleRuntime,
  type FreshnessDueScheduleRuntime,
  type FreshnessDueScheduleRuntimeConfiguration,
} from "./freshness-due-schedule-runtime.js";
import type { WorkerEnvironment } from "../layers/l4-application-integration/api.js";

export type FreshnessDueScheduleRuntimeFactory = (
  configuration: FreshnessDueScheduleRuntimeConfiguration,
) => FreshnessDueScheduleRuntime | undefined;

/** Adapts the platform timer event using only the dedicated freshness writer binding. */
export async function handleFreshnessDueScheduleTrigger(
  scheduledTime: number,
  environment: WorkerEnvironment,
  createRuntime: FreshnessDueScheduleRuntimeFactory = createFreshnessDueScheduleRuntime,
): Promise<void> {
  const runtime = createRuntime({
    datasetMode: environment.DATASET_MODE,
    schedulerEnabled: environment.FRESHNESS_DUE_SCHEDULER_ENABLED,
    freshnessWriterConnectionString: environment.FRESHNESS_DUE_HYPERDRIVE?.connectionString,
  });
  if (runtime === undefined) return;
  await runtime.schedule(scheduledTime);
}
