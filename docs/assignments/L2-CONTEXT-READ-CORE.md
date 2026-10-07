# L2-CONTEXT-READ-CORE — exact lookup of persisted grounding context

- **Status:** Accepted
- **Implementation model:** GPT-6 Luna, max reasoning
- **Branch:** `work/L2-CONTEXT-READ-CORE`
- **Worktree:** `.codex-build/worktrees/l2-context-read-core`
- **Base:** `b6f08575f9f448354b9acefce476158e7bc9f91d`
- **Contract baseline:** Internal schema 2.0 `GroundingContextRecord`; [ADR-015](../decisions/ADR-015-l2-grounding-context-persistence.md); existing `waspada_l2_grounding_writer` column grants from migration 010.
- **Dependencies:** `L2-CONTEXT-PERSIST-CORE`, `L2-CONTEXT-BRIDGE-CORE`, `RAG-CONTEXT-ASSEMBLY-CORE`, `DB-TEST-RUNNER-ISOLATION`.
- **Requirements:** FR-05/06/07; NFR-01/05/07.

## Objective

Expose a strict exact-key read for a canonical persisted grounding context through the existing Layer 2 repository and its current least-privilege role. Validate the immutable JSON record against normalized columns and every persisted evidence, event, and decision link before returning it. This lets a future L2 runtime rehydrate by `(dataset_kind, context_id)` while keeping source text out of the stored context and avoiding direct context-content access from L3.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md`
- `docs/IMPLEMENTATION_BACKLOG.md`
- `ARCHITECTURE.md`
- `docs/DOMAIN_MODEL.md`
- `docs/decisions/ADR-011-l2-grounding-reader.md`
- `docs/decisions/ADR-014-l3-investigation-ledger.md`
- `docs/decisions/ADR-015-l2-grounding-context-persistence.md`
- `apps/db/migrations/001_foundation.sql`
- `apps/db/migrations/008_l3_investigation_ledger.sql`
- `apps/db/migrations/010_l2_grounding_context_writer.sql`
- `apps/db/src/grounding-contexts.ts`, `apps/db/src/ports.ts`, `apps/db/src/sql.ts`, and `apps/db/test/grounding-contexts.test.ts`
- `apps/worker/src/layers/l2-model-grounding/contracts.ts` and `validation.ts`

## Required behavior

1. Add an exact read method to the existing `GroundingContextRepository`, keyed by the closed dataset enum and a validated context ID. Return `null` for an absent exact key; reject malformed input before issuing SQL.
2. Reconstruct and validate the closed schema 2.0 record from persisted `record_json`. Require exact agreement with normalized parent columns: dataset, context, trace, candidate, retrieval version, index version, and sufficiency value.
3. Read and compare every normalized relation set: evidence natural identities (including relation and exact span/hash), candidate event versions, and prior-decision IDs. Missing, duplicate, unexpected, malformed, cross-dataset, or mismatched links must fail closed with a stable typed error.
4. Keep the read in Layer 2 under the existing `waspada_l2_grounding_writer` capability. Use only existing column grants; do not add a migration, grant, role membership, direct L3 context-content read, or access to raw report text.
5. Preserve `createOrVerify` behavior and share validation/link-checking code where practical. Do not write, repair, update, or delete any row during reads.
6. Return only the validated canonical context record and its persisted identity. Do not log or include report text, excerpts, URLs, database diagnostics, prompts, or model output in errors or telemetry.

## Acceptance criteria

- Tests cover exact-key success, missing rows, same context ID in separate datasets, malformed requests with no SQL, strict closed-record validation, normalized-column drift, every relation-link mismatch/duplicate, and stable redacted errors.
- A real PGlite test executes the read under `SET ROLE waspada_l2_grounding_writer`, verifies all exact links, and proves the existing public, L1, L2 retrieval-reader, and L3 coordinator roles cannot use this path or read the full context record.
- Read operations leave all context and link rows unchanged. Existing create, identical replay, conflict, rollback, and append-only tests continue to pass.
- No contract, migration, grant, runtime, route, provider, source, dependency, lockfile, or deployment configuration changes.
- In WSL Ubuntu-26.04, pass the focused context test, `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD`. Report the Node/npm versions and actual results.

## Allowed paths

- `apps/db/src/grounding-contexts.ts`
- `apps/db/src/ports.ts` only if the existing repository interface/factory requires it
- `apps/db/test/grounding-contexts.test.ts`
- This file's **Implementation handoff** section only

Do not edit root-owned architecture, ADR, backlog, checkpoint, delivery log, public or internal schema files, migrations, Worker runtime, API, UI, package manifests, lockfiles, or unrelated tests. If the existing role lacks a required read privilege or the closed context contract cannot be checked within these paths, stop and report the exact gap to root.

## Implementation handoff

Implemented on branch `work/L2-CONTEXT-READ-CORE` in worktree `/mnt/d/Projects/RPL/.codex-build/worktrees/l2-context-read-core`, from assigned base `b6f08575f9f448354b9acefce476158e7bc9f91d` (worktree HEAD began at root planning commit `4d51450dabb38e133e19d3833e59e829ab93db0d`). Code commit: `9a1d1dd27f932270e17a0964852af2efb665074e` — `feat(L2-CONTEXT-READ): add strict grounding context rehydration`.

Changed paths: `apps/db/src/grounding-contexts.ts`, `apps/db/src/ports.ts`, and `apps/db/test/grounding-contexts.test.ts`. The SQL repository now performs an exact `(dataset_kind, context_id)` lookup, validates persisted schema 2.0 JSON against all normalized parent columns, and compares exact evidence, candidate-event-version, and prior-decision link sets with their same-dataset targets. Malformed requests fail before SQL; missing rows return `null`; corrupt JSON, identity drift, link drift, and storage failures use stable redacted read errors. Reads perform no writes. The SQL factory and `RepositoryPorts.groundingContexts` expose the required `GroundingContextReadRepository`; `GroundingContextRepository.findById` remains optional for source-compatible writer-only adapters. Existing `createOrVerify` behavior remains covered.

WSL Ubuntu-26.04 used Node `v24.21.0` and npm `11.19.0`. Actual checks:

- `./node_modules/.bin/tsx --test apps/db/test/grounding-contexts.test.ts` — exit 0, 14/14 passed on the committed implementation.
- `npm run db:test` — exit 0, 40/40 database test files passed. This run preceded only the final writer-interface compatibility typing change; the subsequent full test run exercised the updated tree.
- `npm test` — exit 0 on the updated tree: web 60/60, Worker 440/440, database 40/40 files, evaluation 19/19.
- `npm run typecheck` — exit 0 on the updated tree.
- `npm run build` — exit 0 on the updated tree, including Vite production build and Wrangler dry-run.
- `git diff --check b6f08575f9f448354b9acefce476158e7bc9f91d..HEAD` — exit 0. The task-only diff from `4d51450dabb38e133e19d3833e59e829ab93db0d` contains the three allowed code/test paths above plus only this Implementation handoff section.

The PGlite test reads under `SET ROLE waspada_l2_grounding_writer`, verifies exact persisted links, and compares context/link snapshots before and after the read. Public, L1, L2 retrieval-reader, and L3 coordinator roles fail closed through this read path and cannot select `record_json`. Existing grants were sufficient. No migration, grant, role, runtime, API, provider, dependency, lockfile, or deployment configuration changes were needed. No known implementation limitation or remaining design decision; do not merge or push.
