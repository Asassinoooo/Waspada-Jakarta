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

### Implementer handoff — 27 September 2026

- **Branch/worktree:** `work/API-PUBLIC-EVENT-LIST-CURSOR-CORE`; WSL path `/mnt/c/Users/perry/.codex/worktrees/api-geojson-route-core/RPL` (Windows path `C:\Users\perry\.codex\worktrees\api-geojson-route-core\RPL`). The task-worktree Git metadata is shared with the root repository; all project verification ran inside WSL Ubuntu-26.04.
- **Implementation commit:** `f4de80f16082f7fe853e85aac9acb63b042d7e29` — `feat(API-PUBLIC-EVENT-LIST-CURSOR-CORE): add authenticated public cursors`.
- **Changed paths:** `apps/worker/src/layers/l4-application-integration/public-event-list-cursor.ts`; `apps/worker/test/l4-public-event-list-cursor.test.ts`; this assignment handoff.
- **Behavior:** Added an injected `CryptoKey`/clock codec for `PublicEventListCursor` and the accepted closed filters. It issues `v1` base64url HMAC-SHA-256 tokens with separate domain-separated filter-binding and full-token signatures, a 15-minute expiry, and a 2,048-character limit. Decoding authenticates before parsing payload values, checks exact canonical keys/keyset/expiry/binding, rejects `expires_at <= now`, and returns bounded redacted error codes. Filter binding follows deterministic closed-key order, lowercases trimmed `q`, trims `place_id`, omits blank text filters, and does not accept/bind page size. Raw filter values are absent from the payload. The focused tests use generated in-memory keys, authored fictional cursors, and a deterministic clock.
- **WSL tools/packages:** Ubuntu-26.04; Node.js `v24.21.0`, npm `11.19.0`, Git `2.53.0`; TypeScript `7.0.2`, tsx `4.23.15`, Wrangler `4.137.0`. A temporary `node_modules` symlink was used only after confirming its target was exactly `/mnt/d/Projects/RPL/node_modules`; it was removed before handoff.
- **Checks:** Direct focused test `node --import tsx --test apps/worker/test/l4-public-event-list-cursor.test.ts` — exit 0, 8/8. `npm test` — exit 0 (web 22/22, Worker 183/183, DB 16/16 files, evaluation 12/12); the new focused cursor test is not registered in the Worker aggregate and was run separately. `npm run typecheck` — exit 0. `npm run build` — exit 0, including Vite production output and Wrangler Worker dry-run. `git diff --check` and staged diff checks — exit 0.
- **Limitations:** Tests exercise Node's standard Web Crypto implementation with ephemeral keys. Wrangler dry-run passed, but no deployed Cloudflare Worker, production key, route, database, live data, or hosted service was configured or exercised.
- **Migration/configuration impact:** None. No OpenAPI/DTO, package script, dependency/lockfile, migration, runtime binding, deployment setting, or production secret changed.
- **Remaining decisions:** None for this bounded codec. Root review and integration remain outstanding.
