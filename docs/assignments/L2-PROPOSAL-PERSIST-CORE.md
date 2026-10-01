# L2-PROPOSAL-PERSIST-CORE — Persist canonical grounded drafts

- **Status:** Assigned; implementation and root acceptance pending
- **Agent:** GPT-6 Luna / max
- **Branch:** `work/L2-PROPOSAL-PERSIST-CORE`
- **Worktree:** `C:\Users\perry\.codex\worktrees\l1-fixture-runner-core\RPL` (`/mnt/c/Users/perry/.codex/worktrees/l1-fixture-runner-core/RPL`)
- **Base:** Root's dispatch commit; exact SHA is supplied in the assignment message and must appear in the handoff
- **Dependencies:** DATA-01, L2-CONTEXT-PERSIST-CORE, L2-DIRECT-REASONING-CORE, PUB-WRITE-CORE; ADR-015/036
- **Requirements:** FR-05/06/08/14; NFR-01/05/07
- **Contracts:** Closed schema 2.0 EventProposal/ProposalClaim and nested definitions; existing TransactionalSqlExecutor; public API unchanged

## Objective

Read SOFTWARE_DEVELOPMENT_PLAN.md first, this backlog item, ADR-036, canonical contracts, DOMAIN_MODEL.md, grounding-contexts.ts, publication-writer.ts, SQL interfaces and migration/role tests. Implement exactly ADR-036's typed transaction-required writer. Do not invoke reasoning or convert ReasoningResult in this slice.

Validate and copy the complete canonical input before asynchronous work, using ADR-036's explicit local budgets. Preserve unknown/date precision and evidence relations. Stable validation/reference/conflict/storage errors must not include user content or raw database exceptions. Resolve trace/context/candidate, exact grounded evidence, claim support-origin coverage, optional existing-event pair and investigation lineage before writing. Investigation context may be initial or a persisted checkpoint for the same case/candidate/target; the writer has no case-state or budget authority.

Root clarification: proposal trace equals context trace. For the initial case context it also equals request trace; for a refreshed context it equals the exact recorded checkpoint trace, which may differ from the immutable request trace. Both branches preserve the request's dataset/candidate/target pair; the checkpoint branch also verifies its exact target. Cover a refreshed different-trace success and mismatched checkpoint trace/context failure. Existing L3 refresh behavior is preserved.

Persist all normalized rows and canonical JSON atomically with immutable dataset/proposal identity. Exact complete replay succeeds. Changed JSON, normalized metadata, claim/link sets or incomplete stored rows conflict and are never repaired. Keep assessments/draft labels as data. Migration 023 aligns draft-only label/length constraints and creates the isolated clamped role with narrow reads and inserts. Existing public/publication constraints and roles must remain unchanged.

## Allowed paths

- `apps/db/src/event-proposals.ts`
- `apps/db/src/ports.ts` — type/factory registration only if needed
- `apps/db/migrations/023_l2_event_proposal_writer.sql`
- `apps/db/test/event-proposals.test.ts`
- `apps/db/test/migrations.test.ts` and `apps/db/test/public-event-updates.test.ts` — migration inventory/staging maintenance only
- `docs/assignments/L2-PROPOSAL-PERSIST-CORE-HANDOFF.md`

Root owns plans/ADRs/backlog. Stop and report missing grants/paths/decisions or contract conflicts before expansion, continuing independent checks. No dependency, schema/OpenAPI, Worker/UI/auth/publication-writer change, source/model/provider call, runtime binding, external resource, deployment, purchase, merge, push or additional agents. Another agent owns chunk invalidation on its own worktree; do not edit or merge that work.

## Acceptance and verification

Use authored synthetic fixtures and the real PGlite transaction/role boundaries. Prove complete creation and replay, empty abstention, uncertain/disputed/under-review preservation, 4,000-character draft capacity without public constraint widening, claim-specific origin/evidence coverage, all four grounded evidence relations, absent/cross-dataset/mismatched context/trace/target/investigation rejection, refreshed case contexts, payload/link corruption conflicts, failed child-write rollback, copied-input behavior across awaits, bounded malformed inputs and generic storage errors. Show no event/decision/outbox row created and unrelated writes/reads denied under the new role. Migration reapplication preserves authored draft rows and existing role/public restrictions. Single-session PGlite is not a concurrency/semantic-quality claim.

Use WSL Ubuntu-26.04 with existing Node 24.21.0/npm 11.19.0/dependencies; include `/home/perry/.nvm/versions/node/v24.21.0/bin` in PATH. WSL Git uses `GIT_DIR=/mnt/d/Projects/RPL/.git/worktrees/RPL2` and `GIT_WORK_TREE=/mnt/c/Users/perry/.codex/worktrees/l1-fixture-runner-core/RPL`. A temporary node_modules symlink to `/mnt/d/Projects/RPL/node_modules` is allowed; remove before handoff. Run `node --import tsx --test --test-concurrency=1 apps/db/test/event-proposals.test.ts apps/db/test/migrations.test.ts apps/db/test/public-event-updates.test.ts`, `npm run db:test`, `npm test`, `npm run typecheck`, existing `npm run build` (Vite local outputs and Wrangler dry-run only), and `git diff --check <assigned-base>..HEAD`. Commit coherent changes on the assigned branch and hand off exact SHAs/messages, paths, behavior, actual versions/counts/results/failures, review fixes, migration/configuration impact, limitations and decisions. Root reviews and accepts separately.
