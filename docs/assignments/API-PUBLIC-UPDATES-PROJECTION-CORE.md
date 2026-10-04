# API-PUBLIC-UPDATES-PROJECTION-CORE — strict update page and signed cursor

- **Status:** Accepted on local `main`; see [root review](../CURRENT_CHECKPOINT.md)
- **Backlog ID:** `API-PUBLIC-UPDATES-PROJECTION-CORE`
- **Objective:** Compose the accepted update-feed DB reader into the existing `HistoryEntry` allowlist and implement a stateless 30-day cursor plus empty bootstrap behavior, without adding a route.
- **Dependencies:** `API-PUBLIC-UPDATES-READER-CORE`, `API-PUBLIC-HISTORY-PROJECTION-CORE`, `API-PUBLIC-EVENT-LIST-CURSOR-CORE`, `SPEC-03`, `ADR-026`.
- **Requirements:** `FR-10/11/13`; `NFR-01/05/07`.
- **Allowed paths:** `apps/worker/src/layers/l4-application-integration/public-event-updates-cursor.ts`; `apps/worker/src/layers/l4-application-integration/public-event-updates-service.ts`; focused cursor/service tests at `apps/worker/test/l4-public-event-updates-cursor.test.ts` and `apps/worker/test/l4-public-event-updates-service.test.ts`; and this assignment's implementation handoff only.
- **Forbidden scope:** No HTTP route, public/OpenAPI contract change, `PublicReadModel` wiring, database SQL or migration, Hyperdrive/runtime binding, production secret creation or configuration, moderation write/authentication, source acquisition, live data, paid service, dependency, package-script edit, or unrelated path.
- **Branch/worktree:** Use branch `work/API-PUBLIC-UPDATES-PROJECTION-CORE` in a dedicated managed worktree, based on the pushed assignment commit. Do not edit through the root checkout.
- **Contract baseline:** Keep schema 2.0 event records, `HistoryEntry`, and OpenAPI `UpdatePage` unchanged. Define only the internal service result needed to mirror the existing `items`, `next_cursor`, `cursor_expires_at`, and `checked_at` contract. Database reader values and codec inputs are untrusted; never serialize raw rows.
- **Dependencies/configuration:** No runtime configuration or package changes. Inject the accepted DB-reader port, a Web Crypto `CryptoKey`, and a deterministic clock; do not import `apps/db` directly from `apps/worker`.

## Context to read before editing

Read `SOFTWARE_DEVELOPMENT_PLAN.md`, `docs/IMPLEMENTATION_BACKLOG.md`, this assignment, [ADR-026](../decisions/ADR-026-public-update-feed-cursor.md), [ADR-021](../decisions/ADR-021-public-event-list-cursor.md), [OpenAPI update contract](../api/openapi.yaml), `apps/worker/src/contracts/public-api.ts`, the accepted DB reader assignment and implementation, `public-event-history-projection-service.ts`, and `public-event-list-cursor.ts` plus its tests. Confirm the exact `HistoryEntry` fields, four change labels, cursor TTL/key/domain rules, and existing Worker-compatible Web Crypto patterns before coding.

## Required behavior

1. Define a narrow injected reader port for `readWatermark()` and bounded `readCandidates({ afterSequence, throughSequence, limit })`. Treat every response as `unknown` at the service boundary and validate exact object keys, dataset, event ID/version, canonical signed-bigint decimal strings, ascending unique sequence, bounds, change label, summary, publication timestamp, candidate count, and `hasMore` consistency.
2. Project each candidate through an explicit allowlist into exactly the existing `HistoryEntry`: `event_id`, `version`, moderator-reviewed `change_type`, `changed_at` from the exact version's `published_at`, and the reviewed `summary`. Enforce 1–500 Unicode code points for summaries. Do not infer withdrawal, a new event time, or safety from a change label or absent page.
3. Implement a versioned base64url HMAC-SHA-256 cursor for `{ dataset: 'live', sequence, expires_at }`, with a 30-day lifetime and a 2,048-character maximum. Use the existing `PUBLIC_EVENT_LIST_CURSOR_HMAC_KEY_HEX` only through an injected `CryptoKey`, with a signature domain distinct from the event-list cursor. Do not include interests, location, event content, or reviewer identity. No filter binding is needed.
4. On an omitted cursor, read the current watermark and return an empty `items` array with a signed cursor at that watermark; this is a baseline and never replays older updates. With a valid cursor, read the current watermark, return `CURSOR_RESTART_REQUIRED` for expired or ahead-of-watermark cursors, and query strictly after the cursor sequence through the observed watermark. Malformed, tampered, or wrong-scope tokens produce a stable invalid-request error.
5. If the reader reports `hasMore`, require a full requested page and continue from the last returned candidate sequence. Otherwise advance the cursor to the observed watermark, including when sequence gaps contain only held/revoked review decisions. Always return a cursor, its expiry, and an RFC 3339 `checked_at`, including for empty pages. The runtime task must later read watermark and candidates within one repeatable-read request snapshot.
6. Keep reader/cursor/service failures bounded and redacted. Distinguish malformed input/cursor, cursor restart, reader failure, invalid reader result, and cursor issue failure in typed errors for later route mapping. Never expose SQL, raw tokens, sequence inputs, event summaries, candidate rows, crypto errors, or reviewer IDs in errors.
7. Keep the slice deterministic and read-only. Use generated ephemeral test keys, an injected test clock, and authored fictional reader fixtures. No real source, moderator approval, provider, database, or deployment is needed.

## Acceptance criteria

- An omitted cursor returns an empty bootstrap page at the current watermark, with a valid opaque continuation and exact 30-day expiry.
- A valid signed cursor reads only `(cursor.sequence, observedWatermark]`; pagination uses the last returned sequence only when `hasMore`, otherwise it advances to the watermark.
- Expired and ahead-of-watermark cursors map to the restart-required error; malformed, tampered, noncanonical, wrong-scope, oversized, or extra-field cursors fail with fixed redacted errors.
- Sequences remain decimal strings throughout JavaScript; no conversion to `number` can lose signed-bigint precision.
- Invalid page requests are rejected before reader calls. Malformed, unordered, duplicate, out-of-range, oversized, stale, or cross-dataset candidates fail closed without partial output.
- Every result item has exactly the existing `HistoryEntry` keys and only uses candidate publication time plus approved review label/summary. The page has the already documented `items`, `next_cursor`, `cursor_expires_at`, and `checked_at` fields.
- Tests verify empty bootstrap, cursor round-trip and domain separation, 30-day boundary, ahead-of-watermark reset, multi-page continuation, sequence gaps, exact DTO keys, all four change labels, Unicode summary limits, reader failures, and strict malformed-result rejection.
- No route, OpenAPI, public contract, DB migration, deployment binding, production secret, source, dependency, or live data changes.

## Verification (WSL Ubuntu-26.04 only)

Record Node.js, npm, Git, and relevant package versions. Reuse existing dependencies; do not install packages. Run the two focused tests directly with `npm exec -- tsx --test apps/worker/test/l4-public-event-updates-cursor.test.ts` and `npm exec -- tsx --test apps/worker/test/l4-public-event-updates-service.test.ts`, then `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`. Report actual results; do not claim hosted Neon or deployed Cloudflare behavior.

## Commit and handoff

Implement only on the assigned branch/worktree. Commit implementation and this handoff in coherent descriptive commits, leave the checkout clean, and do not merge or push. Report branch/worktree, exact commit SHAs/messages, changed paths, behavior, actual WSL checks, limitations, configuration impact, and remaining decisions. Root independently reviews and integrates.

## Stop conditions

Stop and report if the unchanged OpenAPI response cannot be represented without changing its contract, if a 30-day bounded cursor cannot fit within 2,048 characters, or if correct bootstrap/continuation cannot be proven from the reader port. Do not add a second secret, route, production runtime wiring, or browser behavior. Escalate to GPT-6 Astra xhigh only after a GPT-6 Luna Max attempt fails on a substantive technical difficulty.

## Implementation handoff

Append exact branch/worktree, commit SHAs/messages, changed paths, behavior, actual WSL checks, limitations, configuration impact, and remaining decisions here. Do not merge or push.

### Delivery record

- **Branch:** `work/API-PUBLIC-UPDATES-PROJECTION-CORE`
- **Worktree:** `C:\Users\perry\.codex\worktrees\api-updates-reader-core\RPL` (`/mnt/c/Users/perry/.codex/worktrees/api-updates-reader-core/RPL`)
- **Implementation commit:** `d45d583b8f600b8c0b998c41a3b13eaab408c3b9` - `feat(worker): add public update projection and cursor`
- **Changed paths:**
  - `apps/worker/src/layers/l4-application-integration/public-event-updates-cursor.ts`
  - `apps/worker/src/layers/l4-application-integration/public-event-updates-service.ts`
  - `apps/worker/test/l4-public-event-updates-cursor.test.ts`
  - `apps/worker/test/l4-public-event-updates-service.test.ts`
  - `docs/assignments/API-PUBLIC-UPDATES-PROJECTION-CORE.md` (this handoff)

The injected reader port has typed bounded candidate options and returns untrusted results for exact-shape validation. The service validates the request before reads; omitted cursors return an empty baseline page at the committed watermark. Valid cursors read strictly after their decimal-string sequence through the observed watermark. Full pages with `hasMore` continue from the last returned candidate; completed pages advance to the watermark across held/revoked sequence gaps. Candidate rows are validated for exact identity, dataset, order, bounds, review label, Unicode summary length, and publication time before the service constructs exactly the existing five-field `HistoryEntry`. No withdrawal entry is synthesized; the accepted reader's current-public/latest-approved filtering remains authoritative.

The cursor is a versioned base64url HMAC-SHA-256 token for only `dataset`, `sequence`, and `expires_at`, signed under a domain distinct from the event-list cursor. It uses an injected `CryptoKey` and clock, expires after 30 days, and is capped at 2,048 characters. Service errors have fixed messages and distinguish invalid requests, cursor restart, reader failure, invalid reader results, and cursor issue failure.

- **Verification environment:** WSL Ubuntu-26.04; Node.js `v24.21.0`; npm `11.19.0`; Git `2.53.0`; tsx `4.23.15`; Vite `8.3.0`; Wrangler `4.137.0`. A temporary symlink to the existing root `node_modules` tree enabled checks; it was removed before commit. No packages were installed.
- **Focused cursor test:** `npm exec -- tsx --test apps/worker/test/l4-public-event-updates-cursor.test.ts` - passed, 5/5.
- **Focused service test:** `npm exec -- tsx --test apps/worker/test/l4-public-event-updates-service.test.ts` - passed, 9/9.
- **Full test suite:** `npm test` - passed, exit 0; web 41/41, Worker 251/251, DB 20/20 test files, evaluation 12/12. The two new focused files are run by their explicit commands above because the Worker package script enumerates its existing tests.
- **Typecheck:** `npm run typecheck` - passed, exit 0.
- **Build:** `npm run build` - passed, exit 0; Vite production build and Wrangler dry-run completed.
- **Whitespace:** `git diff --check` and staged diff check - passed, exit 0.

**Limitations:** No route or runtime transaction wrapper was added, so no HTTP mapping or deployed behavior was exercised. The future runtime must call the watermark and candidates through a single request-scoped repeatable-read snapshot and map the typed service errors. No hosted Cloudflare or database behavior was tested.

**Configuration impact:** None. No package, binding, secret, migration, provider resource, or live data changed. Runtime construction requires the existing list-cursor secret to be imported as an injected `CryptoKey`; this task creates no secret or binding.

**Remaining decisions:** None within this bounded projection task. Route error mapping and transaction snapshot wiring remain assigned to later runtime integration.
