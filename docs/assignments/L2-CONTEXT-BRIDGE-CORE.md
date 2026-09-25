# L2-CONTEXT-BRIDGE-CORE — validated reasoning context to canonical persistence

- **Status:** Accepted on `main` at merge `6ced3ea`
- **Depends on:** L2-ADAPTER-01, L2-CONTEXT-PERSIST-CORE
- **Requirements:** FR-05/06/07; NFR-01/05/07
- **Branch/worktree:** `work/L2-CONTEXT-BRIDGE-CORE`; `.codex-build/worktrees/l2-context-bridge-core`
- **Owner:** GPT-6 Luna Max implementation agent; root plans and reviews

## Objective

Add an injected Layer 2 bridge between the expanded, excerpt-bearing `ReasoningRequest` and the canonical refs-only `GroundingContext` persistence repository. The bridge validates the untrusted request with the existing L2 validator, projects only schema 2.0 persistence fields, calls the injected repository once, and returns both the validated in-memory request and persisted record. This gives the L2 model boundary and data/persistence boundary an explicit seam without wiring a provider, database connection, Worker route, or autonomous workflow.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md`
- `ARCHITECTURE.md`
- `docs/IMPLEMENTATION_BACKLOG.md`
- `docs/assignments/L2-CONTEXT-PERSIST-CORE.md` and its handoff
- `docs/decisions/ADR-015-l2-grounding-context-persistence.md`
- `docs/contracts.schema.json` and `docs/contracts.examples.json` — canonical persisted record
- `apps/worker/src/layers/l2-model-grounding/contracts.ts`
- `apps/worker/src/layers/l2-model-grounding/validation.ts` — `validateReasoningRequest`
- `apps/worker/src/layers/l2-model-grounding/adapter.ts`
- `apps/worker/src/layers/l2-model-grounding/retrieval.ts`
- `apps/db/src/grounding-contexts.ts`
- `apps/worker/package.json` — explicit test discovery

## Required behavior

- Accept an `unknown` reasoning request at the bridge boundary and validate it with the existing `validateReasoningRequest`; do not duplicate, relax, or change that validator or any shared contract.
- Map the validated camel-case `GroundingContext` to the exact persisted schema 2.0 record. Convert every evidence reference field exactly and preserve revision states, candidate event/version pairs, prior decision IDs, missing fields, conflicts, retrieval/index versions, IDs, dataset, trace, and `sufficient`.
- Persist evidence-reference metadata only. Never copy excerpt text, source IDs, timestamps, origin/lineage detail, prompts, or model output into the canonical record.
- Call the injected `GroundingContextRepository.createOrVerify` exactly once after request validation. If validation fails, do not call the repository. Preserve and propagate repository conflict/reference/validation errors unchanged.
- Return the validated in-memory reasoning request with its excerpt and provenance data intact alongside the canonical persisted result. Do not mutate the caller's input.
- Preserve `sufficient` exactly as supplied. The bridge does not assess evidence quality or sufficiency, invoke a model/retriever/tool, make an L3 decision, create a proposal, or authorize publication.
- Expose the result as a typed pair containing the `ReasoningRequest` and the `GroundingContextRecord` returned by the repository. The names may follow local conventions, but callers must be able to distinguish the in-memory request from its refs-only persisted record.

## Boundaries

- **Allowed paths:** `apps/worker/src/layers/l2-model-grounding/context-persistence.ts`, `apps/worker/test/l2-context-persistence.test.ts`, `apps/worker/package.json` (add the new test to explicit discovery only), and this assignment's implementation handoff.
- **Forbidden:** database migrations or repository changes, edits to public/schema/model contracts or validators, retrieval changes, sufficiency policy, provider calls, source acquisition, L3/L4 orchestration, HTTP/Worker route or database-session wiring, live data, human labels, dependencies, credentials, cloud resources, or deployment.
- Use synthetic, authored test values only. No source rights or human-adjudicated evaluation data are needed or implied.

## Acceptance and checks

- Worker tests prove exact field mapping, all evidence relations including `updates`, excerpt/provenance stripping from persisted data, preservation of the validated in-memory request and caller sufficiency, no input mutation, validation-before-write, exactly one repository call, and typed error propagation.
- In WSL Ubuntu-26.04 run `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`. No route changes are allowed, so no smoke test is expected. Run the focused Worker test while iterating.
- Add no dependencies or lockfile changes. Commit implementation and handoff separately on this branch, leave a clean worktree, and record exact commands/results, commits, changed paths, and limitations. Do not push or merge.

## Handoff

Record branch/worktree, implementation and handoff commits, changed paths, field mapping and error behavior, exact WSL results, and limitations. Root independently reviews and accepts before integration.
