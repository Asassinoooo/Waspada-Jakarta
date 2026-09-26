# RAG-CONTEXT-ASSEMBLY-CORE — assemble exact evidence into a grounded reasoning request

- **Status:** Accepted on `main` at `f4ca0dc` (`6a2ee3b` implementation; `f4ca0dc` handoff)
- **Depends on:** RAG-CORE, RAG-ACCESS-01, L2-ADAPTER-01, L2-CONTEXT-PERSIST-CORE, L2-CONTEXT-BRIDGE-CORE
- **Requirements:** FR-05/06/07; NFR-01/05/07
- **Layer:** L2 — grounding and model input preparation
- **Implementation model:** GPT-6 Luna, max reasoning
- **Branch/worktree:** `work/RAG-CONTEXT-ASSEMBLY-CORE`; `.codex-build/worktrees/rag-context-assembly-core`

## Objective

Create a deterministic Layer 2 adapter that turns one bounded hybrid-retrieval result into a validated schema 2.0 `ReasoningRequest`. Retrieval currently returns excerpts capped at 2,048 code points, while the reasoning contract requires text to cover the cited evidence span exactly. The adapter must re-read each selected reference's exact full span through the existing least-privilege reader before model input is assembled. Preserve dataset, reference, source timestamps, revision state, origin lineage, contradictions, candidate event versions and retrieval/index versions.

Sufficiency, missing fields, conflicts, candidate-event matches and prior decisions are explicit inputs from the caller and must be copied without assessment or invention. This task does not invoke a model, trigger L3, persist a proposal, or authorize publication. Human-labelled evaluation and real provider selection remain later gates.

## Read first

- `AGENTS.md` and `SOFTWARE_DEVELOPMENT_PLAN.md`
- `docs/IMPLEMENTATION_BACKLOG.md`, `docs/DOMAIN_MODEL.md`, and `docs/UX_API_SPEC.md`
- `docs/assignments/RAG-CORE.md`, `docs/assignments/RAG-ACCESS-01.md`, `docs/assignments/L2-CONTEXT-PERSIST-CORE.md`, and `docs/assignments/L2-CONTEXT-BRIDGE-CORE.md`
- `apps/db/src/evidence-retrieval.ts` and `apps/db/migrations/004_l2_grounding_reader.sql`
- `apps/worker/src/layers/l2-model-grounding/contracts.ts`, `validation.ts`, `retrieval.ts`, and `context-persistence.ts`

## Required behavior

- Add a bounded read method for exact evidence spans, keyed by the existing dataset and evidence-reference ID. Recheck the canonical report revision ID, immutable text hash, span offsets, offset unit and relation against storage before returning text. Return the exact code-point span only; do not return a whole report.
- Read at most the reasoning contract's eight evidence references per request. Bound each full span at 40,000 Unicode code points. Reject oversized spans and stale/mismatched references explicitly; never truncate text while retaining full-span citation offsets.
- Run new SQL under `waspada_l2_grounding_reader`. Reuse existing column privileges only. Add no grants, roles, migrations, dependencies or provider configuration. Tests must exercise the actual query under `SET ROLE` and confirm unrelated columns remain inaccessible.
- Assemble the strict schema 2.0 context from explicit caller input and the retrieval snapshot. Preserve `supports`, `contradicts`, `updates` and `context` relations, source observation/publication/retrieval times, revision states, and origin dependency/independence status. Preserve conflicts and candidate/prior-decision references as supplied.
- Fail closed if the retrieval result or selected evidence set is truncated, exceeds eight references, crosses dataset/candidate identity, contains duplicate reference identities, or cannot be exactly rehydrated. Never turn partial retrieval into a `sufficient: true` model request.
- Copy an explicit caller-provided `sufficient` boolean unchanged when the retrieval context is complete. Do not implement a sufficiency threshold or claim that a boolean is calibrated. If no index version is present, encode the documented explicit sentinel `not_applicable`; never fabricate a model/index identity.
- Validate the completed request with `validateReasoningRequest` before returning it. Do not alter the shared schema 2.0 contract or validator.
- Use only authored synthetic PGlite and Worker fixtures. They are boundary tests, not retrieval-quality or safety evidence.

## Allowed paths

- `apps/db/src/evidence-retrieval.ts`
- `apps/db/test/evidence-retrieval.test.ts`
- `apps/worker/src/layers/l2-model-grounding/grounding-context.ts` (new)
- `apps/worker/test/l2-grounding-context.test.ts` (new)
- `apps/worker/package.json` — test discovery only
- `docs/assignments/RAG-CONTEXT-ASSEMBLY-CORE-HANDOFF.md` (new)

Do not edit API/OpenAPI contracts, schema examples, migration files, DB grants, model/provider adapters, source ingestion, L3/L4 orchestration, UI, dependencies or lockfiles. If existing role/query boundaries cannot support exact span rehydration, stop and report the precise gap to the root planner without broadening privileges.

## Acceptance and checks

- Exact span text is proven against stored text hashes and code-point offsets under the L2 reader role.
- Retrieval-to-context mapping is deterministic and preserves evidence provenance and conflicts; invalid, truncated or over-limit inputs cannot produce a reasoning request.
- The explicit `sufficient` input is never inferred or defaulted, and a complete context passes it through unchanged.
- No model, source, L3, L4, API, publication or cloud action occurs.
- In WSL Ubuntu-26.04 run focused DB/Worker tests, `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build` and `git diff --check`. Record exact results and limitations in the handoff.
- Commit implementation and handoff separately on the assigned branch. Do not merge or push; root reviews and integrates.

## Root review and acceptance

Root reviewed and fast-forwarded the clean branch to `main` at `f4ca0dc`. The SQL reader runs under the existing L2 reader privileges and returns only the exact selected substring after rechecking dataset, candidate, reference, revision, hash, offsets, unit, relation and current revision status. The Worker assembler rejects incomplete retrieval and invalid or mixed identity sets, preserves the selected evidence's relations, timestamps, revision status and known origin lineage, copies explicit caller fields without assessing sufficiency, and validates the finished schema 2.0 request. The OpenAPI file was restored from `main` as requested; no contract, migration, grants, provider, source, L3/L4 behavior, dependency or publication path changed.

Root independently verified in WSL Ubuntu-26.04 with Node.js `v24.21.0` and npm `11.19.0`: focused database/Worker tests passed 14/14 and 6/6; `npm run db:test` passed 78/78 across 10 files; `npm test` passed 179/179 (web 5, Worker 84, DB 78, casebook 12); `npm run typecheck`, `npm run build` (Vite and Wrangler dry-run), and `git diff main...HEAD --check` passed. PGlite and synthetic fixtures verify the local boundary only; hosted Neon permissions/concurrency and runtime/model-provider integration remain unverified.
