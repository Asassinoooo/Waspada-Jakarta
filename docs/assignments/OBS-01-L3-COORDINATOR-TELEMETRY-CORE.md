# OBS-01-L3-COORDINATOR-TELEMETRY-CORE — bounded telemetry for coordinator advances

- **Status:** Assigned for implementation
- **Backlog ID:** `OBS-01-L3-COORDINATOR-TELEMETRY-CORE`
- **Parent:** OBS-01 / FR-14 / NFR-04/07
- **Implementation model:** GPT-6 Luna, max reasoning
- **Branch:** `work/OBS-01-L3-COORDINATOR-TELEMETRY-CORE`
- **Worktree:** `.codex-build/worktrees/obs-01-l3-coordinator-telemetry-core`
- **Base:** The exact `main` commit containing this assignment, supplied by root at dispatch.
- **Contract baseline:** Existing `InvestigationCoordinator` port and typed Layer 5 telemetry sink. Do not change Layer 3 outcome or public/persisted contract versions.
- **Dependencies:** `L3-COORDINATOR-CORE`, `OBS-01-API-TELEMETRY-CORE`, `OBS-01-L3-LEDGER-TELEMETRY-CORE`, [ADR-050](../decisions/ADR-050-l3-coordinator-outcome-telemetry.md).

## Objective

Add an opt-in Layer 5 decorator for the bounded coordinator port. It records one closed outcome and elapsed duration per `advance` call while preserving the exact returned outcome or original exception. This slice does not add a runtime caller or claim operational/quality results.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md`
- `docs/IMPLEMENTATION_BACKLOG.md`
- `ARCHITECTURE.md`
- [ADR-050](../decisions/ADR-050-l3-coordinator-outcome-telemetry.md)
- `docs/assignments/OBS-01-L3-LEDGER-TELEMETRY-CORE.md`
- `apps/worker/src/layers/l3-investigation/contracts.ts`
- `apps/worker/src/layers/l3-investigation/coordinator.ts`
- `apps/worker/src/layers/l5-evaluation-monitoring/telemetry.ts`
- existing telemetry producer tests and `apps/worker/package.json`

## Allowed paths

- `apps/worker/src/layers/l5-evaluation-monitoring/telemetry.ts`
- A new `apps/worker/src/layers/l3-investigation/coordinator-telemetry.ts`
- A new focused `apps/worker/test/l3-coordinator-telemetry.test.ts`
- `apps/worker/package.json` only to register the focused test
- This assignment's **Implementation handoff** section only

Do not edit `coordinator.ts`, DB code, migrations, roles/grants, APIs/OpenAPI, model/source/provider code, other telemetry producers, Worker entrypoints/runtime bindings, Wrangler configuration, dependencies/lockfiles, or root-owned planning documents. If a required behavior needs a disallowed path or changes the coordinator contract, stop and report the exact gap.

## Required behavior

1. Extend the existing closed telemetry union with `l3_coordinator_advance`, preserving all existing event types and validators.
2. Wrap the existing `InvestigationCoordinator` interface; call its `advance` method exactly once and emit at most one event. Emit `continue`, `sufficient_context`, or `review_required` for a valid returned outcome and `error` for a thrown error or malformed runtime outcome.
3. The event must contain exactly the event name, closed outcome, and finite non-negative duration. Do not inspect or emit the input. Do not include case status, review reason, IDs, dataset, budget counters, report/evidence content, prompts, model/tool names, or error details.
4. Use the existing no-op-default sink. Telemetry, clock, or validation failures must never change the original result or thrown error. Invalid telemetry is dropped.
5. The console sink must construct an allowlisted plain object and reject forged extra fields or unknown runtime discriminators.
6. Do not add a caller or runtime composition, and make no quality, cost, safety, Cloudflare, Neon, or live-source claim.

## Acceptance criteria

- Focused tests cover all three valid outcome statuses, thrown-error identity, exact result identity, one call/at most one event, malformed outcomes, invalid duration, clock failure, sink failure, and unknown/forged telemetry fields.
- Existing API, L2, L3 ledger, freshness, and synthetic-poll telemetry contracts and tests remain unchanged.
- Only the allowed paths change; no migration, dependency, configuration, runtime, public contract, provider, source, or external service is added.
- In WSL Ubuntu-26.04 with existing dependencies, run the focused test, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD`. Record actual Node/npm versions and results; do not install dependencies.

## Stop and handoff

Stop if privacy requires adding identifiers or branch-specific coordinator details, if telemetry would alter coordinator behavior, or if an out-of-scope contract/runtime change is needed. Commit implementation and handoff separately on this task branch. Do not merge or push. Handoff with branch/worktree, exact base, full commit SHAs and messages, changed paths, behavior, actual WSL commands/results and versions, limitations, configuration/migration impact, and remaining decisions. Root independently reviews and integrates.

## Implementation handoff

Implemented on branch `work/OBS-01-L3-COORDINATOR-TELEMETRY-CORE` in worktree `/mnt/d/Projects/RPL/.codex-build/worktrees/obs-01-l3-coordinator-telemetry-core`, from assigned base `bf4eafa99f11f207be140bdfb4492cc43cd0bc20`.

- **Implementation commit:** `5505d80dd8f10538d2c29e818949c88d0b5f356a` — `feat(OBS-01): add coordinator advance telemetry`
- **Handoff commit:** `fb2104d229b22542e1cf6b5aef8c0c401aa535f0` — `docs(OBS-01): record coordinator telemetry handoff`
- **Final handoff metadata commit:** `41ddb5bf216cc4b7ac6dde91929257190117fd96` — `docs(OBS-01): complete coordinator handoff metadata`
- **Changed paths:** `apps/worker/package.json`; `apps/worker/src/layers/l3-investigation/coordinator-telemetry.ts`; `apps/worker/src/layers/l5-evaluation-monitoring/telemetry.ts`; `apps/worker/test/l3-coordinator-telemetry.test.ts`; this handoff section.

The opt-in decorator wraps the existing coordinator port and emits one `l3_coordinator_advance` record with a closed outcome and finite, non-negative duration. It passes the exact result object or thrown error through unchanged, maps malformed outcomes and thrown errors to `error`, and isolates clock and sink failures. Validation checks the closed status envelope, status-specific exact top-level keys, required own plain-record presence, and the closed review-reason set. It deliberately leaves nested record semantics to the coordinator, L2, and database contracts. The existing no-op sink remains the default; console output is built from an exact allowlist and drops forged fields and unknown outcomes.

Checks ran in WSL Ubuntu-26.04 with Node.js `v24.21.0` and npm `11.19.0`:

- `npm exec --workspace=@waspada/worker -- tsx --test test/l3-coordinator-telemetry.test.ts` — passed, 8/8.
- `npm test` — passed, exit 0; Worker 448 tests, database 40/40 files, evaluation 19 tests; web workspace also ran.
- `npm run typecheck` — passed, exit 0.
- `npm run build` — passed, exit 0; includes typecheck, Vite build, and Wrangler dry-run.
- `git diff --check bf4eafa99f11f207be140bdfb4492cc43cd0bc20..41ddb5bf216cc4b7ac6dde91929257190117fd96` — passed, exit 0, on the final handoff metadata commit (independently verified during review).

No migration, configuration, dependency, runtime composition, API/public contract, provider/source, or external-service change was needed. No Worker caller or remote log destination was added. Hosted logging and Cloudflare execution remain unverified; the telemetry is operational and makes no quality, cost, or safety claim.

## Root review and acceptance

Root reviewed and integrated the three agent commits on local `main` as `9c2f06f` (implementation), `9762a60` (handoff), and `c6a26b4` (final handoff metadata). Independent code review found no actionable implementation issue; its environment lacked a Linux Node runtime, so the reviewer could not reproduce tests. Root independently ran the full suite, typecheck, build, and final assigned-base diff check in WSL Ubuntu-26.04 with the toolchain listed above. The task remains opt-in with no runtime caller, remote sink, or hosted behavior claim.
