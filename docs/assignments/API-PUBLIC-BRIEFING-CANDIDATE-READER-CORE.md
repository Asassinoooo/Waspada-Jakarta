# API-PUBLIC-BRIEFING-CANDIDATE-READER-CORE — select complete bounded briefing candidates

- **Backlog ID:** `API-PUBLIC-BRIEFING-CANDIDATE-READER-CORE`
- **Objective:** Add a least-privilege, read-only database candidate reader that selects all current-public live events eligible for the existing exact-interest briefing projection, subject to the response's 100-item cap.
- **Dependencies:** `DATA-01`, `DB-TEST-RUNNER-ISOLATION`, `API-PUBLIC-EVENT-LIST-CANDIDATE-CORE`, `API-PUBLIC-SNAPSHOT-CORE`, `API-PUBLIC-LOOKUPS-CORE`, `API-BRIEFING-PROJECTION-CORE`, `ADR-012`, `ADR-024`.
- **Branch/worktree:** `work/API-PUBLIC-BRIEFING-CANDIDATE-READER-CORE` in a free managed worktree based on pushed `main`; root will identify and prepare the checkout before implementation. Do not edit through the root checkout.
- **Contract/design baseline:** Existing transient `BriefingRequest.interests` and `BriefingResponse` bounds in `docs/api/openapi.yaml`; exact matching behavior in [API-BRIEFING-PROJECTION-CORE](API-BRIEFING-PROJECTION-CORE.md); overflow and current-public rules in [ADR-024](../decisions/ADR-024-bounded-exact-interest-briefing-candidates.md). Do not change OpenAPI, the DTO, or the match behavior.
- **Allowed paths:** `apps/db/src/public-briefing-candidates.ts`, `apps/db/test/public-briefing-candidates.test.ts`, `apps/db/package.json` only to register the focused DB test, and this assignment's handoff section.
- **Prohibited scope:** Worker/HTTP route, public DTO, OpenAPI, Layer 4 projection, UI, model/provider, source acquisition, preference persistence, historical or synthetic public data, migration, index, role/grant change, deployment/binding, dependency addition, and live data.

## Required behavior

1. Implement an injected `SqlExecutor` repository in the DB package; do not import Worker code or establish a connection.
2. Accept only a closed, bounded interest value matching the existing contract: up to 30 text interests of at most 128 Unicode code points in each of `places`, `services`, `institutions`, and `audiences`, plus up to 10 unique valid categories. Reject malformed values before SQL; empty interests return an empty result without querying.
3. Select only current, published, live events through existing safe public views. Exclude withdrawn/latest-withdrawn events, historical/synthetic rows, and missing/unapproved scope names. Match categories exactly. Scope matches must cover event scope, published claim scopes, and exact current linked impact scopes, using only approved `waspada.public_scope_names` rows.
4. Database matching must preserve the L4 projector's NFC, trim, and Indonesian-locale case-insensitive exact name semantics. It must not use substring, fuzzy, semantic, or model matching. If the existing SQL environment cannot implement a candidate predicate without false negatives or broader access, stop and report the exact limitation; do not silently use a recent-event scan.
5. Match before ordering and overflow probing. Return only the bounded event identity, exact current event version, and immutable version-1 publication-time ordering key; use order `firstPublishedAt DESC, eventId ASC`. Deduplicate events that match multiple interests/scopes.
6. The response has no pagination. Probe at 101: return every match if there are at most 100, and a stable bounded `RESULT_LIMIT_EXCEEDED`-style error with no partial candidates when the 101st exists. Do not truncate or turn overflow into an empty result.
7. Parameterize all user-controlled values, validate returned rows/order/identity/version/timestamps, and redact SQL, event names, interest values, and driver errors. Use the existing public reader role/views only. No schema/grant/index additions.
8. Tests use authored fictional PGlite rows and verify category and each scope dimension across event/claim/impact scopes, mixed-case and Unicode normalization, exact-vs-substring behavior, approved-name gating, current withdrawal/live filtering, deduplication, deterministic order, zero-interest no-query behavior, maximum/overflow, malformed inputs/rows, parameterization, role grants, and redacted failures.

## Verification (WSL Ubuntu-26.04 only)

Record exact runtime and package versions. Reuse installed dependencies. Run the focused DB test, `npm run db:test`, full `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`. Report actual results; PGlite fixtures do not verify hosted Neon query plans or physical cost.

## Stop conditions

Stop if the required exact locale matching cannot be implemented with existing DB capabilities, if safe public views/role grants do not expose the required approved scope links, if selection could include withdrawn/non-live rows, or if a migration/index/grant/contract change is needed. Report the exact constraint and do not broaden the task. Escalate to GPT-6 Astra xhigh only after a GPT-6 Luna Max attempt encounters a substantive technical difficulty it cannot resolve; usage limits or a WSL configuration issue do not qualify.

## Implementation handoff

Append branch/worktree, exact commit SHA(s) and messages, paths, behavior, actual checks/results, runtime versions, limitations, migration/configuration impact, and remaining decisions. Commit code and handoff on the assigned branch; do not merge or push. Root independently reviews and integrates.


### Completed implementation handoff

- **Branch/worktree:** work/API-PUBLIC-BRIEFING-CANDIDATE-READER-CORE; C:/Users/perry/.codex/worktrees/api-geojson-route-core/RPL (/mnt/c/Users/perry/.codex/worktrees/api-geojson-route-core/RPL).
- **Implementation commit:** b238d018532453a558f4db4947b3d8ec31aadaf3 — feat(db): add public briefing candidate reader.
- **Changed paths:** apps/db/src/public-briefing-candidates.ts, apps/db/test/public-briefing-candidates.test.ts, and this handoff section. apps/db/package.json is unchanged because the DB runner discovers the new *.test.ts file.
- **Behavior:** Adds an injected SqlExecutor reader with closed request validation, exact category matching, and NFC/ECMAScript-trim/Indonesian-locale case-insensitive exact scope matching against approved names for current event, claim, and linked-impact scopes. It reads only the existing safe public views and current published live rows, deduplicates, orders by immutable version-1 publication time descending then event ID ascending, and asks SQL for at most 101 rows. It returns all 100 or fewer candidates and raises a stable redacted overflow error at 101. Empty normalized interests skip SQL; malformed inputs, rows, and driver errors are bounded and redacted.
- **Actual checks:** The final focused command node --import tsx --test apps/db/test/public-briefing-candidates.test.ts passed all 7 tests after the final edits. Final npm run typecheck passed. Final npm run build passed (typecheck, Vite web build, and Wrangler worker dry-run). git diff --check and git diff --cached --check passed before this handoff edit; they are rerun for the completed commit below. Earlier in the sequence, npm run db:test passed all 19/19 DB test files and npm test passed the web, worker, DB, and evaluation suites. Those broad runs preceded only the defensive result-row plain-object guard and the additional descending-order fixture; focused tests, typecheck, and build passed again on the final implementation.
- **Runtime/package versions:** WSL Ubuntu-26.04; Node.js v24.21.0; npm 11.19.0; @electric-sql/pglite 0.5.8; @electric-sql/pglite-pgvector 0.0.9; @electric-sql/pglite-postgis 0.2.8; pg 8.16.3; tsx 4.23.15; TypeScript 7.0.2; Vite 8.3.0; Wrangler 4.137.0.
- **Limitations:** Locale matching was exercised with PGlite's PostgreSQL/ICU support, including dotted capital I, contextual Greek sigma, NFC, and ECMAScript whitespace. No hosted Neon connection or query-plan/physical-cost check was run. SQL returns no more than the 101-row probe; hosted scan/sort cost against a larger production corpus remains unmeasured.
- **Migration/configuration impact:** None. No migration, index, grant, role, dependency, environment, or OpenAPI change was made.
- **Remaining decisions:** None within this DB reader slice. Independent review and integration remain with the root planner.
