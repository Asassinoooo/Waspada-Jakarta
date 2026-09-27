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

### Delivery

- **Branch:** `work/L2-INVESTIGATION-PLAN-CORE`
- **Worktree:** `C:\Users\perry\.codex\worktrees\l1-fixture-runner-core\RPL` (WSL: `/mnt/c/Users/perry/.codex/worktrees/l1-fixture-runner-core/RPL`)
- **Base:** `07421620f976ecd58433e0e683f4230f0ff46f48`
- **Implementation commit:** `49b5c15bcc48e4745e6a040943c1358d0cc4dcd9` — `feat(L2-INVESTIGATION-PLAN-CORE): add typed action planner`
- **Handoff commit:** recorded separately with message `docs(L2-INVESTIGATION-PLAN-CORE): record implementation handoff`; its SHA is in the task handoff.

### Behavior implemented

`createInvestigationPlanner` accepts a new internal `InvestigationPlanRequest` version `1.0`, validates its schema 2.0 `GroundingContext` with the existing Layer 2 validator, and rejects sufficient context. It requires the `questions` array to exactly match the existing L3 position-label projection from missing-field and conflict counts. The trusted action menu has 1–16 unique bounded names with non-empty descriptions up to 256 Unicode code points. A provider is injected explicitly; no default provider is configured, and each valid proposal call invokes it at most once.

The adapter returns closed typed outcomes for missing provider, malformed request, malformed result, and provider failure. A successful result is either one action name present in the supplied menu with a cloned plain JSON object input or one of the three fixed abstentions. Action input is limited to 8 KiB UTF-8, depth 8, 32 properties/items per object or array, 64-code-point keys, and 2,048-code-point strings. Extra result fields, unknown actions, accessors, non-JSON values, prototype-bearing objects, sparse or extended arrays, and cycles fail closed. The request and accepted input copies are frozen before leaving their respective boundaries. No raw error or provider output is returned in failure outcomes, and this adapter emits no telemetry.

The result is only an L3 proposal. The trusted registry, action-specific parser, investigation checkpoint and budget checks, ledger reservation, and single-step executor retain execution authority.

### Changed paths

- `apps/worker/src/layers/l2-model-grounding/investigation-planner.ts` — internal versioned request/result contracts, injected provider boundary, and closed validation outcomes.
- `apps/worker/test/l2-investigation-planner.test.ts` — synthetic fake-provider coverage for request validation, action/abstention results, bounds, output closure, provider errors, and data redaction.
- `apps/worker/package.json` — focused test discovery only.
- `docs/assignments/L2-INVESTIGATION-PLAN-CORE.md` — this handoff.

No shared contract, schema, migration, database, route, telemetry, provider SDK, dependency, credential, or runtime configuration changed. There is no migration or configuration impact.

### Verification

Checks ran in WSL Ubuntu-26.04 with Node.js `v24.21.0`, npm `11.19.0`, tsx `4.23.15`, TypeScript `7.0.2`, Wrangler `4.137.0`, and Vite `8.3.0`. Existing dependencies were reused.

- `node_modules/.bin/tsx --test apps/worker/test/l2-investigation-planner.test.ts` — passed 11/11.
- `npm test --workspace=@waspada/worker` — passed 293/293.
- `npm test` — exited 0; web and Worker suites passed, all 20 DB test files passed, and the evaluation casebook passed 12/12.
- `npm run typecheck` — passed for web, Worker, database, and evaluation.
- `npm run build` — passed typecheck, Vite production build, and Wrangler `4.137.0` Worker dry-run.
- WSL `git diff --cached --check` and `git diff --check` — passed with explicit `GIT_DIR` and `GIT_WORK_TREE` for the Windows-created worktree metadata.

### Limitations and remaining decisions

This is synthetic provider-injected groundwork only. There is no model provider, prompt construction, registered action, L3 coordinator loop, runtime composition, route, acquisition, or publication behavior. The tests prove structural validation and redaction, not model quality, hosted-provider behavior, or prompt-injection resistance. No contract gap or migration decision remains. Root review and integration are pending.
