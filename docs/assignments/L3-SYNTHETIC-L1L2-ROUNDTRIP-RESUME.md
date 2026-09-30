# L3-SYNTHETIC-L1L2-ROUNDTRIP-RESUME — complete the synthetic L1/L2 return path

**Parent package:** AGENT-01 / FR-05 and FR-07  
**Status:** Assigned after acceptance of the RFC3339 retrieval adapter  
**Implementation model:** GPT-6 Luna, max reasoning  
**Branch:** `work/L3-SYNTHETIC-L1L2-ROUNDTRIP-RESUME`  
**Worktree:** `C:\Users\perry\.codex\worktrees\l3-coordinator-core\RPL` (`/mnt/c/Users/perry/.codex/worktrees/l3-coordinator-core/RPL` in WSL)  
**Base:** The root dispatch message identifies the exact `main` commit containing this assignment. Create the task branch from that commit before editing.  
**Contract baseline:** Schema 2.0 `GroundingContext`, `ExtractionResult`, and investigation records; internal investigation plan 1.0; existing L1 fixture, L2 retrieval/context assembly, and L3 coordinator ports. Do not change public or persisted contract versions.

## Dependencies

- Accepted `L3-COORDINATOR-CORE`, `L1-FIXTURE-RUNNER-CORE`, `L1-EXTRACTION-REPLAY-CORE`, `RAG-CONTEXT-ASSEMBLY-CORE`, `L2-CONTEXT-PERSIST-CORE`, `L3-LEDGER-CORE`, and `DB-TEST-RUNNER-ISOLATION`.
- Accepted `RAG-RETRIEVAL-TIMESTAMP-RFC3339-CORE` at `42c2f72`/`948d2a9`, which makes SQL evidence timestamps valid for the existing strict L2 request validator. Preserve that validator.
- The previous attempt's timestamp failure and unaccepted draft are documented in [the original handoff](L3-SYNTHETIC-L1L2-ROUNDTRIP-CORE-HANDOFF.md). This is a fresh branch and worktree assignment; do not reuse or amend that branch.

## Objective

Complete the original test-only PGlite composition objective in [L3-SYNTHETIC-L1L2-ROUNDTRIP-CORE](L3-SYNTHETIC-L1L2-ROUNDTRIP-CORE.md). In one bounded coordinator advance, an authored synthetic test action invokes the existing Layer 1 fixture pipeline through real SQL repositories; Layer 2 retrieves the persisted report evidence, rehydrates its exact span, assembles and persists a refs-only context; and the coordinator receives that exact context through its refresh port before recording progress for the same case.

The accepted UTC RFC3339 projection is the only production boundary correction in scope. This work must not claim or implement production source dispatch, a Cloudflare Workflow runtime, or model quality.

## Allowed paths

- `apps/db/test/investigation-ledger.test.ts`
- `docs/assignments/L3-SYNTHETIC-L1L2-ROUNDTRIP-RESUME-HANDOFF.md`

Do not change production code, schemas/contracts, migrations, repositories, package scripts, dependencies, APIs/OpenAPI, source registration, providers, credentials, routes, Worker/Workflow runtime, deployment configuration, publication behavior, or root planning documents. If the existing contracts cannot prove the exact report and context identity within the test-only path, stop and report the smallest missing interface rather than weakening validation or expanding scope.

## Required behavior

1. Use the existing PGlite harness and real SQL repositories for Layer 1 report/evidence/extraction/job writes, Layer 2 retrieval and context persistence, and Layer 3 ledger/fingerprint state. Apply checked-in migrations; do not mock the SQL repositories under test.
2. Use only an in-memory, explicitly synthetic fixture catalog and injected deterministic planner/extractor doubles. No network, live source, real model, or provider. Keep dataset, trace, candidate, report revision, evidence reference, and context identities stable and explicitly matched across layers.
3. Have one registered test action process at most one fixture through the existing L1 fixture pipeline. Its output references must identify the exact authored report/revision consumed by L2. The coordinator must not inspect or process raw report text.
4. In the refresh port, use the returned output reference and case identity to retrieve persisted evidence, rehydrate the selected exact span, assemble a schema 2.0 reasoning request using the strict validator, and persist the refs-only context. Return that exact persisted context to the coordinator.
5. Assert source provenance and distinct report/event/retrieval timestamps survive the L1/L2 boundary; context points only to exact evidence references and contains no excerpt text; coordinator records or returns the context for the same dataset, trace, candidate, and event; and no event/publication record is created.
6. Make no sufficiency or factuality claim about authored fixtures. Any sufficiency flag must be an explicit test input.
7. Preserve retry, reservation, and budget guarantees. The coordinator performs at most one planner call, one action, and one refresh; exact replay does not re-run L1/L2 or duplicate persisted records.

## Acceptance and verification

- The focused integration test proves synthetic action → persisted L1 output → L2 retrieval → exact-span read → persisted L2 context → coordinator checkpoint/progress.
- Assertions prove exact dataset/trace/candidate/report/context identity, span/hash/relation provenance, distinct timestamps, refs-only persistence, one completed L1 job, no publication writes, and replay without duplicate execution.
- Only the two allowed paths change; all fixtures/model outputs are labelled synthetic.
- Run in WSL Ubuntu-26.04: focused `apps/db/test/investigation-ledger.test.ts`, `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD`.

## Stop conditions and handoff

Stop if the available L1 result/queue contract cannot bind an exact report/revision to the returned action reference, L2 cannot read persisted fixture evidence under the existing roles, or completion requires a production-contract change. Report the concrete failing identity/invariant; do not replace it with a mock or looser assertion.

Commit on this task branch in coherent, descriptive commits. Do not merge, push, provision, configure external resources, or edit root planning files. Handoff must state branch/worktree, base, commit SHA(s) and exact messages, changed paths, behavior, WSL commands and results, runtime versions, limitations, migration/configuration impact, and remaining decisions. Root owns review, acceptance, integration, and task status.
