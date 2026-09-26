# API-PUBLIC-PROJECTION-SERVICE-CORE — fail-closed snapshot projection

- **Status:** Assigned; injected Layer 4 service only
- **Parent work package:** API-01 — public published-event endpoints
- **Requirements:** FR-08/09/10; NFR-01/07
- **Dependencies:** API-PUBLIC-SNAPSHOT-CORE, API-PUBLIC-LOOKUPS-CORE, API-PROJECT-CORE, ADR-012, ADR-019
- **Layer:** L4 application integration and public allowlist projection
- **Contract baseline:** Existing `PublicProjectionLookups`, `projectPublicEvent`, internal snapshot/lookup port shapes, and public `EventView`; no API/DTO/OpenAPI change
- **Implementation model:** GPT-6 Luna, max reasoning
- **Branch:** `work/API-PUBLIC-PROJECTION-SERVICE-CORE`
- **Worktree:** Create or select a dedicated managed worktree from the pushed assignment commit; do not edit the root checkout.
- **Owner:** Luna Max implementation agent; root plans, reviews, accepts, integrates, and pushes

## Objective

Compose an injected current-event snapshot reader with the reviewed lookup reader and the existing strict `projectPublicEvent` boundary. For one event ID, return either a not-found result or only the existing public `EventView`. Internal event/impact JSON, scope IDs, support spans, reviewer provenance, and rights references must never leave this service as a public result.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md` (first repository document), then `docs/IMPLEMENTATION_BACKLOG.md`
- `docs/DOMAIN_MODEL.md`, `docs/decisions/ADR-012-public-projection-boundary.md`, and `docs/decisions/ADR-019-public-projection-lookups.md`
- `docs/assignments/API-PROJECT-CORE.md`, `docs/assignments/API-PUBLIC-LOOKUPS-CORE.md`, and `docs/assignments/API-PUBLIC-SNAPSHOT-CORE.md`
- `apps/worker/src/layers/l4-application-integration/public-projection.ts`
- `apps/worker/src/contracts/public-api.ts`
- The accepted snapshot and lookup repository interfaces and their tests
- `apps/worker/package.json` and existing Layer 4 projection tests

## Required behavior

1. Define narrow injected interfaces for the snapshot and reviewed-lookup read ports. Keep Worker/L4 independent of database clients and do not import or create a concrete database connection.
2. Read exactly one requested event snapshot. If it is missing, return an explicit missing result without calling the lookup port. Before lookup, validate that the snapshot's event ID and version agree with the requested ID and the event `recordJson`; validate that each impact envelope agrees with the snapshot and its impact `recordJson`. Any mismatch is an invalid snapshot and fails closed without lookup. Never fall back to demo, synthetic, historical, proposal, unreviewed, or previous-version records.
3. Before calling the lookup port, extract scope IDs from the event, every claim, and every impact because the projector resolves names for all three record types. Exclude geometry IDs, which are not public scope-name lookups. Extract source-attribution keys only from each claim's exact `support` references; do not request attribution for contradiction, context, or update evidence. Validate extracted values, deterministically deduplicate them, and cap scope keys and support references at 100 each before any lookup call.
4. Pass only the bounded exact keys to the injected lookup port. Compose its scope-name and approved-attribution results with the snapshot's impact `recordJson` values, then pass the complete input through the existing `projectPublicEvent` validator/projector. That existing function remains the final authority for schema validation and output allowlisting; missing or ambiguous required lookup rows fail closed.
5. Return only `{ kind: 'found', event: EventView }` or `{ kind: 'missing' }`. Map unexpected port/projection failures to stable bounded errors without event IDs, source text, SQL details, or exception content. Never partially return an event with unresolved scope names or support attributions.
6. Tests use authored fictional, live-shaped records and injected fake ports. Prove requested/event/impact envelope identity checks before lookup; exact key derivation/deduplication across event, claim, and impact scopes; claim-support-only attribution lookup; rejection before either lookup when a cap is exceeded; no lookup on missing or malformed snapshots; strict final DTO allowlisting; correct source timestamps/attributions; impact projection; fail-closed missing/duplicate lookups; malformed records; and redacted errors. Test markers do not represent source rights, facts, human review, or live records.

## Explicit boundaries

- No HTTP route, public list/search/pagination, detail/history/GeoJSON wiring, database adapter, Worker runtime binding, role/grant, schema/migration, model call, publication action, source acquisition, or reviewer action.
- No change to `EventView`, `EventDetail`, OpenAPI, L4 projector allowlists, freshness/lifecycle/evidence semantics, or public source-attribution policy.
- No excerpts or internal evidence/provenance fields in the result. A public attribution decision permits metadata display only; it does not prove factuality, safety, freshness, or user relevance.
- No real source text, source-rights assertion, human label, approval record, provider provisioning, dependency, paid service, or deployment.

## Allowed paths

- `apps/worker/src/layers/l4-application-integration/public-event-projection-service.ts` (new)
- `apps/worker/test/l4-public-event-projection-service.test.ts` (new)
- `apps/worker/package.json` — test script only, to register the new test
- This assignment's implementation handoff only

Root owns the backlog, SDP, architecture, contracts, source-rights decisions, API routes, and runtime/provider composition. Report a scope conflict instead of broadening this assignment.

## Acceptance and checks

- Focused Worker tests cover requested/event/impact identity binding before lookup, the required data boundary, event/claim/impact scope-key derivation, claim-support-only attribution keys, bounded lookups, failure behavior, and final `EventView` allowlist.
- Test fixtures are authored and fictional; all live-shaped fields are test inputs only and no test result is described as factual or source-rights evidence.
- In WSL Ubuntu-26.04 run the focused test, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`; record exact tool versions and actual results.
- Commit implementation and handoff as coherent descriptive commits on the assigned branch. Leave the task worktree clean. Do not merge or push.

## Stop conditions

Stop and report if implementation requires a contract change, permissive projection behavior, source-rights assumption, public mutation, database/provider wiring, or route change. GPT-6 Astra xhigh is allowed only after a substantive technical difficulty was attempted by Luna Max and remains unresolved.

## Implementation handoff

Append exact branch/worktree, commit SHAs and messages, changed paths, behavior, actual checks, limitations, migration/configuration impact, and remaining decisions. Root independently reviews and verifies before acceptance.

### Implementer handoff — 26 September 2026

- **Branch/worktree:** `work/API-PUBLIC-PROJECTION-SERVICE-CORE`; Windows path `C:\Users\perry\.codex\worktrees\api-geojson-route-core\RPL`; WSL path `/mnt/c/Users/perry/.codex/worktrees/api-geojson-route-core/RPL`.
- **Implementation commits:** `3adcc0106cec34bf77a4e794f125bfb656a36098` — `feat(API-PUBLIC-PROJECTION-SERVICE-CORE): compose public event projection`; `58727dd08080ca760842a351de7dc9b88e59e77f` — `fix(API-PUBLIC-PROJECTION-SERVICE-CORE): suppress lookup excerpts`.
- **Changed paths:** `apps/worker/src/layers/l4-application-integration/public-event-projection-service.ts`; `apps/worker/test/l4-public-event-projection-service.test.ts`; `apps/worker/package.json` (Worker test script only); this handoff.
- **Behavior:** Added injected snapshot and reviewed-lookup read ports with no database client dependency. The service reads one live snapshot, verifies the requested event ID and version against its record, and verifies every impact envelope and record against that same event version before lookup. It derives sorted, deduplicated name keys from event, claim, and impact scopes while excluding geometry IDs, and attribution keys only from exact claim `support` references. It rejects malformed extracted keys and more than 100 unique keys in either class before lookup, composes the lookup rows and impact records through `projectPublicEvent`, and returns only `missing` or the existing `EventView`. Before projection, every attribution lookup row must be a record with `excerpt_public_use_approved === false` and `excerpt === null`; any other row fails closed with a stable redacted error. Port, lookup-result, and projector failures are mapped to short stable errors without input or exception content.
- **Fixture note:** Tests use authored fictional live-shaped records and fake ports. They do not represent live records, facts, publication approval, source rights, or human review.
- **WSL tools:** Ubuntu-26.04; Node.js `v24.21.0`; npm `11.19.0`; Git `2.53.0`; TypeScript `7.0.2`; tsx `4.23.15`; Vite `8.3.0`; Wrangler `4.137.0`. Existing dependencies were reused through a temporary symlink to the root `node_modules`; it was removed after checks.
- **Checks:** `node --import tsx --test apps/worker/test/l4-public-event-projection-service.test.ts` passed 38/38. `npm test` passed 309 total tests (web 22, Worker 183 including this file, DB 92 across 12/12 files, evaluation 12). `npm run typecheck` passed. `npm run build` passed, including Vite production output and Wrangler dry-run. `git diff --check` and the final staged diff check passed.
- **Limitations:** The ports are not wired to an HTTP route or Worker runtime. This does not verify hosted PostgreSQL/Neon behavior and does not connect live data.
- **Migration/configuration impact:** None. No DTO, OpenAPI, migration, grant, binding, dependency, or lockfile changes.
- **Remaining decisions:** None within this bounded service slice; root review and integration remain pending.

### Root review and acceptance — 26 September 2026

- **Accepted branch:** `work/API-PUBLIC-PROJECTION-SERVICE-CORE`; fast-forwarded to local `main` at `eae394bf44bdb2d6e7116deef0437dedb327364b`.
- **Reviewed implementation commits:** `3adcc0106cec34bf77a4e794f125bfb656a36098` (`feat(API-PUBLIC-PROJECTION-SERVICE-CORE): compose public event projection`), `58727dd08080ca760842a351de7dc9b88e59e77f` (`fix(API-PUBLIC-PROJECTION-SERVICE-CORE): suppress lookup excerpts`); handoff commit `a17b8a3f2bc0a8fed9b48e4cc67370c3c2f76c68` and excerpt-review handoff `eae394bf44bdb2d6e7116deef0437dedb327364b`.
- **Root review:** Confirmed event and impact identity/version checks run before lookups; lookup keys are bounded and derive from event/claim/impact scopes plus claim `support` references only; geometry IDs are not sent to scope-name lookup; excerpt-bearing lookup results fail closed before projection; final response passes through the existing allowlist. Tests are authored, fictional fixtures only.
- **Independent WSL checks:** Ubuntu-26.04, Node.js `v24.21.0`, npm `11.19.0`, Git `2.53.0`. Focused test passed 38/38; `npm test` passed 309/309 (web 22, Worker 183, DB 92 across 12 files, evaluation 12); `npm run typecheck`, `npm run build` (Vite production and Wrangler `4.137.0` dry-run), and `git diff --check` passed.
- **Acceptance limits:** Hosted Neon/PostgreSQL behavior and Worker HTTP/runtime integration remain unverified. No migration, route, DTO, binding, dependency, live source, or external service changed. The implementation is accepted for its bounded service scope; API-01 remains in progress.
