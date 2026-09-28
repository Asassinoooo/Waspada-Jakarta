# L1-EXTRACTION-RESULT-PERSIST-CORE — persist typed extraction candidates

- **Backlog ID:** `L1-EXTRACTION-RESULT-PERSIST-CORE`
- **Objective:** Add a least-privilege, append-only database repository for validated schema 2.0 `ExtractionResult` records, resolving their evidence references to exact persisted evidence rows.
- **Dependencies:** `DATA-01`, `L2-ADAPTER-01`, `L1-EVIDENCE-RELATION-ALIGN-CORE`, `DB-TEST-RUNNER-ISOLATION`.
- **Requirements:** `FR-03/04/05/06`; `NFR-01/05/07`.
- **Layer:** L1 persistence boundary for candidate output produced by the fixed L2 extraction adapter. This slice does not call a model or establish semantic correctness beyond the existing validated extraction contract.
- **Contract:** Keep schema version `2.0`, the existing `ExtractionResult` record shape, current `extraction_results` and `extraction_evidence` tables, and the four `EvidenceRelation` values unchanged. Do not add provider identity to the schema 2.0 record; model identity remains in its `model_run` contract.
- **Branch/worktree:** `work/L1-EXTRACTION-RESULT-PERSIST-CORE` in `C:\Users\perry\.codex\worktrees\l1-fixture-runner-core\RPL` (`/mnt/c/Users/perry/.codex/worktrees/l1-fixture-runner-core/RPL` in WSL), based on the pushed `main` commit containing this assignment. Verify the reused checkout is clean, then create/select the task branch before editing. Do not edit through the root checkout.
- **Owner:** GPT-6 Luna Max implementation agent. Root plans, independently reviews, integrates, and pushes.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md`, then `docs/IMPLEMENTATION_BACKLOG.md` and this assignment
- `docs/DOMAIN_MODEL.md`, `docs/contracts.schema.json`, `apps/worker/src/layers/l2-model-grounding/contracts.ts`, and its extraction output validator
- `apps/db/src/ports.ts`, `apps/db/src/grounding-contexts.ts`, `apps/db/src/sql.ts`, migration 001, migrations 006 and 010, and their PGlite tests

## Required behavior

1. Add a typed `ExtractionResultRepository` to the existing database ports. Persist a closed schema 2.0 record into the existing extraction tables; do not introduce a Worker-to-database dependency cycle.
2. Validate the complete persisted record envelope and bounded nested fields before SQL. Require the normalized table columns and record JSON to agree on dataset, trace, candidate, report revision, and category. Reject unknown top-level or nested fields, duplicate evidence identities, unsupported categories/relations, malformed tags, invalid scopes/times, and invalid model-run metadata.
3. Verify the referenced report revision exists in the same dataset and that its permitted-text hash matches. Resolve every evidence reference using its full identity: dataset, report revision, text hash, code-point offsets, offset unit, and relation. Preserve `supports`, `contradicts`, `updates`, and `context` distinctly. Never create or repair evidence references in this repository.
4. Enforce the existing extraction contract's support invariant: if the extraction proposes a category, tags, known event time, or non-empty scope, at least one exact linked reference must have relation `supports`. The repository records candidate extraction only; it does not mark evidence true, establish source independence, create an Event, or authorize publication.
5. Implement transactional create-or-verify semantics. An identical retry returns success without duplicate evidence links. Reuse of a candidate ID with any record or link drift returns a stable typed conflict. Missing parent/evidence references return typed errors; failures roll back the parent and every link.
6. Add a forward-only migration that grants `waspada_l1_pipeline` only the column-level `SELECT` needed to verify existing extraction rows and their evidence links on retry. Preserve existing insert grants and deny update/delete and unrelated-column reads. Test the real repository with `SET ROLE waspada_l1_pipeline` and assert the privilege boundary.
   Update migration-history expectations in `apps/db/test/migrations.test.ts` and `apps/db/test/public-event-updates.test.ts` to account for version 018 while preserving their earlier-version and ordering assertions.
7. Use authored synthetic PGlite fixtures only. No live source text, real model calls, acquisition, Worker route, HTTP, scheduler, or event/publication writes.

## Allowed paths

- `apps/db/src/ports.ts`
- `apps/db/src/extraction-results.ts` (new)
- `apps/db/migrations/018_l1_extraction_result_verification.sql` (new)
- `apps/db/test/extraction-results.test.ts` (new)
- `apps/db/test/migrations.test.ts` (migration-history expectations for 018 only)
- `apps/db/test/public-event-updates.test.ts` (018 history expectation for the version-016 ordering scenario only)
- This assignment's implementation handoff only

Do not edit L2 model behavior, extraction prompts/provider selection, API/OpenAPI/DTOs, Worker runtime, public contracts, other migrations, source/provider settings, deployment configuration, package manifests/lockfiles, or unrelated task documentation. Keep changes to the two named migration test files limited to migration-history fixture filters, expected ordered version lists/counts, and later-version assertions required by migration 018. Add no dependency or cloud configuration.

## Verification

In WSL Ubuntu-26.04 using Node `v24.21.0` and npm `11.19.0`, record dependency/tool versions at implementation start and run:

- Focused: `node_modules/.bin/tsx --test apps/db/test/extraction-results.test.ts`
- `npm run db:test`
- `npm test`
- `npm run typecheck`
- `npm run build`
- `git diff --check`

Required cases include valid multi-reference persistence; all four relations; exact same-dataset and text-hash checks; empty/unknown extraction; unsupported or ungrounded proposed fields; closed-schema rejection; idempotent retry; candidate/link drift conflict; missing evidence; rollback on link failure; and actual L1-role success plus denied unrelated access and writes. Do not run the DB suite concurrently with other PGlite suites.

## Stop conditions

Stop and report the exact issue if schema 2.0 cannot represent the validated result without a contract change, the existing L1 role boundary cannot support the exact-column verifier without broad grants, or local PGlite cannot verify the required transaction semantics. Do not weaken the schema, add broad access, fabricate live/model evaluation, or expand the task. Escalate to GPT-6 Astra xhigh only after a GPT-6 Luna Max attempt fails on a substantive technical difficulty.

## Implementation handoff

Append branch/worktree, commit SHAs and exact messages, changed paths, behavior, WSL checks and results, migration/privilege impact, limitations, and unresolved decisions. Commit implementation and handoff separately on this task branch. Do not push or merge; root reviews and integrates.

## Completed implementation handoff

- **Branch/worktree:** `work/L1-EXTRACTION-RESULT-PERSIST-CORE` at `C:\Users\perry\.codex\worktrees\l1-fixture-runner-core\RPL` (`/mnt/c/Users/perry/.codex/worktrees/l1-fixture-runner-core/RPL` in WSL).
- **Implementation commit:** `51fb012fb0645dd30740603c578dce0c8df373c9` — `feat(db): persist validated L1 extraction results`.
- **Handoff commit:** `fc03e97f7941cd5c4d8cbf44213e6f654225faa9` — `docs(L1-EXTRACTION-RESULT-PERSIST-CORE): record implementation handoff`.
- **Implementation paths:** `apps/db/src/ports.ts`, `apps/db/src/extraction-results.ts`, `apps/db/migrations/018_l1_extraction_result_verification.sql`, and `apps/db/test/extraction-results.test.ts`.
- **Root-authorized migration-fixture extensions:** `apps/db/test/migrations.test.ts` and `apps/db/test/public-event-updates.test.ts` now treat migration 018 as later than their legacy baselines. The original assertions remain; expected migration lists and applied counts include 018 where appropriate.
- **Behavior:** Adds a closed schema 2.0 L1 extraction-result repository and port. It validates bounded record/nested fields before SQL; requires a same-dataset report revision and matching permitted-text hash; resolves full evidence identities without creating or repairing evidence; preserves all four relations; enforces the supports invariant for proposed fields; and transactionally creates or verifies immutable candidate rows and exact evidence links. Identical retries succeed, while candidate or link drift returns a typed conflict. Missing references and failed link writes produce typed errors and rollback. The synthetic PGlite tests exercise the real `waspada_l1_pipeline` role and deny unrelated reads and writes.
- **Tool/dependency versions recorded at implementation start:** WSL Ubuntu-26.04, Node `v24.21.0`, npm `11.19.0`, TypeScript `7.0.2`, tsx `4.23.15`, PGlite `0.5.8`, PGlite pgvector `0.0.9`, PGlite PostGIS `0.2.8`, pg `8.16.3`, and Wrangler `4.137.0`. `npm ci --no-audit --no-fund` installed the existing lockfile dependencies in this worktree; no package or lockfile changed.
- **Checks:** Focused `./node_modules/.bin/tsx --test apps/db/test/extraction-results.test.ts` passed 8/8 after the final type-name correction. `npm run db:test` passed 21/21 files after the authorized 018 migration-fixture updates. `npm test` passed web 60/60, worker 293/293, DB 21/21, and casebook 12/12; that full run preceded the final compile-time-only type-name correction, after which the focused suite, `npm run typecheck`, and `npm run build` were rerun successfully. The final `npm run typecheck` passed all workspace and evaluation configurations. The final `npm run build` exited 0, including Vite production build and Wrangler dry-run. WSL `git diff --check` exited 0; staged diff check also passed. Git emitted only its CRLF-to-LF working-copy notices.
- **Migration/access impact:** Forward-only migration 018 changes no schema or API contract. It removes table-wide SELECT from the L1 pipeline on the extraction tables, revokes the prior exact-column reads, then grants only the columns required to verify candidate rows and linked evidence on retry. Existing INSERT grants remain; UPDATE/DELETE and unrelated-column reads remain denied. No configuration or dependency changes are required.
- **Limitations and remaining decisions:** This slice persists the existing validated extraction output; it adds no provider/model call, live-source acquisition, Worker route, or publication behavior. Schema/API remain at 2.0, with no contract changes or broad grants. Root review and integration remain pending. The worktree `.git` pointer contains a Windows absolute gitdir that WSL Git cannot resolve directly; no worktree metadata was changed. WSL Git commands used `GIT_DIR=/mnt/d/Projects/RPL/.git/worktrees/RPL2` and `GIT_WORK_TREE=/mnt/c/Users/perry/.codex/worktrees/l1-fixture-runner-core/RPL`. At handoff, the task branch is two local commits ahead and two commits behind `origin/main`; do not push or merge from this branch.

### Root review and acceptance — 28 September 2026

Root reviewed both commits and independently passed `npm run db:test` (21/21 DB files), `npm run typecheck`, `npm run build` including Vite and Wrangler dry-run, and `git diff --check` in WSL Ubuntu-26.04. The implementation and handoff were cherry-picked to `main` as `ebb6605` and `27b6ae0`. The full `npm test` passed on the branch before a final compile-time-only type-name correction; focused extraction tests, workspace typecheck, and build were rerun after that correction. Hosted Neon behavior and runtime composition remain unverified.
