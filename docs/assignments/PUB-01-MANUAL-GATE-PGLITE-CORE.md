# PUB-01-MANUAL-GATE-PGLITE-CORE — persisted publication composition proof

- **Status:** Accepted locally on `main` after independent root review
- **Backlog ID:** `PUB-01-MANUAL-GATE-PGLITE-CORE`
- **Parent:** `PUB-01`
- **Dependencies:** Accepted `PUB-01-MANUAL-GATE-CORE`, `PUB-01-REVIEWED-EVIDENCE-LABEL-CORE`, `PUB-WRITE-CORE`, `MOD-01-WRITER-ROLE-CORE`, and the DB PGlite harness
- **Assigned base:** `3426e21098784417bb9c78303075f36f832d59ed` (contains accepted L3 migration 035 and handoff, moderator-selected label implementation and handoff, and root acceptance record)
- **Contract baseline:** Schema 2.0 `EventProposal`, `PublicationDecision`, label-aware `ManualPublicationServiceInput`, label-aware `PublicationWriteCommand`, and the existing moderator writer role in migration 017; no database schema or migration change
- **Implementation model:** GPT-6 Luna, max reasoning
- **Branch/worktree:** `work/PUB-01-MANUAL-GATE-PGLITE-CORE` / `.codex-build/worktrees/pub-01-manual-gate-pglite-core`; agent works only in this isolated WSL-accessible worktree
- **Allowed paths:** `apps/db/test/manual-publication-gate-composition.test.ts` (new) and `docs/assignments/PUB-01-MANUAL-GATE-PGLITE-CORE-HANDOFF.md` (new). The DB test runner discovers `*.test.ts` automatically, so do not edit package manifests or runner code.

## Objective

Add a test-only PGlite composition proving the accepted Layer 4 manual publication service can read the canonical persisted proposal and invoke the real atomic SQL publication writer under the existing least-privilege moderator publication capability. Use authored, synthetic, live-shaped fixture rows only. Prove one explicit approval persists one publication atomically and exact replay does not duplicate it; prove a stale or policy-denied case creates no publication writes.

The test composes `createSqlEventProposalReader`, `createManualPublicationService`, and `SqlPublicationWriter`. It verifies that Team 12's explicit per-claim moderator label choices reach the immutable decision and published claims and participate in idempotency. It does not add production wiring or claim that a trusted moderator identity, source rights, or hosted database is available.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md`
- `ARCHITECTURE.md`
- `docs/IMPLEMENTATION_BACKLOG.md`
- `docs/assignments/PUB-01-MANUAL-GATE-CORE.md` and its handoff
- `docs/assignments/PUB-01-REVIEWED-EVIDENCE-LABEL-CORE.md` and its handoff
- `docs/assignments/PUB-WRITE-CORE.md` and its handoff
- `docs/decisions/ADR-052-moderator-selected-public-evidence-labels.md`
- `docs/assignments/MOD-01-WRITER-ROLE-CORE.md` and its handoff
- `docs/decisions/ADR-013-publication-write-transaction.md`
- `apps/db/test/harness.ts`, `apps/db/test/event-proposal-reader.test.ts`, and `apps/db/test/publication-writer.test.ts`
- `apps/db/src/event-proposals.ts`, `apps/db/src/publication-writer.ts`, and `apps/worker/src/layers/l4-application-integration/manual-publication-service.ts`
- `apps/worker/test/l4-manual-publication-service.test.ts` and `apps/worker/package.json`

## Required behavior

1. Create an isolated PGlite database and apply the checked-in migrations. Seed only the minimum internally consistent proposal and evidence lineage needed by the strict reader, service, and writer. Use authored synthetic values even if the isolated test rows use `dataset_kind = 'live'` to exercise the live publication boundary; clearly label that distinction in test names/comments and the handoff.
2. Instantiate the real SQL reader and `SqlPublicationWriter`, then pass them to the existing `createManualPublicationService`. Do not use a fake writer in this composition test. Run the composed operation under the existing `waspada_l4_moderator_publication_writer` role from migration 017, which grants the reader columns and the atomic writer operations. Assert the active role at the boundary. Do not add grants, role membership, migrations, runtime configuration, or a new database capability.
3. For an explicit synthetic approval and a policy-matched persisted proposal, assert the service returns `written`, and independently query as the test administrator to confirm exactly one event version, impact version, decision, claim decision/evidence set, audit record, write receipt, and publication outbox notice were committed with the expected lineage.
4. Use at least two claims with different selected labels, and provide moderator choices in an order different from persisted proposal claim order. Prove exact `claim_id` mapping rather than positional mapping. Query the persisted `PublicationDecision.record_json.claim_decisions`, `Event.record_json.claims`, and normalized `event_claims.evidence_label`; assert all three carry the exact selected value for each claim, and none contains `under_review`. Also compare the persisted proposal's claim labels before and after publication to confirm its private `under_review` values remain unchanged.
5. After the first successful write, snapshot fixture-scoped rows across the writer's complete publication footprint: `publication_decisions`, `publication_claim_decisions`, `publication_decision_evidence`, `event_versions`, `event_claims`, `event_claim_evidence`, `event_claim_origins`, `event_claim_geometries`, `impact_versions`, `impact_claim_support`, `event_impact_refs`, `audit_records`, `publication_outbox`, and `publication_write_receipts`. Replay the exact same service input. Assert the service returns `replayed`, the request fingerprint and all 14 table snapshots remain unchanged, and there is still one logical outbox notice. Then reuse the same idempotency key with one changed label; assert `idempotency_key_reused` and all 14 snapshots remain unchanged from the successful write. Do not describe this as exactly-once network delivery.
6. In an isolated denied case, make a current policy input stale or otherwise policy-ineligible while keeping the persisted proposal valid. Assert a stable denial result and compare fixture-scoped snapshots across the same 14-table publication footprint before/after to prove no event, impact, decision, claim/evidence, audit, receipt, or outbox rows were written. The proposal's seed rows may exist and are not publication writes.
7. Keep proposals, evidence relations, target versions, labels and publication drafts exact and internally consistent. Preserve separate policy and database duties: the service assesses the decision; the SQL writer enforces transaction-time lineage, label validation, idempotency and append-only writes.
8. Keep this test unreachable from routes and scheduled handlers. Do not modify production code, public API/DTO/OpenAPI, database schema, migrations, grants, dependencies, source/model adapters, fixtures used by the demo, source access, external services, or deployment configuration. Do not create any `/updates` entry for a freshness-only change; freshness remains visible on event/impact views only under the existing Team 12 decision.

## Allowed paths

- `apps/db/test/manual-publication-gate-composition.test.ts` (new)
- `docs/assignments/PUB-01-MANUAL-GATE-PGLITE-CORE-HANDOFF.md` (new)

The DB test runner discovers `*.test.ts` automatically, so no package-manifest or runner edit is allowed. Root owns architecture, backlog, SDP, checkpoint, delivery log, and any scope changes. If a coherent persisted fixture or real SQL writer call cannot run under the existing moderator publication role without a schema/grant change, stop and report the exact gap. Do not broaden permissions or weaken the test.

## Acceptance and verification

- A focused PGlite test composes the persisted SQL reader, manual gate service, and real SQL writer under `waspada_l4_moderator_publication_writer`; the test is automatically discovered by the existing DB runner.
- The positive path writes one coherent event/impact publication and all required append-only decision, evidence, audit, receipt, and outbox rows; replay returns `replayed` without duplicate publication rows.
- Per-claim selections are identical in the private decision JSON, public Event claim JSON, and normalized `event_claims.evidence_label`; the decision and published claim never contain the private `under_review` label.
- Moderator choices are supplied in an order different from persisted proposal claims, proving matching uses exact `claim_id`; publication leaves the persisted private proposal's `under_review` labels unchanged.
- The stored idempotency fingerprint is stable on exact replay, while a changed label under the same key produces `idempotency_key_reused` without extra publication rows.
- The handoff cites the accepted label-core SQL-writer tests that independently reject missing, duplicate, unknown, invalid, and `under_review` selected labels; the composition covers valid labels through the real writer.
- After the first successful write, replay and changed-label idempotency conflict preserve exact fixture-scoped snapshots across all 14 publication writer tables listed above; the stale/policy-denied path returns a stable denial and causes no publication-table writes.
- Tests verify the proposal used by the gate came from the strict DB reader, no fake writer substitutes for the real writer in the positive path, and no route/runtime or demo wiring changed.
- Fixtures and comments clearly state that all source/evidence/reviewer values are authored synthetic test values and make no real source-rights, reviewer-identity, or quality assertion.
- In WSL Ubuntu-26.04 with existing dependencies only, record Node/npm and PGlite versions; run the focused composition test, `npm run db:test`, full `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD`. Do not install dependencies or call external services.
- The DB test runner discovers the new `*.test.ts` file automatically. Commit the test, then the completed handoff, as separate descriptive commits on the assigned branch. Leave the worktree clean. Do not edit outside allowed paths, merge, or push; root independently reviews and accepts.

## Stop and escalation conditions

Stop if the existing moderator publication writer role cannot execute the composed proposal read and atomic write, if an accepted label input or writer contract is missing from the assigned base, or if proving the positive path requires a database schema/migration/grant, public contract, route, identity provider, source, or external service. Return the exact blocker and evidence. Team 12's label policy is already decided by ADR-052 and is not a blocker. Escalate beyond Luna/max only if a substantive technical difficulty was attempted by Luna/max and remains unresolved; usage or scheduling constraints are not escalation grounds.

## Implementation handoff

The implementer records the assigned branch/worktree and exact base, commit SHA(s) and exact messages, changed paths, behavior, WSL runtime/package versions, actual check results, limitations, migration/configuration impact, and remaining decisions in the allowed handoff file. Root independently reviews and records acceptance here.

### Root review — original blocker before label decision

At the time of the original review, the implementer correctly stopped at the writer boundary. Migration 023 already permits `under_review` in private `proposal_claims`, as specified by ADR-036. The mismatch was that the L2 bridge and manual gate required the draft label `under_review`, while `SqlPublicationWriter` accepted only the four public evidence labels and projected the proposal label into the published claim. `PublicationWriteCommand` had no explicit moderator-reviewed public label, so the writer failed closed. Team 12 resolved this policy in ADR-052, and `PUB-01-REVIEWED-EVIDENCE-LABEL-CORE` later implemented and received acceptance for the moderator-selected input and projection.

No changes or commits were made during this original attempt; its worktree was clean at assigned base `877fbc8281ef3334a6bb23001b98d29a17b32bd5`. The task stopped because Team 12's public-label rule was unresolved. ADR-052 later resolved that policy in favor of an explicit moderator-selected label per published claim. The composition then remained gated until `PUB-01-REVIEWED-EVIDENCE-LABEL-CORE` was accepted and root pinned an assigned base containing that work and the integrated L3 migration 035. Both conditions were met before the current assignment below; no policy decision remains open.

### Current assignment — 8 October 2026

The label-core implementation was accepted and pushed to `main` before this task. The PGlite composition was assigned from exact base `3426e21098784417bb9c78303075f36f832d59ed` on `work/PUB-01-MANUAL-GATE-PGLITE-CORE` in `.codex-build/worktrees/pub-01-manual-gate-pglite-core`; root verified the worktree was clean and fast-forwarded it from its prior base. The earlier label-policy blocker is historical and resolved.

### Root review and acceptance

Root accepted the test from `work/PUB-01-MANUAL-GATE-PGLITE-CORE`. Agent commits are `7ec049a0cae687bc9961542ad69a2c9f4f9d6673` (`test(PUB-01): compose manual gate with SQL writer`) and `53e05ae16f4db498b0b5f14d3ec284c0f64add6f` (`docs(PUB-01): record PGlite composition handoff`). Root preserved them on `main` as `8653f79` and `4100b59` with the same messages.

The test composes the real strict SQL proposal reader, manual gate service, and SQL writer under the existing moderator writer role. It proves a single coherent synthetic publication, exact claim-ID label and evidence lineage, unchanged private proposal labels, exact replay, changed-label idempotency conflict, and stale-evidence denial using fixture-scoped snapshots across all 14 publication tables. Independent read-only review findings (an undefined import and incomplete per-claim lineage assertions) were fixed before acceptance; follow-up reviews found no remaining issue.

Verification ran in WSL Ubuntu-26.04 with Node `v24.21.0`, npm `11.19.0`, and PGlite `0.5.8`. The agent passed the focused test (3/3), `npm run db:test` (42/42 files), full `npm test` (Web 60/60, Worker 451/451, DB 42/42 files, evaluation 19/19), typecheck, build, and assigned-base diff check. The full `npm test` preceded a final test-only type annotation; focused test (3/3), typecheck, build, and diff check passed again afterward. Root independently reran the focused test (3/3) after the final commit and confirmed the task branch was clean and limited to the two allowed paths.

No migration, grant, package, configuration, route/runtime, API/OpenAPI, identity, application-code, source, hosted-service, or deployment change occurred. Synthetic PGlite results do not establish hosted Neon behavior, actual moderator identity/authorization, source rights, factual quality, or network delivery guarantees. No remaining decision is needed for this local test slice; subsequent source-backed evaluation and publication work remain gated by rights-cleared data and human review.
