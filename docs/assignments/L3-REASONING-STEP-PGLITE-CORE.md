# L3-REASONING-STEP-PGLITE-CORE — verify planner budgeting with the durable ledger

**Parent package:** AGENT-01 / FR-07 bounded investigation
**Status:** Assigned on `main` at `d8779f8`
**Implementation model:** GPT-6 Luna, max reasoning
**Branch:** `work/L3-REASONING-STEP-PGLITE-CORE`
**Worktree:** Reuse `C:\Users\perry\.codex\worktrees\obs-01-l1-fixture-telemetry\RPL` only after creating the new task branch from `main`; do not edit the root checkout.
**Base commit:** `d8779f8214001b800c684a4ad7b40cc8fe04c2f3`
**Contract baseline:** L2 investigation-plan 1.0; schema 2.0 grounding context and L3 ledger; no runtime or public API changes.

## Objective

Add a synthetic PGlite integration test that exercises the accepted `createReasoningStepExecutor` against the real SQL investigation-ledger repository. Verify that L3's one-call planning boundary and the durable repository agree on success and failure accounting. This task changes tests only; it does not change production behavior.

## Read first and dependencies

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md` and `docs/IMPLEMENTATION_BACKLOG.md`
- `ARCHITECTURE.md`, `docs/DOMAIN_MODEL.md`, ADR-014, ADR-017 and ADR-029
- `docs/assignments/L3-REASONING-STEP-CORE.md` and its handoff
- `apps/db/test/investigation-ledger.test.ts`, `apps/db/test/harness.ts`, and `apps/db/src/investigation-ledger.ts`
- `apps/worker/src/layers/l3-investigation/reasoning-step-executor.ts` and its focused test

Dependencies `L3-REASONING-STEP-CORE`, `L3-LEDGER-CORE`, `DATA-01` and `DB-TEST-RUNNER-ISOLATION` are accepted. Use only the existing PGlite harness, authored synthetic records and an injected planner double. Do not fetch a source or activate a model provider.

## Allowed paths

- `apps/db/test/investigation-ledger.test.ts` (test additions only)
- `docs/assignments/L3-REASONING-STEP-PGLITE-CORE-HANDOFF.md` (new implementation handoff)

Root owns this assignment, the backlog, checkpoint, delivery log and acceptance. Do not change production code, migrations, schemas, package scripts, dependency versions or other files without first reporting the need to root.

## Required behavior

1. Use the existing test database setup, migrations, synthetic grounding fixture and `createSqlInvestigationLedgerRepository`; do not mock the repository or ledger transitions.
2. Inject a typed planner double whose preflight returns a structurally valid, insufficient context matching the persisted case identity. It must not make a network/model call.
3. For one valid proposal, assert exactly one planner invocation and verify the persisted checkpoint contains one reasoning turn, measured active seconds, exact trusted model/prompt metadata and actual input-plus-output token usage; reserved counters must return to zero and the attempt must be closed as succeeded.
4. Retry with the original checkpoint version and reservation identity. Confirm the stale/replay path makes no second planner invocation and does not change persisted accounting.
5. For a separate provider-error case, assert exactly one planner invocation, a closed failed attempt, full configured active-time and token reservation consumed, no `ModelRun`, and zero remaining reserved counters.
6. Keep all seed data synthetic and labelled. Do not persist plan input, source excerpts, provider output or exception text in the ledger.

## Acceptance criteria

- The integration test would fail if the L3 wrapper called before durable reservation/start, reconciled the wrong token/time amount, repeated a stale plan, or failed to close a provider-error reservation.
- The real persisted checkpoint and reservation rows agree on outcomes, counters and model-run provenance.
- No production source, API/OpenAPI, SQL/schema/migration, dependency, package script, runtime configuration, source or provider behavior changes.
- In WSL Ubuntu-26.04 run the DB test suite, full workspace `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`.
- Commit the test and handoff separately on the task branch. Leave the worktree clean; do not merge or push. Root independently reviews and runs the DB and full workspace suites before acceptance.

## Stop conditions and handoff

Stop and report to root if the existing PGlite harness cannot exercise the L3 service without production-code changes, or if a schema, contract, dependency, package-script or runtime change appears necessary. Continue the test-only task if a fixture detail is missing by following existing synthetic patterns; do not add new source data.

The handoff must include branch/worktree, base and full commit SHAs with exact messages, changed paths, WSL commands/results and runtime versions, what the real-ledger test proves, limitations, and any remaining decisions. Do not claim hosted Neon or provider behavior was tested.
