# AI-01-EXTRACTION-NO-DEADLINE-PROBE

Diagnostic implementation accepted and one real probe completed12 October2026; the live probe failed validation. Parent AI-01/RAG-01 gates remain unchanged.

User request: run extraction without timeout. Objective: one separately opt-in, authored synthetic extraction request through `Waspada-Jakarta`, using the existing request/profile and typed output validation. No client wall-clock deadline for this diagnostic; the gateway/upstream may still impose its own limits. Production/local scheduler defaults stay bounded. No retries, discovery, embeddings, reasoning, database writes, source collection or publication.

Dependencies: accepted RAG-01-NINEROUTER-PROVIDER, AI-01 synthetic fixtures, domain2.0/publicv1 unchanged. Existing Node24.21.0/tsx/TypeScript only; WSL Ubuntu-26.04. Native Node HTTP transport must not add connect/header/body timers, must reject redirects and oversized responses, and must support user cancellation without leaking errors.

Luna/max implementation on an isolated branch/worktree. Allowed: `apps/worker/src/layers/l2-model-grounding/ninerouter-provider.ts`, `apps/worker/test/ninerouter-provider.test.ts`, `tools/ai/run-extraction-probe.ts`, `tools/ai/extraction-probe.test.ts`. Add explicitly nullable transport timeout for diagnostics, retaining default/numeric bounds. Reuse provider formatting, request budgets, observations and application parser; one-request ceiling. The probe defaults disabled and requires explicit live/no-timeout flags. Persist only a safe ignored manifest with elapsed time, closed outcome, fixture identity/hash and typed field/lineage summaries; no key, endpoint, prompts/raw output or raw errors. Root alone runs the authorized real probe from ignored root environment after review.

Acceptance: mocks prove delayed extraction completes without an app deadline, existing deadlines still abort, cancellation is supported, invalid output remains failure, defaults make no HTTP request and one call/no retry is enforced. Root independently reviews before live execution and records actual elapsed time/result, commits and remaining gates. No assertion that one successful diagnostic fixes the25/45-second latency failures or complete live pipeline.

```sh
export PATH=/home/perry/.nvm/versions/node/v24.21.0/bin:/usr/local/bin:/usr/bin:/bin
npx tsx --test apps/worker/test/ninerouter-provider.test.ts tools/ai/extraction-probe.test.ts
npx tsc --noEmit -p tools/ai/tsconfig.json
npm run typecheck --workspace=@waspada/worker
```

Stop for required contract/source/provider-resource changes. No dependency install, credentials access, provider calls, merge, push, cloud changes or additional agents by implementer. Return exact commits/messages/paths/actual checks/limitations. Root can cancel a pending real request if instructed by the user; elapsed tool yields are not request timeouts.

Handoff: `codex/ai-01-extraction-no-deadline` / `.codex-build/worktrees/extraction-no-deadline`, commit `eea2d90d680120fc05f95b17328c44edbd3f82ff` — `feat(ai): add opt-in no-deadline extraction probe`, exactly the four assigned files. Agent and independent Luna/max reviewer each passed focused28/28, AI and Worker typechecks, disabled CLI and diff checks in WSL/native Git as appropriate; neither called the real provider. Root merged at `29ca903` after review and passed focused45/45, Worker517/517, workspace/tool typecheck and Worker dry-run. Root added the probe's mocked tests to the standard test command.

Actual authorized probe: one HTTP attempt, no client deadline, native Node HTTP, synthetic125-code-point fixture,75,773ms elapsed,HTTP200, `provider_error` / `invalid_response`, unavailable usage, no accepted extraction schema/lineage. No retry or other capability ran. Safe manifest and exact scope are recorded in [the gateway guide](../PRIVATE_AI_GATEWAY_TESTING.md). The response was not retained, so the failing response check and upstream cause remain unknown. This is a diagnostic delivery, not a fixed extraction latency/compatibility or full live-pipeline gate.

## Follow-on: omit generation limit parameters

User explicitly requests one rerun without `max_tokens` or any other output-limit parameter, still without timeout. Assignment keeps this stable task ID and the same four allowed implementation paths. Root updates the isolated task worktree to the current baseline. Implement a separate explicit `--omit-output-limits` diagnostic opt-in, preserving other callers. The outbound extraction payload must contain only model, messages and stream; no token/output/stop/sampling constraint is added. Request count remains one; no retry or other capabilities/resources are authorized.

Reuse the existing no-deadline native transport and typed output validation. Omission must not accidentally retain the previous4096 output allowance as a response-acceptance check. The unchanged schema2.0 total-usage validity/budget remains an application check, not a parameter sent to the model. Record that distinction and any resulting typed failure explicitly. Record omitted parameter names/closed payload keys and optional content-free response shape (finish reason mapped to a fixed enum, nonempty-content/JSON/usage booleans); never raw output, key, URL or provider errors. Mocks must prove omission, retained default4096 behavior, cancellation and no retries. Root independently reviews, runs exactly one authorized real request, and logs actual results/commits. No source, database, publication, router setting, contract version or dependency change.
