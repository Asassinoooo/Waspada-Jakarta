/**
 * HOSTED-25: the production cron starts the GitHub Actions ingest workflow instead of ingesting in the Worker.
 * GitHub's own schedule fired once in about 18 hours (17 to 18 Nov 2026), so the Worker cron is the timer now.
 * The Worker never sees ingest data here: it sends one workflow_dispatch request and logs a fixed outcome code.
 */

export interface IngestDispatchEnv {
  /** `github_dispatch` makes scheduled() only start the workflow. Unset keeps the in-Worker scheduled path. */
  SCHEDULED_MODE?: string;
  /** Fine-grained GitHub token: this repo only, Actions read and write. Secret, never logged. */
  GITHUB_DISPATCH_TOKEN?: string;
  /** `owner/name` of the repository that holds the workflow. */
  INGEST_DISPATCH_REPO?: string;
  /** Workflow file name. Defaults to ingest.yml. */
  INGEST_DISPATCH_WORKFLOW?: string;
  /** Git ref to run. Defaults to main. */
  INGEST_DISPATCH_REF?: string;
}

export type IngestDispatchOutcome =
  | "dispatched"
  | "not_configured"
  | "rejected_auth"
  | "rejected_not_found"
  | "rejected_other"
  | "network_error";

export function isGithubDispatchMode(env: IngestDispatchEnv): boolean {
  return env.SCHEDULED_MODE === "github_dispatch";
}

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const WORKFLOW_PATTERN = /^[A-Za-z0-9_.-]+\.ya?ml$/;

export async function dispatchIngestWorkflow(
  env: IngestDispatchEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<{ outcome: IngestDispatchOutcome; status?: number }> {
  const token = env.GITHUB_DISPATCH_TOKEN?.trim();
  const repo = env.INGEST_DISPATCH_REPO?.trim();
  const workflow = env.INGEST_DISPATCH_WORKFLOW?.trim() || "ingest.yml";
  const ref = env.INGEST_DISPATCH_REF?.trim() || "main";
  if (!token || !repo || !REPO_PATTERN.test(repo) || !WORKFLOW_PATTERN.test(workflow)) {
    return { outcome: "not_configured" };
  }
  let response: Response;
  try {
    response = await fetchImpl(
      `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "user-agent": "waspada-ingest-cron",
          "x-github-api-version": "2022-11-28",
        },
        body: JSON.stringify({ ref }),
      },
    );
  } catch {
    return { outcome: "network_error" };
  }
  // GitHub answers 204 (or 200 with a run id on newer API versions) when the run is queued.
  if (response.status === 204 || response.status === 200) return { outcome: "dispatched", status: response.status };
  if (response.status === 401 || response.status === 403) return { outcome: "rejected_auth", status: response.status };
  if (response.status === 404) return { outcome: "rejected_not_found", status: response.status };
  return { outcome: "rejected_other", status: response.status };
}
