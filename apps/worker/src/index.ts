import { handlePublicApiRequest, type WorkerEnvironment } from "./layers/l4-application-integration/api.js";

export default {
  fetch(request: Request, env: WorkerEnvironment): Promise<Response> {
    return handlePublicApiRequest(request, env);
  },
};
