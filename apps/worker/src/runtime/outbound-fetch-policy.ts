/**
 * NFR-07: outbound acquisition never follows a redirect. A followed redirect would move a feed or
 * API request to a host nobody approved, and its body would be ingested as if the approved
 * endpoint had served it. A redirect is therefore a refusal: the response is not parsed and the
 * fetch is recorded as blocked.
 */
export const OUTBOUND_REDIRECT_POLICY = "manual" as const;

/** The error recorded when a refused redirect is the reason a fetch produced nothing. */
export const BLOCKED_REDIRECT_ERROR = "redirect_blocked";

/**
 * True for the response that "manual" hands back instead of following: a 3xx with Location, or an
 * opaqueredirect (status 0) in runtimes that hide the Location.
 */
export function isBlockedRedirect(response: Response): boolean {
  return response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400);
}
