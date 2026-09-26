# API-PUBLIC-EVENT-LIST-CURSOR-CORE — authenticate public event-list cursors

- **Backlog ID:** `API-PUBLIC-EVENT-LIST-CURSOR-CORE`
- **Objective:** Implement a small, stateless Web Crypto codec that converts the accepted internal event-list keyset into a short-lived public cursor bound to the normalized filters.
- **Dependencies:** `API-PUBLIC-EVENT-LIST-FILTERS-CORE`, `API-PUBLIC-EVENT-LIST-PROJECTION-CORE`, `SPEC-03`, `ADR-021`.
- **Requirements:** `FR-09/10`; `NFR-01/07`.
- **Contract boundary:** Preserve the existing `next_cursor` string (maximum 2,048 characters) and `cursor_expires_at` fields. Do not change OpenAPI, DTOs, or URL parsing.
- **Allowed paths:** `apps/worker/src/layers/l4-application-integration/public-event-list-cursor.ts`; `apps/worker/test/l4-public-event-list-cursor.test.ts`; this assignment's implementation handoff only.
- **Forbidden scope:** No HTTP route, `URLSearchParams` parser, Worker environment binding, production secret provisioning, key persistence/rotation service, database connection, migration/index, public contract change, dependency, package-script, deployment, or live event data.
- **Branch/worktree:** Use branch `work/API-PUBLIC-EVENT-LIST-CURSOR-CORE` in a dedicated worktree, starting from the root's pushed assignment commit. Do not edit the root checkout.

## Context to read before editing

Read `AGENTS.md`, `SOFTWARE_DEVELOPMENT_PLAN.md`, `docs/IMPLEMENTATION_BACKLOG.md`, this assignment, [ADR-021](../decisions/ADR-021-public-event-list-cursor.md), [OpenAPI list contract](../api/openapi.yaml), [filter assignment](API-PUBLIC-EVENT-LIST-FILTERS-CORE.md), [projection assignment](API-PUBLIC-EVENT-LIST-PROJECTION-CORE.md), and the existing event-list projection service/types.

## Required behavior

1. Define a narrow injected codec over the existing `PublicEventListCursor` and `PublicEventListFilters` types. Accept an injected Workers-compatible `CryptoKey` for HMAC-SHA-256 and an injected clock for deterministic expiry tests. Do not load or generate the production key in the codec.
2. Issue a versioned base64url token that authenticates the internal cursor, a 15-minute expiry, and a keyed binding of the normalized filters. Return the matching expiry timestamp for the public `cursor_expires_at` field. Reject tokens longer than 2,048 characters.
3. Bind filters in deterministic closed-key order, treating absent/blank `q` and `place_id` as absent, and use HMAC domain separation for the filter binding and token signature. Never include raw `q` or other raw filter values in the decoded token payload.
4. Decode only the current token version; require exact payload keys and valid canonical cursor timestamps, identifiers, expiry, and filter binding. Verify the signature before trusting payload values. A token issued for a different normalized filter set is invalid. A page-size change alone does not invalidate the token.
5. Treat `expires_at <= now` as expired. Return stable bounded error codes that a later route can map to the existing `INVALID_REQUEST`/400 response. No error contains the cursor, key, filters, event ID, or crypto/runtime exception detail.
6. Use only standard Web Crypto and platform encoding APIs; add no dependency. The token is authenticated, not encrypted, and contains only public keyset fields and expiry plus an opaque filter binding.
7. Tests use generated in-memory test keys, authored fake cursor values, and a deterministic clock. They do not provision secrets, access Cloudflare/Neon, or establish deployment behavior.

## Acceptance criteria

- Valid issue/decode round trips preserve the internal keyset and exact expiry.
- Payload tampering, signature tampering, invalid base64url, unknown versions, extra/missing fields, malformed keysets, and overlong tokens fail with stable redacted errors.
- Expiry boundary at `expires_at <= now` is enforced.
- A cursor cannot be replayed with a different effective filter set; blank text filters normalize as absent; page-size changes do not alter binding.
- Decoded payloads do not contain raw filter values or the raw search query.
- `CryptoKey` and clock are injected; no environment binding, route, dependency, package script, public contract, or external service changes.

## Verification (WSL Ubuntu-26.04 only)

Record Node.js, npm, Git, and relevant package versions. Reuse existing dependencies. Run the focused Worker cursor test directly, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`. The Worker aggregate test does not currently include new focused files; run the assigned test directly and report that accurately. Do not run host-side Node/npm or access paid/live services.

## Commit and handoff

Implement only on the assigned branch/worktree. Commit implementation/tests and this handoff in coherent descriptive commits, leave the checkout clean, and do not merge or push. Report branch/worktree, exact commit SHAs/messages, changed paths, behavior, actual WSL checks, limitations, configuration impact, and remaining decisions. Root independently reviews and integrates.

## Stop conditions

Stop and ask root if the existing `CryptoKey`/Web Crypto types are unavailable in the configured Worker runtime, if the token cannot fit within 2,048 characters under bounded valid inputs, or if a public-contract change or production secret setup is needed. Escalate to GPT-6 Astra xhigh only after a GPT-6 Luna Max attempt fails on a substantive technical difficulty.

## Implementation handoff

Append exact branch/worktree, commit SHAs/messages, changed paths, behavior, actual WSL checks, limitations, configuration impact, and remaining decisions here. Do not merge or push.

