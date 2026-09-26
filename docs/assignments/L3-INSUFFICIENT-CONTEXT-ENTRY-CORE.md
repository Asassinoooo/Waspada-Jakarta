# L3-INSUFFICIENT-CONTEXT-ENTRY-CORE — open bounded cases from insufficient L2 context

- **Status:** Assigned on `work/L3-INSUFFICIENT-CONTEXT-ENTRY-CORE`
- **Depends on:** L2-DIRECT-REASONING-CORE, RAG-CONTEXT-ASSEMBLY-CORE, L2-CONTEXT-PERSIST-CORE, L3-LEDGER-CORE, OBS-01-L3-LEDGER-TELEMETRY-CORE
- **Requirements:** FR-05/06/07/14; NFR-01/02/05/07
- **Layer:** L3 — bounded investigation entry
- **Implementation model:** GPT-6 Luna, max reasoning
- **Branch/worktree:** `work/L3-INSUFFICIENT-CONTEXT-ENTRY-CORE`; `.codex-build/worktrees/l3-insufficient-context-entry-core`

## Objective

Connect the Layer 2 `investigation_required` outcome to the existing durable L3 ledger. Validate the persisted context identity and insufficiency state, derive bounded non-content question references, then call the injected `InvestigationLedgerRepository.create` with explicit policy, budget, ID and time inputs. The database remains the authority for confirming the context exists, is insufficient, and matches dataset/candidate/trace.

This entry slice creates or idempotently replays a case only. It does not choose tools, call a model, fetch sources, enqueue work, refresh grounding, or publish. Ambiguous event matches, missing investigation questions, or excess questions return a typed review-required result rather than guessing or truncating.

## Read first

- `AGENTS.md` and `SOFTWARE_DEVELOPMENT_PLAN.md`
- `docs/IMPLEMENTATION_BACKLOG.md`, `docs/ARCHITECTURE_ALIGNMENT.md`, `docs/DOMAIN_MODEL.md`, and `docs/UX_API_SPEC.md`
- `docs/assignments/L2-DIRECT-REASONING-CORE.md` and handoff
- `docs/assignments/RAG-CONTEXT-ASSEMBLY-CORE.md` and handoff
- `docs/assignments/L3-LEDGER-CORE.md` and handoff
- `docs/decisions/ADR-014-l3-investigation-ledger.md`
- `apps/db/src/investigation-ledger.ts` (`InvestigationLedgerRepository`, `CreateInvestigationInput`)
- `apps/db/src/grounding-contexts.ts` (`GroundingContextRecord`)
- `apps/worker/src/layers/l2-model-grounding/direct-reasoning.ts`, `contracts.ts`, and `context-persistence.ts`
- `apps/worker/src/layers/l3-investigation/contracts.ts` and `telemetry.ts`

## Required behavior

- Accept the typed `investigation_required` result from `createDirectReasoningService`; do not accept a direct-reasoning success as an investigation entry.
- Check exact agreement between the in-memory grounding request and the persisted record for schema version, record type, dataset, trace, context, candidate and `sufficient`. Require `sufficient === false`. On any mismatch, fail closed before the ledger call.
- Build investigation questions only from the counts/positions of `missingFields` and `conflicts`, using stable labels such as `missing_field_1` and `conflict_1`. Never copy evidence text, raw conflict strings, prompts, URLs, or source text into the ledger question list.
- Require 1–20 generated questions. If none exist or more than 20 would be required, return a closed `review_required` result and do not silently invent or truncate questions.
- Use the sole candidate event ID/version only when exactly one candidate event is present. If multiple event matches exist, return `review_required` without choosing one. If none exists, pass the required `(null, null)` event pair.
- Require explicit caller values for investigation ID, requested time, policy version and budget limits. Do not reset, enlarge, or default limits; let the existing ledger validate policy/budget maxima and preserve exact replay/conflict behavior.
- Map dataset, trace, candidate and context IDs from the persisted record. Pass the injected ledger's returned checkpoint through unchanged. Propagate ledger errors unchanged.
- Use `createTelemetryInvestigationLedgerRepository` for optional write telemetry where instrumentation is requested; do not emit a duplicate manual L3 event from this entry adapter.
- Test with synthetic schema 2.0 requests and an injected in-memory ledger fake. These tests verify mapping and guard behavior, not PGlite transactions, human review, model quality, or source accuracy.

## Allowed paths

- `apps/worker/src/layers/l3-investigation/entry.ts` (new)
- `apps/worker/test/l3-insufficient-context-entry.test.ts` (new)
- `apps/worker/package.json` — test discovery only
- `docs/assignments/L3-INSUFFICIENT-CONTEXT-ENTRY-CORE-HANDOFF.md` (new)

Do not change database code, migrations, roles/grants, schema/OpenAPI contracts, L2 logic, L3 ledger behavior, tool/provider adapters, API routes, UI, source ingestion, dependencies, credentials, external services or deployment. If the current persisted identity or ledger contract cannot support the entry boundary, stop and report the exact gap.

## Acceptance and checks

- Tests prove exact field mapping, event pair handling for zero/one/multiple candidates, safe deterministic question labels, and error passthrough.
- Tests prove sufficient or mismatched contexts never create an investigation; ambiguous event matches and question-count edge cases return `review_required` without truncation.
- Tests prove replay arguments remain identical and no raw report/conflict text is copied into questions.
- Run the focused Worker test, `npm test`, `npm run typecheck`, `npm run build`, and WSL Ubuntu-26.04 `git diff --check` using native Node.js `v24.21.0` and npm `11.19.0`.
- Commit implementation and handoff separately on the assigned branch, leave a clean worktree, record exact commits/checks/limitations, and do not push or merge. Root reviews and integrates.

## Handoff

Report branch/worktree, commit SHAs/messages, exact input/output mapping, review-required conditions, test results and limitations. State explicitly that this adds case entry only: no planner, tool executor, external source, L3 loop, model call, route, or publication behavior.
