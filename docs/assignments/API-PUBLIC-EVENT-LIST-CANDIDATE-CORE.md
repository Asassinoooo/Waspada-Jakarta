# API-PUBLIC-EVENT-LIST-CANDIDATE-CORE — bounded current-public event candidates

- **Backlog ID:** `API-PUBLIC-EVENT-LIST-CANDIDATE-CORE`
- **Objective:** Add an injected, bounded database reader that returns current published live event candidates in a stable initial-publication order for later Layer 4 list projection.
- **Dependencies:** `DATA-01`, `DB-TEST-RUNNER-ISOLATION`, `API-PUBLIC-SNAPSHOT-CORE`, `API-PUBLIC-HISTORY-READER-CORE`, `ADR-012`, `ADR-018`.
- **Requirements:** `FR-09/10`; `NFR-01/07`.
- **Allowed paths:** `apps/db/src/public-event-list.ts`; `apps/db/test/public-event-list.test.ts`; `apps/db/test/run-db-tests.ts` (register the focused database test); and this assignment's implementation handoff only.
- **Forbidden scope:** No public L4 projection, search/filter semantics, HTTP route, DTO/OpenAPI contract, Worker/runtime database binding, migration, source acquisition, review/publication write, real data, paid service, dependency, or package script.
- **Branch/worktree:** Use branch `work/API-PUBLIC-EVENT-LIST-CANDIDATE-CORE` in a dedicated managed worktree. Start from the root's pushed assignment commit; never edit through the root checkout.
- **Contract boundary:** This is an internal candidate port, not a public response. Event record JSON remains untrusted schema 2.0 input and must not be serialized directly.
- **Ordering decision:** Use descending initial `published_at` from event version 1, then ascending `event_id` as a deterministic tie-breaker. This key does not change when later versions are published. Root selected this recommended default after offering the user a choice; the user may still steer it before implementation.

## Context to read before editing

Read `AGENTS.md`, `SOFTWARE_DEVELOPMENT_PLAN.md`, `docs/IMPLEMENTATION_BACKLOG.md`, this assignment, [ADR-012](../decisions/ADR-012-public-projection-boundary.md), [ADR-018](../decisions/ADR-018-jakarta-geojson-query-envelope.md), `apps/db/src/public-event-snapshot.ts`, `apps/db/src/public-event-history.ts`, migrations 001 and 013, the DB test runner, and relevant PGlite tests. Verify existing grants before beginning; this assignment does not permit migration changes.

## Required behavior

1. Define a narrow `PublicEventListRepository` with an injected `SqlExecutor`; do not create a database connection or import Worker code.
2. Read from existing safe public views only. Return candidates solely for `dataset_kind = live` events that remain currently published. A withdrawn current version must remove its event from the list, even though older history exists.
3. Validate the bounded request before SQL: default page size 20, maximum 100; cursor is either absent or an exact closed `{ firstPublishedAt, eventId }` keyset anchor. Reject malformed IDs, timestamps, extra keys, unsafe values, and out-of-range limits without querying.
4. Use initial publication time from version 1 as the immutable sort anchor. Sort by `firstPublishedAt DESC, eventId ASC`; for a cursor, read strictly after it with `firstPublishedAt < anchor OR (firstPublishedAt = anchor AND eventId > eventIdAnchor)`. Probe at `limit + 1`, return at most `limit`, and form the next internal anchor from the last returned row only when another candidate exists.
5. Return each candidate as an internal exact current `eventId`, current `eventVersion`, validated `firstPublishedAt`, and untrusted `recordJson`; validate row identity, current record envelope/version, published-live status, first-version timestamp, deterministic ordering, duplicate IDs, and page bounds. Never expose SQL errors or record content.
6. The cursor preserves position when later versions update an event because its initial publication key does not change. It is not a historical snapshot: a current withdrawal removes that event, and candidate content is the current published version at read time. New events before the cursor appear on a later refresh, not halfway through an existing page sequence.
7. Do not implement or infer category/lifecycle/freshness/date/search/place filters in this slice. Do not change the existing OpenAPI filter vocabulary, demo list behavior, public DTOs, route, or pagination token. A later Layer 4 list service owns safe projection and query-filter behavior.
8. Tests use only authored fictional PGlite records. They do not establish source rights, event truth, hosted Neon compatibility, or a functioning public list API.

## Acceptance criteria

- Pages are bounded, deterministic, and keyset-stable under later event-version changes, with no duplicate or out-of-order rows.
- Current withdrawals and non-live/synthetic namespaces are excluded by the existing safe public view path.
- Malformed cursor, records, identity, timestamp, duplicates, unsorted rows, excessive limits, and reader failures produce bounded redacted errors.
- Query values are parameterized; input validation occurs before SQL; the reader has only the existing necessary least-privilege view access.
- Tests verify first-publication sort stability across version updates, same-time event ID ordering, limit-plus-one behavior, valid continuation, end-of-list, filters intentionally absent, withdrawn/non-live exclusion, and validation/error handling.
- No migration, route, DTO, filter implementation, database connection, Worker binding, source, approval, or dependency is added unless the root accepts a separate design change.

## Verification (WSL Ubuntu-26.04 only)

Record `node --version`, `npm --version`, `git --version`, and relevant package versions. Reuse existing dependencies. Run the focused DB test directly, then `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`. Report actual results only; do not describe hosted Neon behavior as verified.

## Commit and handoff

Implement only on the assigned branch/worktree. Commit the implementation and this handoff in coherent descriptive commits, leave the checkout clean, and do not merge or push. Report branch/worktree, exact commit SHAs and messages, changed paths, behavior, actual checks, limitations, configuration impact, and remaining decisions. Root independently reviews and integrates.

## Stop conditions

Stop and report if the existing public views cannot supply initial version-1 timestamps without broader grants, if implementing the cursor requires changing a public contract, or if the required identity/ordering cannot be established. Do not invent first-publication timestamps or fall back to latest-update ordering. Escalate to GPT-6 Astra xhigh only after a GPT-6 Luna Max attempt fails on a substantive technical difficulty.

## Implementation handoff

Append exact branch/worktree, commit SHAs/messages, changed paths, behavior, actual WSL checks, limitations, migration/configuration impact, and remaining decisions here. Do not merge or push.
