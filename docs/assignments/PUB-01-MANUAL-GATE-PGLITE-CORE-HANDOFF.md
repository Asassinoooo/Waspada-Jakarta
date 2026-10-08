# PUB-01 manual gate and PGlite composition handoff

## Assignment and commits

- Branch: `work/PUB-01-MANUAL-GATE-PGLITE-CORE`
- Worktree: `D:\Projects\RPL\.codex-build\worktrees\pub-01-manual-gate-pglite-core` (`/mnt/d/Projects/RPL/.codex-build/worktrees/pub-01-manual-gate-pglite-core` in WSL Ubuntu-26.04)
- Exact assigned base: `3426e21098784417bb9c78303075f36f832d59ed`
- Test commit: `7ec049a0cae687bc9961542ad69a2c9f4f9d6673` — `test(PUB-01): compose manual gate with SQL writer`
- Handoff commit message: `docs(PUB-01): record PGlite composition handoff`. Its SHA is included in the accompanying task handoff report because a commit cannot contain its own final SHA.

Changed paths:

- `apps/db/test/manual-publication-gate-composition.test.ts`
- `docs/assignments/PUB-01-MANUAL-GATE-PGLITE-CORE-HANDOFF.md`

## Behavior verified

The DB test applies the checked-in migrations to isolated PGlite and seeds only the minimum authored synthetic, live-shaped proposal/evidence lineage. It reads the persisted proposal through the real strict `createSqlEventProposalReader`, composes the existing `createManualPublicationService` with the real `SqlPublicationWriter`, and runs the positive publication boundary under `waspada_l4_moderator_publication_writer`, asserting the active role there. It does not fake the reader or writer and does not add production, demo, route, or scheduled-worker wiring.

One policy-matched approval returns `written`. Test-admin reads independently verify exactly one expected event and impact version, publication decision, claim decisions and evidence links, audit record, outbox notice, and receipt, with exact fixture lineage. Two claims use different moderator-selected evidence labels, supplied in reverse proposal order; the test checks the claim-ID-to-label mapping in private decision JSON, public event claims, and normalized `event_claims.evidence_label`. Published records contain no `under_review`; the proposal's private labels remain unchanged. Exact retry returns `replayed` with the fixture-scoped 14-table publication snapshot and fingerprint unchanged. Reusing the key with one changed label returns `idempotency_key_reused`, again with no snapshot change. A stale evidence case returns the stable `publication_not_authorized` denial and leaves the full publication footprint empty.

The exact snapshot covers `publication_decisions`, `publication_claim_decisions`, `publication_decision_evidence`, `event_versions`, `event_claims`, `event_claim_evidence`, `event_claim_origins`, `event_claim_geometries`, `impact_versions`, `impact_claim_support`, `event_impact_refs`, `audit_records`, `publication_outbox`, and `publication_write_receipts`. Lineage assertions cover exact claim/evidence/kind relations, origins, impact support, and decision evidence arrays.

The test comments and fixture values state that source, evidence, and reviewer values are synthetic; the test makes no real source-rights, reviewer-identity, authorization, or factual-quality assertion. Policy/service authorization and transaction-time writer checks remain separate. The test observes one logical persisted outbox notice; it does not claim exactly-once network delivery.

## Runtime and dependency versions

Commands ran in WSL Ubuntu-26.04 using existing dependencies, without installing packages:

- Node.js `v24.21.0`
- npm `11.19.0`
- `@electric-sql/pglite` `0.5.8`
- `tsx` `4.23.15`
- TypeScript `7.0.2`
- Wrangler `4.137.0`
- Vite `8.3.0`

The worktree temporarily linked its `node_modules` to the repository-root dependency tree; that symlink was removed before handoff.

## Verification results

- `node --import tsx --test apps/db/test/manual-publication-gate-composition.test.ts` — passed, 3/3 tests.
- `npm run db:test` — passed, 42/42 DB test files, including the composition test and the 15-test publication-writer suite.
- `npm test` — completed with all reported suites passing: Web 60/60, Worker 451/451, DB 42/42 files, and the authored fixture checks 19/19. The composition and publication-writer suites passed in this run.
- `npm run typecheck` — passed after the test helper's `Object.fromEntries` result was explicitly narrowed to object evidence records.
- `npm run build` — passed; this ran typecheck, Vite production build, and Wrangler `--dry-run`.
- `git diff --check 3426e21098784417bb9c78303075f36f832d59ed..HEAD` — run after both commits; passed.

Two implementation-time failures were resolved before handoff. The initial focused test had an incorrect expectation that private decision JSON used the normalized `evidence_ref_id` field; the test was corrected to assert its actual evidence-reference shape and then passed. The first typecheck found that helper's inferred `Object.fromEntries` values were `unknown`; runtime validation and an explicit record return type fixed the test-only typing issue. The full test run passed before that typing-only adjustment; the focused test and typecheck passed again afterward.

## Impact and limitations

There are no schema, migration, grant, package, configuration, route, API/OpenAPI, identity, application-code, or hosted-service changes. No migration was added. The result establishes the composition and role boundary in PGlite with authored synthetic rows only; it does not establish hosted Neon behavior, external source rights, actual reviewer identity/authorization, factual quality, or network delivery semantics. No further design decision is needed for this test-only slice.
