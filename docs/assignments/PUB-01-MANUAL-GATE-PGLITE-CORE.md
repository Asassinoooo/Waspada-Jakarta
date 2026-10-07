# PUB-01-MANUAL-GATE-PGLITE-CORE — persisted publication composition proof

- **Status:** Ready for implementation; test-only synthetic composition
- **Backlog ID:** `PUB-01-MANUAL-GATE-PGLITE-CORE`
- **Parent:** `PUB-01`
- **Dependencies:** Accepted `PUB-01-MANUAL-GATE-CORE`, `PUB-WRITE-CORE`, `MOD-01-WRITER-ROLE-CORE`, and the DB PGlite harness
- **Contract baseline:** Schema 2.0 `EventProposal`, current `ManualPublicationServiceInput`, current `PublicationWriteCommand`, and the existing moderator writer role in migration 017; no contract or migration change
- **Implementation model:** GPT-6 Luna, max reasoning
- **Branch/worktree:** Root pins these in the dispatch; agent works only in that isolated worktree

## Objective

Add a test-only PGlite composition proving the accepted Layer 4 manual publication service can read the canonical persisted proposal and invoke the real atomic SQL publication writer under the existing least-privilege moderator publication capability. Use authored, synthetic, live-shaped fixture rows only. Prove one explicit approval persists one publication atomically and exact replay does not duplicate it; prove a stale or policy-denied case creates no publication writes.

The test composes `createSqlEventProposalReader`, `createManualPublicationService`, and `SqlPublicationWriter`. It does not add production wiring or claim that a trusted moderator identity, source rights, or hosted database is available.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md`
- `ARCHITECTURE.md`
- `docs/IMPLEMENTATION_BACKLOG.md`
- `docs/assignments/PUB-01-MANUAL-GATE-CORE.md` and its handoff
- `docs/assignments/PUB-WRITE-CORE.md` and its handoff
- `docs/assignments/MOD-01-WRITER-ROLE-CORE.md` and its handoff
- `docs/decisions/ADR-013-publication-write-transaction.md`
- `apps/db/test/harness.ts`, `apps/db/test/event-proposal-reader.test.ts`, and `apps/db/test/publication-writer.test.ts`
- `apps/db/src/event-proposals.ts`, `apps/db/src/publication-writer.ts`, and `apps/worker/src/layers/l4-application-integration/manual-publication-service.ts`
- `apps/worker/test/l4-manual-publication-service.test.ts` and `apps/worker/package.json`

## Required behavior

1. Create an isolated PGlite database and apply the checked-in migrations. Seed only the minimum internally consistent proposal and evidence lineage needed by the strict reader, service, and writer. Use authored synthetic values even if the isolated test rows use `dataset_kind = 'live'` to exercise the live publication boundary; clearly label that distinction in test names/comments and the handoff.
2. Instantiate the real SQL reader and `SqlPublicationWriter`, then pass them to the existing `createManualPublicationService`. Do not use a fake writer in this composition test. Run the composed operation under the existing `waspada_l4_moderator_publication_writer` role from migration 017, which grants the reader columns and the atomic writer operations. Assert the active role at the boundary. Do not add grants, role membership, migrations, runtime configuration, or a new database capability.
3. For an explicit synthetic approval and a policy-matched persisted proposal, assert the service returns `written`, and independently query as the test administrator to confirm exactly one event version, impact version, decision, claim decision/evidence set, audit record, write receipt, and publication outbox notice were committed with the expected lineage.
4. Replay the exact same service input. Assert the service returns `replayed` and publication rows remain unchanged, including a single logical outbox notice. Do not describe this as exactly-once network delivery.
5. In an isolated denied case, make a current policy input stale or otherwise policy-ineligible while keeping the persisted proposal valid. Assert a stable denial result and compare publication-table counts before/after to prove no event, impact, decision, audit, receipt, or outbox rows were written. The proposal's seed rows may exist and are not publication writes.
6. Keep proposals, evidence relations, target versions, and publication drafts exact and internally consistent. Preserve separate policy and database duties: the service assesses the decision; the SQL writer enforces transaction-time lineage, idempotency and append-only writes.
7. Keep this test unreachable from routes and scheduled handlers. Do not modify production code, public API/DTO/OpenAPI, schemas, migrations, grants, dependencies, source/model adapters, fixtures used by the demo, source access, external services, or deployment configuration. Do not create any `/updates` entry for a freshness-only change; freshness remains visible on event/impact views only under the existing Team 12 decision.

## Allowed paths

- `apps/worker/test/l4-manual-publication-pglite-composition.test.ts` (new)
- `apps/worker/package.json` (register this test only)
- This assignment's implementation handoff section only

Root owns architecture, backlog, SDP, checkpoint, delivery log, and any scope changes. If a coherent persisted fixture or real SQL writer call cannot run under the existing moderator publication role without a schema/grant change, stop and report the exact gap. Do not broaden permissions or weaken the test.

## Acceptance and verification

- A focused PGlite test composes the persisted SQL reader, manual gate service, and real SQL writer under `waspada_l4_moderator_publication_writer`.
- The positive path writes one coherent event/impact publication and all required append-only decision, evidence, audit, receipt, and outbox rows; replay returns `replayed` without duplicate publication rows.
- A stale or policy-denied path returns a stable denial and causes no publication-table writes.
- Tests verify the proposal used by the gate came from the strict DB reader, no fake writer substitutes for the real writer in the positive path, and no route/runtime or demo wiring changed.
- Fixtures and comments clearly state that all source/evidence/reviewer values are authored synthetic test values and make no real source-rights, reviewer-identity, or quality assertion.
- In WSL Ubuntu-26.04 with existing dependencies only, record Node/npm and PGlite versions; run the focused composition test, full `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD`. Do not install dependencies or call external services.
- Commit the test and package registration, then the completed handoff, as separate descriptive commits on the assigned branch. Leave the worktree clean. Do not merge or push; root independently reviews and accepts.

## Stop and escalation conditions

Stop if the existing moderator publication writer role cannot execute the composed proposal read and atomic write, if the fixture needs a new schema/grant/contract, or if proving the positive path requires a route, identity provider, source, or external service. Return the exact blocker and evidence. Escalate beyond Luna/max only if a substantive technical difficulty was attempted by Luna/max and remains unresolved; usage or scheduling constraints are not escalation grounds.

## Implementation handoff

The implementer records the assigned branch/worktree and exact base, commit SHA(s) and exact messages, changed paths, behavior, WSL runtime/package versions, actual check results, limitations, migration/configuration impact, and remaining decisions here. Root independently reviews and records acceptance.
