/**
 * SEC-HEADERS-01 (NFR-07): security headers for Worker responses, and the plain-http redirect for the API.
 *
 * Static web assets are served by Cloudflare without running this Worker, so their headers live in
 * apps/web/public/_headers. Everything the Worker answers (JSON, SSE, redirects) passes through here.
 */

/**
 * Applied only when the response does not already set the header. The API serves JSON and SSE, never HTML,
 * so a `default-src 'none'` policy blocks any script that a browser might run from a rendered JSON document.
 */
export const API_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

/** Local development (`wrangler dev`, the Vite proxy, the local smoke run) speaks plain http on loopback. */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Adds the API security headers without touching the body or any header the response already sets
 * (`cache-control`, `set-cookie`, a route's own frame policy). The body stream is handed to the new Response
 * unread, so an SSE response keeps streaming. Responses are rebuilt rather than mutated because
 * fetch-derived responses have immutable headers.
 */
export function withSecurityHeaders(response: Response): Response {
  // A 101 Switching Protocols response cannot be rebuilt with a status the constructor accepts.
  if (response.status === 101) return response;

  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * For a plain-http request to /api/, returns a 308 to the https URL. A 308 keeps the method and body, so POST
 * clients follow it too. Returns null when no redirect applies. Loopback hosts are never redirected.
 */
export function httpsApiRedirect(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.protocol !== "http:") return null;
  if (!url.pathname.startsWith("/api/")) return null;
  if (LOOPBACK_HOSTNAMES.has(url.hostname)) return null;

  url.protocol = "https:";
  return new Response(null, { status: 308, headers: { Location: url.toString() } });
}
