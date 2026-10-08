# L2-CONTEXT-RESUME-CORE — rehydrate a pinned grounding context for restart

- **Status:** Assigned for implementation
- **Backlog ID:** `L2-CONTEXT-RESUME-CORE`
- **Implementation model:** GPT-6 Luna, max reasoning
- **Branch:** `work/L2-CONTEXT-RESUME-CORE`
- **Worktree:** `.codex-build/worktrees/l2-context-resume-core` (WSL-compatible linked worktree)
- **Assigned base:** `b56392ac48032e1816b560a66f56fa04c89a9d30`
- **Contract baseline:** Internal schema 2.0 `GroundingContextRecord` and `ReasoningRequest`; existing `waspada_l2_grounding_reader` grants from migrations 004 and 030; [ADR-015](../decisions/ADR-015-l2-grounding-context-persistence.md), [ADR-044](../decisions/ADR-044-l2-source-revision-grounding-gate.md), [ADR-049](../decisions/ADR-049-l2-grounding-context-resume.md).
- **Dependencies:** `L2-CONTEXT-READ-CORE`, `L2-CONTEXT-PERSIST-CORE`, `L2-CONTEXT-BRIDGE-CORE`, `RAG-CONTEXT-ASSEMBLY-CORE`, `LIFE-01-L2-SOURCE-REVISION-GROUNDING-GATE-CORE`, `DB-TEST-RUNNER-ISOLATION`.
- **Requirements:** FR-05/06/07/11; NFR-01/05/07.

## Objective

Add a Layer 2-only service that reads one exact refs-only context and reconstructs its excerpt-bearing schema 2.0 `ReasoningRequest` from the exact saved evidence identities and current permitted database state. This is a local capability only; do not wire a Workflow, model provider, route, or Worker runtime.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md`
- `docs/IMPLEMENTATION_BACKLOG.md`
- `ARCHITECTURE.md`
- `docs/DOMAIN_MODEL.md`
- ADR-011, ADR-015, ADR-044, and ADR-049
- migrations 001, 004, 010, and 030
- `apps/db/src/grounding-contexts.ts`, `apps/db/src/evidence-retrieval.ts`, `apps/db/src/ports.ts`, and `apps/db/src/sql.ts`
- `apps/worker/src/layers/l2-model-grounding/contracts.ts`, `validation.ts`, `grounding-context.ts`, and `context-persistence.ts`
- relevant DB retrieval/PGlite tests and Worker grounding-context tests

## Required behavior

1. Accept only `(datasetKind, contextId)` as the resume key. Use the existing exact `GroundingContextReadRepository.findById`; missing contexts return `null` or a typed not-found result without a model request.
2. Resolve the validated record's saved natural evidence identities in one bounded exact read, at most eight references. Require exactly one current match per saved reference in the same dataset and candidate, matching revision ID, text hash, span, offset unit, and relation. Do not invoke broad hybrid search or substitute different references.
3. Re-read current report revision state and require equality with the saved `revision_states`. Require the current source registry state to be `active` and approval to be `approved`. Source health alone does not invalidate already persisted evidence, per ADR-049.
4. Re-read the current source ID, publication/observation/retrieval timestamps, and exact origin lineage/dependencies for every pinned reference. Re-read each exact excerpt through the existing exact-span source-invalidation gate, preserving its typed `source_invalidated` failure.
5. Construct an ephemeral closed schema 2.0 `ReasoningRequest`. Copy context/candidate/trace identity, candidate event versions, prior-decision IDs, missing fields, conflicts, retrieval/index versions, and original sufficiency from the validated refs-only record. Return only after full `validateReasoningRequest` succeeds.
6. Fail closed on missing, duplicate, malformed, cross-dataset/candidate, changed, source-ineligible, invalidated, or inconsistent references. Errors must be stable and must not contain excerpt text, source content, URLs, model output, SQL, or provider details.
7. Do not persist the reconstructed request or excerpt text. Do not change schema 2.0, migrations, grants, API/OpenAPI/DTOs, model prompts, L3 budgets/ledger, publication, Workflow payloads, runtime configuration, dependencies, provider/source access, or deployment.

## Acceptance criteria

- Worker tests cover exact successful reconstruction, preserved contrary evidence and origin lineage, copied timestamps and pinned context metadata, absent context, each stale/missing/duplicate/cross-identity case, source-status denial, invalidation denial, and redacted failures. Assert no caller mutation and no write through the context repository.
- PGlite tests execute the exact evidence reader under `SET ROLE waspada_l2_grounding_reader`, prove each selected natural identity resolves exactly once, verify current status/timestamps/origin dependencies and span text, prove invalidating source observations return no request text, and snapshot rows to confirm reads are unchanged.
- Verify no new migration/grant is necessary. Existing public, L1, L2 writer, and L3 roles must not gain this content-read capability. If the current L2 reader grants cannot support the exact behavior, stop and report the specific gap; do not add a grant in this task.
- In WSL Ubuntu-26.04, run focused tests, `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check b56392ac48032e1816b560a66f56fa04c89a9d30..HEAD`. Record Node/npm versions and actual outcomes; do not install dependencies or contact external services.
- Commit implementation and handoff as coherent commits on the assigned branch. Root independently reviews and integrates only after acceptance; do not merge or push.

## Allowed paths

- `apps/db/src/evidence-retrieval.ts` (new exact selected-reference rehydration reader and supporting closed types; preserve initial hybrid-search behavior)
- `apps/db/test/evidence-retrieval.test.ts` or a dedicated exact rehydration test
- a dedicated PGlite composition test under `apps/db/test/` (synthetic fixtures only)
- `apps/worker/src/layers/l2-model-grounding/context-resumption.ts` (new service) and, only if a small shared type boundary requires it, `grounding-context.ts`
- `apps/worker/test/l2-grounding-context-resumption.test.ts`
- this file's **Implementation handoff** section only

Do not edit migrations, existing grants, context/model schema, APIs, OpenAPI, L3 runtime/Workflow configuration, source connectors, providers, package manifests, lockfiles, unrelated tests, or root-owned docs. Ask root about a scope or interface conflict; stop if a new grant or schema migration appears necessary.

## Stop/escalation conditions

Do not spawn additional agents. Stop and report to root if an exact persisted natural identity cannot be resolved without widening grants; if a stored status conflicts with current report/source state; if the existing invalidation reader cannot be composed safely; or if a contract/schema/runtime change is required. Do not escalate models unless Luna/max attempted a substantive technical problem and could not resolve it.

## Implementation handoff

Implemented on branch `work/L2-CONTEXT-RESUME-CORE` in `.codex-build/worktrees/l2-context-resume-core`.

- **Task commits:**
  - `20c09ea606e424d91a8e15ffaf5a3bde94b3d1ab` — `feat(L2-CONTEXT-RESUME): rehydrate pinned context`
  - `12aad6def719c28d382ec9425a7e271f9ffd6a56` — `docs(L2-CONTEXT-RESUME): record implementation handoff`
  - `5acfbf31989e5d003cadaa8e3e93c7f9d80d96b3` — `docs(L2-CONTEXT-RESUME): record final diff check`
- **Changed paths:** `apps/db/src/evidence-retrieval.ts`; `apps/db/test/l2-context-resumption-composition.test.ts`; `apps/worker/src/layers/l2-model-grounding/context-resumption.ts`; `apps/worker/test/l2-grounding-context-resumption.test.ts`.
- **Behavior:** Layer 2 reads one exact refs-only context, resolves at most eight saved evidence identities in one bounded query, requires exact same-dataset/candidate identity and unchanged revision states, requires the current source registry to be active and approved, reloads source timestamps and origin lineage, and reads every exact span through the existing source-revision invalidation gate. It returns only an in-memory schema 2.0 `ReasoningRequest` after closed-contract validation. Source health is preserved as metadata and does not block resume. Failures use stable content-free codes.
- **Verification environment:** WSL Ubuntu-26.04; Node `v24.21.0`; npm `11.19.0`.
- **Focused command:** `npx tsx --test apps/db/test/evidence-retrieval.test.ts apps/db/test/l2-context-resumption-composition.test.ts apps/worker/test/l2-grounding-context.test.ts apps/worker/test/l2-grounding-context-resumption.test.ts` — 36/36 passed.
- **Full commands and results:** `npm run db:test` — 41/41 DB files passed; `npm test` — web 60, Worker 440, DB 41 files, evaluation 19, all passed; `npm run typecheck` — exit 0; `npm run build` — exit 0, including Vite production build and Wrangler dry-run.
- **Assigned-base diff check:** `git diff --check b56392ac48032e1816b560a66f56fa04c89a9d30..5acfbf31989e5d003cadaa8e3e93c7f9d80d96b3` — exit 0; target is full commit `5acfbf31989e5d003cadaa8e3e93c7f9d80d96b3`.
- **Post-correction assigned-base diff check:** `git diff --check b56392ac48032e1816b560a66f56fa04c89a9d30..2ce71d24624eb0d00ad4bf69937fcef8ed652edd` — exit 0; target is full commit `2ce71d24624eb0d00ad4bf69937fcef8ed652edd`.
- **Migration/configuration impact:** None. Existing L2 reader grants support evidence/source/origin reads and exact-span invalidation; the context lookup uses the existing context repository boundary. No schema, grants, API, runtime, provider, source, dependency, or deployment configuration changed.
- **Limitations and remaining decisions:** Local synthetic PGlite and injected-reader behavior only; hosted Neon isolation/concurrency and any deployed Worker/Workflow behavior remain unverified. Root review and integration are pending; no additional design decision is required by this implementation.
