# L3-CONTEXT-RESUME-COORDINATOR-CORE — compose exact context rehydration into a bounded restart

**Backlog ID:** `L3-CONTEXT-RESUME-COORDINATOR-CORE`

**Status:** Assigned; synthetic test-only proof

**Branch:** `work/L3-CONTEXT-RESUME-COORDINATOR-CORE`

**Worktree:** `.codex-build/worktrees/l3-context-resume-coordinator-core`

## Objective

Add one PGlite composition test proving that a restarted Layer 3 coordinator can load its latest checkpoint, rehydrate that checkpoint's exact refs-only Layer 2 context through the accepted Layer 2 resumer, and make one bounded resume advance. This closes the persistence-to-resumer-to-coordinator test seam; it does not add a production resume runtime.

## Read first

Read `SOFTWARE_DEVELOPMENT_PLAN.md`, `docs/IMPLEMENTATION_BACKLOG.md`, this assignment, `docs/decisions/ADR-049-l2-grounding-context-resume.md`, and the accepted handoffs for `L2-CONTEXT-RESUME-CORE`, `L3-COORDINATOR-CORE`, `L3-LEDGER-CORE`, and `DB-TEST-RUNNER-ISOLATION`. Follow repository `AGENTS.md` branch/worktree/commit and WSL rules.

## Dependencies and contracts

- Accepted `L2-CONTEXT-RESUME-CORE`, `L3-COORDINATOR-CORE`, `L3-LEDGER-CORE`, and `DB-TEST-RUNNER-ISOLATION`.
- Context schema 2.0 and checkpoint version 1 remain unchanged.
- The context record is refs-only. Rehydrated excerpt text may exist only in the in-memory resume request and coordinator input.
- Use only authored synthetic records and the existing database/worker ports. No model or source provider is called.

## Allowed paths

- `apps/db/test/investigation-ledger.test.ts`
- `docs/assignments/L3-CONTEXT-RESUME-COORDINATOR-CORE-HANDOFF.md`

Do not change production code, other tests, public/internal contracts, APIs, migrations, grants, package manifests, lockfiles, runtime configuration, source fixtures, or deployment settings.

## Acceptance criteria

1. Persist an authored synthetic refs-only context and an L3 checkpoint that names its exact context ID. Simulate process restart by reading the latest checkpoint and context back from PGlite.
2. Rehydrate only from the checkpoint's dataset/context identity using the real `GroundingContextResumer` and current exact evidence readers. Before coordinator work, prove the saved context remains refs-only and the in-memory context matches the persisted identity, current source lineage, and exact spans.
3. Supply the exact checkpoint, persisted record, and reconstructed context to one `kind: "resume"` coordinator advance with stable replay keys. Assert exact case/context identity and at most one planner, registered action, and refresh for that advance.
4. Replay the same logical advance and prove durable reservations/checkpoint state do not duplicate or reinvoke completed external ports.
5. For missing, stale/source-ineligible, or source-invalidated context, prove the resumer fails closed before planner/action/refresh calls. Reuse one deterministic failure class per scenario; do not expose excerpts in errors or logs.
6. Assert no excerpt text is persisted in context/checkpoint/ledger rows and no publication, moderator decision, public event, or outbox write occurs.
7. Use synthetic labels and state clearly that PGlite does not establish hosted Neon, live-source, provider, Cloudflare Workflow, or production-runtime behavior.

## Verification

Run from WSL Ubuntu-26.04 with the installed lockfile toolchain; do not install dependencies or use Windows-host Node:

```sh
npm exec tsx -- --test apps/db/test/investigation-ledger.test.ts
npm run db:test
npm test
npm run typecheck
npm run build
git diff --check <assigned-base>..HEAD
```

Record the actual Node/npm versions and results. Do not report a check as passing unless it was run.

## Stop conditions

Stop and ask the root orchestrator if this requires production wiring, a contract/schema/grant/migration change, non-synthetic data, or a change to the reserved budget/replay semantics. Do not add a Cloudflare Workflow, trigger, deployment binding, source/provider call, or external service. Do not spawn agents, merge, or push. Root will review and integrate the branch.
