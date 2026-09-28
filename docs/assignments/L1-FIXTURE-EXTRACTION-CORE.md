# L1-FIXTURE-EXTRACTION-CORE — persist candidates through the synthetic L1 pipeline

- **Backlog ID:** `L1-FIXTURE-EXTRACTION-CORE`
- **Objective:** Extend the existing synthetic moderator-submission pipeline to call only the fixed Layer 2 extraction capability and persist its validated schema 2.0 candidate through the accepted extraction-result repository before acknowledging the queue job.
- **Dependencies:** `L1-FIXTURE-PIPE-CORE`, `L1-EXTRACTION-RESULT-PERSIST-CORE`, `L2-ADAPTER-01`, `L1-EVIDENCE-RELATION-ALIGN-CORE`, `DB-TEST-RUNNER-ISOLATION`.
- **Requirements:** FR-02/03/04/05/06; NFR-01/05/07.
- **Layer:** Layer 1 workflow with one injected, fixed Layer 2 extraction capability. No L3 investigation or L4 publication.
- **Contract:** Preserve schema/API version 2.0, the existing L2 `ExtractionResult`, all four `EvidenceRelation` values, and the accepted DB repository. Do not write Events, proposals, public versions, or model/provider identity into fields outside the existing model-run contract.
- **Branch/worktree:** `work/L1-FIXTURE-EXTRACTION-CORE` in the reusable, now-free `C:\Users\perry\.codex\worktrees\l1-fixture-runner-core\RPL` worktree (`/mnt/c/Users/perry/.codex/worktrees/l1-fixture-runner-core/RPL` in WSL), based on the pushed `main` commit containing this assignment. Verify it is clean and select the new task branch before editing. Never edit through the root checkout.
- **Owner:** GPT-6 Luna Max implementer; root plans, independently reviews, integrates and pushes.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md`, `ARCHITECTURE.md`, `docs/IMPLEMENTATION_BACKLOG.md`, then this assignment
- `docs/contracts.schema.json` and `docs/DOMAIN_MODEL.md`
- `apps/worker/src/layers/l1-data-knowledge/synthetic-fixture-pipeline.ts` and its worker test
- `apps/worker/src/layers/l2-model-grounding/contracts.ts`, `adapter.ts`, and `validation.ts`
- `apps/db/src/extraction-results.ts`, `ports.ts`, and `apps/db/test/synthetic-fixture-pipeline.test.ts`
- The accepted `L1-FIXTURE-PIPE-CORE` and `L1-EXTRACTION-RESULT-PERSIST-CORE` assignments and handoffs

## Required behavior

1. Add an explicit caller-authored stable `candidateId` to each synthetic report manifest. Do not derive it from parser feature IDs, submitted URLs, source values, or model output.
2. Inject only the existing `ModelCapabilityAdapter.extract` capability plus a structural extraction-result persistence port into the L1 fixture processor. Keep Worker code free of DB runtime imports and workspace dependency changes. Provide no default mock, API key, live model or tool access.
3. After the exact report revision and its prepared permitted text exist, submit the manifest's candidate ID and exact report text/hash to Layer 2. Treat only a `succeeded` validated adapter outcome as an extraction record. Empty synthetic collections must not call the adapter.
4. Persist every returned exact evidence identity through the existing evidence-reference port, preserving `supports`, `contradicts`, `updates`, and `context`. Map only the validated L2 fields into the closed snake-case schema 2.0 `ExtractionResult` envelope: use the leased job trace and `synthetic` dataset, convert model-run fields, and omit the adapter-only provider property. Then call the injected repository's `createOrVerify`.
5. Do not complete the job until all extraction evidence links and the extraction result have persisted. Map provider-unavailable/transient failures to a retryable bounded queue failure and malformed adapter output to a permanent bounded failure. Return only fixed codes; never include text, URLs, provider output, or exception messages. Existing stable IDs and create-or-verify writes must make retries converge after partial persistence.
6. Keep event truth, source independence, evidence quality, source approval, investigation sufficiency, event creation and publication outside this pipeline. Extraction proposes candidate fields; it does not validate their truth.

## Acceptance tests

- Worker tests prove fixed-adapter input and output mapping, stable candidate IDs, all four relation values, call ordering after report creation, provider omission, no extraction for empty input, and safe queue behavior for unavailable, invalid, and persistence-failure outcomes.
- PGlite integration invokes the real L1 pipeline under `SET ROLE waspada_l1_pipeline` with an authored synthetic provider double and the accepted `createRepositoryPorts().extractionResults`. It verifies one exact persisted candidate, report/hash/evidence links, all four relations where applicable, and queue completion only after success; no Event or publication row is written.
- Retry after a persistence/acknowledgement interruption leaves one candidate and exact links; a failed or malformed extraction does not mark the job completed. No source fetching, model network call, timer, scheduler, API or cloud resource is used.
- Hosted Neon multi-session behavior remains explicitly unverified.

## Allowed paths

- `apps/worker/src/layers/l1-data-knowledge/synthetic-fixture-pipeline.ts`
- `apps/worker/test/synthetic-fixture-pipeline.test.ts`
- `apps/worker/test/synthetic-fixture-runner.test.ts` — root-authorized, narrowly scoped fixture and mock updates required by the new non-empty extraction contract; no runner behavior expansion.
- `apps/db/test/synthetic-fixture-pipeline.test.ts`
- This assignment's implementation handoff only

### Root-authorized scope adjustment

On 28 September 2026, root authorized updating `apps/worker/test/synthetic-fixture-runner.test.ts` because its typed fixture and port mocks construct non-empty `SyntheticReportManifest` and `FixturePipelinePorts` values. The required stable candidate ID and injected extraction/persistence ports make those values invalid without this test-only adjustment. Keep the change limited to fixture IDs, fake adapter/repository behavior, and assertions needed to retain the existing runner behavior; do not add runner functionality.

Do not modify database migrations or repository implementation, model prompts/provider selection, public contracts/API/OpenAPI, Worker routes or bindings, queue schema, other tasks' files, dependency manifests/lockfiles or deployment configuration. Add no dependencies. Do not use live source or model services.

## Verification

In WSL Ubuntu-26.04 using Node `v24.21.0` and npm `11.19.0`, record relevant package versions and run these checks sequentially where PGlite is involved:

- Focused: `node_modules/.bin/tsx --test apps/worker/test/synthetic-fixture-pipeline.test.ts apps/db/test/synthetic-fixture-pipeline.test.ts`
- `npm test --workspace=@waspada/worker`
- `npm run db:test`
- `npm test`
- `npm run typecheck`
- `npm run build`
- `git diff --check`

Use only authored synthetic fixtures and injected test providers. Do not run DB suites concurrently. Do not claim hosted integration or live model behavior from local tests.

## Stop conditions

Stop and report the exact contract or package-boundary issue if the existing L2 output cannot map to schema 2.0, if L1 cannot persist evidence references with all four relations under its existing least-privilege role, or if the real repository cannot be used in the scoped PGlite composition test. Do not weaken validation, broaden grants, alter the DB repository, change public contracts or expand the task. Escalate to GPT-6 Astra xhigh only after a GPT-6 Luna Max attempt fails on substantive technical difficulty.

## Implementation handoff

Commit implementation and handoff separately on this task branch. The handoff must include branch/worktree, both commit SHAs and exact messages, changed paths, behavior, actual WSL checks, schema/dependency/configuration impact, limitations and unresolved decisions. Leave the worktree clean; do not push or merge.
