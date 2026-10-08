# SYNTHETIC-PUBLICATION-ISOLATION-PGLITE-CORE — prove synthetic drafts stay private

- **Status:** Accepted locally on `main` at root merge `d7568a833b861b8dc867ac8c1a0f421ce3af9b48`.
- **Backlog ID:** `SYNTHETIC-PUBLICATION-ISOLATION-PGLITE-CORE`
- **Depends on:** L1 fixture processing/extraction persistence; `RAG-CORE`, `RAG-ACCESS-01`, L2 context assembly/persistence/direct reasoning/proposal persistence/bridge; `PUB-01-MANUAL-GATE-PGLITE-CORE`; `API-PUBLIC-DETAIL-RUNTIME-CORE`; `DB-TEST-RUNNER-ISOLATION`.
- **Requirements:** FR-03/05/06/07/08/09/13; NFR-01/05/07.
- **Architecture:** Test-only L1 → L2 → private proposal → L4/public-read isolation composition.
- **Exact base:** `931ebef205166dd273e507ba3fe397c16309338d`.
- **Branch/worktree:** `work/SYNTHETIC-PUBLICATION-ISOLATION-PGLITE-CORE` at `/mnt/d/Projects/RPL/.codex-build/worktrees/synthetic-publication-isolation-pglite-core`.
- **Contracts:** Existing schema 2.0 dataset-kind separation, private proposal, manual-gate, publication writer and public detail DTO remain unchanged.

## Objective

Compose accepted local components in a disposable PGlite database to prove an authored synthetic report can be persisted and grounded into a private draft while remaining invisible to the live-only manual publication reader and public event-detail view.

## Required behavior

- Persist one in-memory authored synthetic report using the real L1 fixture pipeline and deterministic injected extraction adapter.
- Use real L2 retrieval, exact-span assembly, refs-only context persistence, deterministic reasoning double and private proposal bridge. Keep report revision and proposal in dataset `synthetic`; label proposed evidence `under_review`.
- Invoke the real strict L4 proposal reader/manual gate without moderator identity or approval. It must return `proposal_not_found`, never invoke the SQL writer, and preserve exact snapshots across the publication tables.
- Read the synthetic-only event identity through the existing public detail runtime with its least-privilege public-reader role and verify the existing not-found envelope; prove the public role cannot read private report content.
- Explicitly preserve the boundary: do not copy or retag synthetic data as live, invent a reviewer, or claim successful publication. This negative-path test does not exercise the moderator-selected public evidence-label rule.

## Scope

- **Allowed implementation paths:** `apps/db/test/synthetic-publication-isolation-composition.test.ts` and `docs/assignments/SYNTHETIC-PUBLICATION-ISOLATION-PGLITE-CORE-HANDOFF.md`.
- Root owns this assignment, backlog status, architecture documents, delivery log, and checkpoint.
- No production code, migration, grant, public API/OpenAPI/DTO, dependency, source/provider, authentication, runtime, external service or deployment change is allowed.

## Acceptance and verification

- One auto-discovered sequential PGlite test exercises the real synthetic L1/L2 path, live-only L4 read denial, no-write publication oracle and public-reader not-found behavior.
- Verify authored values and exact evidence lineage; assert no event or publication writes and no private content in the public response.
- In `/mnt/d/Projects/RPL/.codex-build/worktrees/synthetic-publication-isolation-pglite-core` under WSL Ubuntu-26.04, run `node --import tsx --test --test-concurrency=1 apps/db/test/synthetic-publication-isolation-composition.test.ts`, `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check 931ebef205166dd273e507ba3fe397c16309338d..HEAD`, using existing Node `24.21.0` and npm `11.19.0` only. Record actual results in the handoff.
- Commit only the assigned test and handoff on the task branch. Do not merge or push.

## Stop conditions

Stop and report to root if any positive publication path would require changing the synthetic/live boundary, if a moderator identity is needed, or if the test requires production/schema/grant/contract changes or external services. Do not substitute a permissive mock for the strict live-only reader or public role. Do not escalate models without an attempted Luna/max solution and a substantive unresolved technical difficulty.

## Root review and acceptance

The implementation branch was `work/SYNTHETIC-PUBLICATION-ISOLATION-PGLITE-CORE`, based on `931ebef205166dd273e507ba3fe397c16309338d`, in its dedicated worktree. Root integrated it in merge `d7568a833b861b8dc867ac8c1a0f421ce3af9b48`, preserving agent implementation commit `7082fea9d3c2a02751878d8702872bae82f255fc` (`test(SYNTHETIC-PUBLICATION-ISOLATION): prove synthetic draft isolation`) and handoff commit `03202442da2ee618de9d675bb517947a7cf9dd05` (`docs(SYNTHETIC-PUBLICATION-ISOLATION): record PGlite handoff`). The only agent branch paths were the allowed new PGlite test and handoff.

Peer review found no actionable issues. Root independently reran the focused composition (**1/1**) before merge. After integrating both current test branches, root passed the full WSL workspace `npm test` (web, Worker **451**, DB **44/44 files**, casebook/evaluation **19/19**), `npm run typecheck`, `npm run build` (Vite production output and Wrangler **4.137.0** dry-run), and `git diff --check 931ebef205166dd273e507ba3fe397c16309338d..HEAD`. The agent passed all assigned checks on final source: focused composition, `npm run db:test` (**44/44 files**), full `npm test`, typecheck, build and assigned-base diff check. A typecheck-only closure fix was followed by these final-source checks.

This test proves negative-path isolation in disposable PGlite only. It does not test successful publication, reviewer identity, factual quality, source rights, hosted Neon behavior, configured provider use, or production route wiring. The moderator-selected label policy remains enforced by its separate accepted L4 slice; this test does not exercise that policy. No migration, grant, public API, dependency, production code, or configuration changed.
