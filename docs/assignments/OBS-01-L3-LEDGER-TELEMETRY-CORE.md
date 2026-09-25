# OBS-01-L3-LEDGER-TELEMETRY-CORE — privacy-safe investigation ledger metrics

**Parent package:** OBS-01 (Layer 5 evaluation and monitoring)
**Status:** Assigned; local synthetic module only
**Implementation model:** GPT-6 Luna, max reasoning
**Branch:** `work/OBS-01-L3-LEDGER-TELEMETRY-CORE`
**Worktree:** `.codex-build/worktrees/obs-01-l3-ledger-telemetry-core`

## Objective

Add an opt-in Layer 3 repository decorator that reports operational summaries for durable investigation-ledger write transitions through the existing typed Layer 5 sink. The summary should expose only the closed operation name, finite duration, checkpoint lifecycle status, closed stop reason, and consumed budget counters. Preserve the wrapped repository's exact returned object or original error.

This is operational telemetry for the local ledger port, not a coordinator, agent, source integration, model call, quality metric, or database runtime composition. The sink defaults to no-op and must be injected explicitly.

## Read first and dependencies

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md`
- `ARCHITECTURE.md`
- `docs/IMPLEMENTATION_BACKLOG.md` and this assignment
- `docs/assignments/L3-LEDGER-CORE.md` and its handoff
- `docs/assignments/OBS-01-API-TELEMETRY-CORE.md` and handoff
- `docs/assignments/OBS-01-L2-RETRIEVAL-TELEMETRY-CORE.md` and handoff
- `apps/db/src/investigation-ledger.ts`
- `apps/worker/src/layers/l5-evaluation-monitoring/telemetry.ts`
- `apps/worker/test/api.test.ts`
- `apps/worker/package.json`

Dependencies L3-LEDGER-CORE and both prior OBS-01 telemetry slices are accepted. Use only synthetic checkpoint/reservation data. No source rights, labels, model, cloud resource, or live database are required.

## Allowed paths

- `apps/worker/src/layers/l5-evaluation-monitoring/telemetry.ts`
- `apps/worker/src/layers/l3-investigation/telemetry.ts` (new Worker-side decorator)
- `apps/worker/test/l3-investigation-telemetry.test.ts` (new test file)
- `apps/worker/test/api.test.ts` only as needed to narrow the expanded event union
- `apps/worker/package.json` only to register the new test file
- `docs/assignments/OBS-01-L3-LEDGER-TELEMETRY-CORE-HANDOFF.md`

Do not edit the DB ledger or migrations, database roles, contracts/OpenAPI, Wrangler configuration, dependencies/lockfiles, runtime bindings, other telemetry producers, or unrelated files.

## Telemetry contract and guardrails

- Extend the closed telemetry union with the fixed `l3_ledger_operation` event name while preserving API and L2 event shapes exactly.
- Instrument write transitions only: `create`, `reserve_action`, `start_action`, `reconcile_action`, `reconcile_interrupted`, `release_uninvoked`, `pause`, `resume`, and `terminate`. Pass `getLatest` and `getInFlightReservation` through without recording an event.
- Success records may contain only the closed operation name, fixed success outcome, finite non-negative duration, checkpoint status, closed stop reason (or `null`), and finite non-negative consumed tool-attempt, reasoning-turn, active-second, and model-token counters.
- Error records may contain only the fixed event name, closed operation name, fixed error outcome, and finite non-negative duration. Do not record exception names/messages/stacks/codes.
- Never emit investigation, candidate, context, event, trace, reservation, or checkpoint IDs; questions; dataset identity; action/tool names; model or prompt versions; source values; or user-controlled values.
- `consoleTelemetry` must create plain structured objects from exact allowlists and drop forged extra properties or invalid runtime discriminators.
- The decorator must preserve returned object identity and the exact original repository error. A telemetry sink exception must not alter either. The sink defaults to no-op; do not add a caller or database runtime composition path.
- Do not infer factual progress, evidence sufficiency, safety, or a quality/review rate from ledger counters.

## Acceptance criteria

1. The event is discriminated and typed, and existing API/L2 telemetry contracts remain unchanged.
2. Every listed write transition is covered for success; both uninstrumented read methods preserve their results and emit no event.
3. Repository failures and sink failures preserve the original error; successful calls preserve exact result identity even when the sink throws.
4. Tests verify finite non-negative durations/counters, lifecycle and stop-reason summaries, omission of sensitive markers, and console exact-field allowlists against forged properties.
5. No L3 decisions, tool execution, source acquisition, model behavior, schema, SQL, API, Wrangler, cloud or publication behavior changes.
6. Run focused telemetry/API tests, `npm run typecheck`, `npm run build`, and `git diff --check` in WSL Ubuntu-26.04. Root independently runs the full integrated suite before acceptance.
7. Commit implementation and handoff separately on the assigned branch; leave the worktree clean. No deployment.

## Verification and handoff

Use WSL Ubuntu-26.04 and the repository's existing locked dependencies with Node.js `v24.21.0`. Report branch/worktree, full commit IDs and exact messages, changed files, actual commands/results, limitations and remaining decisions. State clearly that no Worker/database composition or remote log collection was tested.

Stop and report to the root planner if a schema/API change, new dependency, content/identifier logging, DB change, source/provider call, external account operation, paid service or telemetry policy change appears necessary.
