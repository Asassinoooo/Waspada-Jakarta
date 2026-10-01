# DATA-02-EMBEDDING-PERSIST-CORE — Atomic embedding persistence

- **Status:** Ready after scheduled-runtime integration; not assigned
- **Agent:** GPT-6 Luna / max
- **Branch/worktree/base:** Root will select a clean dedicated managed worktree at dispatch.
- **Dependencies:** DATA-01, DATA-02-CORE, RAG-CORE, RAG-ACCESS-01; ADR-034
- **Requirements:** FR-03/05/06; NFR-01/05/07
- **Contracts:** Closed schema 2.0 EmbeddingRun; existing SqlTransactionRunner, chunks and retrieval identities; public API unchanged

## Scope

Read SOFTWARE_DEVELOPMENT_PLAN.md first, assigned backlog row, ADR-034, schema EmbeddingRun/EvidenceChunk, DOMAIN_MODEL.md, evidence-chunks.ts, evidence-retrieval.ts, extraction-results.ts, sql.ts, and existing L1/L2 grants. Implement the real persistence repository in ADR-034; no embedding invocation or duplicated retrieval policy.

Validate the closed metadata, IDs/hashes, explicit calendar-valid RFC3339 time, provider/model/index bounds, dataset, 1–2048 dimensions and finite numeric vector before SQL. Reject float32 overflow and cosine vectors that become zero after storage conversion. Accept one available run per call, with vector separate from the schema record. Use bounded errors without input or raw exception content.

Use a transaction-capable executor. Validate exact persisted chunk hash/span against immutable permitted text/hash and same-dataset trace. Serialize run identity and lock the chunk before inserting metadata and vector together. New runs need active chunks and unreviewed/eligible revisions. Same metadata/time/vector in storage representation is a replay; changed input fails without changing either table. Database failure rolls back both inserts. Invalidated runs/chunks stay invalidated; exact invalidated replay may report unavailable, while failed/missing/mismatched prior vectors fail closed. Do not repair prior rows, update earlier identity/vector, or grant revision-state updates. Reindexing requires a new ID.

Migration 022 adds only exact column-level L1 verification reads, preserving current write/status grants. No role membership, credential, table/index, API/schema, provider or runtime change. Register the repository port only if needed.

## Allowed paths

- `apps/db/src/embedding-runs.ts`
- `apps/db/src/ports.ts` — repository type/factory registration only if needed
- `apps/db/migrations/022_l1_embedding_verification_reads.sql`
- `apps/db/test/embedding-runs.test.ts`
- `apps/db/test/migrations.test.ts` and `apps/db/test/public-event-updates.test.ts` — staging/inventory assertions only for 022
- `docs/assignments/DATA-02-EMBEDDING-PERSIST-CORE-HANDOFF.md`

Root owns plans/ADRs/backlog. Report conflicts, missing identity, additional grants/paths before changing scope; continue unrelated checks. No dependencies, live content/model calls, cloud/source activation, publication, Worker/UI/auth, deployment, purchase, merge, push or additional agents.

## Acceptance and handoff

PGlite tests use authored synthetic vectors/chunks. Prove atomic writes, float32-aware replay, changed-input rejection, dataset isolation, hash/span/state validation, vector/dimension mismatch, overflow/NaN/infinity/zero-cosine rejection, and failed-second-write rollback. Compose with real chunk invalidation and RAG semantic retrieval: matching identity can use the persisted vector; incompatible identity or stale/invalidated content cannot. Verify under L1; unrelated readers gain no grants. No semantic quality/source-rights claim.

Use WSL Ubuntu-26.04 and existing Node24.21.0/npm11.19.0/dependencies only. Root supplies exact branch/base/worktree and WSL Git override. Temporary node_modules link is allowed, remove before handoff. Run focused tests, `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD`. Record actual versions/counts/failures. Commit coherent changes on the assigned branch and return exact SHAs/messages, paths, behavior, checks, limits, migration/config impact and decisions. Independent PostgreSQL/Neon and real semantic evaluation remain unverified.
