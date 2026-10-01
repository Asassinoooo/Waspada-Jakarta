# RAG-GROUNDED-PROPOSAL-ROUNDTRIP-CORE — Verify synthetic grounding through private draft persistence

**Status:** Assigned; implementation and root acceptance pending  
**Implementation model:** GPT-6 Luna, max reasoning  
**Base:** Root dispatch commit; exact SHA will be supplied in the assignment message  
**Branch:** `work/RAG-GROUNDED-PROPOSAL-ROUNDTRIP-CORE`  
**Worktree:** `C:\Users\perry\.codex\worktrees\rag-grounded-proposal-roundtrip-core\RPL` (`/mnt/c/Users/perry/.codex/worktrees/rag-grounded-proposal-roundtrip-core/RPL` in WSL)

## Objective

Add a PGlite integration test for the already-implemented local RAG path: retrieve eligible synthetic evidence; rehydrate the exact selected span; assemble a typed Layer 2 request; persist its reference-only grounding context before reasoning; pass that context to a fixed synthetic reasoning double; and map the successful typed outcome to the canonical private proposal repository. This closes a verification gap between individually tested Layer 2 components. It adds test coverage only and does not claim model, source, or production-runtime quality.

## Architectural and product boundaries

- Layer 1 data preparation and persistence, Layer 2 retrieval/grounding, and private proposal storage remain separate existing components. Do not add an agent loop or move preprocessing into an orchestrator.
- Retrieve and ground persisted evidence before calling the reasoning capability. The test double runs locally and deterministically; do not invoke a model/provider, network service, source, or external API.
- Keep the stored grounding context refs-only. Exact report text may enter the in-memory reasoning request only after the exact-span reader rehydrates the matching persisted range.
- The bridge may write only an immutable schema 2.0 private draft through the existing proposal repository. It must not create or alter public events, publication decisions, outbox records, lifecycle state, or moderation state.
- Use authored `synthetic` fixtures only. Do not add source rights assumptions or claim the fixture is historical/live data.
- Preserve exact source/evidence references, offset units, event time, origins, conflicts and model identity through the typed path. Keep publication authorization with deterministic Layer 4 services.

## Dependencies and contracts

Dependencies are accepted `DATA-01`, `RAG-CORE`, `RAG-ACCESS-01`, `RAG-CONTEXT-ASSEMBLY-CORE`, `L2-CONTEXT-PERSIST-CORE`, `L2-DIRECT-REASONING-CORE`, `L2-PROPOSAL-PERSIST-CORE`, `L2-PROPOSAL-REASONING-BRIDGE-CORE`, `L2-TIME-PRECISION-CORE`, and `DB-TEST-RUNNER-ISOLATION`.

Use the current schema 2.0 grounding-context and proposal contracts, existing repository ports/roles, and existing typed model-capability interfaces. No contract, API, schema, migration, dependency, permission, production runtime, provider, or source changes are allowed.

## Required checks

At minimum, the integration test must demonstrate:

1. Only persisted, approved/eligible synthetic evidence with a deterministic embedding is returned by the existing retrieval repository for the requested candidate.
2. The selected reference is rehydrated from the exact persisted text span; a text excerpt is absent from the persisted grounding-context row.
3. The context is persisted before the synthetic reasoning capability is invoked. The test should observe this ordering through repository/database state at the call boundary.
4. The capability receives the matching typed context and returns a fixed successful result whose support references resolve only to that context.
5. The reasoning bridge writes one private schema 2.0 proposal with exact evidence/origin linkage and preserved time/model metadata. Exact retry must not duplicate the proposal, claims, or evidence links.
6. No public event, publication decision, audit/publication outbox row, or moderator action is created by proposal generation.
7. An insufficient context is still persisted but short-circuits before the reasoning capability; it creates no proposal.

Keep the test focused on one bounded direct-reasoning success path and the insufficient-context stop path. Do not add an end-to-end agent investigation loop or publication scenario.

## Allowed paths

- `apps/db/test/rag-grounded-proposal-roundtrip.test.ts`
- `docs/assignments/RAG-GROUNDED-PROPOSAL-ROUNDTRIP-CORE-HANDOFF.md`

The database test runner discovers `*.test.ts` automatically; do not change package scripts or other test paths. If existing helpers cannot support the objective within these paths, stop and report the smallest required path extension before editing elsewhere.

## Verification

Use WSL Ubuntu-26.04 with the existing dependency installation and Node `v24.21.0` / npm `11.19.0`. Run the focused test, full `npm test`, `npm run typecheck`, `npm run build` (Vite production output and Wrangler dry-run only), and `git diff --check <assigned-base>..HEAD`. Do not install dependencies or use Windows-host project runtimes. Record the exact counts and outcomes for every check.

Commit coherent implementation and handoff changes on the assigned branch. The handoff must include the exact base, branch/worktree, commit SHAs/messages, changed paths, behavior, checks actually run, limitations, and any remaining decision. Remove temporary dependency links before handoff. Do not merge or push; root reviews and integrates.

## Stop conditions

Stop and ask the primary orchestrator if the integration requires a production coordinator, a public/persisted contract change, a schema/migration/grant change, a live source/provider, or a publication/moderation write. Do not broaden the assigned test-only scope. Do not escalate models unless a GPT-6 Luna/max attempt makes and documents a substantive unresolved technical attempt.
