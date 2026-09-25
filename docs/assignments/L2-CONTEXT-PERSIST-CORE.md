# L2-CONTEXT-PERSIST-CORE — immutable grounding-context persistence

- **Status:** Accepted on `main` at merge `6effd54` (implementation `9c5f582`, schema-parity correction `25454b5`; handoffs `075ddd3`, `ab092bd`). Root independently passed 10/10 DB files (77 tests), the full suite (156/156), typecheck, build, and WSL diff checks. PGlite only; hosted Neon and Worker wiring remain unverified and out of scope.
- **Depends on:** DATA-01, L1-EVIDENCE-RELATION-ALIGN-CORE, L2-ADAPTER-01, RAG-ACCESS-01, L3-LEDGER-CORE, ADR-015
- **Requirements:** FR-05/06/07; NFR-01/05/07
- **Branch/worktree:** `work/L2-CONTEXT-PERSIST-CORE`; `.codex-build/worktrees/l2-context-persist-core`
- **Owner:** GPT-6 Luna Max implementation agent; root plans and reviews
- **Decision:** [ADR-015](../decisions/ADR-015-l2-grounding-context-persistence.md)

## Objective

Add a typed, transactional Layer 2 repository that stores and create-or-verifies the canonical schema 2.0 `GroundingContext` record and its normalized evidence/event/decision links. This closes the persistence dependency between retrieval results and the existing L3 ledger without implementing retrieval, a sufficiency policy, proposal generation, or runtime wiring.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md`
- `docs/IMPLEMENTATION_BACKLOG.md`
- `ARCHITECTURE.md`
- `docs/DOMAIN_MODEL.md`
- `docs/decisions/ADR-011-l2-grounding-reader.md`
- `docs/decisions/ADR-014-l3-investigation-ledger.md`
- `docs/decisions/ADR-015-l2-grounding-context-persistence.md`
- `docs/contracts.schema.json` and `docs/contracts.examples.json` — exact schema 2.0 `GroundingContext` shape
- `apps/db/migrations/001_foundation.sql` — grounding tables and append-only triggers
- `apps/db/migrations/004_l2_grounding_reader.sql`
- `apps/db/migrations/008_l3_investigation_ledger.sql`
- `apps/db/src/ports.ts`, `apps/db/src/sql.ts`, and `apps/db/test/harness.ts`
- `apps/db/src/evidence-retrieval.ts` and `apps/db/test/evidence-retrieval.test.ts`
- `apps/worker/src/layers/l2-model-grounding/contracts.ts` and `validation.ts` — distinguish the expanded in-memory reasoning payload from the persisted contract

## Required behavior

- Implement the exact persisted schema 2.0 `GroundingContext` record using the existing closed JSON contract. The canonical record stores evidence references, not excerpt text. Do not change `docs/contracts.schema.json`, its examples, or public/API contracts.
- Keep this task after L1-EVIDENCE-RELATION-ALIGN-CORE so each schema-valid reference relation can resolve to persisted evidence.
- Validate that normalized columns (`dataset_kind`, `trace_id`, `context_id`, `candidate_id`, `retrieval_version`, `index_version`, and `sufficient`) exactly match the record JSON. Reject extra/missing/invalid fields and duplicate links.
- Resolve every evidence reference by exact same-dataset natural identity (`report_revision_id`, `permitted_text_hash`, `span_start`, `span_end`, `offset_unit`, and `relation`) to an already persisted evidence reference. Do not accept a caller-supplied numeric database ID or create L1 evidence.
- Persist the context row and `grounding_evidence`, `grounding_candidate_events`, and `grounding_prior_decisions` links in one required transaction. Dataset, trace, candidate, event-version, decision, and evidence foreign keys must remain authoritative.
- Provide `createOrVerify`: identical retries for the same dataset/context ID return the stable prior result; any normalized field, JSON, or linked-set drift returns a stable typed conflict. Never update or delete an existing record. Roll back the parent and every link on any failure.
- Require a `TransactionalSqlExecutor`; do not silently fall back to non-transactional partial writes.
- Add an idempotent migration for a separate `NOLOGIN` `waspada_l2_grounding_writer` role. Grant only schema usage, exact column-level reads needed for evidence/context replay checks, and insert/select privileges needed on the grounding context/link tables. Grant no update/delete, sequence, general report/source, audit, event, decision, queue, or publication writes. Keep the existing `waspada_l2_grounding_reader` read-only.
- Test role attributes and exact effective table/column privileges; execute real create/replay operations under `SET ROLE`; prove unrelated reads/writes and context/link mutation are denied; verify migration reapplication.
- Refresh the existing L3 ledger test's latest-migration inventory assertion to 010 only; do not change ledger behavior or other assertions.
- Use authored synthetic fixtures only. Preserve `sufficient` exactly as provided; do not default, derive, or evaluate it. The field remains routing metadata, not a safety/factuality or publication decision.

## Boundaries

- **Allowed paths:** `apps/db/migrations/010_l2_grounding_context_writer.sql`, `apps/db/src/grounding-contexts.ts`, additions to `apps/db/src/ports.ts` for the repository port/factory, `apps/db/test/grounding-contexts.test.ts`, `apps/db/test/migrations.test.ts`, `apps/db/test/investigation-ledger.test.ts` (latest-migration expectation only), and this assignment's implementation handoff.
- **Forbidden:** Worker runtime or API wiring, changes to the model/reasoning contract, public schemas/OpenAPI, retrieval/sufficiency/proposal logic, L3 orchestration, L4 publication behavior, live-source data, human evaluation labels, new dependencies, credentials, hosted role membership, Cloudflare/Neon provisioning, or deployment.
- No real source excerpt or rights-pending report may be added to fixtures. The stored schema record has reference metadata only.

## Acceptance and checks

- Synthetic PGlite tests prove strict record/column agreement, exact evidence identity resolution, dataset isolation, atomic rollback, append-only behavior, exact create/replay/conflict semantics, and role isolation for context/evidence/event/decision links.
- In WSL Ubuntu-26.04 run `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`. No route changes are allowed, so no smoke test is expected.
- Add no dependencies or lockfile changes. Commit implementation and handoff separately on this branch, leave a clean worktree, and record exact commands, counts, commits, changed paths, and limitations. Do not push or merge.

## Handoff

Implementation agent records branch/worktree, commits and messages, behavior, changed paths, actual WSL results, role privilege coverage, and limitations. Root independently reviews and accepts before integration.
