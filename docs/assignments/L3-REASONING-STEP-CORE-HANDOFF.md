# L3-REASONING-STEP-CORE implementation handoff

## Branch and commits

- Branch: `work/L3-REASONING-STEP-CORE`
- Worktree: `/mnt/c/Users/perry/.codex/worktrees/obs-01-l1-fixture-telemetry/RPL`
- Base commit: `d3a9c6e77c32c09c1edf243afa9283fbbfadc492` — `docs(L3-REASONING-STEP-CORE): assign budgeted planner call`
- Implementation commit: `d2fcf03bfa8f1cde64b28192cabd2c695bcbe06a` — `feat(L3-REASONING-STEP-CORE): execute one budgeted L2 planning call`
- Original handoff commit: `f6d96819f5b4b8a52667af088f5ea53a20096e44` — `docs(L3-REASONING-STEP-CORE): record implementation handoff`
- Provider identifier compatibility fix: `c372ae133cb93a03284c886d8b5dfc7d2d6073ba` — `fix(L3-REASONING-STEP-CORE): accept provider model identifiers`
- This follow-up handoff update is committed separately; its SHA and exact message are included in the task report after creation.

The root checkout was not modified, and this branch was not merged or pushed.

## Changed paths and behavior

- `apps/worker/src/layers/l2-model-grounding/investigation-planner.ts` adds a no-provider-call preflight, abort signal and total-token-cap call options, strict input/output usage-envelope validation, and trusted model/prompt version metadata. The 1.0 request/result schemas are unchanged.
- Trusted model and prompt identifiers preserve their exact configured values and now accept the bounded safe ASCII set `A-Z`, `a-z`, `0-9`, `@`, `.`, `_`, `:`, `/`, and `-`; values must be 1–128 characters and begin with an alphanumeric or `@`. L2 configuration and L3 result validation use the same rule. Empty, whitespace, backslash and overlong values are rejected.
- `apps/worker/src/layers/l3-investigation/reasoning-step-executor.ts` adds the one-call durable budget wrapper. It checks the open checkpoint, expected version, context identity and in-flight state before reserving. It reserves the fixed `l2_investigation_planning` reasoning action, and invokes L2 only after a fresh `startAction` result with `mayInvoke: true` and `replayed: false`.
- The executor passes the trusted total-token ceiling and an `AbortSignal`, invokes once, and enforces the active-time deadline with an injected timer plus a post-completion monotonic-clock check. Timeout aborts the signal and charges the full reservation even when the timer callback is delayed. Provider errors, malformed plans, invalid or over-cap usage and uncertain planner results also reconcile the full reservation. The planner is never retried.
- A valid result reconciles measured active time and actual token usage and appends a closed reasoning `ModelRun` using trusted adapter versions. A proposal is returned as data without executing its action. A valid abstention is reconciled before the case is stopped for moderator review. Optional L3 telemetry decorates ledger operations without adding case or content fields.
- The checkpoint schema 2.0 does not persist question labels. Per the root-approved boundary, the executor checks the L2-preflighted labels against `missing_field_1..N` followed by `conflict_1..M`, derived from the validated context, and binds that context to the current checkpoint's dataset, trace, candidate, context and event identity. No database read API or schema change was added.
- `apps/worker/test/l2-investigation-planner.test.ts` and `apps/worker/test/l3-reasoning-step-executor.test.ts` cover provider envelopes, preflight, reservation/replay rules, identity and label checks, abstention, failure accounting, uncertain transitions, telemetry, timeout/abort, delayed timer callbacks, malformed post-start requests, accepted exact `@cf/meta/llama-3.1-8b-instruct` metadata, and rejected malformed or overlong metadata.
- `apps/worker/package.json` registers the new executor test in the Worker test script.
- `docs/assignments/L3-REASONING-STEP-CORE-HANDOFF.md` records this implementation handoff.

## Verification

After the provider identifier compatibility fix, all assigned checks were rerun in WSL Ubuntu-26.04 using the existing worktree `node_modules`; no dependency install or version change was needed. The Node directory was prepended to `PATH` as shown below. Commands used `set -o pipefail`, with output piped through `tail` for concise logs.

Runtime/tool versions observed:

- Node.js `v24.21.0`
- npm `11.19.0`
- tsx `4.23.15`
- TypeScript `7.0.2`
- Wrangler `4.137.0`
- Vite `8.3.0`

Commands and results:

```bash
set -o pipefail
PATH="/home/perry/.local/opt/waspada-node-v24.21.0/bin:$PATH"; export PATH
/mnt/c/Users/perry/.codex/worktrees/obs-01-l1-fixture-telemetry/RPL/node_modules/.bin/tsx --test \
  /mnt/c/Users/perry/.codex/worktrees/obs-01-l1-fixture-telemetry/RPL/apps/worker/test/l2-investigation-planner.test.ts \
  /mnt/c/Users/perry/.codex/worktrees/obs-01-l1-fixture-telemetry/RPL/apps/worker/test/l3-reasoning-step-executor.test.ts 2>&1 | tail -n 60
# 27 tests passed, 0 failed

npm --prefix /mnt/c/Users/perry/.codex/worktrees/obs-01-l1-fixture-telemetry/RPL run test --workspace=@waspada/worker 2>&1 | tail -n 35
# 327 tests passed, 0 failed

npm --prefix /mnt/c/Users/perry/.codex/worktrees/obs-01-l1-fixture-telemetry/RPL run typecheck --workspace=@waspada/worker 2>&1 | tail -n 30
# passed

npm --prefix /mnt/c/Users/perry/.codex/worktrees/obs-01-l1-fixture-telemetry/RPL run build --workspace=@waspada/worker 2>&1 | tail -n 35
# Wrangler dry-run build passed; 523.27 KiB upload, 101.67 KiB gzip

git diff --check
# passed; staged changes also passed `git diff --cached --check`
```

Git status and diff checks used `GIT_DIR=/mnt/d/Projects/RPL/.git/worktrees/RPL4` and `GIT_WORK_TREE=/mnt/c/Users/perry/.codex/worktrees/obs-01-l1-fixture-telemetry/RPL`.

## Limitations and impact

All provider behavior was tested with injected synthetic doubles. No live model/source, production registry, runtime composition or route was enabled or changed. Abort is cooperative; the tests verify signal delivery and late-result rejection, not that an external provider actually stops computation. Hosted database behavior was not tested.

There is no public API, OpenAPI, SQL/schema/migration or dependency impact. No production configuration was wired. A future composition that configures this planner must supply trusted `modelVersion` and `promptVersion` values so preflight can authorize a call. The stable question-label projection is an accepted root decision; the root owns updating the main-branch ADR/assignment clarification. Reviewer acceptance and root integration remain outstanding.
