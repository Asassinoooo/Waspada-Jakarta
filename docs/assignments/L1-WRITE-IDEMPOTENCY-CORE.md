# L1-WRITE-IDEMPOTENCY-CORE — Retry-safe report and evidence writes

- **Status:** Assigned
- **Depends on:** DATA-01, GEO-STORE-CORE
- **Requirements:** FR-02/03; NFR-05/07
- **Architecture:** Layer 1 immutable report/evidence persistence
- **Branch/worktree:** `work/L1-WRITE-IDEMPOTENCY-CORE`; `.codex-build/worktrees/l1-write-idempotency-core`
- **Owner:** GPT-6 Luna Max implementation agent; root plans and reviews

## Objective

Make the existing L1 `ReportRevisionRepository` safe to retry after a worker restart. Reusing the same caller-supplied `(dataset_kind, report_revision_id)` for an identical immutable record must succeed without adding a row; reusing it for different content must return a stable conflict. Evidence references currently receive a generated identity every time. Give an exact `(dataset_kind, report_revision_id, permitted_text_hash, span_start, span_end, offset_unit, relation)` one database-enforced identity and return the same ID on retries. This is the storage prerequisite for a later synthetic queue-to-fixture pipeline; it does not implement acquisition or choose source IDs.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md` — FR-02/03, NFR-05/07 and five-layer ownership
- `docs/IMPLEMENTATION_BACKLOG.md` — DATA-01, JOB-01, DATA-02-CORE and GEO-STORE-CORE
- `docs/DOMAIN_MODEL.md` — immutable revisions, evidence offsets and trace lineage
- `docs/assignments/GEO-STORE-CORE.md` — exact supporting-reference lookup and migration 006 grants
- `apps/db/src/ports.ts`, `apps/db/src/sql.ts`, current migrations and PGlite tests

## Required behavior

- Keep schema 2.0, public APIs and `NewReportRevision`/`NewEvidenceReference` input shapes unchanged. The caller owns stable `reportRevisionId` generation; this task must not derive IDs from unverified provider fields.
- Make revision creation race-safe using the existing dataset/revision primary key. Do not rely on a read-before-insert. Insert with conflict handling, then verify every typed immutable field and JSONB `record_json` against the exact supplied record. An identical replay is a no-op; any different payload for that ID returns a typed, stable `report_revision_conflict` error. Never update the existing row, including its original trace or retrieval timestamp.
- Add an append-only natural uniqueness rule for evidence references using dataset, report revision, text hash, exact code-point span, offset unit and relation. `trace_id` records the first creation trace and is not part of evidence identity; a replay under another trace returns the existing evidence ID without changing that row. Different spans, relations or datasets remain distinct.
- Add only migration `apps/db/migrations/007_l1_write_idempotency.sql`. Before adding uniqueness, fail clearly if duplicate natural evidence identities already exist; do not merge, delete, rewrite or choose among existing duplicates. Store no new text or provider data. Preserve the migration ordering/checksum behavior.
- Make evidence-reference creation safe under `SET ROLE waspada_l1_pipeline`: validate the referenced immutable revision hash and code-point span, perform an atomic insert-or-existing-ID lookup using the database uniqueness rule, and retain only the already-authorized column-scoped reads from migration 006. Do not widen any role grants.
- Add synthetic PGlite coverage for identical and conflicting revision retries, stable evidence IDs, relation/dataset separation, duplicate legacy-row migration refusal without row loss, and successful operations under the L1 role. Exercise parallel calls where useful but state that single-session PGlite cannot establish multi-session hosted PostgreSQL concurrency.
- Keep downstream geometry/chunk/event records immutable and untouched. Do not add queue orchestration, source adapters, generated model data, live acquisition, or API wiring in this package.

## Explicit exclusions

No network, live source content, provider/model call, new dependency, domain/API/OpenAPI contract change, data cleanup, cloud resource, credential, deployment, or paid service. A stable local retry result does not establish source rights, quality, hosted locking behavior or safe publication.

## Allowed paths

- `apps/db/src/ports.ts`
- `apps/db/test/persistence.test.ts`
- `apps/db/test/migrations.test.ts`
- `apps/db/migrations/007_l1_write_idempotency.sql` only
- This assignment's implementation handoff only

Root owns any broader contract, schema or privilege decision. If a safe identity or migration requires deleting/rewriting existing evidence or changing the schema contract, stop and report the exact blocker rather than expanding scope.

## Acceptance and checks

- Prove exact same-key revision retries do not add rows; changed text, hash, source, timestamps, statuses, trace or record JSON conflict without mutation.
- Prove identical evidence fields resolve to one stable ID across retries, while a different relation, span or dataset receives a distinct ID. Prove `trace_id` is preserved from first creation.
- Prove the uniqueness migration detects pre-existing duplicate evidence identities and leaves all rows untouched on failure.
- Under `SET ROLE waspada_l1_pipeline`, prove revision and evidence writes work while unrelated reads and update/delete remain denied; no grant outside 006 is added.
- In WSL Ubuntu-26.04 run `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build` and `git diff --check`. Record exact runtime versions and outcomes. Avoid running build concurrently with the PGlite suites if WSL memory pressure occurs.
- Commit coherent implementation and handoff changes separately on the assigned branch, leave a clean worktree and report commits, changed paths, actual checks, limitations and remaining decisions. Do not push or merge.

## Handoff

Append the implementation branch/worktree, exact commits/messages, paths, behavior, actual verification results, limitations, migration impact and unresolved decisions. Root reviews and accepts before integration.

### Implementation handoff — 25 September 2026

- Branch/worktree: `work/L1-WRITE-IDEMPOTENCY-CORE`; `D:\Projects\RPL\.codex-build\worktrees\l1-write-idempotency-core` (`/mnt/d/Projects/RPL/.codex-build/worktrees/l1-write-idempotency-core` in WSL).
- Implementation commit: `c333ecd1bbb2190a2d5d181ce20c9f951f007315` — `feat(L1-WRITE-IDEMPOTENCY-CORE): make report and evidence writes retry-safe`.
- Paths: `apps/db/src/ports.ts`, `apps/db/migrations/007_l1_write_idempotency.sql`, `apps/db/test/persistence.test.ts`, `apps/db/test/migrations.test.ts`, and `apps/db/test/geometry-writer.test.ts`. Root authorized the narrow geometry-test update to remove its now-impossible duplicate-evidence ambiguity fixture; no geometry writer behavior changed.
- Behavior: Report creation inserts against the existing dataset/revision key before comparing every stored typed immutable field and JSONB `record_json`; exact replays are no-ops, while changed payloads throw `ReportRevisionConflictError` with stable `code` and message `report_revision_conflict`. Evidence creation validates the referenced stored revision hash and Unicode code-point bounds, then uses the database natural key `(dataset_kind, report_revision_id, permitted_text_hash, span_start, span_end, offset_unit, relation)` to return the same identity on retry while preserving the first `trace_id`. Relation, span, and dataset variations remain distinct. Operations use the executor's transaction runner when available. L1 tests prove both writes work with existing privileges and that unrelated reads and revision/evidence update/delete remain denied.
- Verification in WSL Ubuntu-26.04 with Node `v24.21.0` and npm `11.19.0`: `npm run db:test` passed (60/60); `npm test` passed (web 5/5, Worker 52/52, DB 60/60, evaluation casebook 12/12); `npm run typecheck` passed; `npm run build` passed (Vite production build and Wrangler dry-run); `git diff --check` passed.
- Migration/configuration impact: additive migration `007_l1_write_idempotency.sql` first rejects any duplicate legacy natural evidence identities, then creates one unique index. A failure leaves the existing rows untouched and does not record migration 007. The migration adds no grants; migration 006's existing column-level reads remain the only extra L1 reads in scope. No dependency, API, schema contract, or live-source configuration changed.
- Limitations: validation uses authored synthetic PGlite fixtures. One authored fixture uses the `historical` dataset namespace only to prove dataset partitioning; it contains no real historical or live data. PGlite's single-session test harness does not establish hosted multi-session PostgreSQL/Neon concurrency or locking behavior. Local checks establish storage identity, retry, conflict, migration-failure, and privilege behavior only; they do not prove semantic evidence support, source rights, or factual accuracy.
- Remaining decisions: no implementation-scope decision is open. A hosted migration must stop if duplicate natural identities already exist; any remediation policy for such rows remains an operator/root decision. Root review and acceptance remain pending before integration.
