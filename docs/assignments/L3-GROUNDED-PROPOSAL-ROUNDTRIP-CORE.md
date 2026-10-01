# L3-GROUNDED-PROPOSAL-ROUNDTRIP-CORE — compose investigation with private proposal persistence

**Status:** Assigned as a test-only integration slice after accepting the L3 synthetic L1/L2 refresh and RAG-to-private-proposal roundtrips.  
**Backlog ID:** `L3-GROUNDED-PROPOSAL-ROUNDTRIP-CORE`  
**Implementation model:** GPT-6 Luna, max reasoning  
**Branch:** `work/L3-GROUNDED-PROPOSAL-ROUNDTRIP-CORE`  
**Worktree:** `C:\Users\perry\.codex\worktrees\l3-grounded-proposal-roundtrip-core\RPL` (`/mnt/c/Users/perry/.codex/worktrees/l3-grounded-proposal-roundtrip-core/RPL` in WSL Ubuntu-26.04). Root will create it from the exact pushed `main` commit identified in the dispatch.

## Context and dependencies

Read `SOFTWARE_DEVELOPMENT_PLAN.md`, `docs/IMPLEMENTATION_BACKLOG.md`, this assignment, and the referenced accepted handoffs before editing. The two accepted tests currently prove separate paths: `L3-SYNTHETIC-L1L2-ROUNDTRIP-RESUME` composes a bounded coordinator advance through persisted synthetic L1 and exact L2 refresh; `RAG-GROUNDED-PROPOSAL-ROUNDTRIP-CORE` composes L2 grounding through private proposal persistence. This task verifies their boundary together without creating a production runtime.

Dependencies: `L3-COORDINATOR-CORE`, `L3-SYNTHETIC-L1L2-ROUNDTRIP-RESUME`, `RAG-GROUNDED-PROPOSAL-ROUNDTRIP-CORE`, `L2-DIRECT-REASONING-CORE`, `L2-CONTEXT-PERSIST-CORE`, `L2-PROPOSAL-PERSIST-CORE`, `L2-PROPOSAL-REASONING-BRIDGE-CORE`, and `DB-TEST-RUNNER-ISOLATION`.

Use the existing schema 2.0 `GroundingContext`, `EventProposal`, and investigation records, internal investigation plan 1.0, PGlite harness, SQL repositories, roles, and injected model/action ports. Do not change contract versions.

## Objective

Extend the existing PGlite composition in `apps/db/test/investigation-ledger.test.ts` to prove this bounded path:

`initial insufficient L2 context → one L3 coordinator advance → synthetic L1 fixture replay → persisted-evidence L2 refresh → same-case sufficient-context checkpoint → fixed L2 reasoning double → canonical private proposal`

The initial context must be persisted and explicitly insufficient, so the direct reasoning service returns `investigation_required` without calling the reasoning capability. The coordinator then performs no more than one plan, one registered action, and one refresh. The refresh uses the action's exact output reference to retrieve the persisted synthetic report, rehydrate the exact evidence span, and persist its refs-only context. To exercise the post-investigation reasoning path, the test may explicitly set the refreshed synthetic context's `sufficient` input to `true`; this is a fixture control only, not an evaluation of factual sufficiency or a claim about real reports.

After the coordinator returns its existing `sufficient_context` outcome, pass that exact refreshed request to `createDirectReasoningService` with a deterministic reasoning double. Then pass the result, the matching in-memory context, and its persisted record to `createReasoningProposalBridge`. The canonical proposal repository is the only proposal write path in scope.

## Architectural and safety boundaries

- Keep L1 fixture processing, L2 retrieval/context persistence, L3 investigation, L2 reasoning, and private proposal persistence as separate existing components. Do not move extraction, retrieval, validation, or persistence into the coordinator.
- The coordinator receives only opaque action output references and typed refreshed context; it must not inspect report text.
- Grounding context persistence remains refs-only. Exact text can reach the reasoning double only after the exact-span reader rehydrates the persisted source range.
- Use only authored, labelled synthetic fixtures, a deterministic planner, and a fixed reasoning double. No network, live source, model/provider API, or external service.
- Model output remains a proposal. Do not write event versions, publication decisions, outbox/audit records, or moderator state.
- Assert evidence status/provenance directly; do not claim the synthetic test establishes factual support, model quality, source rights, or real-world sufficiency.
- Preserve existing L3 budget, reservation, checkpoint, and replay assertions. A retry must not repeat L1/L2 work or create duplicate proposal rows.

## Allowed paths

- `apps/db/test/investigation-ledger.test.ts`
- `docs/assignments/L3-GROUNDED-PROPOSAL-ROUNDTRIP-CORE-HANDOFF.md`

Do not change production code, schemas, migrations, repositories, package scripts, dependencies, APIs/OpenAPI, source registration, providers, credentials, routes, Worker/Workflow runtime, deployment configuration, publication behavior, or root planning documents. If the accepted interfaces cannot prove exact identity across the full path, stop and report the smallest missing interface rather than weakening validation or expanding scope.

## Acceptance criteria

1. The initial `sufficient: false` context is persisted before L3 entry; the direct reasoning capability is not called before investigation.
2. One coordinator advance calls at most one planner, one registered synthetic action, and one L1/L2 refresh. The action runs the existing L1 pipeline through real SQL repositories; L2 retrieves the exact report revision and evidence reference identified by the action output.
3. Exact-span rehydration, source lineage, evidence hash/relation, and distinct source/event/retrieval timestamps survive into the refreshed typed request. The matching persisted context contains references only and exists before reasoning is invoked.
4. The refreshed `sufficient` value is explicitly an authored test input. The coordinator returns the exact same-case `sufficient_context` result, including the refreshed context record and checkpoint identity.
5. The deterministic reasoning double is called only after that result, receives the exact refreshed request, and returns a typed result grounded only in its evidence references. The existing reasoning bridge persists a schema 2.0 private proposal with exact dataset, trace, candidate, context, investigation, report revision, span, relation, and model-run identity.
6. Exact proposal replay adds no duplicate proposal, claim, evidence, or origin rows. The test asserts zero event-version/publication-decision/outbox/audit/moderator writes for this trace.
7. Existing failure, replay, reservation, budget, and no-raw-text persistence assertions remain effective. No sufficiency/factuality or live-provider claim is made.
8. Only the two allowed paths change; all model/action outputs and fixtures are labelled synthetic.

## Verification

Use WSL Ubuntu-26.04 with the existing dependencies; do not install dependencies. Record Node.js, npm, Git, PGlite, TypeScript, and Wrangler versions. Run:

```sh
npm exec tsx -- --test apps/db/test/investigation-ledger.test.ts
npm run db:test
npm test
npm run typecheck
npm run build
git diff --check <assigned-base>..HEAD
```

Record actual results and counts. `npm run build` must be described as a local Vite/Wrangler dry-run only; do not deploy or configure a Cloudflare/Neon resource.

## Stop conditions and handoff

Stop if an existing typed interface cannot bind the reasoning request and private proposal to the coordinator's exact persisted context/case, if satisfying the test requires production/schema/API changes, or if it would cross the Layer 4 publication gate. Report the concrete identity/invariant and the smallest missing interface. Do not escalate to GPT-6 Astra xhigh unless a GPT-6 Luna/max attempt reaches a substantive technical difficulty it cannot resolve.

Commit implementation and handoff on the task branch in coherent descriptive commits; do not merge or push. Handoff must state branch/worktree, assigned base, commit SHAs and exact messages, changed paths, behavior, WSL commands/results, runtime versions, limitations, migration/configuration impact, and remaining decisions. Root owns independent review, acceptance, integration, task status, and push.
