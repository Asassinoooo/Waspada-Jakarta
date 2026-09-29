# L3-SYNTHETIC-L1L2-ROUNDTRIP-CORE — verify the synthetic L1/L2 refresh path

**Parent package:** AGENT-01 / FR-05 and FR-07
**Status:** Assigned for implementation on an isolated task branch
**Implementation model:** GPT-6 Luna, max reasoning
**Branch:** `work/L3-SYNTHETIC-L1L2-ROUNDTRIP-CORE`
**Worktree:** Dedicated managed worktree, based on the full commit containing this assignment; do not edit in the root checkout.
**Contract baseline:** Schema 2.0 `GroundingContext`, `ExtractionResult`, and investigation records; internal investigation plan 1.0; existing L1 fixture, L2 retrieval/context assembly, and L3 coordinator ports. Do not change public or persisted contract versions.
**Dependencies:** `L3-COORDINATOR-CORE`, `L1-FIXTURE-RUNNER-CORE`, `L1-EXTRACTION-REPLAY-CORE`, `RAG-CONTEXT-ASSEMBLY-CORE`, `L2-CONTEXT-PERSIST-CORE`, `L3-LEDGER-CORE`, `DB-TEST-RUNNER-ISOLATION`.

## Objective

Extend the existing PGlite coordinator composition test so one bounded investigation advance exercises the established cross-layer return path using only authored synthetic material: a registered test action invokes the existing Layer 1 fixture pipeline through real SQL repositories; Layer 2 retrieves the persisted report evidence, rehydrates exact spans, assembles and persists a refs-only context; the context returns through the coordinator refresh port and is tied to the same case before progress is recorded.

This is integration evidence for the existing layer contracts. It does not implement or claim a production source-dispatch runtime.

## Allowed paths

- `apps/db/test/investigation-ledger.test.ts`
- `docs/assignments/L3-SYNTHETIC-L1L2-ROUNDTRIP-CORE-HANDOFF.md`

Do not change production code, schemas/contracts, migrations, repositories, package scripts, dependencies, APIs/OpenAPI, source registration, providers, credentials, routes, Worker/Workflow runtime, deployment configuration, publication behavior, or root-owned planning documents. If the existing contracts cannot prove the exact report and context identity within these test-only paths, stop and report the smallest missing interface rather than expanding scope or weakening validation.

## Required behavior

1. Use the existing PGlite test harness and real SQL repositories for the Layer 1 report/evidence/extraction/job writes, Layer 2 retrieval and context persistence, and Layer 3 ledger/fingerprint state. Apply the checked-in migrations; do not mock the SQL repositories under test.
2. Use only an in-memory, explicitly synthetic fixture catalog and injected deterministic planner/extractor doubles. No network access, live source, real model, or provider is permitted. Keep the event, dataset, trace, candidate, report revision, evidence reference, and context identities stable and explicitly matched across layers.
3. Have one registered test action process at most one fixture through the existing L1 fixture pipeline. Its output references must identify the exact authored synthetic report/revision that the subsequent L2 query consumes. Do not let the coordinator inspect or process raw report text.
4. In the refresh port, use the returned output reference and case identity to retrieve persisted evidence with the existing Layer 2 repository, rehydrate the selected exact span(s) with the exact-span reader, assemble a schema 2.0 reasoning request, and persist the refs-only context with the existing context persister. Return that exact persisted context to the coordinator.
5. Assert source provenance and the distinct report/event/retrieval timestamps survive the L1/L2 boundary; assert the persisted context points only to exact evidence references and contains no excerpt text; assert the coordinator records or returns the new context for the same dataset, trace, candidate, and event; assert no event/publication record is created.
6. Make no sufficiency or factuality claim about the authored fixture. Any sufficiency flag used to reach a coordinator branch must be an explicit test input, not a model-quality result.
7. Preserve current retry, reservation, and budget guarantees. The coordinator performs at most one planner call, one action, and one refresh; an exact replay does not re-run L1 or L2 or duplicate persisted records.

## Acceptance criteria

- Focused test proves the ordered path: synthetic action → persisted L1 output → L2 retrieval → exact-span read → persisted L2 context → coordinator checkpoint/progress.
- Assertions show exact dataset/trace/candidate/report/context identity, exact span/hash/relation provenance, distinct timestamps, refs-only durable context, one L1 job completion, and no publication writes.
- Replay or stale checkpoint cases do not execute the fixture pipeline a second time.
- No production files or interfaces change; fixtures and model outputs are clearly synthetic test data.
- WSL Ubuntu-26.04 checks pass: focused `apps/db/test/investigation-ledger.test.ts`, `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD`.

## Stop conditions and handoff

Stop if the available L1 result/queue contract cannot bind an exact report/revision to the returned action reference, if L2 cannot read the persisted fixture under the existing roles, or if completion requires a production-contract change. Report the concrete failing identity/invariant and do not replace it with a mock or looser assertion.

Commit the work on this branch in coherent, descriptive commits. Do not merge, push, provision/configure external resources, or edit root planning files. Handoff must state worktree, base, commit SHA(s) and exact messages, changed paths, behavior, WSL commands and results, runtime versions, limitations, migration/configuration impact, and remaining decisions. Root owns review, acceptance, integration, and task status.
