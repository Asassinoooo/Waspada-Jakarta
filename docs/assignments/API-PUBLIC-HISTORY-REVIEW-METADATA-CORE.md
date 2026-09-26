# API-PUBLIC-HISTORY-REVIEW-METADATA-CORE — exact-version reviewed disclosure reader

- **Backlog ID:** `API-PUBLIC-HISTORY-REVIEW-METADATA-CORE`
- **Objective:** Store and read explicit moderator-reviewed history labels and summaries for exact event versions, as required by [ADR-020](../decisions/ADR-020-public-event-history-disclosure.md).
- **Dependencies:** `DATA-01`, `API-PUBLIC-HISTORY-READER-CORE`, `ADR-020`.
- **Requirements:** `FR-10/12/13`; `NFR-01/07`.
- **Allowed paths:** `apps/db/migrations/014_public_event_history_review_metadata.sql`; `apps/db/src/public-event-history-disclosure.ts`; `apps/db/test/public-event-history-disclosure.test.ts`; `apps/db/test/migrations.test.ts` (migration-sequence expectations only); and this assignment's implementation handoff only.
- **Forbidden scope:** No moderator write endpoint, authentication or authorization implementation, public HistoryEntry projection, HTTP route, OpenAPI/public DTO change, Worker/runtime binding, migration-runner change, publication behavior, source acquisition, live review row, paid service, dependency, or unrelated path.
- **Branch/worktree:** Use a dedicated branch `work/API-PUBLIC-HISTORY-REVIEW-METADATA-CORE` in the prepared task worktree. Start from the root's pushed assignment commit; do not edit through the root checkout.
- **Contract versions:** Keep schema 2.0 records and public `HistoryEntry` unchanged. Internal database output is untrusted input and must never be serialized directly to a client.
- **Dependencies/configuration:** No package or runtime configuration changes. Use existing SQL executor, migration harness, and authored PGlite tests.

## Context to read before editing

Read `SOFTWARE_DEVELOPMENT_PLAN.md`, `docs/IMPLEMENTATION_BACKLOG.md`, this assignment, [ADR-020](../decisions/ADR-020-public-event-history-disclosure.md), [ADR-012](../decisions/ADR-012-public-projection-boundary.md), [DOMAIN_MODEL](../DOMAIN_MODEL.md), [UX/API spec](../UX_API_SPEC.md), [OpenAPI contract](../api/openapi.yaml), migration 013 and its reader, migration 001 role/view conventions, existing append-only approval snapshots and repositories, and DB test conventions. Confirm the exact HistoryEntry enum/summary limits and the current-public/withdrawal filter before designing the schema.

## Required behavior

1. Add an append-only, version-bound record for a moderator-selected `HistoryEntry.change_type` and moderator-authored public summary. Bind each decision to exact `live` dataset, event ID, and event version; retain an opaque reviewer identity and review timestamp for later MOD-01 authorization/audit integration.
2. Only the latest approved review for an exact published version may be returned. A later withheld/revoked review must suppress the prior approval rather than reveal it. No decision or revoked approval returns no approved metadata.
3. A least-privilege, security-barrier read view and injected parameterized repository must join/limit rows to versions visible in `public_event_history_versions`. Exclude withdrawn versions, historical/synthetic datasets, non-current-public events, and mismatched event/version identities. Latest-withdrawn events remain missing with their entire history hidden.
4. Bound the exact lookup/page size and validate identities, change-type enum, non-empty summary length (at most 500 Unicode code points), review state and timestamps. Fail closed with stable redacted errors for malformed, duplicate, unexpected, or identity-mismatched rows.
5. Preserve the distinction between a version's `published_at` (future public `changed_at`) and its moderator review timestamp. Do not derive labels/summaries from event JSON, text diffs, model output, or source content.
6. The public-reader role may SELECT only the approved filtered view and must not gain direct access to the review table or private/moderation tables. This task creates no writer; authored fictional test rows do not prove a real moderator decision or source/data rights.
7. No public projection may interpret absent review metadata as “no history.” A later Layer 4 projection must verify complete review coverage for the bounded candidate page and fail closed or report unavailable if coverage is incomplete.

## Acceptance criteria

- Exact event-version identity and append-only review revision state are database-enforced.
- Only the latest approved, current-public, published live version's review metadata can be read; a newer revoked/held revision suppresses old approval.
- Reader queries are parameterized, deterministic, bounded, identity-validating, and redacted.
- Tests cover approved/unapproved/revoked revisions, duplicate and mismatched IDs, current withdrawal, non-live datasets, bounds/summary constraints, query parameters, and least-privilege grants.
- No public DTO, projection, route, runtime binding, real reviewer identity, source, or dependency is added.

## Verification (WSL Ubuntu-26.04 only)

Record `node --version`, `npm --version`, `git --version` and relevant package versions. Reuse existing dependencies. Run the focused test, `npm run db:test`, full `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`. Report actual results only; do not describe hosted Neon behavior as verified.

## Commit and handoff

Implement only on the assigned branch/worktree. Commit implementation and this handoff in coherent, descriptive commits. Leave the checkout clean. Do not merge or push. Report exact branch/worktree, SHA(s), commit messages, changed paths, behavior, actual checks/results, limitations, configuration impact and remaining decisions. Root independently reviews and integrates.

## Stop conditions

Stop and report if the stored contract cannot preserve moderator review provenance, if safe view access requires withdrawn-event exposure, or if the task would need MOD-01 writes/authentication, a public DTO/route, source rights, or live runtime changes. Continue unrelated safe work within scope where possible. Escalate to GPT-6 Astra xhigh only after a GPT-6 Luna Max attempt fails on a substantive technical difficulty.

## Implementation handoff

Append the exact branch/worktree, commit(s), changed paths, behavior, actual WSL checks, limitations and remaining decisions here. Do not merge or push.

### Implementation handoff - 2026-09-26

- **Branch:** `work/API-PUBLIC-HISTORY-REVIEW-METADATA-CORE`
- **Worktree:** `C:\Users\perry\.codex\worktrees\api-geojson-route-core\RPL` (WSL: `/mnt/c/Users/perry/.codex/worktrees/api-geojson-route-core/RPL`)
- **Implementation commit:** `9b2ab2adb09cfb60446d4f2853aa2e1b023822cf` - `feat(db): add reviewed public history metadata reader`
- **Changed paths:** `apps/db/migrations/014_public_event_history_review_metadata.sql`; `apps/db/src/public-event-history-disclosure.ts`; `apps/db/test/public-event-history-disclosure.test.ts`; `apps/db/test/migrations.test.ts`; this handoff.

Migration 014 adds append-only, exact-version review decisions and a security-barrier view that selects the newest decision before exposing only approved metadata joined to `public_event_history_versions`. The public-reader role can SELECT the filtered view only; it has no review-table or sequence access. The injected repository performs bounded, parameterized keyset reads, validates exact live event/version keys and metadata, redacts failures, and reports missing approvals as explicit per-version nulls with `coverageComplete: false`. It never selects record JSON. The tests cover approved, held, and revoked revisions; multiple versions; non-UTC offset `+07:30`; invalid timezone and bounds; tab/newline-only summaries; withdrawals; non-live rows; parameterization and page bounds; malformed, duplicate, or mismatched IDs; append-only enforcement; and grants.

**Checks run in WSL Ubuntu-26.04:** focused test passed (7/7); `npm run db:test` passed (15/15 DB test files); `npm test` passed (22 web, 183 Worker, 15 DB, and 12 eval tests); `npm run typecheck` passed; `npm run build` passed, including the Wrangler dry run; `git diff --check` passed. Runtime/tool versions were Node `v24.21.0`, npm `11.19.0`, Git `2.53.0`; relevant packages were PGlite `0.5.8`, pgvector adapter `0.0.9`, PostGIS adapter `0.2.8`, tsx `4.23.15`, TypeScript `7.0.2`, Vite `8.3.0`, and Wrangler `4.137.0`.

No dependencies or runtime configuration changed. Validation used authored synthetic PGlite rows; hosted Neon behavior and real moderator decisions were not tested. MOD-01 must supply authenticated review writes, and a future public projection must check complete coverage and keep internal reviewer metadata out of public serialization. No policy change or further decision was needed for this slice; root review and integration remain pending.
