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
2. Read exactly one requested event snapshot. If it is missing, return an explicit missing result without calling the lookup port. Never fall back to demo, synthetic, historical, proposal, unreviewed, or previous-version records.
3. Before calling the lookup port, extract only the event and impact scope IDs needed by the projector and only each claim's exact `support` references. Do not request attribution for contradiction, context, or update evidence. Validate extracted values, deterministically deduplicate them, and cap scope keys and support references at 100 each before any lookup call.
4. Pass only the bounded exact keys to the injected lookup port. Compose its scope-name and approved-attribution results with the snapshot's impact `recordJson` values, then pass the complete input through the existing `projectPublicEvent` validator/projector. That existing function remains the final authority for schema validation and output allowlisting; missing or ambiguous required lookup rows fail closed.
5. Return only `{ kind: 'found', event: EventView }` or `{ kind: 'missing' }`. Map unexpected port/projection failures to stable bounded errors without event IDs, source text, SQL details, or exception content. Never partially return an event with unresolved scope names or support attributions.
6. Tests use authored fictional, live-shaped records and injected fake ports. Prove exact key derivation/deduplication, no lookup on missing events, strict final DTO allowlisting, correct source timestamps/attributions, impact projection, fail-closed missing/duplicate lookups, malformed/over-limit records, and redacted errors. Test markers do not represent source rights, facts, human review, or live records.

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

- Focused Worker tests cover the required data boundary, exact key derivation, bounded lookups, failure behavior, and final `EventView` allowlist.
- Test fixtures are authored and fictional; all live-shaped fields are test inputs only and no test result is described as factual or source-rights evidence.
- In WSL Ubuntu-26.04 run the focused test, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`; record exact tool versions and actual results.
- Commit implementation and handoff as coherent descriptive commits on the assigned branch. Leave the task worktree clean. Do not merge or push.

## Stop conditions

Stop and report if implementation requires a contract change, permissive projection behavior, source-rights assumption, public mutation, database/provider wiring, or route change. GPT-6 Astra xhigh is allowed only after a substantive technical difficulty was attempted by Luna Max and remains unresolved.

## Implementation handoff

Append exact branch/worktree, commit SHAs and messages, changed paths, behavior, actual checks, limitations, migration/configuration impact, and remaining decisions. Root independently reviews and verifies before acceptance.
