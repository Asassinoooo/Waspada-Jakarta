# PUB-WRITE-CORE — Manual publication transaction

- **Status:** Accepted (local implementation; root review complete)
- **Depends on:** DATA-01, SPEC-02, PUB-POLICY-CORE, ADR-013
- **Requirements:** FR-08/13; NFR-01/05/07
- **Branch/worktree:** `work/PUB-WRITE-CORE`; `.codex-build/worktrees/pub-write-core`
- **Owner:** GPT-6 Luna Max implementation agent; root plans and reviews

## Objective

Add a local Layer 4 persistence operation that atomically stores a moderator-approved publication decision and its complete event/impact version set. The operation enforces exact current-version and idempotency checks and appends a minimal outbox event. It is not an HTTP endpoint, login system, source connector, or quality evaluation. Source/data rights remain pending.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md`, Sections 4, 6, 7 and 10
- `ARCHITECTURE.md`, Sections 6 and 7
- `docs/IMPLEMENTATION_BACKLOG.md`
- `docs/DOMAIN_MODEL.md`, Sections 4, 8 and 9
- `docs/decisions/ADR-003-domain-publication-evidence.md`
- `docs/decisions/ADR-013-publication-write-transaction.md`
- `docs/assignments/PUB-POLICY-CORE.md`
- `docs/contracts.schema.json`, `docs/contracts.examples.json`
- `apps/db/migrations/001_foundation.sql`, `apps/db/migrations/002_acquisition_jobs.sql`
- `apps/db/src/sql.ts`, `apps/db/src/ports.ts`, `apps/db/src/queue.ts`
- `apps/db/test/harness.ts` and existing migration/persistence/queue tests

## Required behavior

- Implement a typed Layer 4 write command over a transaction boundary. Validate all command fields consumed by the writer at runtime, including closed record shapes, dataset, event target, decision/reviewer data, claim dispositions, evidence references, impact references, and version relationships. Never trust TypeScript types or caller-supplied model confidence as authorization.
- Accept only `dataset_kind: live` and a trusted caller's explicit authorized moderator approval with a non-empty publishable claim set. Require every included public claim to have a `publish` disposition; held/rejected claims stay out of the new event version. The writer does not authenticate the actor; document that the trusted L4 caller must obtain identity and authorization from MOD-01 when that boundary exists. Do not expose this operation through the current public or moderator routes.
- For a new event, require a null expected base version and version 1. For an update, compare the supplied event ID/base version with the current database version inside the transaction and require exactly base+1. A stale or duplicate version returns a stable typed conflict and persists no rows.
- Validate each published claim's support evidence relation and IDs against its same-dataset proposal/retrieval-backed stored references and publication decision. Contradiction/context rows remain separate. All origin and geometry references must already exist in the same dataset. Every impact must name the new event/version and be referenced exactly once; its supporting claim IDs must be among the included published claims.
- Persist the decision, per-claim dispositions and evidence, event version, claims and relations, impact versions and relations, and audit record atomically. Keep all records append-only. Add a dataset-scoped idempotency receipt keyed by caller key and canonical request fingerprint: identical replays return the original decision/event/version, while a key reused for a different payload fails without writes.
- Insert one minimal outbox row in the same transaction for a committed event version. It may contain event ID, version, a bounded event kind, trace/reference ID and occurrence time; it must not contain source text, claims, evidence spans, hashes, credentials, or raw `record_json`. No delivery or retry worker is included.
- Use the existing `waspada_l4_publication_writer` role for this operation, with only its required reads and inserts. Migration 005 must not add `UPDATE`, `DELETE`, broad table reads, or privileges for L1/L2/public roles. Preserve the existing source-policy, trace/audit and acquisition-job grants used by accepted work; document that this shared role is not suitable for HTTP wiring until a dedicated narrower runtime role replaces it. Test the writer under `SET ROLE` and verify denied publication mutations and unrelated reads.
- Use only authored local synthetic/live-shaped records. Clearly mark every `live` dataset marker as a test fixture, not actual live data or source/reviewer rights. Do not create real reports, sources, moderator accounts, credentials or permission decisions.
- Do not change API/OpenAPI/domain contracts, L2 policy behavior, source permissions, model/provider calls, routes, UI, dependencies, package lockfiles, cloud configuration, or remote services. Do not alter migrations 001–004; add a forward-only migration if needed.

## Allowed paths

- `apps/db/migrations/005_publication_write_receipts_outbox.sql`
- `apps/db/src/publication-writer.ts`
- `apps/db/src/sql.ts` — only if a minimal transaction runner contract is needed
- `apps/db/test/publication-writer.test.ts`
- `apps/db/test/harness.ts` — only to adapt local PGlite transaction tests
- This assignment's implementation handoff only

Root owns ADRs, architecture, backlog, API composition, source-rights decisions, and any contract changes. If the existing schema or role cannot support an atomic writer within these paths, report the exact gap before broadening scope.

## Acceptance and checks

- Tests prove that absent/unauthorized/manual-review inputs, historical/synthetic datasets, empty publishable claims, malformed references, orphan/mismatched impacts, and invalid new/update version pairs fail closed.
- Tests verify successful create/update writes, same-key/same-payload replay, same-key/different-payload conflict, stale concurrent-style retries, rollback after a failure partway through writes, append-only behavior, and one outbox row per event version.
- Tests prove the idempotency receipt and outbox are written atomically with publication rows and contain no raw claims/evidence/private payload. Execute the actual writer under `SET ROLE waspada_l4_publication_writer`; verify required column access and denied unrelated reads/writes.
- In WSL Ubuntu-26.04 run `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`. Report that PGlite tests do not prove independent hosted PostgreSQL/Neon transactions.
- Commit coherent work on the assigned branch with descriptive messages, leave a clean worktree, and append actual changes, checks, limitations and unresolved decisions here. Do not push or merge.

## Implementation handoff

The implementation agent appends branch/worktree, exact commit SHAs/messages, changed paths, behavior, actual WSL checks, limitations and scope issues. Root reviews and accepts before integration.

### Implementer handoff — 2026-09-25

- **Branch/worktree:** `work/PUB-WRITE-CORE`; `D:\Projects\RPL\.codex-build\worktrees\pub-write-core`.
- **Implementation commit:** `3889e756194cd9c4451a1009334bb9c8c4e475e7` — `feat(PUB-WRITE-CORE): persist approved publications atomically`.
- **Implementation paths:** `apps/db/migrations/005_publication_write_receipts_outbox.sql`, `apps/db/src/publication-writer.ts`, `apps/db/src/sql.ts`, `apps/db/test/harness.ts`, `apps/db/test/migrations.test.ts`, and `apps/db/test/publication-writer.test.ts`. Root approved the narrow `migrations.test.ts` extension to register migration 005 and update migration/version counts.
- **Behavior:** Added a transaction-scoped writer for an explicitly approved publication in the configured `live` namespace. It validates closed command and stored proposal shapes, exact event and impact versions, same-dataset retrieval-backed evidence, origins and geometries, and impact geometry against supporting claims. It atomically appends decisions, event/claim/impact versions and relations, audit, a dataset-scoped idempotency receipt, and a payload-minimal outbox row. Identical requests replay the original receipt; changed payloads and stale versions return stable conflicts. Exact/date/range time scopes enforce endpoint and ordering rules, including mixed date/datetime range comparison at midnight UTC. Runtime inputs remain trusted-caller data: authentication/authorization and source-rights decisions are outside this slice.
- **Migration and grants:** Migration 005 adds append-only receipt/outbox tables. It replaces broad L4 SELECT on publication input tables with the columns read by this operation, retains the selected source-registry columns used by `SourceRegistryRepository.findById`, and grants the receipt/outbox reads/inserts needed by the writer. Root-approved namespace guard and synthetic-namespace regression are included. Existing shared-role source-policy UPDATE, trace/audit, and acquisition-job grants remain intact as previously accepted behavior. The L4 role therefore still has privileges beyond this writer; a future dedicated publication runtime role should separate publication persistence from source-policy, trace-management, and queue operations if those privileges need removal.
- **Checks:** In WSL Ubuntu-26.04 with Node v24.21.0, `npm run db:test` passed (50/50); `npm test` passed (web 5, worker 52, db 50, evaluation 12); `npm run typecheck` passed; `npm run build` passed (Vite build and Wrangler dry-run); and `git diff --check` passed. The WSL worktree's `.git` pointer contains a Windows absolute path, so the final diff check supplied explicit `--git-dir` and `--work-tree` paths. A temporary `node_modules` symlink to the root dependencies was removed after checks.
- **Limitations and pending decisions:** Fixtures are authored synthetic/live-shaped test records only; their `live` marker does not assert real material, source rights, or reviewer rights. Source/data rights remain pending. The trusted caller must later obtain identity and authorization from MOD-01. PGlite tests do not prove independent hosted PostgreSQL/Neon transaction and concurrency behavior. No API/auth/routes, external source access, contract/schema changes outside migration 005, dependency or lockfile changes, or cloud configuration were added. Root review and acceptance are recorded below.

### Root review — accepted 2026-09-25

Root reviewed both task commits and merged `work/PUB-WRITE-CORE` into `main` as `b2fb994`. The root-approved scope extension to `apps/db/test/migrations.test.ts` is limited to registering migration 005 and its expected migration counts. Root independently ran WSL Ubuntu-26.04 checks with Node.js `v24.21.0` and npm `11.19.0`: `npm run db:test` passed 50/50; `npm test` passed 119/119 (web 5, Worker 52, DB 50, evaluation 12); `npm run typecheck`, `npm run build` (Vite production build and Wrangler dry-run), and `git diff main...HEAD --check` passed. The WSL Git check used explicit `GIT_DIR`/`GIT_WORK_TREE` because the linked worktree pointer contains a Windows path.

Acceptance is for the local synthetic implementation only. Source/data rights remain pending; no real source material, reviewer account or authorization was created. The shared L4 role retains accepted privileges for other services, so a dedicated narrower runtime role and MOD-01 authorization are required before this writer is exposed through a route. PGlite does not establish hosted Neon transaction behavior.
