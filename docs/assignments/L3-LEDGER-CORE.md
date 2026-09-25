# L3-LEDGER-CORE — Durable investigation requests and checkpoints

**Status:** Accepted on `main` at `32d4678` after root review; implementation `ed0f307`, handoff `32d4678`.
**Depends on:** DATA-01, RAG-ACCESS-01, ADR-014.
**Requirements:** FR-07; NFR-02/05/07.
**Branch/worktree:** `work/L3-LEDGER-CORE`; `.codex-build/worktrees/l3-ledger-core`.

## Objective

Implement the local Layer 3 persistence boundary for creating insufficient-context investigation cases, appending resumable checkpoints, and reserving/reconciling bounded tool or reasoning actions. This is durable groundwork for the coordinator. It does not invoke tools or models and cannot publish.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md` Sections 5–8 and 10
- `docs/IMPLEMENTATION_BACKLOG.md`, `docs/CURRENT_CHECKPOINT.md`, and `docs/DOMAIN_MODEL.md`
- `docs/contracts.schema.json` `$defs.GroundingContext`, `$defs.InvestigationRequest`, `$defs.ToolAttempt`, `$defs.InvestigationCheckpoint`, and `$defs.BudgetLedger`
- `docs/decisions/ADR-002-job-queue-and-scheduler.md`, `docs/decisions/ADR-011-l2-grounding-reader.md`, and `docs/decisions/ADR-014-l3-investigation-ledger.md`
- `apps/db/src/sql.ts`, `apps/db/src/migrations.ts`, the PGlite `harness.ts`, and relevant migration/role tests

## Required behavior

- Add migration `008_l3_investigation_ledger.sql` and a typed repository in `apps/db/src/`. Preserve the schema 2.0 public JSON contract; keep additional reservation identity/outcome state internal to the database.
- Create an investigation request and version-1 open checkpoint atomically only if their persisted context exists, is insufficient, and has exact dataset/candidate/trace linkage. Validate 1–20 bounded questions, nullable event ID/version pairing, configured budget values, and hard maxima of 5 tool attempts, 4 reasoning turns, 60 active seconds, and 12,000 model tokens. Initial consumed/reserved counters are zero. Exact replays return the existing case; changed input under the same ID fails with a bounded conflict.
- Keep `InvestigationRequest.context_id` as the initial grounding context. Allow each checkpoint version to reference a newer persisted grounding context only for the same dataset and candidate. Preserve investigation ID, event target, budget policy, limits, consumed counters, and any outstanding reservation on resume. A sufficient initial context cannot create a case.
- Maintain `investigation_requests` counters as the current aggregate ledger; append full schema 2.0 checkpoint snapshots on every reservation, reconciliation, pause/resume, or terminal transition. Prevent checkpoint update/delete. Replace the existing context/candidate foreign key that blocks L2 refresh with two constraints: checkpoint-to-case identity `(dataset_kind, investigation_id, candidate_id)` and checkpoint-to-context identity `(dataset_kind, context_id, candidate_id)`.
- Reserve one tool attempt or one reasoning turn before execution using a stable idempotency ID and caller-supplied worst-case active seconds/tokens. Check expected checkpoint version, case state, in-flight reservation, per-case remaining budget, and hard caps in one transaction. A duplicate reservation ID with identical input must never authorize a second invocation; changed input fails closed.
- Reconcile each started action exactly once. Successful and failed/time-out/denied/cancelled invocations count against consumed limits; actual usage cannot exceed reservation. An interrupted reservation is reconciled as timed out using its full reserved amounts. Explicit release is allowed only for an action known not to have been invoked. Duplicate acknowledgement returns the original disposition without incrementing counters again.
- A tool reconciliation appends the schema `ToolAttempt` to the cumulative checkpoint snapshot. A successful reasoning reconciliation may append the validated schema `ModelRun`; never persist prompts, raw tool results, source text, or raw model output in the ledger. Failed reasoning remains visible through the internal bounded reservation outcome and counters.
- Pause/resume and terminal transitions are explicit and version-checked. No transition may change event identity, limits, or policy version, or reset counters. Do not close a case while an action remains reserved.
- Add a dedicated `waspada_l3_coordinator` `NOLOGIN` role. Grant only the exact columns required: read grounding context/candidate and current ledger, insert request/checkpoint/reservation rows, update only request counters and reservation reconciliation fields. Prove required operations under `SET ROLE`; prove unrelated/publication access and checkpoint-history mutation/deletion are denied.
- Use synthetic PGlite fixtures only. PGlite's single-session behavior must not be presented as proof of hosted PostgreSQL concurrency.

## Allowed paths

- `apps/db/migrations/008_l3_investigation_ledger.sql`
- `apps/db/src/investigation-ledger.ts`
- `apps/db/test/investigation-ledger.test.ts`
- `apps/db/test/migrations.test.ts` only for migration and privilege assertions
- this assignment's implementation handoff

No schema 2.0/OpenAPI changes, Worker or web code, provider/tool adapter, model selection, source acquisition, external service, credential, dependency, or lockfile changes. Root owns architectural changes and reviews the implementation.

## Acceptance and verification

- Cover creation from insufficient context and rejection from sufficient/missing/cross-dataset contexts; first snapshot fields and exact replay/conflict behavior.
- Cover refreshed-context linkage while preserving case identity/event pair/limits/usage; stale-version, wrong-candidate, changed-budget, invalid-pair, and terminal/resume rejection.
- Cover reserve-before-action, reservation ID replay/conflict, one-in-flight enforcement, configured and absolute budget boundaries, failed actions counting, bounded actual accounting, interruption consuming the reserved maximum, safe uninvoked release, duplicate reconciliation, and immutable checkpoint snapshots.
- Under `SET ROLE waspada_l3_coordinator`, prove only intended operations succeed and unrelated access remains denied. Preserve every existing test.
- In WSL Ubuntu-26.04 with native Node.js `v24.21.0` / npm `11.19.0`, run sequentially: `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`. Do not overlap PGlite aggregate commands with each other or with the build.
- Commit implementation and handoff separately on the assigned branch. Leave a clean worktree and report exact commands/counts, changed paths, limitations, and hosted behavior not tested. Do not push or merge.

## Stop/escalation

Stop and ask root before changing record shapes, budget maxima, public contracts, or the accepted transactional semantics. If a requirement cannot be enforced within the current migration/SQL boundary, return the failing invariant and minimal architectural choice; do not weaken it. Escalation to GPT-6 Astra xhigh is only allowed after an actual GPT-6 Luna max attempt fails on a substantive technical issue.
