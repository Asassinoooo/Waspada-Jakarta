# L1-EVIDENCE-RELATION-ALIGN-CORE — schema 2.0 evidence relations

- **Status:** Accepted on `main` at merge `7dd8ea7`
- **Depends on:** DATA-01, DATA-02-CORE, L2-ADAPTER-01
- **Requirements:** FR-03/05/07; NFR-01/07
- **Branch/worktree:** `work/L1-EVIDENCE-RELATION-ALIGN-CORE`; `.codex-build/worktrees/l1-evidence-relation-align-core`
- **Owner:** GPT-6 Luna Max implementation agent; root plans and reviews
- **Decision:** [ADR-016](../decisions/ADR-016-evidence-reference-relation-alignment.md)

## Objective

Make local evidence-reference persistence and retrieval accept all four relation values already defined by the closed schema 2.0 `EvidenceRef`: `supports`, `contradicts`, `updates`, and `context`. Preserve each value exactly so downstream assessment can distinguish them. This is a storage representation fix; it does not change what counts as claim support.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md`
- `docs/IMPLEMENTATION_BACKLOG.md`
- `ARCHITECTURE.md`
- `docs/DOMAIN_MODEL.md`
- `docs/decisions/ADR-011-l2-grounding-reader.md`
- `docs/contracts.schema.json` and `docs/contracts.examples.json` — `EvidenceRef.relation`
- `docs/decisions/ADR-016-evidence-reference-relation-alignment.md`
- `docs/assignments/DATA-01.md` and `docs/assignments/L2-ADAPTER-01.md`
- `apps/db/migrations/001_foundation.sql` and all later evidence-reference migrations
- `apps/db/src/ports.ts`, `apps/db/src/evidence-retrieval.ts`
- `apps/db/test/persistence.test.ts`, `apps/db/test/evidence-retrieval.test.ts`, and `apps/db/test/migrations.test.ts`
- `apps/worker/src/layers/l2-model-grounding/contracts.ts`
- `apps/worker/src/layers/l4-application-integration/publication-policy.ts` and its existing `updates` coverage

## Required behavior

- Add migration `009` that forward-updates only the `evidence_references.relation` check constraint to accept all four schema 2.0 values. Leave migration 001 and existing rows untouched; migration application and reapplication must be transactional and repeatable.
- Extend `apps/db/src/ports.ts` `EvidenceRelation` to exactly match the existing schema 2.0 enum. Ensure repository input and retrieval results preserve `updates` without remapping it to `supports`, `contradicts`, or `context`.
- Test an `updates` reference through the L1 persistence repository under the existing L1 role, including its stable natural-key retry behavior. Test retrieval preserves `updates` under `waspada_l2_grounding_reader`.
- Verify migration tests assert the four accepted values and exclude unrelated values; reapply the migration to prove idempotency. Refresh any test that explicitly records the latest migration version, without changing its behavior assertions.
- Keep downstream meaning unchanged: the L4 publication policy must still fail closed if it cannot use `updates` as claim support. Do not modify L4 code or reinterpret the relation.
- Use synthetic fixtures only. Do not modify schema 2.0, OpenAPI, public API, providers, sources, source rights, or model prompts.

## Boundaries

- **Allowed paths:** `apps/db/migrations/009_evidence_reference_updates_relation.sql`, `apps/db/src/ports.ts` (relation type only), `apps/db/test/migrations.test.ts`, `apps/db/test/persistence.test.ts`, `apps/db/test/evidence-retrieval.test.ts`, `apps/db/test/investigation-ledger.test.ts` (latest-migration expectation only), and this assignment's implementation handoff.
- **Forbidden:** edits to migration 001, L4 publication policy behavior, Worker model contracts, public schemas/OpenAPI, retrieval ranking/filter semantics, new dependencies, external data, credentials, hosted service configuration, or deployment.
- Do not grant new privileges or alter the L1/L2 roles.

## Acceptance and checks

- Synthetic PGlite tests show all four allowed values persist and retrieve exactly, `updates` idempotency keeps the original reference identity, invalid values are rejected, the L1/L2 roles remain unchanged, and migration reapplication passes.
- Existing policy tests continue to prove that an `updates` relation alone cannot satisfy publication support.
- In WSL Ubuntu-26.04 run `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`. The sequential database launcher must report every file once.
- Add no dependencies or lockfile changes. Commit implementation and handoff separately on this branch, leave it clean, and report exact paths, commands/results, commit SHAs, and limitations. Do not push or merge.

## Handoff

### Implementation handoff — 26 September 2026

- **Status:** Root reviewed and accepted on `main` at merge `7dd8ea7`.
- **Branch/worktree:** `work/L1-EVIDENCE-RELATION-ALIGN-CORE`; `D:\Projects\RPL\.codex-build\worktrees\l1-evidence-relation-align-core` (`/mnt/d/Projects/RPL/.codex-build/worktrees/l1-evidence-relation-align-core` in WSL).
- **Commits:** `34ecb04665f019f4ab1f8e266f505f9f80b4f9e5` — `fix(L1-EVIDENCE-RELATION-ALIGN-CORE): preserve updates evidence references`; `9b8f20ad3f318fa3cbacb029ac62ec262cbb31b8` — `docs(L1-EVIDENCE-RELATION-ALIGN-CORE): record implementation handoff`; integrated at root merge `7dd8ea7c5d540a56a1b4436f456b5f678ff6e9a1`.
- **Implementation paths:** `apps/db/migrations/009_evidence_reference_updates_relation.sql`, `apps/db/src/ports.ts`, `apps/db/test/migrations.test.ts`, `apps/db/test/persistence.test.ts`, `apps/db/test/evidence-retrieval.test.ts`, and `apps/db/test/investigation-ledger.test.ts`. Root explicitly authorized the final test file as a narrow addition to the allowlist: it updates only the latest migration inventory assertion from 008 to 009, since 009 is now the last migration.
- **Behavior:** Migration 009 replaces only the evidence-reference relation check constraint with the existing schema 2.0 four-value enum. Tests seed existing three-value rows before migration and prove their identities and fields remain unchanged; a synthetic failing migration proves the transaction rolls back both the constraint change and ledger entry. The migration accepts `supports`, `contradicts`, `updates`, and `context`, rejects an unrelated value, and is safely reapplied inside a transaction. L1's `EvidenceRelation` now matches that enum. Under `waspada_l1_pipeline`, repository writes preserve `updates`, and a stable-natural-key retry returns the original evidence reference ID and trace. Under `waspada_l2_grounding_reader`, retrieval returns each relation unchanged, including `updates`. Role attributes and evidence relation privileges are snapshotted and remain unchanged. Existing L4 policy tests continue to pass with `updates` unable to satisfy claim support.
- **Runtime/dependencies:** WSL Ubuntu-26.04, native Node.js `v24.21.0`, npm `11.19.0`, Git `2.53.0`. The existing locked test harness uses PGlite `0.5.8`, PGlite PostGIS `0.2.8` (experimental), and PGlite pgvector `0.0.9`; no dependencies or lockfiles changed.
- **Checks:** `npm run db:test` — passed, all 9 DB files once (70 tests); `npm test` — passed, including 5 web, 62 Worker, 70 DB, and 12 casebook tests; `npm run typecheck` — passed; `npm run build` — passed (Vite production build and Wrangler deploy dry-run only); `git diff --check` — passed in WSL with the worktree Git metadata paths set explicitly. `git diff --cached --check` also passed before the implementation commit.
- **Migration/configuration impact:** Forward-only migration 009; no schema 2.0, OpenAPI, public API, Worker contracts, L4 policy, database roles or grants, source settings, runtime configuration, dependencies, or deployment changes. No live source or hosted service was used.
- **Limitations/remaining decisions:** PGlite verifies local migration and repository behavior only; hosted PostgreSQL/Neon migration behavior and concurrency remain unverified. No implementation decisions remain; independent root review and integration are pending.

The implementation agent records branch/worktree, commits and messages, changed paths, actual WSL results, and limitations. Root independently reviews and accepts before integration.
