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
