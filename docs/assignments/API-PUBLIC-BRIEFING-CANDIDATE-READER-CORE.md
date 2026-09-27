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
