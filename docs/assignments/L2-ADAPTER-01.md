# L2-ADAPTER-01 — Typed model capabilities and test doubles

- **Status:** Ready for local implementation
- **Depends on:** SPEC-02, DATA-01
- **Requirement coverage:** FR-04/05/07; NFR-02
- **Branch/worktree:** `work/L2-ADAPTER-01-typed-contracts`; `D:\Projects\RPL\.codex-build\worktrees\l2-adapter-01` (`/mnt/d/Projects/RPL/.codex-build/worktrees/l2-adapter-01` in WSL)
- **Owner:** GPT-6 Luna Max implementation agent; root plans and reviews

## Objective

Replace the placeholder L2 `unknown` interfaces with explicit capability contracts and fail-closed validation that will support later extraction, embedding, retrieval grounding, and reasoning. Implement only local contracts, validators, an unconfigured-provider result, and test-only doubles. This task must not call or imply access to a real model.

## Read first

- `SOFTWARE_DEVELOPMENT_PLAN.md` — FR-04/05/07, NFR-02, and model/grounding requirements
- `docs/IMPLEMENTATION_BACKLOG.md` — L2-ADAPTER-01, AI-01, DATA-02 and RAG-01
- `ARCHITECTURE.md` — Layer 2 grounding and separation from Layer 3
- `docs/contracts.schema.json` and `docs/contracts.examples.json` — ExtractionResult, EvidenceRef, GroundingContext, ProposalClaim, EventProposal, and ModelRun contracts
- `docs/DOMAIN_MODEL.md` — immutable report revision and evidence-span rules
- `apps/worker/src/layers/l2-model-grounding/contracts.ts`
- `apps/db/src/ports.ts` — source report hashes and persisted embedding lineage

## Required behavior

- Define distinct typed requests/results for low-latency classification, extraction, embedding, and complex reasoning. A reasoning request receives an already retrieved, versioned grounding context; it does not retrieve, call tools, mutate data, approve a source, or publish an event.
- Provider outputs enter the boundary as `unknown` and must pass strict runtime validation before becoming typed values. Reject missing/extra fields, oversized values, non-finite vectors, invalid dimensions, bad hashes, invalid time precision, and evidence spans that do not match the input report revision/hash or retrieved context.
- Every proposed claim must cite one or more evidence references that exist in the supplied source/context and fall within the exact Unicode code-point bounds. Preserve unknowns and contradictions; empty or unsupported model output must abstain or require review.
- Keep embeddings separate from extraction/reasoning token records; bind each embedding result to its input chunk ID/hash, provider/model version, dimensions, metric, and index version. Do not use a fake embedding as evidence of semantic quality.
- Provide an explicit not-configured adapter outcome. It must not silently substitute a mock or emit an empty success when no provider is set.
- Test doubles belong only in test code and must be clearly named test-only. They may return scripted, synthetic outputs for contract tests but must not be imported into Worker production entry points.
- Keep source text inside data-only input fields. Model-proposed classifications, claims, support assessments, and evidence labels remain proposals; no model result has L4 publication authority.

## Boundaries and checks

- **Allowed paths:** `apps/worker/src/layers/l2-model-grounding/**`, `apps/worker/test/l2-*.test.ts`, and this assignment's handoff section.
- **Forbidden:** public API/OpenAPI/domain schema changes, L1 parsing or DB changes, L3 tool orchestration, L4 publication writes, user-facing UI, external provider calls, credentials/secrets, new dependencies, cloud resources, or deployment.
- No human-labelled casebook is needed to validate contracts. Do not claim model accuracy, grounding quality, latency, semantic retrieval quality, or provider compatibility.
- Use WSL Ubuntu-26.04 with native Node.js/npm from `docs/BOOTSTRAP.md`. Run the new focused test, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check` from the assigned worktree. No API route changes are expected, so no smoke test is expected; explain if that boundary changes.
- Commit coherent work on the assigned branch and leave it clean. Do not push or merge.

## Handoff

Implementation agent appends branch/worktree, commit SHA(s) and exact messages, changed paths, actual checks and results, limitations, and any contract impact. Root independently reviews before acceptance.
