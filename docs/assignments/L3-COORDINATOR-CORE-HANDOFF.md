# L3-COORDINATOR-CORE implementation handoff

## Branch and commits

- Branch: `work/L3-COORDINATOR-CORE`
- Worktree: `/mnt/c/Users/perry/.codex/worktrees/l3-coordinator-core/RPL`
- Assigned base: `40e94100753a96eabdd908a5a76d6ab8ffd7d188`
- Implementation commit: `88512df618a6846c07ff81c7d27f3e25eb693aeb` — `feat(L3-COORDINATOR-CORE): compose bounded investigation advances`
- The handoff record is committed separately after the implementation commit; its commit is reported in the task return.

## Changed paths

- `apps/worker/src/layers/l3-investigation/contracts.ts`
- `apps/worker/src/layers/l3-investigation/coordinator.ts`
- `apps/worker/test/l3-investigation-coordinator.test.ts`
- `apps/db/test/investigation-ledger.test.ts`
- `docs/assignments/L3-COORDINATOR-CORE-HANDOFF.md`

## Behavior implemented

The placeholder has been replaced by a typed, stateless coordinator that accepts an insufficient-context L2 handoff or an exact checkpoint/context pair for resume. It validates the schema 2.0 context against its persisted record and the durable investigation identity before building the internal planner 1.0 request. Sufficient context bypasses investigation work and is returned to the L2 caller for synthesis.

One advance makes at most one budgeted planner call, one registered action, and one injected L1/L2 refresh. Only a fresh `proposed` planner result can authorize the action. Both planner and action reservation IDs are distinct, and their timestamps are required replay keys that are passed unchanged to the executors. Replayed planner or action results return a fixed review outcome and attempt an `awaiting_moderator` ledger stop; if the ledger refuses a stop while work is in flight, the coordinator returns the bounded review result without retrying or invoking another step.

The refresh port receives only the action output reference IDs. It must return the new L2 grounding context and persisted record after any new report has entered through L1/L2. The coordinator fingerprints and records progress only after that persistence. A sufficient refreshed context returns to L2; an insufficient context returns a checkpointed continuation after a changed digest or the first unchanged snapshot. A second unchanged snapshot, material conflict, abstention, budget exhaustion, timeout, denied/failed/uncertain action, invalid identity, or other bounded failure returns a fixed review result. There is no internal loop, fan-out, publication authority, or exception-detail logging.

Checkpoint version checks follow the durable executor transitions: the planner advances the initial checkpoint by two versions (reservation and reconciliation); the registered action advances its planner checkpoint by two; and the refreshed progress snapshot advances once. The PGlite test exercises v1→v3→v5→v6 and verifies that the context is persisted before the progress fingerprint is recorded.

The PGlite composition test uses only synthetic L1/L2 and planner/action ports. It verifies action reservation replay with the identical ID and timestamp returns `replayed` without a second handler call, and an outer retry after the planner has advanced does not invoke either executor again. Persisted ledger and context records exclude the synthetic planner/action input and action output reference.

## Verification

Checks ran under WSL Ubuntu-26.04 with Node `v24.21.0` and npm `11.19.0`.

- `tsx --test apps/worker/test/l3-investigation-coordinator.test.ts` — passed, 17/17.
- `tsx --test --test-name-pattern="composes one coordinator advance" apps/db/test/investigation-ledger.test.ts` — passed, 1/1 after the replay-stop change.
- `npm run db:test` — passed, all 21/21 DB test files.
- `npm test` — passed across web, Worker, DB, and evaluation casebook tests; the run included the full DB suite and completed before the chained typecheck began.
- `npm run typecheck` — passed after removing an unused test-only type import found by the first post-test typecheck.
- `npm run build` — passed. Vite built the web app and Wrangler completed a Worker `--dry-run` build.
- `git diff --cached --check` — passed before the implementation commit. The final assigned-base-to-HEAD `git diff --check` is run after the handoff commit and reported in the task return.

An initial PGlite run caught a real planner checkpoint-delta mismatch: the coordinator expected v+1 while the executor/ledger produce v+2. The coordinator and fake ledger were aligned to v+2; the action delta remains v+2. A later test-only assertion mistake about the progress snapshot versions was corrected, and the focused composition test passed.

## Limitations and integration notes

- No migration, configuration, dependency, lockfile, script, route, UI, workflow binding, provider, or source activation was added.
- All providers and actions in verification were synthetic. These checks do not verify hosted Neon, source permissions, model quality, live behavior, deployment, or Cloudflare runtime behavior.
- The caller must retain each planner/action reservation ID and timestamp byte-for-byte for an outer retry of the same advance, including the later action reservation timestamp.
- Root review and task acceptance remain outstanding.
