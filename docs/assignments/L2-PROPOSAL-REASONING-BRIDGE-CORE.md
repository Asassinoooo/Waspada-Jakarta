# L2-PROPOSAL-REASONING-BRIDGE-CORE — Map validated reasoning into private drafts

- **Status:** Assigned; implementation and root acceptance pending
- **Agent:** GPT-6 Luna / max
- **Branch:** `work/L2-PROPOSAL-REASONING-BRIDGE-CORE`
- **Worktree:** To be created from the root dispatch commit in its own checkout
- **Dependencies:** L2-DIRECT-REASONING-CORE, L2-CONTEXT-PERSIST-CORE, L2-PROPOSAL-PERSIST-CORE, RAG-CORE, ADR-037
- **Requirements:** FR-05/06/07/14; NFR-01/05/07
- **Contracts:** Existing typed `ReasoningResult`, `GroundingContext`, `GroundingContextRecord`, and canonical schema 2.0 `EventProposal`; no public API change

## Objective

Implement the deterministic L2 bridge from an already validated reasoning capability outcome and its persisted grounding context to the accepted private `EventProposalRepository`. Read `SOFTWARE_DEVELOPMENT_PLAN.md` first, then this backlog item, ADR-037, ADR-036, the L2 model/context contracts and validation, the existing direct-reasoning/context-persistence boundaries, and `apps/db/src/event-proposals.ts`.

The bridge must never invoke a provider, retrieve evidence, open or advance an L3 case, or call publication services. A failure outcome returns a no-write result. On success, validate that the supplied `GroundingContext` matches its persisted `GroundingContextRecord` across identity, evidence, event candidates, gaps/conflicts, versions and sufficiency. Require the result's preserved conflicts to match the context.

Map claims and references to the closed canonical proposal shape without changing the schema. `ProposedClaim` has no claim ID, so assign stable proposal-local IDs by claim order (`claim-001` through `claim-020`); keep input order so an unchanged retry produces the same draft. Preserve evidence order and all time precision. Map model support assessment as data and set every draft claim's evidence label to `under_review`. The canonical draft `ModelRun` has no provider field: map only its existing capability, model version, prompt version and token fields, and do not encode provider identity into another field. Derive each claim's origin IDs only from exact context-origin metadata for its support references, sort/deduplicate deterministically, and fail closed before persistence if any support has missing, ambiguous or non-context origin lineage. Do not infer independence, public source labels, semantic support or publication eligibility.

Use caller-supplied stable proposal ID and proposed-at time, a tagged new/update event target, and optional investigation ID. Validate update targets against the exact context candidate-event pair. Pass investigation lineage to the repository for its persisted request/checkpoint checks. Persist abstentions as empty-claim drafts with their unresolved fields; create no event or publication row.

## Allowed paths

- `apps/worker/src/layers/l2-model-grounding/reasoning-proposal-bridge.ts`
- `apps/worker/test/l2-reasoning-proposal-bridge.test.ts`
- `apps/worker/package.json` — test command registration only
- `docs/assignments/L2-PROPOSAL-REASONING-BRIDGE-CORE-HANDOFF.md`

Root owns the plan, backlog and ADR. Do not change model prompts/contracts, source access, retrieval, DB schema/roles, public API, publication policy/writer, L3 ledger/coordinator state/budgets, runtime bindings, dependencies, or project configuration. Stop and report any mismatch that would require one of those changes.

## Acceptance and verification

Use authored synthetic fixtures and a recording/fake `EventProposalRepository`. Cover a proposed result, an abstention, every non-success capability status with no repository call, exact mapping of all evidence relations and time precision, stable ordered claim IDs, representable model-run metadata, `under_review` labels, support-only origin derivation and deterministic origin ordering, missing/ambiguous origin rejection, persisted-context mismatch, conflict mismatch, exact update target acceptance/rejection, caller-supplied identity/time preservation, investigation-ID pass-through, malformed outcomes and content-free errors. Confirm no provider call or publication side effect. Do not claim semantic quality.

Run in WSL Ubuntu-26.04 with existing dependencies (Node 24.21.0/npm 11.19.0; include `/home/perry/.nvm/versions/node/v24.21.0/bin` in `PATH`). If this worktree lacks `node_modules`, a temporary symlink to `/mnt/d/Projects/RPL/node_modules` is allowed and must be removed before handoff. Run `node --import tsx --test --test-concurrency=1 apps/worker/test/l2-reasoning-proposal-bridge.test.ts`, `npm test`, `npm run typecheck`, `npm run build` (Vite/Wrangler dry-run only), and `git diff --check <assigned-base>..HEAD`. Record actual runtime versions, counts and results; commit implementation/test and handoff on the assigned branch. Root reviews and accepts separately.
