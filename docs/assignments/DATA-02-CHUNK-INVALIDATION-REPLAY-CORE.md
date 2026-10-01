# DATA-02-CHUNK-INVALIDATION-REPLAY-CORE — Preserve invalidated chunk generations

- **Status:** Ready after embedding persistence integration; not assigned
- **Agent:** GPT-6 Luna / max
- **Branch/worktree/base:** Root selects a clean dedicated worktree at dispatch.
- **Dependencies:** DATA-02-CORE, DATA-02-EMBEDDING-PERSIST-CORE, RAG-CORE; ADR-035
- **Requirements:** FR-03/05/13; NFR-01/05/07
- **Contracts:** Existing EvidenceChunkRepository input/result and schema 2.0; public API unchanged

## Objective and boundaries

Read SOFTWARE_DEVELOPMENT_PLAN.md first, this backlog item, ADR-035, the chunk repository/tests, embedding repository/tests and retrieval eligibility checks. Fix the root-confirmed stale retry: an invalidated old chunk set currently returns to active and invalidates a newer set through `ON CONFLICT SET status = 'active'`.

Apply tombstone and revision-state guards in the actual atomic persistence statement, not only a preliminary lookup. Reject incoming invalidated IDs and any chunker version already invalidated for the exact dataset/revision, including new IDs with that old version. Require unreviewed/eligible revisions. Preserve the current complete-set, hash/span, lineage and active-replay rules. Guard failure must write nothing and invalidate nothing. Keep historical chunk/run/vector rows; do not reactivate invalidated embedding runs or mutate report revisions.

No generation order is inferred from version text. Genuinely new versions remain allowed; true multi-session ordering remains unverified. Use the current fixed policy error for rejected atomic writes or a bounded redacted equivalent; do not reveal source text or raw provider errors. Preserve repository contracts and existing L1 permissions.

## Allowed paths

- `apps/db/src/evidence-chunks.ts`
- `apps/db/test/evidence-chunks.test.ts`
- `apps/db/test/embedding-runs.test.ts` — stale generation/chunk/embedding composition only
- `docs/assignments/DATA-02-CHUNK-INVALIDATION-REPLAY-CORE-HANDOFF.md`

No migration, grants, schema, dependencies, runtime, provider calls, source access, UI/API/auth, publication, deployment, purchase, merge, push or further agents. Root owns plans/ADR/backlog. Report missing paths/decisions before expanding scope; continue independent checks.

## Acceptance and verification

Under L1 with authored synthetic rows, prove active identical replay succeeds; re-chunking to a new generation invalidates older chunks/runs and preserves vectors; old-set replay and a new ID with an invalidated version are denied; a mixed stale/new set leaves no partial writes/status changes; unreviewed/eligible revisions work and quarantined/superseded/retracted do not; dataset scoping and exact lineage remain enforced. Compose actual embedding persistence and retrieval after rejected replay to show the current generation remains usable and old content cannot become current support. No semantic-quality or hosted-concurrency claim.

Use WSL Ubuntu-26.04 and existing dependencies only. Run focused chunk/embedding tests, `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build` (dry-run only), and assigned-base `git diff --check`. Commit coherent changes on the assigned branch. Return branch/worktree/base, exact SHAs/messages, paths, behavior, actual checks with versions/counts/failures, limits and configuration impact. Root sets final acceptance.
