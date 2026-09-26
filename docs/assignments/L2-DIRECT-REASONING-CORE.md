# L2-DIRECT-REASONING-CORE — persist grounded context before direct reasoning

- **Status:** Assigned on `work/L2-DIRECT-REASONING-CORE`
- **Depends on:** L2-ADAPTER-01, L2-CONTEXT-BRIDGE-CORE, RAG-CONTEXT-ASSEMBLY-CORE, OBS-01
- **Requirements:** FR-05/06/07/14; NFR-01/02/07
- **Layer:** L2 — model grounding and direct reasoning
- **Implementation model:** GPT-6 Luna, max reasoning
- **Branch/worktree:** `work/L2-DIRECT-REASONING-CORE`; `.codex-build/worktrees/l2-direct-reasoning-core`

## Objective

Add a small injected service that composes the existing validated reasoning-context persister with `ModelCapabilityAdapter.reason`. Persist every valid context before any model call. A context whose caller-supplied `sufficient` value is false must return an explicit `investigation_required` result and must never call the reasoner. A sufficient context may call the injected reasoner once and return its typed capability outcome. No source text, retrieval, agent tools, L3 coordinator, L4 policy, publication, route, or external provider is added.

The service preserves `sufficient` as a caller-owned input; it must not infer, adjust, or describe the value as calibrated. The existing adapter remains responsible for validating provider output against only references in the supplied context. Synthetic provider doubles are tests, not a live model integration or quality result.

## Read first

- `AGENTS.md` and `SOFTWARE_DEVELOPMENT_PLAN.md`
- `docs/IMPLEMENTATION_BACKLOG.md`, `docs/ARCHITECTURE_ALIGNMENT.md`, `docs/DOMAIN_MODEL.md`, and `docs/UX_API_SPEC.md`
- `docs/assignments/L2-ADAPTER-01.md`, `docs/assignments/L2-CONTEXT-BRIDGE-CORE.md`, `docs/assignments/RAG-CONTEXT-ASSEMBLY-CORE.md`, and their handoffs
- `apps/worker/src/layers/l2-model-grounding/contracts.ts`, `adapter.ts`, `validation.ts`, `context-persistence.ts`, and `grounding-context.ts`
- `apps/worker/src/layers/l5-evaluation-monitoring/telemetry.ts`
- `apps/worker/test/l2-model-grounding.test.ts` and `apps/worker/test/l2-context-persistence.test.ts`

## Required behavior

- Accept an untrusted request through the existing `ReasoningContextPersister`; do not duplicate or weaken validation.
- Persist the canonical refs-only context before branching or calling the model. Keep evidence excerpts/provenance only in the validated in-memory request.
- If the validated context says `sufficient: false`, return `investigation_required` with the persisted context and validated request; call `ModelCapabilityAdapter.reason` zero times.
- If it says `sufficient: true`, call `ModelCapabilityAdapter.reason` exactly once with that validated request and return the adapter's exact typed outcome. Preserve explicit unavailable, invalid-output and provider-error states; do not fabricate an empty success.
- If request validation or context persistence fails, do not call the reasoner. Propagate the original error object unchanged.
- Do not create or modify proposals outside the existing validated `ReasoningResult`; do not call L3, classify investigation sufficiency, decide publication eligibility, or write L4 records.
- Add bounded L2 reasoning telemetry using the existing injected `TelemetrySink`: closed outcome and finite duration only. Do not record prompts, text, evidence/source/event/case IDs, provider/model names, token content, exception messages, or arbitrary output. The default is no-op; telemetry failure must not change the service result or the original thrown error. Extend `consoleTelemetry` only with the exact documented allowlist.
- Test only synthetic requests and a scripted provider double in test code. No real provider selection, key, network call, human label, source-rights claim or quality claim.

## Allowed paths

- `apps/worker/src/layers/l2-model-grounding/direct-reasoning.ts` (new)
- `apps/worker/test/l2-direct-reasoning.test.ts` (new)
- `apps/worker/src/layers/l5-evaluation-monitoring/telemetry.ts`
- `apps/worker/package.json` — test discovery only
- `docs/assignments/L2-DIRECT-REASONING-CORE-HANDOFF.md` (new)

Do not change model or public API contracts, OpenAPI, the schema/validator, retrieval/assembly behavior, database code or migrations, grants, L3/L4, UI, source ingestion, dependency files, provider configuration, credentials, cloud resources, or deployment. If the existing capability contracts cannot support this composition without a contract change, stop and report the exact gap.

## Acceptance and checks

- Tests prove insufficient context persists first and skips reasoning, while sufficient context persists first and calls reasoning once.
- Tests prove explicit `not_configured`, provider-error and invalid-output results are preserved; validation/persistence errors prevent model invocation and retain object identity.
- Tests prove safe closed telemetry, no identifying/content fields, no-op default, and sink failure cannot mask results/errors.
- Run focused L2 tests, `npm test`, `npm run typecheck`, `npm run build`, and WSL Ubuntu-26.04 `git diff --check` with Node.js `v24.21.0` and npm `11.19.0`.
- Commit implementation and this handoff separately on the assigned branch, leave a clean worktree, and record exact SHAs/messages, files, checks, and limitations. Do not push or merge; root reviews and integrates.

## Handoff

Record branch/worktree, implementation/handoff SHAs and messages, behavior, exact test results, telemetry fields, and limitations. State explicitly that no live provider, L3 coordinator, application route, publication, deployment, or model-quality claim was added.
