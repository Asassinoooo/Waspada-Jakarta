import { handlePublicApiRequest, type WorkerEnvironment } from "./layers/l4-application-integration/api.js";
import { consoleTelemetry } from "./layers/l5-evaluation-monitoring/telemetry.js";

export default {
  fetch(request: Request, env: WorkerEnvironment): Promise<Response> {
    return handlePublicApiRequest(request, env, consoleTelemetry);
  },
};
