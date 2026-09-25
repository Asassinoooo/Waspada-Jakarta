# OBS-01-L2-RETRIEVAL-TELEMETRY-CORE — privacy-safe retrieval metrics

**Parent package:** OBS-01 (Layer 5 evaluation and monitoring)
**Status:** Assigned; local synthetic module only
**Implementation model:** GPT-6 Luna, max reasoning
**Branch:** `work/OBS-01-L2-RETRIEVAL-TELEMETRY-CORE`
**Worktree:** `.codex-build/worktrees/obs-01-l2-retrieval-telemetry-core`

## Objective

Extend the existing typed Layer 5 telemetry sink with one bounded retrieval event, then instrument the Layer 2 evidence-retrieval adapter through that injected sink. Capture only safe operational metadata: outcome, elapsed time, candidate count, rows examined, truncation flags, and the closed semantic-status enum. Preserve the retrieved evidence result or original repository error exactly.

This task adds no sufficiency judgment, evidence-quality score, model, database route, source call, or runtime database wiring. The retrieval adapter remains read-only and the telemetry default remains no-op unless a caller explicitly injects a sink.

## Read first and dependencies

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md`
- `ARCHITECTURE.md`
- `docs/IMPLEMENTATION_BACKLOG.md` and this assignment
- `docs/assignments/OBS-01-API-TELEMETRY-CORE.md` and its handoff
- `apps/worker/src/layers/l2-model-grounding/retrieval.ts`
- `apps/worker/src/layers/l5-evaluation-monitoring/telemetry.ts`
- `apps/db/src/evidence-retrieval.ts` (`EvidenceRetrievalResult`)
- `apps/worker/test/l2-evidence-retrieval.test.ts`
- `apps/worker/test/api.test.ts`

Dependencies RAG-CORE, RAG-ACCESS-01, and OBS-01-API-TELEMETRY-CORE are accepted. Use only the existing synthetic test repository/results.

## Allowed paths

- `apps/worker/src/layers/l5-evaluation-monitoring/telemetry.ts`
- `apps/worker/src/layers/l2-model-grounding/retrieval.ts`
- `apps/worker/test/l2-evidence-retrieval.test.ts`
- `apps/worker/test/api.test.ts` only as required to preserve typing after the telemetry union extension
- `docs/assignments/OBS-01-L2-RETRIEVAL-TELEMETRY-CORE-HANDOFF.md`

Do not modify database code, retrieval SQL, OpenAPI/public contracts, Wrangler configuration, lockfiles/dependencies, other services, or unrelated files.

## Telemetry contract and guardrails

- Keep the API request record unchanged. Add a discriminated `l2_retrieval` record to the sink's closed union.
- A retrieval success record may contain only the fixed event name, outcome, finite non-negative duration, candidate count, rows examined, `scanTruncated`, `resultTruncated`, and `semanticStatus` from its closed enum.
- A retrieval error record may contain only the fixed event name, error outcome, and finite non-negative duration. Do not log exception names, messages, stacks, or SQL.
- Never log or forward the retrieval query, identifiers, exact terms, geography, vectors, candidate/source/event/revision IDs, excerpt text, origins, dates, or evidence relations. Do not put dataset identity or user-controlled values in the telemetry.
- `consoleTelemetry` must serialize each event type with an explicit allowlist into a plain structured object. Unknown runtime properties must be ignored.
- The L2 adapter receives a `TelemetrySink` by injection and defaults to `noOpTelemetry`. Whether its caller chooses the console sink remains explicit; there is no current Worker/database composition path.
- Sink exceptions must not replace a successful retrieval result or mask/rewrite the original repository failure.
- No Wrangler, logging plan, or sampling configuration change is needed; Cloudflare's existing 1% head sampling applies to all Worker console telemetry when deployed.

## Acceptance criteria

1. Typed records keep API request telemetry unchanged and constrain L2 retrieval events to the documented safe success/error shapes.
2. Tests cover retrieval success, repository error propagation, duration bounds, counts/truncation/status values, and sink failure on both success/error outcomes.
3. Privacy tests inject query markers and forged runtime properties and prove none reach the telemetry sink/logger.
4. Structured console telemetry logs plain objects with an exact allowlist for each event type.
5. The existing evidence result and query are passed through unchanged; no sufficiency or factuality judgment is added.
6. No route, SQL, schema, database role, migration, dependency, or source behavior changes.
7. Implementer runs focused retrieval/API tests, `npm run typecheck`, `npm run build`, and `git diff --check` in WSL Ubuntu-26.04. Root independently runs the full integrated suite before acceptance. No deployment.

## Verification and handoff

Use WSL Ubuntu-26.04 with existing locked dependencies and the documented Node.js `v24.21.0` runtime. Commit implementation and a separate handoff on the assigned branch. Report both full commit IDs and exact messages, changed files, actual commands/results, and limitations. Do not report remote log collection, model quality, retrieval accuracy, or provider behavior as verified.

Stop and report to the root orchestrator if a schema/API change, new dependency, query/content logging, new database access, external account operation, paid service, or change to the accepted API telemetry configuration appears necessary.
