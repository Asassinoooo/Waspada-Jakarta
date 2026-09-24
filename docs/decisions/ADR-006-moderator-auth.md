# ADR-006 — Moderator authentication and authorization

- **Status:** Accepted as SPEC-03 design; runtime authentication remains unimplemented.
- **Date:** 24 September 2026
- **Owners:** Backend/API and moderator UX

## Context

Public map, feed, history, GeoJSON and briefing reads need no account. Moderation can publish supported claims, correct versions, retract information and approve sources, so those operations need authenticated identity, explicit roles, CSRF protection, concurrency control and an audit trail. The MVP has no public registration. The API selects the active `live`, `historical` or `synthetic` dataset from server configuration; a browser must not select or mix datasets.

## Decision

Use a same-origin, server-side session for moderator access. Do not put bearer tokens or credentials in browser local/session storage.

- The authentication service issues an opaque, cryptographically random session token with at least 256 bits of entropy. The database stores a one-way hash of the token, its moderator subject, current server-assigned role, creation/last-use/expiry times, CSRF secret and selected dataset binding. Authorization reads the current account/role state server-side; a client-provided role is never trusted.
- Send the token only in the `__Host-waspada_session` cookie with `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, and no `Domain`. Serve moderator pages and APIs over HTTPS. No moderator CORS access from other origins is enabled.
- A same-origin pre-authentication CSRF endpoint sets a short-lived, `Secure`, `SameSite=Strict`, host-only pre-auth cookie and returns its token in the response body. Login requires an exact same-origin `Origin` header and a matching `X-CSRF-Token` header. After successful login, discard the pre-auth token, rotate into a fresh session, and return the session's synchronizer CSRF token only in the response body. Logout and every state-changing moderator request require the session cookie, exact same-origin `Origin`, and the matching `X-CSRF-Token` header. Compare secrets in constant time. CORS does not allow credentialed cross-origin requests.
- Rotate the session identifier after authentication and any privilege change. Invalidate the server-side session immediately on logout, account disablement or role removal. Apply both idle and absolute expiration; provisional values are 30 minutes idle and 8 hours absolute, to be confirmed against deployment needs before implementation. Mark moderator responses `Cache-Control: no-store`.
- Use generic login failures that do not reveal account existence, rate-limit attempts, and store password verifiers with a vetted memory-hard password hashing implementation. Provision accounts and roles through a restricted operator procedure; there is no public signup or account-management endpoint.
- Authorize every action at the API boundary. `moderator` can review evidence and submit eligible corrections; `admin` can additionally approve sources and manage moderator access. Both roles remain subject to the publication gate; neither can waive missing evidence, make model confidence equivalent to verification, or bypass source/geometry checks. Source approval is separate from approving a specific claim. Reads and writes are limited to the dataset selected by the server for that API deployment.
- Append an audit record for each successful write with internal actor ID, role at decision time, action, target event/impact/source version, reason, request trace, idempotency key and timestamp. Do not expose audit internals through public projections. Retain prior versions rather than rewriting them.
- Mutation requests supply expected event/impact versions. Return a conflict if the target has advanced; the caller must reload and reconcile. Mutation requests also carry an idempotency key. A retry with the same actor, route, key and body returns the original result and creates no second version or audit entry; reusing the key with a different body is rejected. Apply authorization and CSRF checks before returning an idempotent result.

## Consequences

The browser can authenticate without storing a reusable token in JavaScript-accessible storage, and the server can revoke sessions and enforce role/dataset changes promptly. The API and operator runbook must provide protected account provisioning, credential rotation/disablement, session cleanup and audit retention. Multi-instance deployment requires shared server-side session storage. HTTPS and same-origin routing are deployment requirements.

The selected deployment has a same-origin Cloudflare Worker and Neon-backed server-side session store; sessions and roles stay on the server and all moderators are scoped to the configured dataset. The proposed idle and absolute timeouts, password-hash implementation/parameters, operator provisioning workflow, MFA decision and audit retention period remain implementation decisions. They must be resolved before real moderator accounts are provisioned; this ADR does not claim an auth service exists.

## References

- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) — host-only `__Host-` cookie protections, secure cookie attributes, and avoiding browser storage for session credentials.
- [OWASP Cross-Site Request Forgery Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html) — synchronizer token and same-site defense-in-depth guidance.
