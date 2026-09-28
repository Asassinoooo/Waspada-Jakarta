# OBS-01-L1-FIXTURE-TELEMETRY-CORE — privacy-safe synthetic pipeline metrics

**Parent package:** OBS-01 (Layer 5 evaluation and monitoring)  
**Status:** Planned; no implementation accepted  
**Implementation model:** GPT-6 Luna, max reasoning  
**Branch:** `work/OBS-01-L1-FIXTURE-TELEMETRY-CORE`  
**Worktree:** Dedicated task worktree branched from the assignment commit; never edit the root checkout.

## Objective

Add an opt-in telemetry seam to the bounded Layer 1 synthetic fixture job runner. Emit one safe summary for each invocation, including idle and rejected/failed work. Preserve the runner's existing outcome and acknowledgement behavior. This is local operational instrumentation for synthetic fixtures; it does not add a source connector, make a factual-quality claim, or enable telemetry by default in a runtime composition.

## Read first and dependencies

- Local `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md`, then `docs/IMPLEMENTATION_BACKLOG.md`
- `ARCHITECTURE.md` and `docs/DOMAIN_MODEL.md`
- `docs/assignments/L1-FIXTURE-RUNNER-CORE.md` and its accepted handoff
- `docs/assignments/OBS-01-L3-LEDGER-TELEMETRY-CORE.md` and its accepted handoff
- `apps/worker/src/layers/l1-data-knowledge/synthetic-fixture-runner.ts`
- `apps/worker/src/layers/l5-evaluation-monitoring/telemetry.ts`
- `apps/worker/test/synthetic-fixture-runner.test.ts`
- `apps/worker/package.json`

Dependencies `L1-FIXTURE-RUNNER-CORE` and `OBS-01-L3-LEDGER-TELEMETRY-CORE` are accepted. Use only authored synthetic fixtures and existing mock ports. No source rights, human labels, external model, cloud resource, live data, or database is required.

## Allowed paths

- `apps/worker/src/layers/l1-data-knowledge/synthetic-fixture-runner.ts`
- `apps/worker/src/layers/l5-evaluation-monitoring/telemetry.ts`
- `apps/worker/test/l1-fixture-runner-telemetry.test.ts` (new focused tests)
- `apps/worker/package.json` (test script only)
- `docs/assignments/OBS-01-L1-FIXTURE-TELEMETRY-CORE-HANDOFF.md` (implementation handoff)

Do not modify queue or pipeline behavior, database files/migrations, API or domain contracts, other telemetry producers, Worker runtime composition, Wrangler settings, dependency versions/lockfiles, external services, or unrelated documentation. Root owns the backlog acceptance entry and delivery log.

## Telemetry contract and guardrails

- Add a closed `l1_synthetic_fixture_job` record to the existing telemetry union. Keep API, L2, and L3 record shapes unchanged.
- Record one of the fixed outcomes `idle`, `completed`, `not_eligible`, `lost_lease`, or `failed`, plus a finite non-negative duration. Include bounded completion counts and the `empty` flag only for `completed`. If recording a failure code or queue outcome, validate it against a closed allowlist derived from the runner's stable result types.
- Never record or forward a trace ID, job/candidate/report/source/revision ID, URL, source name, permitted text, raw payload, model/provider detail, exception name/message/stack, timestamp, or any caller-controlled value. Do not derive factuality, source health, evidence sufficiency, freshness, user safety, or model quality from these operational results.
- The runner accepts an injected `TelemetrySink` and defaults to `noOpTelemetry`. Emit best-effort: a throwing sink or invalid telemetry must not alter any result, queue transition, retry, acknowledgement, or error redaction.
- The console sink must serialize the event into an exact plain-object allowlist and drop forged extra properties and invalid runtime discriminators.
- Keep the event explicitly synthetic-only. Do not wire it to live ingestion or change the Worker entrypoint's sampling/logging configuration. No remote collection is tested.

## Acceptance criteria

1. The record is typed and runtime-validated; existing telemetry event contracts remain intact.
2. Tests cover exactly one event for completed, empty-completed, idle, not-eligible, lost-lease and failed outcomes, with valid duration and only outcome-appropriate counts.
3. Tests verify the runner returns its existing result unchanged when a sink throws, including stable failure redaction and queue acknowledgement behavior.
4. Privacy tests prove URLs, fixture text, IDs, raw exception markers and forged fields do not enter console telemetry; exact structured field names are asserted.
5. Telemetry stays opt-in/no-op by default; no live source, runtime composition, L3 orchestration, publication, schema, migration, public API, model, dependency or deployment changes.
6. In WSL Ubuntu-26.04, run the focused runner/telemetry tests, full Worker tests, `npm run typecheck`, `npm run build`, and `git diff --check`. Root independently runs the integrated workspace suite before acceptance.
7. Commit implementation and handoff as coherent descriptive commits on the task branch. Leave the worktree clean; do not merge or push.

## Stop conditions and handoff

Stop and report to the root planner if implementation would require changing runner/queue semantics, adding content or identifiers to telemetry, broadening beyond the synthetic runner, changing a stable contract, adding a dependency, configuring a runtime/provider, accessing source data, or using a paid/external service. Escalate to GPT-6 Astra xhigh only if Luna max attempts a substantive technical problem and cannot resolve it.

The handoff must report the branch and worktree, full commit SHAs and exact messages, changed paths, implemented behavior, actual WSL commands/results and runtime versions, limitations, configuration/migration impact, and remaining decisions. Do not claim remote log collection or production integration was verified.
