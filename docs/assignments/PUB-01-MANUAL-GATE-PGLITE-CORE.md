# PUB-01-MANUAL-GATE-PGLITE-CORE — persisted publication composition proof

- **Status:** Assigned on `work/PUB-01-MANUAL-GATE-PGLITE-CORE` from the pinned base below
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
5. Replay the exact same service input. Assert the service returns `replayed`, the request fingerprint and publication rows remain unchanged, and there is still one logical outbox notice. Reuse the same idempotency key with one changed label; assert `idempotency_key_reused` and no additional event versions, impact versions, decisions, claim-decision/evidence rows, audit records, receipts, or outbox writes. Do not describe this as exactly-once network delivery.
6. In an isolated denied case, make a current policy input stale or otherwise policy-ineligible while keeping the persisted proposal valid. Assert a stable denial result and compare publication-table counts before/after to prove no event, impact, decision, audit, receipt, or outbox rows were written. The proposal's seed rows may exist and are not publication writes.
7. Keep proposals, evidence relations, target versions, labels and publication drafts exact and internally consistent. Preserve separate policy and database duties: the service assesses the decision; the SQL writer enforces transaction-time lineage, label validation, idempotency and append-only writes.
8. Keep this test unreachable from routes and scheduled handlers. Do not modify production code, public API/DTO/OpenAPI, database schema, migrations, grants, dependencies, source/model adapters, fixtures used by the demo, source access, external services, or deployment configuration. Do not create any `/updates` entry for a freshness-only change; freshness remains visible on event/impact views only under the existing Team 12 decision.

## Allowed paths

- `apps/worker/test/l4-manual-publication-pglite-composition.test.ts` (new)
- `apps/worker/package.json` (register this test only)
- This assignment's implementation handoff section only

Root owns architecture, backlog, SDP, checkpoint, delivery log, and any scope changes. If a coherent persisted fixture or real SQL writer call cannot run under the existing moderator publication role without a schema/grant change, stop and report the exact gap. Do not broaden permissions or weaken the test.

## Acceptance and verification

- A focused PGlite test composes the persisted SQL reader, manual gate service, and real SQL writer under `waspada_l4_moderator_publication_writer`.
- The positive path writes one coherent event/impact publication and all required append-only decision, evidence, audit, receipt, and outbox rows; replay returns `replayed` without duplicate publication rows.
- Per-claim selections are identical in the private decision JSON, public Event claim JSON, and normalized `event_claims.evidence_label`; the decision and published claim never contain the private `under_review` label.
- Moderator choices are supplied in an order different from persisted proposal claims, proving matching uses exact `claim_id`; publication leaves the persisted private proposal's `under_review` labels unchanged.
- The stored idempotency fingerprint is stable on exact replay, while a changed label under the same key produces `idempotency_key_reused` without extra publication rows.
- The handoff cites the accepted label-core SQL-writer tests that independently reject missing, duplicate, unknown, invalid, and `under_review` selected labels; the composition covers valid labels through the real writer.
- A stale or policy-denied path returns a stable denial and causes no publication-table writes.
- Tests verify the proposal used by the gate came from the strict DB reader, no fake writer substitutes for the real writer in the positive path, and no route/runtime or demo wiring changed.
- Fixtures and comments clearly state that all source/evidence/reviewer values are authored synthetic test values and make no real source-rights, reviewer-identity, or quality assertion.
- In WSL Ubuntu-26.04 with existing dependencies only, record Node/npm and PGlite versions; run the focused composition test, full `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD`. Do not install dependencies or call external services.
- The DB test runner discovers the new `*.test.ts` file automatically. Commit the test, then the completed handoff, as separate descriptive commits on the assigned branch. Leave the worktree clean. Do not edit outside allowed paths, merge, or push; root independently reviews and accepts.

## Stop and escalation conditions

Stop if the existing moderator publication writer role cannot execute the composed proposal read and atomic write, if an accepted label input or writer contract is missing from the assigned base, or if proving the positive path requires a database schema/migration/grant, public contract, route, identity provider, source, or external service. Return the exact blocker and evidence. Team 12's label policy is already decided by ADR-052 and is not a blocker. Escalate beyond Luna/max only if a substantive technical difficulty was attempted by Luna/max and remains unresolved; usage or scheduling constraints are not escalation grounds.

## Implementation handoff

The implementer records the assigned branch/worktree and exact base, commit SHA(s) and exact messages, changed paths, behavior, WSL runtime/package versions, actual check results, limitations, migration/configuration impact, and remaining decisions in the allowed handoff file. Root independently reviews and records acceptance here.

### Root review — original blocker before label decision

At the time of the original review, the implementer correctly stopped at the writer boundary. Migration 023 already permits `under_review` in private `proposal_claims`, as specified by ADR-036. The mismatch was that the L2 bridge and manual gate required the draft label `under_review`, while `SqlPublicationWriter` accepted only the four public evidence labels and projected the proposal label into the published claim. `PublicationWriteCommand` had no explicit moderator-reviewed public label, so the writer failed closed. Team 12 resolved this policy in ADR-052, and `PUB-01-REVIEWED-EVIDENCE-LABEL-CORE` is implementing the moderator-selected input and projection.

No changes or commits were made on `work/PUB-01-MANUAL-GATE-PGLITE-CORE`; its worktree remains clean at assigned base `877fbc8281ef3334a6bb23001b98d29a17b32bd5`. The task originally stopped because Team 12's public-label rule was unresolved. ADR-052 has since resolved that policy in favor of an explicit moderator-selected label per published claim. The PGlite composition remains gated only until `PUB-01-REVIEWED-EVIDENCE-LABEL-CORE` is accepted and root pins its own assigned base containing the integrated L3 migration 035 and handoff. No policy decision remains open.

### Current assignment — 8 October 2026

The label-core implementation has been accepted locally and pushed to `main`. This task is assigned from exact base `3426e21098784417bb9c78303075f36f832d59ed` on `work/PUB-01-MANUAL-GATE-PGLITE-CORE` in `.codex-build/worktrees/pub-01-manual-gate-pglite-core`. Root verified that the existing worktree was clean and that its previous base is an ancestor of the assigned base; it will be advanced to the exact assigned base before implementation. The old blocker above is historical; no public-label policy decision remains open.
