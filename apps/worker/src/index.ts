import { createPublicEventListRuntime } from "./runtime/public-event-list-runtime.js";
import { handlePublicApiRequest, type WorkerEnvironment } from "./layers/l4-application-integration/api.js";
import { consoleTelemetry } from "./layers/l5-evaluation-monitoring/telemetry.js";

export default {
  async fetch(request: Request, env: WorkerEnvironment): Promise<Response> {
    const url = new URL(request.url);
    const eventListPageService =
      env.DATASET_MODE === "live"
        && request.method === "GET"
        && url.pathname === "/api/v1/events"
        ? await createPublicEventListRuntime({
          datasetMode: env.DATASET_MODE,
          connectionString: env.HYPERDRIVE?.connectionString,
          cursorHmacKeyHex: env.PUBLIC_EVENT_LIST_CURSOR_HMAC_KEY_HEX,
        })
        : undefined;

    return handlePublicApiRequest(request, env, consoleTelemetry, eventListPageService);
  },
};
