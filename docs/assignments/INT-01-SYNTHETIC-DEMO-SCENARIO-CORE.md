# INT-01-SYNTHETIC-DEMO-SCENARIO-CORE — cover the four planned demo scenarios

**Backlog ID:** `INT-01-SYNTHETIC-DEMO-SCENARIO-CORE`  
**Parent:** `INT-01`, FR-01/02/03/09/10; NFR-01/03/07  
**Status:** Assigned for local demo-only implementation  
**Implementation model:** GPT-6 Luna, max reasoning  
**Branch:** `work/INT-01-SYNTHETIC-DEMO-SCENARIO-CORE`  
**Worktree:** `.codex-build/worktrees/int-01-synthetic-demo-scenario-core`  
**Assigned base:** root records the pushed assignment commit below before implementation begins.  
**Dependencies:** `UI-00`, `UI-01-FEED-FILTERS-CORE`, `API-PUBLIC-EVENT-LIST-RUNTIME-CORE`, `API-PUBLIC-DETAIL-RUNTIME-CORE`, `API-01`, and the four scenario definitions in Section 3.1 of `SOFTWARE_DEVELOPMENT_PLAN.md`.

## Objective

Make the existing demo API represent the four scenario archetypes already required by the software plan: a historical crime example, a public gathering with a transport impact, a weather warning with a flood observation, and a non-geographic group notice. These are authored interface fixtures only. This task does not complete `INT-01`, approve sources, or establish evidence quality.

## Read before editing

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md`, especially Sections 3.1 and 5
- `docs/IMPLEMENTATION_BACKLOG.md`
- `docs/DOMAIN_MODEL.md`
- `docs/UX_API_SPEC.md`
- `apps/worker/src/layers/l4-application-integration/synthetic-fixtures.ts`
- `apps/worker/src/layers/l4-application-integration/public-read-model.ts`
- `apps/worker/test/api.test.ts`
- `apps/web/test/smoke-local.tsx`

## Required behavior

1. Extend `syntheticEventFixtures` to four stable records. Preserve the existing IDs `synthetic-demo-01` and `synthetic-demo-02`; assign stable new IDs to the other two.
2. Use the four planned archetypes and their existing closed category enum values. Make the record title and summary in Bahasa Indonesia and label each record explicitly as `SIMULASI FIKTIF` or equivalent. The public demo banner remains in place as a second disclosure.
3. Give the scenarios useful differences in lifecycle, freshness, event time, validity, scope, and impacts where appropriate. Keep lifecycle, freshness, validity, and user relevance distinct. Expiry must not imply resolution or safety.
4. Do not invent source names, URLs, quotations, evidence counts, review decisions, or source-supported geometry. The demo claims arrays stay empty, and GeoJSON remains empty. Any synthetic impact must be described as a simulated example and must not be presented as an observed real-world effect.
5. The non-geographic group notice uses an audience-only scope with no place, service, or institution value. No map point, segment, polygon, radius, or danger zone is added.
6. Preserve default cursor order and filters. Update existing tests/smoke assertions that currently assume exactly two rows; verify category filtering, detail payloads, impacts, audience-only scope, and empty GeoJSON through the existing routes.
7. Keep live-mode behavior, API/OpenAPI/DTO contracts, database, source registry, acquisition, model/provider, publication, authentication, Worker triggers, and deployment configuration unchanged.

## Allowed paths

- `apps/worker/src/layers/l4-application-integration/synthetic-fixtures.ts`
- `apps/worker/test/api.test.ts`
- `apps/web/test/smoke-local.tsx`
- `docs/assignments/INT-01-SYNTHETIC-DEMO-SCENARIO-CORE.md` (implementation handoff section only)

Stop before editing any other path. Root owns the plan, backlog, checkpoint, acceptance status, and delivery log.

## Acceptance and verification

- Demo list API returns exactly the four labelled archetypes in a stable cursor order; existing first and second IDs remain unchanged.
- Each record is explicit synthetic data and contains no source or evidence claim. Unsupported geometry is absent from details and GeoJSON.
- The group notice has audience scope only. The gathering/weather examples expose their synthetic impact examples with independent lifecycle/freshness values.
- Existing search, category/lifecycle/freshness filters, detail, history, pagination, and local smoke behavior continue to pass.
- In WSL Ubuntu-26.04 with existing dependencies, run focused API tests, `npm test --workspace=@waspada/worker`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD`. Record actual WSL, Node, npm, tsx, TypeScript, Vite, and Wrangler versions and results. Do not install packages or contact any source/provider.
- Commit implementation and handoff on this branch in coherent commits, leave its worktree clean, and do not merge or push.

## Stop conditions

Stop if a scenario cannot be represented without fabricated evidence/geometry, a contract change, or unsafe implication. Keep the implemented archetypes clearly synthetic; do not weaken source, freshness, map, or empty-state rules for visual completeness. Root reviews and accepts independently.

## Implementation handoff

Append branch/worktree, exact base, commit SHAs and messages, changed paths, behavior, actual verification, versions, limitations, configuration impact, and remaining decisions here.
