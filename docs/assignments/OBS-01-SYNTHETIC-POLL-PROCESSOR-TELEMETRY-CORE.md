# OBS-01-SYNTHETIC-POLL-PROCESSOR-TELEMETRY-CORE — privacy-safe synthetic poll runtime metrics

**Parent package:** OBS-01 (Layer 5 evaluation and monitoring)  
**Status:** Accepted on local `main` at root commits `b93495427d024350a31b78de5f30ed5fe7da93a3` and `222db761c5abd02e5f2d1a80c6ff7096545c93f5`<br>
**Implementation model:** GPT-6 Luna, max reasoning  
**Branch:** `work/OBS-01-SYNTHETIC-POLL-PROCESSOR-TELEMETRY-CORE`  
**Worktree:** `C:\Users\perry\.codex\worktrees\obs-01-synthetic-poll-processor-telemetry-core\RPL`  
**Base commit:** `5e2abf21b17474d1e93752bec1755f40609352a4`

## Objective

Add an opt-in, privacy-safe Layer 5 summary around the accepted bounded synthetic source-poll processor. Record one structured operational event for each active processor invocation, using a fixed outcome, finite duration and bounded completion counts. Preserve the processor's exact result or original thrown error even if the telemetry clock or sink fails.

The scheduled trigger must remain silent when the runtime gates fail. The checked-in Worker remains dormant because no fixture catalog or extraction adapter is composed. Telemetry is not evidence of source accuracy, factuality, publication quality, or safety.

## Read first and dependencies

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md`
- `ARCHITECTURE.md`
- `docs/IMPLEMENTATION_BACKLOG.md` and this assignment
- `docs/assignments/JOB-01-SYNTHETIC-POLL-WORKER-RUNTIME-CORE.md`
- `docs/assignments/OBS-01-FRESHNESS-DUE-TELEMETRY-CORE.md`
- `apps/worker/src/runtime/synthetic-source-poll-process-runtime.ts`
- `apps/worker/src/runtime/synthetic-source-poll-process-trigger.ts`
- `apps/worker/src/layers/l1-data-knowledge/synthetic-source-poll-runner.ts`
- `apps/worker/src/layers/l5-evaluation-monitoring/telemetry.ts`
- `apps/worker/src/index.ts`
- `apps/worker/test/synthetic-source-poll-process-runtime.test.ts`
- `apps/worker/test/l5-freshness-due-schedule-telemetry.test.ts`
- `apps/worker/package.json`

`JOB-01-SYNTHETIC-POLL-WORKER-RUNTIME-CORE`, the existing L1 fixture telemetry, and the closed Layer 5 telemetry sink are accepted. Work only with authored synthetic fixtures and injected test doubles. No source rights, human labels, live database, model provider, cloud resource, or external service is needed.

## Allowed paths

- `apps/worker/src/layers/l5-evaluation-monitoring/telemetry.ts`
- `apps/worker/src/runtime/synthetic-source-poll-process-runtime.ts`
- `apps/worker/src/index.ts` only to inject the existing structured console sink into the already-gated processor
- `apps/worker/test/synthetic-source-poll-process-runtime.test.ts`
- `apps/worker/test/l5-synthetic-poll-process-telemetry.test.ts` (new)
- `apps/worker/package.json` only to register the new test file
- `docs/assignments/OBS-01-SYNTHETIC-POLL-PROCESSOR-TELEMETRY-CORE-HANDOFF.md`

## Telemetry contract and guardrails

- Add a distinct fixed event name, such as `l1_synthetic_source_poll_process`, to the typed telemetry union. Keep every existing event contract unchanged.
- Emit at most one event per active runtime call. Do not emit when the trigger's exact demo/enable/database/catalog/extractor gates prevent runtime creation.
- The outcome is one of `idle`, `completed`, `not_eligible`, `lost_lease`, or `failed`. Completed records may additionally contain only `empty`, `reportCount`, `evidenceReferenceCount`, `chunkCount`, and `geometryCount`, subject to finite non-negative integer bounds consistent with the existing L1 fixture telemetry policy. Other outcomes carry no completion fields.
- Use finite non-negative duration. Keep timing monotonic where available and safe when a clock fails or returns malformed values.
- Exclude source, report, evidence, job, trace, dataset, event and candidate identifiers; timestamps; fixture/source content; URLs; model/provider/prompt details; runner failure codes; queue outcomes; exception data; connection data; and arbitrary input values.
- `consoleTelemetry` must construct a plain object from the exact safe allowlist and reject malformed discriminators or invalid counts. Forged extra properties must never reach console output.
- Telemetry is best effort. A sink or clock exception must not alter the processor result, mask an existing processor error, create retries, or affect cleanup behavior.
- Inject the existing console sink only at the already-gated scheduled composition. Do not add a remote destination, telemetry enable flag, or new configuration. The checked-in Worker remains dormant because it has no fixture catalog or extractor.
- Do not infer extraction quality, factuality, source-health, freshness, event lifecycle, user relevance, safety, or publication status from these operational counts.

## Acceptance criteria

1. The new event is typed, closed and serialized through an exact privacy allowlist; current API, freshness, L1 fixture, L2 and L3 telemetry shapes remain unchanged.
2. Tests cover all five fixed outcomes and the completed-only bounded count shape. Failure codes, queue outcomes and sensitive marker values are never included in telemetry or console output.
3. Gated runtime creation emits no event. Active runtime results and errors are preserved when the sink throws; clock failure does not interfere with processing.
4. Console tests capture the structured object and prove malformed records and forged extra properties cannot leak.
5. No API/DTO/OpenAPI, migration, grant, dependency, provider, source, database runtime, event/publication, Worker schedule, or public behavior changes. The default checked-in Worker remains dormant.
6. Run focused processor/telemetry tests, `npm run typecheck`, `npm run build`, and `git diff --check` in WSL Ubuntu-26.04. Root independently runs the full integrated suite before acceptance.
7. Commit implementation and handoff separately on this branch, with a clean worktree. Do not merge or push.

## Verification and handoff

Use WSL Ubuntu-26.04 with the repository's existing locked dependencies and Node.js `v24.21.0`. Report the branch/worktree, full commit IDs and exact messages, changed paths, actual checks and results, limitations, and any remaining decisions. State clearly that no remote log collection, live processor run, hosted Neon, or Cloudflare scheduled execution was tested.

Stop and report to the root planner if implementation appears to require an API/schema change, new dependency, identifier/content logging, database change, source/provider call, external account operation, paid service, or altered processor gates.
