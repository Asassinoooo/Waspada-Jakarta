# LIFE-01-L2-SOURCE-REVISION-GROUNDING-GATE-CORE — block invalidated source spans

**Status:** Accepted on local `main` after root review; see the implementation and handoff commits in [DELIVERY_LOG.md](../DELIVERY_LOG.md).
**Backlog ID:** `LIFE-01-L2-SOURCE-REVISION-GROUNDING-GATE-CORE`
**Implementation model:** GPT-6 Luna, max reasoning
**Branch:** `work/LIFE-01-L2-SOURCE-REVISION-GROUNDING-GATE-CORE`
**Worktree:** `.codex-build/worktrees/life01-l2-source-invalidation-grounding-gate-core` (WSL-compatible linked worktree)
**Contract baseline:** Persisted/domain schema 2.0; public API/OpenAPI/DTO unchanged; no model prompt-schema change.

## Context and dependencies

Read `AGENTS.md`, `SOFTWARE_DEVELOPMENT_PLAN.md`, `ARCHITECTURE.md`, `docs/DOMAIN_MODEL.md`, `docs/IMPLEMENTATION_BACKLOG.md`, ADR-011, ADR-042, ADR-043, ADR-044, and the accepted RAG-CORE, RAG-ACCESS-01, RAG-CONTEXT-ASSEMBLY-CORE, LIFE-01 source-observation assignment/handoff, and LIFE-01 impact-reader assignment/handoff before editing.

Layer 1 now persists immutable publisher assertions about an exact source report. The public view keeps its current immutable event version until moderator review. Separately, Layer 2 must not give an explicitly superseded, retracted, or withdrawn report span to a new reasoning request. The existing exact-span reader is the bounded database check immediately before `assembleGroundingReasoningRequest` builds the typed model input.

## Objective

Make exact Layer 2 evidence rehydration fail closed when the same dataset/report revision has any explicit publisher assertion other than `current`, while preserving existing eligibility rules and all public behavior.

## Required behavior

1. In the exact-span SQL read, check `report_revision_source_observations` for the exact dataset and target report-revision ID. Do not infer source state from fetch outcomes, timestamps, legacy `revision_status`, source health, or replacement linkage alone.
2. If any assertion is `superseded`, `retracted`, or `withdrawn`, return a typed redacted source-invalidated error and no span text. A simultaneous `current` assertion does not override it. This is a deterministic deny rule, not a resolved state or a winner selection.
3. If there is no source observation, or all observations are `current`, preserve the exact-span reader's current behavior. A replacement report is evaluated against its own exact revision ID and existing Layer 1 eligibility; do not promote it automatically.
4. Keep the guard inside the exact-span model-input boundary, and map the new error in `assembleGroundingReasoningRequest` to a fixed typed L2 context error. Do not build a reasoning request from a blocked span. Do not change the strict schema 2.0 grounding payload.
5. Add migration 030 with column-only `SELECT` for `dataset_kind`, `target_report_revision_id`, and `asserted_state` to `waspada_l2_grounding_reader`; preserve all other grants and role capabilities. No table-wide grant, write grant, source-text grant, role membership, or hosted configuration.
6. Verify under `SET ROLE waspada_l2_grounding_reader` that no-observation/current assertions permit exact read, each non-current state blocks exact text, and mixed current plus invalidating assertions remain blocked. Verify same-ID observations in a different dataset do not block the request.
7. Add a cross-layer synthetic test that a blocked exact-span rehydration prevents a reasoning request/proposal step and writes no proposal/publication/freshness data. Existing public rows and freshness remain unchanged after the source assertion.
8. Use authored synthetic PGlite fixtures only. No source/provider fetch, external service, dependency install, public route, Worker binding, provider/runtime activation, model prompt/schema update, source-text copy, L3 budget change, moderator review write, or public freshness decision.

## Allowed paths

- `apps/db/migrations/030_l2_source_revision_grounding_gate.sql` (new; exact least-privilege L2 columns only)
- `apps/db/src/evidence-retrieval.ts` (exact-span read and typed error only; do not broaden search or retrieval contracts)
- `apps/worker/src/layers/l2-model-grounding/grounding-context.ts` (map the typed error to a stable L2 context error only)
- `apps/db/test/evidence-retrieval.test.ts`
- `apps/worker/test/l2-grounding-context.test.ts`
- `apps/db/test/migrations.test.ts` (migration inventory/order and exact capability assertions)
- `apps/db/test/public-event-updates.test.ts` (staged migration order expectation only, if needed)
- `apps/db/test/rag-grounded-proposal-roundtrip.test.ts` (synthetic denial/no-write integration assertion)
- `docs/assignments/LIFE-01-L2-SOURCE-REVISION-GROUNDING-GATE-CORE-HANDOFF.md` (new)

Do not edit `GroundingContext` schema, public API/OpenAPI/DTOs, source acquisition, `report_revisions`, observation storage semantics, embeddings, publication/freshness code, L3 orchestration/budgets, moderator mutation paths, package manifests, or deployment configuration. Stop and ask root if passing invalidation status into the model schema, changing public freshness, allowing reviewer clearance, or expanding the database role is required.

## Acceptance and verification

- Tests prove same-query snapshot denial returns no exact report text for every non-current state and for mixed/conflicting assertions, while no observation and current-only preserve existing rehydration behavior.
- Tests prove exact dataset scoping, least-privilege L2 grants, stable redacted error mapping, no reasoning/proposal/publication/freshness writes after denial, and unchanged public versions.
- Run in WSL Ubuntu-26.04 with the existing Node/npm dependencies: focused DB and L2 context tests, `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD`. Report exact results and versions; do not install dependencies or contact external services.
- Commit implementation and handoff separately on this task branch. Root independently reviews and integrates only after acceptance. The agent does not merge or push.

## Stop conditions

Stop and ask root if source observation lineage is ambiguous; a source failure/404 must be treated as retraction; a public freshness/publication change or review mutation is needed; or an invalidated source must be automatically reinstated. Preserve existing published versions and stop at the L2 exact-span boundary.
