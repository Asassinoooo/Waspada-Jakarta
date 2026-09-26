# ADR-021: Authenticated public event-list cursors

- **Status:** Accepted
- **Date:** 27 September 2026
- **Scope:** Future database-backed `GET /api/v1/events` continuation tokens

## Context

The public event-list contract carries an opaque `next_cursor` string (maximum 2,048 characters) and a separate `cursor_expires_at`. The accepted database reader and Layer 4 projection service use an internal keyset of the immutable initial publication timestamp and event ID. The current demo reader still uses its existing offset cursor; this decision does not change demo behavior.

The public token must preserve keyset integrity, expire in bounded time, and remain tied to the filters used to produce the page. A token must not repeat the user's raw text query. No route or runtime secret binding is part of this decision.

## Decision

Use a versioned base64url token with an HMAC-SHA-256 signature through the Workers Web Crypto API. The signed payload carries the internal keyset, expiration time, and a keyed binding to the normalized closed filter set. The raw filter values, including `q`, are not included in the token. Use domain-separated HMAC inputs for the filter binding and complete payload signature.

Tokens expire 15 minutes after issue, matching the current demo list's advertised cursor lifetime. Expiry is enforced at `expires_at <= now`. The page size is not bound: a caller may choose another valid limit while continuing from the same keyset and filters. The existing list endpoint's `INVALID_REQUEST`/400 behavior covers malformed, tampered, filter-mismatched, or expired tokens; this ADR does not add a public response contract.

The codec accepts its `CryptoKey` and clock through injection. It does not read an environment variable, create/store a production secret, or add a dependency. Secret provisioning, key rotation policy, URL parsing, route wiring, and Worker/database runtime composition remain separate tasks. Rotating the signing key invalidates outstanding tokens. HMAC authenticates the cursor but does not encrypt it; the keyset fields are already part of public event pagination.

The first Worker runtime-composition slice accepts the secret as `PUBLIC_EVENT_LIST_CURSOR_HMAC_KEY_HEX`: exactly 64 hexadecimal characters representing 32 random bytes. Runtime code imports it as a non-extractable HMAC-SHA-256 key for `sign` and `verify`. This names and validates the configuration interface only; it does not create a key, configure a Cloudflare secret, or change the deployment.

## Consequences

- Clients cannot alter a keyset position or continue a cursor under a different normalized filter set without invalidating the signature.
- Raw search text is not disclosed by decoding the token.
- Stateless verification works on Cloudflare Workers without a database lookup or paid service.
- The later runtime-composition task must provide a secret `CryptoKey` and must map codec failures to the documented list error response.
- The existing demo offset cursor remains independent until an explicitly assigned route change.
