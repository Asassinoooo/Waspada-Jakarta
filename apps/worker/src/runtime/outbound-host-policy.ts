/**
 * NFR-07 F-42: an outbound acquisition request may go only to a host the source registry approves for that source
 * (source_registry.approved_hosts), or to a host declared in code for a configured endpoint. The check runs before
 * any request, so a refused URL costs no network call. Redirects are never followed (outbound-fetch-policy.ts), so a
 * redirect to another host is refused whether or not that host is approved.
 */

/** The fixed code recorded when a URL's host is not approved for the source. */
export const HOST_NOT_APPROVED_ERROR = "host_not_approved" as const;
/** The fixed code recorded when a URL cannot be parsed, so no host can be checked. */
export const URL_INVALID_ERROR = "url_invalid" as const;

export type OutboundHostRefusal = typeof HOST_NOT_APPROVED_ERROR | typeof URL_INVALID_ERROR;

export type OutboundHostDecision =
  | { readonly allowed: true; readonly host: string }
  | { readonly allowed: false; readonly error: OutboundHostRefusal };

/** Trimmed, lower-cased host entries. Empty entries are dropped, so a blank registry value approves nothing. */
export function normalizeApprovedHosts(hosts: readonly string[] | null | undefined): readonly string[] {
  if (!hosts) return [];
  return hosts.map((host) => host.trim().toLowerCase()).filter((host) => host.length > 0);
}

/**
 * Compares the parsed host of the URL (hostname and any explicit port) with the approved list. The URL parser decides
 * the host, so "https://approved.example@other.example/" is checked as other.example, and a look-alike host is refused.
 * An empty approved list refuses every URL (fail closed).
 */
export function checkOutboundHost(url: string, approvedHosts: readonly string[]): OutboundHostDecision {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, error: URL_INVALID_ERROR };
  }
  const host = parsed.host.toLowerCase();
  if (host.length === 0) return { allowed: false, error: URL_INVALID_ERROR };
  return normalizeApprovedHosts(approvedHosts).includes(host)
    ? { allowed: true, host }
    : { allowed: false, error: HOST_NOT_APPROVED_ERROR };
}

/**
 * The hosts declared by configured endpoints. A poller uses them when no registry list is supplied, so the code-declared
 * endpoints are themselves the allow-list. An unparseable endpoint declares nothing and is refused at fetch time.
 */
export function declaredHostsOf(urls: readonly string[]): readonly string[] {
  const hosts: string[] = [];
  for (const url of urls) {
    try {
      hosts.push(new URL(url).host.toLowerCase());
    } catch {
      // Not declared: a request to this endpoint is refused by checkOutboundHost.
    }
  }
  return [...new Set(hosts)];
}
