# DATA-02-EMBEDDING-GENERATION-CORE — validated embedding-to-storage pipeline

- **Status:** Assigned for local implementation
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
