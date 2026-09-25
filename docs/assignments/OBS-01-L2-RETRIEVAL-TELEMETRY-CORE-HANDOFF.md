# OBS-01-L2-RETRIEVAL-TELEMETRY-CORE — implementation handoff

## Delivery

- Branch: `work/OBS-01-L2-RETRIEVAL-TELEMETRY-CORE`
- Worktree: `D:\Projects\RPL\.codex-build\worktrees\obs-01-l2-retrieval-telemetry-core`
- Implementation commit: `4850da0e0bc3c1967d2c16db1c276cc6640a3339` — `feat(OBS-01-L2-RETRIEVAL-TELEMETRY-CORE): add privacy-safe L2 retrieval telemetry`
- Handoff documentation is committed separately after the implementation.

## Behavior implemented

The closed telemetry union keeps the existing `api_request` record shape and adds `l2_retrieval` success and error records. Success records contain only elapsed time, candidate count, rows examined, truncation flags and the closed semantic-status value. Error records contain only the event name, the fixed error outcome and elapsed time. `consoleTelemetry` builds plain structured objects from explicit per-event allowlists and ignores forged extra fields or invalid retrieval discriminators.

`createCandidateEvidenceRetriever` accepts an injected `TelemetrySink` and defaults to `noOpTelemetry`. It passes the original query object to the repository, returns the exact result object, and emits only the safe summary fields on success. On repository failure it emits only a bounded error record and rethrows the same error. Sink failures are swallowed on both paths so they do not replace the result or repository error. No sufficiency judgment, evidence score, query/source/evidence data, database wiring, or new retrieval behavior was added.

## Changed implementation paths

- `apps/worker/src/layers/l2-model-grounding/retrieval.ts`
- `apps/worker/src/layers/l5-evaluation-monitoring/telemetry.ts`
- `apps/worker/test/l2-evidence-retrieval.test.ts`
- `apps/worker/test/api.test.ts` — updated the recorder typing for the closed telemetry union while retaining API-event assertions.

## Verification

Checks ran in WSL Ubuntu-26.04 with Node.js `v24.21.0`, npm `11.19.0`, and existing locked versions `tsx@4.23.15`, `typescript@7.0.2`, and `wrangler@4.137.0`. No dependency installation or manifest/lockfile change was made.

- `npx tsx --test apps/worker/test/l2-evidence-retrieval.test.ts apps/worker/test/api.test.ts` — passed, 11/11 tests. Coverage includes exact query/result passthrough, success/error record fields, finite non-negative duration, counts/truncation/status, both sink-failure paths, default no-op behavior, privacy markers, API telemetry compatibility, and console allowlists.
- `npm run typecheck` — passed for web, Worker, database, and evaluation TypeScript projects.
- `npm run build` — passed. Vite built the web assets; Wrangler bundled the Worker with `wrangler deploy --dry-run --outdir dist` and exited with `--dry-run: exiting now`.
- `git diff --check` — passed before commit; the staged implementation diff check also passed.

## Limitations and remaining decisions

This is local synthetic-module telemetry. There is no current Worker/database composition path that injects the console sink into L2. The Wrangler dry-run verified the existing configuration and Worker bundle only; no deployment, external account change, or remote log collection occurred. Retrieval accuracy and provider behavior were not evaluated. No migration, configuration, dependency, or source behavior change was required. No design decisions remain within this assignment; the root reviewer owns full integrated verification and acceptance.
