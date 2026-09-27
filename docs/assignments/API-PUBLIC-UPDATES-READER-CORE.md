# API-PUBLIC-UPDATES-READER-CORE assignment

- **Status:** Accepted
- **Backlog ID:** `API-PUBLIC-UPDATES-READER-CORE`
- **Baseline:** `main` at `f653c36` plus the root planning commit that adds this assignment and ADR-026
- **Branch:** `work/API-PUBLIC-UPDATES-READER-CORE`
- **Worktree:** Use the dedicated managed worktree issued for this task; do not edit in the root checkout
- **Implementer:** GPT-6 Luna, max reasoning
- **Dependencies:** DATA-01; API-PUBLIC-HISTORY-READER-CORE; API-PUBLIC-HISTORY-REVIEW-METADATA-CORE; DB-TEST-RUNNER-ISOLATION; ADR-026
- **Contract baseline:** Schema 2.0 event versions; migration 014's append-only review decisions and current-public reviewed metadata view; public `HistoryEntry` fields unchanged. This DB-only assignment does not change OpenAPI or Worker behavior.
- **Allowed paths:** `apps/db/migrations/016_public_update_feed_order.sql`; new `apps/db/src/public-event-updates.ts`; new focused DB test for the reader/migration; migration-sequence expectations in `apps/db/test/migrations.test.ts`; this assignment's implementation handoff only.

## Objective

Add the data-layer foundation for a gap-free, globally ordered public update feed. Use ADR-026's transactional singleton counter to assign review-decision sequences in commit order, and expose a bounded reader of currently approved, current-public version changes. Keep ingestion, Layer 4 projection, HTTP, cursor cryptography, browser polling and all external services outside this task.

## Acceptance criteria

1. Migration 016 creates a private singleton counter, initializes it from committed review-decision rows, backfills their new `change_sequence`, adds a fail-closed insert trigger, and creates dedicated update-feed metadata/watermark views. The trigger increments the transactional row and holds its lock through transaction end; no `review_id`/timestamp ordering assumption is used.
2. The update-feed views expose only the watermark and approved current-public event/version key, `change_sequence`, change label, reviewed summary, and publication time; they omit `reviewer_id`. Only the public reader role receives `SELECT` on these views, with no direct review-table, counter-table, counter-function or sequence privilege. Preserve migration 014's existing `public_event_history_review_metadata` view and grant because the accepted history reader uses that internal provenance field; its Layer 4 projection already omits reviewer identity from the public `HistoryEntry` DTO. Do not change the existing history-reader contract in this task.
3. The reader accepts validated decimal-string lower and upper sequence bounds plus a bounded page size, reads only `change_sequence > after AND <= through`, returns ascending candidates with exact event/version identity, typed change label, reviewed summary, publication timestamp input and internal sequence, and probes one beyond the limit. It never serializes raw rows as an API DTO.
4. Candidate visibility joins the existing current-public history view, preserving the rule that latest withdrawal hides every version and every event update. Only the latest approved review decision per version is eligible; held or revoked latest decisions suppress older approvals.
5. Tests cover initial backfill, consecutive committed assignments, rollback atomicity, latest-review suppression, withdrawn-event exclusion, ordering, invalid bounds/result shapes, overflow probing, and least-privilege grants. Use only authored synthetic data.
6. No HTTP route, DTO/OpenAPI change, cursor signing, Worker wiring, model/source/provider integration, live data, dependency, secret, or deployment configuration is added.

## Verification

Run from WSL Ubuntu-26.04 at the repository root:

```sh
npm run db:test
npm run typecheck --workspace=@waspada/db
git diff --check
```

Report the focused test file and actual aggregate DB result. Do not claim hosted Neon behavior or simultaneous-transaction stress coverage unless actually exercised. Root will independently run the full workspace tests, typecheck and build before acceptance.

## Stop and handoff

If the existing review view/role model cannot support separate redacted update-feed views without changing a separate task's contract, stop and report the precise conflict. Do not modify another branch, push, deploy, introduce a new secret or broaden into projection/runtime work. Commit the complete work package on this task branch with descriptive messages and report branch, worktree, commit SHA/message, changed paths, checks/results, limitations, migration/configuration impact and remaining decisions. Root performs review and integration.
