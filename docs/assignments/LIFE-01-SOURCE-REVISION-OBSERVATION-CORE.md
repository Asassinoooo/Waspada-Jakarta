# LIFE-01-SOURCE-REVISION-OBSERVATION-CORE — persist publisher assertions

**Status:** Accepted on local `main` after root review; see the implementation and handoff commits below and the acceptance record in [DELIVERY_LOG.md](../DELIVERY_LOG.md).
**Backlog ID:** `LIFE-01-SOURCE-REVISION-OBSERVATION-CORE`
**Implementation model:** GPT-6 Luna, max reasoning
**Branch:** `work/LIFE-01-SOURCE-REVISION-OBSERVATION-CORE`
**Worktree:** `.codex-build/worktrees/life01-source-revision-observation-core` (WSL-compatible linked worktree)
**Contract baseline:** Schema 2.0 persisted report revisions; internal DB capability only; public API/DTOs unchanged.

## Context and dependencies

Read `AGENTS.md`, `SOFTWARE_DEVELOPMENT_PLAN.md`, `ARCHITECTURE.md`, `docs/DOMAIN_MODEL.md`, `docs/IMPLEMENTATION_BACKLOG.md`, ADR-005, ADR-032, ADR-042 and ADR-043, and the accepted L1 write-idempotency and LIFE-01 report-revision impact-reader assignments/handoffs before editing.

`report_revisions` are immutable and `revision_status` has legacy processing/eligibility states as well as source-change labels. A later publisher statement must not mutate the revision or overwrite its eligibility. Team 12 selected preserving the exact current published event version until moderator review. The impact reader can map one affected report revision to current published targets, but it does not validate the source change or create review state.

This slice creates the Layer 1 append-only storage boundary for explicit publisher assertions only. It does not calculate a winning/latest source state. No observation means `unknown`, not `current`. The later source-state resolver and Layer 2 retrieval gate are separate tasks; the current L2 behavior must remain unchanged here.

## Objective

Add a typed, idempotent Layer 1 repository and narrow database capability for immutable observations that an issuer explicitly states that an exact report revision is current, superseded, retracted, or withdrawn.

## Required behavior

1. Require an explicit dataset, stable observation ID, exact target report revision, exact same-source report revision containing the assertion, asserted state, retrieval timestamp, and optional publisher-stated observation timestamp. The database supplies `recorded_at`.
2. Preserve the three times separately. Do not infer publisher observation time from fetch time.
3. Require `superseded` observations to name an exact replacement revision from the same source and dataset, and verify that the replacement's immutable `supersedes_id` points to the target. Other states must not carry a replacement ID.
4. Enforce target, assertion, and replacement dataset/source lineage in the database as well as typed input validation. Keep any evidence text in the existing report revision under its source-retention rules; do not copy text or arbitrary `record_json` into the observation ledger.
5. Support create-or-verify replay: exact reuse of the stable observation ID returns the same stored observation; conflicting reuse fails with a fixed content-free error. Store multiple contradictory source assertions as separate rows; do not apply last-write-wins, consensus, moderator approval, or state resolution.
6. A `current` assertion requires explicit publisher content. A successful fetch, changed hash, missing page, `404`, timeout, or stale cache does not by itself assert current, retracted, or withdrawn.
7. Do not let an LLM, L3 investigation, source registry health, or source eligibility create these assertions. No provider or live acquisition runtime is part of this task.
8. Use a least-privilege grant for the existing L1 pipeline capability, append-only database enforcement, deterministic bounds, and redacted errors. Do not grant source text access beyond existing L1 permissions or broaden other roles.
9. Keep `report_revisions.revision_status`, retrieval eligibility, chunks, embeddings, public event versions, freshness, lifecycle, geometry, history, and API behavior unchanged. No moderator queue, freshness record, audit/publication/outbox write, or public badge update is added.
10. Tests use authored synthetic PGlite rows only. Do not call any source or external service, install packages, provision a role membership, or change deployment configuration.

## Allowed paths

- `apps/db/migrations/029_source_revision_observations.sql` (new table, constraints, append-only protection, and exact L1 grants)
- `apps/db/src/report-revision-source-observations.ts` (new typed repository)
- `apps/db/src/ports.ts` (only if required to register the repository in the existing DB port set)
- `apps/db/test/report-revision-source-observations.test.ts` (new)
- `apps/db/test/migrations.test.ts` (migration inventory/order and exact capability assertions only)
- `apps/db/test/public-event-updates.test.ts` (staged migration inventory/order expectation only)
- `docs/assignments/LIFE-01-SOURCE-REVISION-OBSERVATION-CORE-HANDOFF.md` (new)

Do not change Layer 2 retrieval/grounding, Layer 3 orchestration, public API/OpenAPI/DTO/UI, freshness or publication logic, source adapters/providers, Worker runtime, existing immutable report contents, dependencies, secrets, or deployment configuration. Stop and ask root if the observation cannot be attributed to the exact same-source revision or if a broader contract/path change is required.

## Acceptance and verification

- PGlite tests prove exact dataset/source lineage, all four typed assertion states, supersession replacement matching, exact replay, conflicting replay rejection, preservation of contradictory observations, and append-only/update/delete denial.
- Tests prove timestamps remain distinct, no source text is copied, no L2 retrieval or public projection is changed, and no freshness/publication/audit/outbox side effect occurs.
- Run in WSL Ubuntu-26.04 with existing Node/npm dependencies: focused observation tests, `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD`. Report exact results and versions; do not install dependencies or contact external services.
- Commit implementation and handoff separately on the assigned branch. Root independently reviews and integrates only after acceptance. The agent does not merge or push.

## Stop conditions

Stop and ask root if resolving conflicting assertions, deciding public freshness treatment, changing L2 retrieval behavior, creating moderator state, treating fetch failure as retraction, or altering a current published event becomes necessary. Preserve all assertions as data and stop at the append-only L1 boundary.
