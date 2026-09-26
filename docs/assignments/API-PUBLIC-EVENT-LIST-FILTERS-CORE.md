# API-PUBLIC-EVENT-LIST-FILTERS-CORE — filter bounded public event pages

- **Backlog ID:** `API-PUBLIC-EVENT-LIST-FILTERS-CORE`
- **Objective:** Apply the existing event-list filter vocabulary inside the bounded database candidate reader and Layer 4 list composition, before keyset ordering and pagination.
- **Dependencies:** `API-PUBLIC-EVENT-LIST-CANDIDATE-CORE`, `API-PUBLIC-EVENT-LIST-PROJECTION-CORE`, `API-PUBLIC-LOOKUPS-CORE`, `SPEC-03`, `ADR-012`.
- **Requirements:** `FR-09/10`; `NFR-01/07`.
- **Contract boundary:** Preserve the current OpenAPI query vocabulary, `EventView`, and `EventPage`. This is an internal typed-filter extension only; it does not parse URL parameters or encode public cursors.
- **Allowed paths:** `apps/db/src/public-event-list.ts`; `apps/db/test/public-event-list.test.ts`; `apps/worker/src/layers/l4-application-integration/public-event-list-projection-service.ts`; `apps/worker/test/l4-public-event-list-projection-service.test.ts`; this assignment's implementation handoff only.
- **Forbidden scope:** No OpenAPI/DTO changes, URL/query parser, public cursor token or expiry, HTTP route, demo read-model behavior, Worker database binding/connection, migration/index, source acquisition, review/publication write, real data, paid service, dependency, package-script, or runtime configuration change.
- **Branch/worktree:** Use branch `work/API-PUBLIC-EVENT-LIST-FILTERS-CORE` in a dedicated managed worktree. Start from the root's pushed assignment commit; do not edit through the root checkout.

## Context to read before editing

Read `AGENTS.md`, `SOFTWARE_DEVELOPMENT_PLAN.md`, `docs/IMPLEMENTATION_BACKLOG.md`, this assignment, [API-01 OpenAPI list contract](../api/openapi.yaml), [UX/API specification](../UX_API_SPEC.md), [ADR-012](../decisions/ADR-012-public-projection-boundary.md), the candidate-reader and list-projection assignments and source/tests, the public scope-name lookup and migration 011 grants, and the existing `PublicReadModel` list filter behavior.

## Required behavior

1. Extend the injected candidate reader and Layer 4 list service with one closed, typed filter object. Validate filter types, enums, lengths, and dates before issuing SQL or invoking either injected port. No raw `URLSearchParams` crosses these service boundaries.
2. Support the existing filters: `category`, `lifecycle`, `freshness`, `from`, `to`, `q`, and `place_id`. Defaults omit each filter. Enforce the existing category/lifecycle/freshness enums, a 120-character text query, a 128-character place ID, and an inclusive date interval no longer than 90 days when both bounds are supplied. Reject reversed ranges and invalid RFC 3339 date-times.
3. Preserve the demo list's matching semantics: enum filters are exact; date filters compare inclusively against the event's `event_time.start` and exclude an event whose start is unknown; `place_id` is an exact match against the event's top-level `scope.place_ids`; and `q` is trimmed and treated as a case-insensitive substring across event title, summary, category, and top-level event scope display names. A blank trimmed `q` or `place_id` means no filter.
4. Search scope names only through the existing `waspada.public_scope_names` safe view (latest approved Indonesian display names); never search or return private name-review rows, source text, claims, raw excerpts, or unapproved labels. Match the same top-level scope classes used by the current demo list. Treat the query as literal text, not as a SQL wildcard pattern.
5. Apply every requested filter in SQL before keyset ordering and `limit + 1` probing so matches cannot be skipped by page boundaries. Keep `dataset_kind = live`, current-public/withdrawal filtering, the immutable version-1 publication-time descending and event-ID ascending keyset, parameterized inputs, page limits, redacted failures, projection order, and the four-call concurrency cap.
6. A filter is evaluated on the candidate's current version before projection. If any non-empty filter is present and the subsequent current `EventView` projection returns a version newer than that candidate, fail the whole page with a stable, redacted retryable error. Do not return a possibly nonmatching version, especially when `place_id` is active because internal place IDs are intentionally absent from `EventView`. Unfiltered requests retain the accepted behavior of allowing a newer projected version; a missing/withdrawn projection remains omitted while preserving cursor progress.
7. Return only the existing `{ events, nextCursor }` internal list result. Candidate records, lookup data, and filter diagnostics stay private. This is still not a historical snapshot and does not assign freshness, safety or relevance from filtering.
8. Tests use authored fictional PGlite rows and fake projector inputs only. They do not establish data rights, event truth, hosted Neon behavior, full-table-scan cost, or a public route. Do not add an index/migration to improve search; if the bounded implementation requires one, stop and ask the root to revise the assignment.

## Acceptance criteria

- Both service boundaries reject unknown filter keys, invalid enum values, invalid dates/ranges, and overlong text/IDs before any database read or projection.
- Each supported filter has positive, negative, and boundary tests; `q` treats `%` and `_` literally and matches only public event fields and approved scope display names.
- A filtered candidate that advances to a different current event version before projection fails the page with a stable retryable error; an unfiltered newer version remains allowed.
- Filters run before ordering and page probing; filtered pages preserve the stable keyset, limit, cursor and deterministic order without duplicate or skipped matching candidates across continuations.
- Existing current-public/live restrictions remain in force; withdrawn, historical-only, demo and synthetic candidates never enter the public list.
- Projected output remains the exact `EventView` allowlist in input order, with raw record JSON and diagnostics absent; fan-out never exceeds four.
- No OpenAPI/DTO, route, URL parser, cursor token, migration, index, binding, dependency or runtime configuration changes.

## Verification (WSL Ubuntu-26.04 only)

Record `node --version`, `npm --version`, `git --version`, and relevant package versions. Reuse existing dependencies. Run the focused Worker test directly, focused DB test directly, `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`. The Worker aggregate script does not currently list the focused event-list file; run it directly and report this accurately. Report actual results only; hosted Neon behavior and physical query cost are not established by PGlite.

## Commit and handoff

Implement only on the assigned branch/worktree. Commit implementation/tests and this handoff in coherent descriptive commits, leave the checkout clean, and do not merge or push. Report branch/worktree, exact commit SHAs and messages, changed paths, behavior, actual WSL checks, limitations, migration/configuration impact, and remaining decisions. Root independently reviews and integrates.

## Stop conditions

Stop and report if the existing public views/grants cannot provide the needed approved names, if filtering requires a schema/index or a public contract change, if matching semantics cannot be preserved without reading private data, or if correct filtering cannot be applied before pagination. Escalate to GPT-6 Astra xhigh only after a GPT-6 Luna Max attempt fails on a substantive technical difficulty.

## Implementation handoff

Append exact branch/worktree, commit SHAs/messages, changed paths, behavior, actual WSL checks, limitations, migration/configuration impact, and remaining decisions here. Do not merge or push.


### Completed implementation handoff

- **Branch/worktree:** `work/API-PUBLIC-EVENT-LIST-FILTERS-CORE` at `/mnt/c/Users/perry/.codex/worktrees/api-geojson-route-core/RPL` (Windows path `C:\\Users\\perry\\.codex\\worktrees\\api-geojson-route-core\\RPL`).
- **Base/design provenance:** Based on root planning commit `d871c90`; cherry-picked root clarification commit `44ae905`, recorded on this branch as `221e199` (`docs(API-01): clarify filtered version race handling`).
- **Implementation commit:** `8bee623` — `feat(API-PUBLIC-EVENT-LIST-FILTERS-CORE): apply filters before page probing`.
- **Changed paths:** `apps/db/src/public-event-list.ts`; `apps/db/test/public-event-list.test.ts`; `apps/worker/src/layers/l4-application-integration/public-event-list-projection-service.ts`; `apps/worker/test/l4-public-event-list-projection-service.test.ts`.
- **Behavior:** Validates the closed typed filters before DB/projector access; applies exact enums, inclusive UTC event-start range, exact place IDs, and literal case-insensitive search over public fields and approved top-level scope names in SQL before cursor ordering and `limit + 1`. Search uses only `waspada.public_scope_names`. Effective filters fail the page with a stable retryable error if projection advances to a newer event version; unfiltered newer-version behavior and existing bounded fan-out/keyset behavior remain. Added fictional PGlite and fake-projector coverage, including SQL-before-pagination, cursor continuation, private-content exclusion, and date-only start behavior under `Asia/Jakarta` session timezone.
- **WSL tool versions:** Node `v24.21.0`, npm `11.19.0`, Git `2.53.0`; `@electric-sql/pglite` `0.5.8`, `@electric-sql/pglite-postgis` `0.2.8`, `@electric-sql/pglite-pgvector` `0.0.9`, `tsx` `4.23.15`, TypeScript `7.0.2`, Vite `8.3.0`, Wrangler `4.137.0`. Existing root dependencies were reused through a temporary symlink verified to resolve exactly to `/mnt/d/Projects/RPL/node_modules`; the symlink was removed before handoff.
- **Checks:** Focused `node --import tsx --test apps/db/test/public-event-list.test.ts` — exit 0, 4/4; focused `node --import tsx --test apps/worker/test/l4-public-event-list-projection-service.test.ts` — exit 0, 10/10. `npm run db:test` — exit 0, 16/16 files. `npm test` — exit 0 (web 22/22, Worker 183/183, DB 16/16 files, evaluation 12/12; the focused Worker event-list test is not in that aggregate and was run directly). `npm run typecheck` — exit 0. `npm run build` — exit 0 (Vite web build and Wrangler Worker dry-run). `git diff --check` — exit 0.
- **Environment mistake:** A later handoff-writing shell quoting error invoked native `npm run typecheck` in `D:\\Projects\\RPL`; it exited 1 because native `tsc` was unavailable. This was outside WSL and receives no verification credit; all required verification results above were produced in WSL. Root and assigned worktree status were checked afterward.
- **Limitations / impact:** All filter fixtures are fictional. PGlite verifies SQL behavior and the non-UTC session regression, but hosted Neon behavior, production query cost, and data rights are not established. No migration, index, dependency, package-script, binding, public contract, or runtime configuration change.
- **Remaining decisions:** None for the assigned implementation. Root review and integration remain outstanding.
