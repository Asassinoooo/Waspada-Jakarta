# DATA-02-EMBEDDING-GENERATION-CORE — validated embedding-to-storage pipeline

- **Status:** Accepted after root review; implementation merged to `main` at `0c4e618`
- **Backlog ID:** `DATA-02-EMBEDDING-GENERATION-CORE`
- **Implementation model:** GPT-6 Luna, max reasoning
- **Branch:** `work/DATA-02-EMBEDDING-GENERATION-CORE`
- **Worktree:** `.codex-build/worktrees/data-02-embedding-generation-core`
- **Assigned base:** `ff7de506c3d4f9833956e9d0bcb850a0e328273a` (`docs(DATA-02): pin embedding generation base`)
- **Requirements:** FR-03/04/05/06; NFR-01/02/05/07
- **Dependencies:** `DATA-02-CORE`, `DATA-02-EMBEDDING-PERSIST-CORE`, `L2-ADAPTER-01`, `RAG-CORE`, `DB-TEST-RUNNER-ISOLATION`
- **Contracts:** Schema 2.0 `EvidenceChunkInput` and `EmbeddingRun`; existing `ModelCapabilityAdapter.embed` and `EmbeddingRunRepository`; public API unchanged

## Objective

Connect an already prepared, persisted evidence chunk to the existing validated L2 embedding capability and the existing atomic L1 embedding repository. Keep model invocation behind the injected `ModelCapabilityAdapter`; routine tests use a deterministic synthetic provider double only. This fills the local embedding-generation gap without selecting a real provider, activating live data, or claiming semantic quality.

## Required behavior

1. Add a small L1 generation runner that accepts one closed request containing `datasetKind`, a stable caller-supplied `traceId`, `embeddingRunId`, and `createdAt`, and an exact `EvidenceChunkInput` from the existing L1 chunker.
2. Validate the run identity and timestamp before invoking L2. Project the L1 chunk to the exact L2 embedding request fields; never pass source/report text as instructions or add L1-only fields to the L2 contract.
3. Invoke `ModelCapabilityAdapter.embed` once. Preserve its typed unavailable, invalid-request, provider-error, and invalid-output outcomes as bounded results; do not persist anything unless L2 returned a validated success.
4. Map the validated embedding result to the existing closed schema 2.0 `EmbeddingRunRecord`, carrying the exact provider/model/index/dimension/metric/text-hash identity, and pass the vector separately to `EmbeddingRunRepository.createOrVerify`.
5. Map repository creation, exact replay, invalidated/unavailable, and fixed repository failures to closed outcomes. Never expose vectors, chunk text, connection/SQL details, or raw exceptions. A changed vector or metadata under a reused run identity remains a conflict; do not repair or overwrite it.
6. Require the caller to reuse the exact run identity and `createdAt` on retry. Do not add a retry loop, clock/random ID generation, queue/scheduler, Worker binding, L3 invocation, or publication path.
7. Prove with authored synthetic PGlite fixtures that the real L2 adapter, runner, existing L1 repository, and existing semantic retrieval reader compose correctly under the current L1 role. Provider work must happen before database persistence begins. Verify exact replay, invalid output/no write, unavailable provider/no write, persistence conflict, and invalidated chunk non-resurrection; confirm unrelated publication rows stay unchanged.

## Allowed paths

- `apps/worker/src/layers/l1-data-knowledge/embedding-generation.ts` (new)
- `apps/worker/test/embedding-generation.test.ts` (new; run directly as a focused test, no `package.json` edit)
- `apps/db/test/embedding-generation-composition.test.ts` (new PGlite composition)
- `docs/assignments/DATA-02-EMBEDDING-GENERATION-CORE-HANDOFF.md` (new)

Do not modify model contracts, existing adapter validation, embedding persistence, migrations/grants/roles, package manifests/lockfiles, existing fixture pipelines, public contracts, API/UI, model/provider configuration, live source access, scheduled runtime, external services, or deployment configuration. Ask root if a contract, grant, or additional path appears necessary; continue unrelated assigned work where possible.

## Acceptance and verification

- Invalid request, absent provider, provider exception, or invalid model output creates no embedding row.
- Success writes one exact metadata/vector pair through the existing repository; identical retry replays without changing rows, changed output conflicts, and invalidated chunks remain unavailable.
- Retrieval sees only a compatible persisted vector for its exact chunk/model/index identity. Tests make no semantic-accuracy or provider-performance claim.
- Use WSL Ubuntu-26.04 and existing dependencies only. Record Node/npm and relevant package versions. Run the focused Worker test directly, focused PGlite composition, `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD`. Do not install dependencies or contact any external provider/service.
- Work only in the assigned worktree from the exact pinned base. Commit implementation/tests and handoff separately with descriptive messages. Do not merge or push. Handoff must identify branch/worktree/base, exact commits/messages, changed paths, behavior, actual check results, limitations, and migration/configuration impact.

## Stop conditions

Stop and report to root if the existing model adapter or L1 embedding repository cannot represent the required pipeline without changing a schema/API/DB role contract, if persistence cannot safely bind an embedding to the exact chunk identity, or if a real provider/key is required to pass the local tests. Do not invent provider results or semantic-quality claims. Escalate only after a GPT-6 Luna/max attempt documents a substantive technical blocker.

## Root review and acceptance — 5 October 2026

Root reviewed the isolated branch `work/DATA-02-EMBEDDING-GENERATION-CORE` from exact base `ff7de506c3d4f9833956e9d0bcb850a0e328273a` and merged it to `main` at `0c4e618142290a92f9c5705521f67365195f2387`. The merge preserves implementation commit `35e2ecd7bdb90885f8f43d5662a320ccebc2387b` (`feat(DATA-02): generate and persist validated embeddings`) and handoff commit `7276ef9ef98f4be180a0281a24e0fc6947e16876` (`docs(DATA-02): record embedding generation handoff`). The runner invokes the validated L2 embedding adapter before any L1 transaction, persists only successful results through the existing atomic repository, and returns closed outcomes for failures. Synthetic tests cover exact replay, changed-vector conflict, invalidated chunks, and retrieval compatibility.

Root independently passed the focused Worker test and PGlite composition test (**3/3 each**) and assigned-base `git diff --check` in WSL Ubuntu-26.04. The agent passed `npm run db:test` (**39/39 files**), full `npm test` (web **60/60**, Worker **431/431**, DB **39/39 files**, evaluation **12/12**), typecheck, and build (Vite production plus Wrangler dry-run). The accepted diff adds only its three assigned source/test files and handoff. No provider, migration, grant, public contract, dependency, runtime binding, live source, or deployment configuration was added. Tests make no semantic-quality or real-provider performance claim; hosted Neon and provider behavior remain unverified. See the [handoff](DATA-02-EMBEDDING-GENERATION-CORE-HANDOFF.md).
