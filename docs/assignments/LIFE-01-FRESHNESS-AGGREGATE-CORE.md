# LIFE-01-FRESHNESS-AGGREGATE-CORE — project conservative event freshness status

- **Parent:** LIFE-01, FR-09/11/13, NFR-01/05/07
- **Status:** Assigned for local Layer 4 and query integration
- **Implementation model:** GPT-6 Luna, max reasoning
- **Branch:** `work/LIFE-01-FRESHNESS-AGGREGATE-CORE`
- **Worktree:** Reuse the clean managed `l3-coordinator-core` worktree after checking that its previous JOB-01 task and processes are complete. Root supplies the exact `main` base at dispatch.
- **Dependencies:** `LIFE-01-FRESHNESS-TRANSITION-CORE`, public event detail/list/GeoJSON runtimes, `DATA-01`, `DB-TEST-RUNNER-ISOLATION`, and ADR-032.
- **Contract baseline:** Existing `EventView.freshness`, `PublicImpact.freshness`, `PublicClaim` without freshness, public list filters, GeoJSON filters, published-only reader views, and the current `waspada_public_reader` role. No public API/DTO/OpenAPI change.

## Objective

Implement the accepted conservative event freshness status at the Layer 4 projection boundary and keep SQL-side public list and GeoJSON freshness filters consistent with the status returned to callers. This is derived read behavior. Do not persist the aggregate, change item-level freshness transitions, or infer lifecycle, resolution, or safety.

## Decision to apply

For an event, treat the stored event freshness as the freshness of its grouped public claim set. Combine that status with every exact impact version referenced by the current published event version:

- If the claim-set status or any included impact is `needs_update`, return `needs_update`.
- If the included values mix `current` and `expired`, return `needs_update`.
- Return `expired` only when every included value is `expired` under issuer validity.
- Return `current` only when every included value is `current`.
- With no impacts, preserve the claim-set status.

Aggregate only `Freshness.status`. Preserve the event's `evaluated_at`, `review_due_at`, and `basis` as the metadata for the grouped claim set. Preserve each impact's `Freshness` unchanged. `PublicClaim` gains no field. Invalid or unrecognized underlying statuses must fail closed; do not silently return `current`.

## Required behavior

1. Add a pure, deterministic Layer 4 policy with closed typed inputs, explicit handling for the three supported statuses, and meaningful table-driven tests for every combination, empty impacts, ordering independence, and invalid input.
2. Apply the policy to current public event projections so detail, list, geometry/GeoJSON feature properties, briefings, and update hydration report the same aggregate status. Leave claim and impact objects, event lifecycle, event metadata, publication state, and response shapes unchanged.
3. Make live event-list filtering and GeoJSON filtering on `freshness` use the same derived status before ordering, pagination, or feature-limit decisions. Retain exact current-public event/impact version joins and public-reader least privilege. If an internal view needs a derived status column, keep it internal to database reader views and do not copy it into the Event record JSON.
4. Apply the same status-only rule to the fixture-backed demo read model before it filters or returns events. Synthetic/historical datasets remain isolated and explicitly labelled.
5. Add PGlite cases with synthetic database rows proving aggregate output and filtering for no impacts, all-current, all-expired, needs-update, and mixed current/expired statuses. Exercise list and GeoJSON readers under `SET ROLE waspada_public_reader`; ensure event lifecycle and publication rows are unchanged. Add Layer 4 projection tests that prove event metadata and impact freshness are preserved.
6. Do not add freshness to claims, mutate source/event/impact rows, broaden table grants, enable live sources, or add provider, timer, Workflow, API, UI, dependency, or deployment behavior.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md`, `ARCHITECTURE.md`, `docs/IMPLEMENTATION_BACKLOG.md`, and `docs/DOMAIN_MODEL.md`
- `docs/decisions/ADR-032-review-deadline-freshness.md`
- `docs/assignments/LIFE-01-FRESHNESS-TRANSITION-CORE.md` and its handoff
- `apps/worker/src/layers/l4-application-integration/freshness-transition-policy.ts`
- `apps/worker/src/layers/l4-application-integration/public-projection.ts`
- `apps/worker/src/layers/l4-application-integration/public-geometry-projection.ts`
- `apps/worker/src/layers/l4-application-integration/public-read-model.ts`
- `apps/db/src/public-event-list.ts` and `apps/db/src/public-event-geojson-candidates.ts`
- `apps/db/migrations/001_foundation.sql`, `apps/db/migrations/015_public_geojson_candidates.sql`, and current migration tests

## Allowed paths

- `apps/worker/src/layers/l4-application-integration/freshness-aggregate-policy.ts` (new)
- `apps/worker/src/layers/l4-application-integration/public-projection.ts`
- `apps/worker/src/layers/l4-application-integration/public-read-model.ts`
- `apps/worker/test/l4-freshness-aggregate-policy.test.ts` (new)
- `apps/worker/test/l4-public-projection.test.ts`
- `apps/worker/test/l4-public-geometry-projection.test.ts`
- `apps/worker/test/l4-public-event-list-projection-service.test.ts`
- `apps/worker/test/api.test.ts`
- `apps/db/migrations/020_public_event_freshness_aggregate.sql` (new)
- `apps/db/src/public-event-list.ts`
- `apps/db/src/public-event-geojson-candidates.ts`
- `apps/db/test/public-event-list.test.ts`
- `apps/db/test/public-event-geojson-candidates.test.ts`
- `docs/assignments/LIFE-01-FRESHNESS-AGGREGATE-CORE-HANDOFF.md` (new)

Root owns the backlog, architecture, ADR, SDP, delivery log, and assignment status. Stop before editing other paths if compatibility requires a public contract change, additional permission, or a different freshness decision.

## Acceptance and verification

- The Layer 4 projection and database filters agree for every decision-table case; freshness filtering occurs before page ordering/limits and before the GeoJSON overflow check.
- Existing exact-version, withdrawn-event hiding, geometry provenance, strict projection, cursor, query-bound, and source-access behavior remains intact.
- No change to event/impact lifecycle, source health, publication authorization, event versions, `PublicClaim`, or the public OpenAPI/DTO contracts.
- In WSL Ubuntu-26.04, using existing dependencies only: run the focused policy/projection tests, `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD`. Record exact suite counts, command outcomes, and runtime versions in the handoff. Do not install dependencies or invoke external sources/providers.
- Commit implementation/tests and the handoff on the task branch in coherent, descriptive commits. Do not merge or push.

## Stop conditions

Stop and report to root if a schema/API/DTO/OpenAPI change, a new permission, ambiguous event/impact membership, unbounded query behavior, source access, provider, or external service is required. Do not escalate models unless a substantive technical issue was attempted with Luna/max and remains unresolved.

## Handoff fields

Include branch/worktree, exact base, commit SHA(s) and messages, changed paths, policy and projection behavior, actual WSL checks and counts, dependency/runtime versions, transient failures, limitations, migration/grant/configuration impact, and remaining decisions.
