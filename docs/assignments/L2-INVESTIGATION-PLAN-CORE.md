# L2-INVESTIGATION-PLAN-CORE — typed next-action proposals for bounded investigations

- **Status:** Assigned for local implementation
- **Backlog ID:** `L2-INVESTIGATION-PLAN-CORE`
- **Objective:** Add a provider-injected Layer 2 adapter that validates one proposed investigation action or a closed abstention result against retrieved insufficient context and a bounded trusted action menu. This is model-proposal groundwork; it has no action authority.
- **Dependencies:** L2-ADAPTER-01, RAG-CONTEXT-ASSEMBLY-CORE, L3-INSUFFICIENT-CONTEXT-ENTRY-CORE, L3-SINGLE-STEP-EXECUTOR-CORE, ADR-027.
- **Requirements:** FR-07; NFR-01/02/05/07.
- **Contract boundary:** New internal Worker planning contract only. Do not modify schema 2.0, the public API/OpenAPI contract, the database, or existing event-reasoning outputs.
- **Implementation model:** GPT-6 Luna, max reasoning.
- **Branch/worktree:** `work/L2-INVESTIGATION-PLAN-CORE` in the clean managed parser worktree `C:\Users\perry\.codex\worktrees\l1-fixture-runner-core\RPL`, based on the pushed `main` commit containing this assignment. Create/select the branch before editing; do not edit through the root checkout.
- **Provider:** Injected synthetic test double only. Do not add API credentials, model SDKs, a live model provider, or a default provider.

## Read before implementation

- `AGENTS.md` and `SOFTWARE_DEVELOPMENT_PLAN.md`
- `ARCHITECTURE.md`, `docs/IMPLEMENTATION_BACKLOG.md`, `docs/DOMAIN_MODEL.md`, and `docs/UX_API_SPEC.md`
- `docs/decisions/ADR-014-l3-investigation-ledger.md`, `docs/decisions/ADR-017-l3-single-step-execution.md`, and `docs/decisions/ADR-027-l2-investigation-action-proposals.md`
- `docs/assignments/L2-ADAPTER-01.md`, its handoff, `docs/assignments/RAG-CONTEXT-ASSEMBLY-CORE.md`, and its handoff
- `docs/assignments/L3-INSUFFICIENT-CONTEXT-ENTRY-CORE.md`, `docs/assignments/L3-SINGLE-STEP-EXECUTOR-CORE.md`, and `docs/assignments/L3-LEDGER-CORE.md`
- `apps/worker/src/layers/l2-model-grounding/contracts.ts`, `validation.ts`, `adapter.ts`, and `direct-reasoning.ts`
- `apps/worker/src/layers/l3-investigation/contracts.ts`, `single-step-executor.ts`, and `apps/db/src/investigation-ledger.ts`

## Required behavior

1. Add a dedicated internal `InvestigationPlanRequest`/`InvestigationPlanResult` contract with explicit version `1.0` and a `createInvestigationPlanner` adapter in `apps/worker/src/layers/l2-model-grounding/investigation-planner.ts`. Keep this distinct from `ReasoningResult` and `EventProposal`; do not add a public or schema 2.0 contract.
2. Require a structurally valid, bounded GroundingContext with `sufficient === false`, between 1 and 20 stable question labels, and between 1 and 16 unique action-menu entries. Require the ordered labels to equal the deterministic `missing_field_1..N` then `conflict_1..M` projection of that context, and reject a sufficient or malformed context before calling the provider. The request action menu is supplied by trusted composition and includes bounded names and short descriptions from the trusted registry; the adapter does not register tools.
3. Call the injected provider at most once per `propose` call. Preserve provider absence, malformed request, malformed output, and provider failure as closed typed outcomes. Never expose raw errors, raw model output, prompts, evidence text, or action input in an error or telemetry field.
4. Accept either (a) exactly one action name present in the supplied menu with a plain JSON object input no larger than 8 KiB UTF-8, nesting depth at most 8, at most 32 keys/items per object/array, key length at most 64 characters, and string length at most 2,048 characters, or (b) a fixed abstention result with reason `no_available_action`, `ambiguous_context`, or `cannot_form_valid_input`. Reject unknown names, extra result properties, prototype-bearing/cyclic/non-JSON input, oversized data, and claims of sufficiency, budget changes, stop authority, or publication.
5. Do not impose action-specific semantics in Layer 2. The trusted Layer 3 registry must still validate arguments for the selected registered action, confirm case/checkpoint/budget state, and reserve/execute through the ledger. An adapter success is only a proposal.
6. Treat GroundingContext evidence as untrusted source data, never instructions. The adapter itself makes no network calls, reads/writes no database, persists no prompts or model output, selects no source/host, and performs no L1 acquisition, L2 retrieval, L3 budget mutation, or L4 publication.
7. Tests use authored synthetic context and an injected fake provider. Cover request rejection before provider call; insufficient-context requirement; menu and question bounds; one provider call; valid action and abstention; unknown menu action; strict extra-key rejection; JSON byte/depth/count/string limits; prototype/cycle/non-JSON rejection; and generic typed provider failure. Ensure arbitrary content is never copied into error outcomes.

## Allowed paths

- `apps/worker/src/layers/l2-model-grounding/investigation-planner.ts` (new)
- `apps/worker/test/l2-investigation-planner.test.ts` (new)
- `apps/worker/package.json` (Worker test discovery only)
- `docs/assignments/L2-INVESTIGATION-PLAN-CORE.md` (implementation handoff only)

No shared model contract, provider SDK, API/OpenAPI, database/schema/migration, telemetry, route, UI, source adapter, queue, credential, hosted service, deployment, or other file is in scope. If a clean trust boundary requires a public/domain contract change or additional L3 authority, stop and report the precise dependency gap instead of expanding this task.

## Verification and handoff

Run the focused planner test, `npm test --workspace=@waspada/worker`, full `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check` in WSL Ubuntu-26.04 using native Node.js `v24.21.0` and npm `11.19.0`. Reuse the existing cache; no additional dependency is expected or authorized.

Commit implementation and the implementation handoff on the assigned branch in separate coherent commits. Do not merge or push. Record the branch/worktree, commit SHAs and exact messages, changed paths, behavior, actual checks/results, limitations, migration/configuration impact, and remaining decisions. Root reviews and integrates accepted work.

## Handoff

Append the implementer's exact handoff here after committing the completed work package.
