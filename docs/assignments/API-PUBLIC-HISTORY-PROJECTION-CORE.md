# API-PUBLIC-HISTORY-PROJECTION-CORE — strict public HistoryPage projection

- **Backlog ID:** `API-PUBLIC-HISTORY-PROJECTION-CORE`
- **Objective:** Compose the bounded event-version history reader and exact-version reviewed-disclosure reader into the existing public `HistoryPage` allowlist, following [ADR-020](../decisions/ADR-020-public-event-history-disclosure.md).
- **Dependencies:** `API-PUBLIC-HISTORY-READER-CORE`, `API-PUBLIC-HISTORY-REVIEW-METADATA-CORE`, `API-PROJECT-CORE`, `SPEC-03`, `ADR-012`, `ADR-020`.
- **Requirements:** `FR-10/13`; `NFR-01/07`.
- **Allowed paths:** `apps/worker/src/layers/l4-application-integration/public-event-history-projection-service.ts`; `apps/worker/test/l4-public-event-history-projection-service.test.ts`; and this assignment's implementation handoff only.
- **Forbidden scope:** No HTTP route, public/OpenAPI DTO change, `PublicReadModel` integration, database adapter or migration, Worker/runtime binding, moderation writer/authentication, publication behavior, source acquisition, real review row, paid service, dependency, package-script edit, or unrelated path.
- **Branch/worktree:** Use branch `work/API-PUBLIC-HISTORY-PROJECTION-CORE` in a dedicated managed worktree. Start from the root's pushed assignment commit; do not edit through the root checkout.
- **Contract versions:** Keep schema 2.0 records, `HistoryEntry`, `HistoryPage`, and all route contracts unchanged. Database/port payloads are untrusted and must never be serialized directly.
- **Dependencies/configuration:** No package or runtime configuration changes. Define narrow injected ports in the new service; keep `apps/worker` independent of direct imports from `apps/db`.

## Context to read before editing

Read `SOFTWARE_DEVELOPMENT_PLAN.md`, `docs/IMPLEMENTATION_BACKLOG.md`, this assignment, [ADR-012](../decisions/ADR-012-public-projection-boundary.md), [ADR-020](../decisions/ADR-020-public-event-history-disclosure.md), [DOMAIN_MODEL](../DOMAIN_MODEL.md), [UX/API spec](../UX_API_SPEC.md), [OpenAPI contract](../api/openapi.yaml), `apps/worker/src/contracts/public-api.ts`, the two accepted database reader assignments and implementations, and the existing strict Layer 4 projection services. Confirm the existing `HistoryEntry` fields and enum before defining the service result.

## Required behavior

1. Compose bounded candidate-version and exact-version disclosure pages using the same event ID, limit, and keyset boundary. Return `missing` only when the candidate history reader returns `missing`; a missing review-reader page for an existing public event is an unavailable/error result, not “no history.”
2. Validate reader result envelopes, event IDs, datasets, version identities, order, duplicates, page limits, next-version cursors, and agreement between the candidate and disclosure page version sequences. Treat both ports as untrusted even though their current DB implementations also validate results.
3. Build each `HistoryEntry` through an explicit allowlist containing only `event_id`, `version`, moderator-reviewed `change_type`, `changed_at`, and moderator-authored `summary`. Validate exact published live event record identity/status and a usable RFC 3339 `published_at` timestamp. `changed_at` comes from that version's `published_at`, never `reviewed_at` or a source timestamp.
4. Require complete approved-disclosure coverage for every candidate on the bounded page. Any null, held, revoked, stale, duplicate, missing, or mismatched disclosure fails closed with a stable bounded error; never return a partial page as complete and never infer a label or summary from record text, diffs, model output, or source content.
5. Omit reviewer IDs, review status, raw `record_json`, evidence/source content, and internal repository metadata from public `HistoryEntry` output. Validate the exact four `change_type` values and a non-empty summary of at most 500 Unicode code points.
6. Preserve keyset pagination. When more versions exist, set the existing `HistoryPage.page.next_cursor` to the bounded next-version token expected by this service; otherwise use `null`. `cursor_expires_at` remains `null` in this unconnected service slice. Do not add route cursor parsing or HTTP behavior.
7. Keep the projection read-only and independent of MOD-01, external services, hosted databases, and live data. Tests may use only authored synthetic/fictitious candidate and review rows. This is a code foundation, not evidence of real moderator approval, source rights, or a public route.

## Acceptance criteria

- A valid, completely reviewed candidate page projects to exactly the existing `HistoryPage` schema with no internal fields.
- `changed_at` exactly reflects the candidate version's `published_at`; review time is not substituted.
- Every missing/held/revoked or mismatched review prevents a partial public result.
- Withdrawn, non-live, malformed, duplicate, out-of-order, oversized, or cross-event/version records fail closed; a latest withdrawal remains `missing` through the reader boundary.
- Candidate/review page cursors and version sequences must agree; limits are bounded and inputs are rejected before port calls when invalid.
- Reader exceptions and malformed values become stable redacted service errors with no event IDs, summaries, record content, or database details.
- Tests verify unchanged `HistoryEntry`/`HistoryPage` shapes, Unicode summary limits, all `change_type` values, reviewer-ID stripping, cursor behavior, coverage failures, and port/result mismatches.
- No route, OpenAPI, contract, migration, dependency, real approval, runtime binding, or source is added.

## Verification (WSL Ubuntu-26.04 only)

Record `node --version`, `npm --version`, `git --version`, and relevant package versions. Reuse existing dependencies. Run the focused test directly with `npm exec -- tsx --test apps/worker/test/l4-public-event-history-projection-service.test.ts` because the Worker package test script enumerates files; then run `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`. Report actual results only; do not describe hosted Neon behavior as verified.

## Commit and handoff

Implement only on the assigned branch/worktree. Commit implementation and this handoff in coherent, descriptive commits. Leave the checkout clean. Do not merge or push. Report branch/worktree, exact commit SHA(s) and messages, changed paths, behavior, actual checks/results, limitations, configuration impact, and remaining decisions. Root independently reviews and integrates.

## Stop conditions

Stop and report if existing internal readers cannot be composed without a public DTO change or disclosure-policy change, if completeness cannot be proved for each returned page, or if the task would need MOD-01 writes/authentication, route/runtime wiring, source rights, or live data. Continue unrelated safe work within assigned paths where possible. Escalate to GPT-6 Astra xhigh only after a GPT-6 Luna Max attempt fails on a substantive technical difficulty.

## Implementation handoff

Append the exact branch/worktree, commits, changed paths, behavior, actual WSL checks, limitations and remaining decisions here. Do not merge or push.
