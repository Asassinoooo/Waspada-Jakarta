# RAG-01-NINEROUTER-PROVIDER

Status: assigned, 12 October 2026. User explicitly authorizes integrating/testing their private gateway with root `.env.local` variables `NINEROUTER_URL` / `NINEROUTER_KEY`, chat alias `Waspada-Jakarta`, embedding route `gemini/gemini-embedding-2-preview`. Root's WSL catalog-only probe found both routes (chat owned by combo, context_length128000); no inference yet. This overrides the earlier documentation-only boundary for this bounded local synthetic assignment.

## Objective and authority

Implement a Worker-compatible, provider-injected fetch transport behind existing L2 `UntrustedModelProvider` and `InvestigationPlanProvider`. No HTTP route, Worker binding, database, source acquisition, public contract, schema-2.0 change, dependency, hosted configuration or publication activation. No free-text query embedding port; raw evidence chunks only in this slice. Root alone owns private endpoint calls and final acceptance.

Read SDP first, ADR-054, AI_MODEL_INTEGRATION_PLAN, existing adapter/contracts/validation/planner, then this assignment. Dependencies: existing L2/planner contracts; schema2.0/publicv1 unchanged. Models/context/usage are untrusted. Strict application parsers remain the authority for output shape and references; JSON is not factual proof.

Branch/worktree: `work/RAG-01-NINEROUTER-PROVIDER`, `.codex-build/worktrees/rag01-ninerouter-provider`, from root's exact planning commit. Luna/max implementation agent; no additional agents. Allowed new paths: `apps/worker/src/layers/l2-model-grounding/ninerouter-provider.ts`, `apps/worker/test/ninerouter-provider.test.ts`, and this assignment. No existing contracts/adapter/planner/package/config/CLI edits. Root registers test scripts and integrates.

## Shared factory interface

Export `createNinerouterProvider(config: NinerouterProviderConfiguration, fetchImpl?: typeof fetch): NinerouterProviderBundle`.

Configuration fields: `baseUrl`, `apiKey`, `chatModel`, `embeddingModel`, `curationEpoch` (all strings), optional `timeoutMs`, `maxHttpRequests`, `onObservation`. Use fixed768 embedding dimensions/raw-text profile and no prefix mutation. Logical test route/epoch tags in configuration are not reproducible upstream weight IDs. Bundle fields: `provider: UntrustedModelProvider`, `plannerProvider: InvestigationPlanProvider`, `configuration: ModelAdapterConfiguration`, `plannerMetadata: InvestigationPlannerMetadata`, and `discoverModels(): Promise<NinerouterDiscovery>`.

Root compatibility decision after the first live CLI attempt: add private `allowTailnetHttp?:boolean`, default false. HTTPS and loopback HTTP remain allowed. With explicit opt-in only, permit a literal IPv4 address in RFC6598 `100.64.0.0/10`; outside addresses and HTTP DNS names remain denied. The user's configured gateway is in this range; the initial attempt failed before HTTP/inference. This range check is not proof of tailnet membership, so it is restricted to the user-authorized local test; no network/provider configuration changes. Root CLI opts in, reviewer verifies boundaries, and the manifest records the opt-in without storing an endpoint.

Discovery closed fields: `chatFound:boolean`, `embeddingFound:boolean`, `chatContextLength:number|null`, `chatIsCombo:boolean`; inspect only requested aliases via `/v1/models` / `/v1/models/embedding`. No account/credential/configuration reads or writes. Keep base-path handling valid when configured root ends in `/v1` or `/v1/`.

Export a closed non-sensitive `NinerouterObservation` type suitable for a private run manifest: capability/requested route, optional safe reported response model, outcome/reason, HTTP status if available, duration, optional gateway-reported usage or explicit unavailable usage, vector dimensions if available. No URL/key/header/raw input/output/error body, no fabricated usage. The embedding adapter has no usage field; keep its accounting observation separate. Treat chat usage as gateway-reported, not independently measured provider tokens.

## Required behavior

- Validate trusted configuration, bounded input/request body/response, positive limits and single-origin controlled paths. Authorization from backend-only config; manual redirects; bounded deadline and planner caller signal. Suppress sensitive raw error/cause messages and credentials in observations; do not log. No retries, fallback, tool execution or external settings changes. Count failed HTTP attempts against an8-request per-instance limit (2 catalog reads + up to5 model calls intended), with serialized calls or explicit concurrency denial.
- Discovery GETs only. Embed POST `/v1/embeddings`: requested exact route, scalar raw chunk text, dimensions768, float output. Require one indexed finite nonzero vector of exact dimension; return only `{vector}` to the existing L2 parser. Keep source hashes/spans unchanged and report zero/missing embedding usage as unavailable, not measured zero cost.
- Chat POST `/v1/chat/completions`: `stream:false`, requested exact alias, separate versioned system profiles for classify/extract/reason/plan; source/context JSON stays data. Disable gateway token savers with `X-9Router-Token-Saver: off`. Do not register or call tools; planning returns only proposed action/abstention.
- Prompts describe the exact existing output shapes/enums/source references/unknowns. Strictly parse one JSON object from message content; reject extra commentary/fences/refusal/empty/malformed body. No silently repaired output. Do not modify application validators to make provider output pass.
- Require valid positive finite integer chat input/output/total usage with sum consistency and no known estimated/zero/fake usage. Enforce existing12k total boundary, conservative input-byte reservation plus output allowance before request, caller planner maxTotalTokens and cancellation. Missing usage fails closed; do not manufacture tokens. Current app profiles support short bounded synthetic inputs, not full128k prompts.
- Logical configuration provider/version/prompt identity stays fixed for this synthetic test. Observe the gateway-reported response model separately; don't claim combo selection/fallback is pinned upstream. No production activation or source factuality/quality guarantee.

## Checks and handoff

Meaningful mocked tests: route/auth/base-path/dimension/scalar mapping; separate profiles/unchanged source data; strict JSON/envelope/usage/vector validation; no output repair/secret leaks/redirect/fallback/retry; byte/body ceilings, missing/bad configuration, attempt budget including failures, timeout/cancellation, missing aliases/metadata, planner caller limits; composition with existing validating adapters/planner. No private env/endpoint/provider/tiles/model calls by agents.

WSL Ubuntu-26.04 only; fixed PATH `/home/perry/.nvm/versions/node/v24.21.0/bin:/usr/local/bin:/usr/bin:/bin`, Node24.21.0/npm11.19.0, existing tsx4.23.15/TypeScript7.0.2. Run `node --import tsx --test apps/worker/test/ninerouter-provider.test.ts`, `npm run typecheck --workspace=@waspada/worker`, staged/base `git diff --check` using correct WSL Git worktree paths. No installs. Root runs integrated checks and bounded live smoke.

Stop/message root for scope/contract conflicts or substantive failures; continue independent work. Commit coherent code/test and handoff on own branch; return exact SHAs/messages, allowed paths, actual checks/limitations/configuration impact. Never merge/push/approve own implementation or use private root env. Unknown user gateway behaviors remain root's probe responsibility.

## Root acceptance — 12 October 2026

Local transport accepted after root and separate Luna/max review; live end-to-end compatibility remains incomplete. Branch `work/RAG-01-NINEROUTER-PROVIDER`, worktree `.codex-build/worktrees/rag01-ninerouter-provider`, base `64bd95af84c417c436c98a16b2b74e901052b59e`; only the provider and test files changed.

Verified task commits and exact messages:

- `d65b3c4abe665cec2fc8d4d7c59e7cd7449241a8` — `feat(RAG-01): add bounded 9router provider transport`
- `479878e8ed7ec714bc7f56553a05014a17fdf4b1` — `fix(RAG-01): bound embedding input and sanitize model metadata`
- `1d4acef41c8a827d4db1c182efda13e0011f556c` — `fix(RAG-01): reject unsafe configured route labels`
- `e62dd957121a8ede3e96f46392eff30cfaf988ce` — `fix(RAG-01): gate private tailnet HTTP explicitly`
- `df3d7d5623672754ae70cdc597ad79a302466751` — `fix(RAG-01): improve prompt fidelity and bounded chat output`

Root merges preserve all commits: `f30c68cec07add3116a45d25358c444b0abd7307`, `0d42a00a06720c565173413920ebaa9458484962`, and `21e704490ceddd1d35a8f3e680375030784f53db`. No implementer approved or pushed their own work. Independent reviewer reran final provider22/22, Worker typecheck and base diff; root integrated focused39/39 and Worker516/516, workspace/evaluation/AI typecheck, Worker dry-run and UI/API smoke passed in WSL. Node24.21.0/npm11.19.0/existing dependencies only.

Accepted follow-up design: v2 classification/extraction input includes deterministic full-report citation bounds beside unchanged source data, with relation still model-proposed and unsupported facts unknown; v2 reasoning describes exact nested/time/reference types. Output allowance4,096 stays within conservative input/caller/12k bounds. Generic validators, contracts and strict JSON/no-repair behavior are unchanged. HTTP tailnet opt-in is defaultfalse and literal/canonical/range-bounded.

Root-only synthetic probes confirmed both aliases and768-dimensional preview embedding. Latest v2 full smoke accepted classification/reasoning/planner but extraction timed out25s and a separate45s probe also timed out. Both full live smokes remain failed; no source/DB/action/publication/cloud configuration changed. Actual attempts/limitations are in [the guide](../PRIVATE_AI_GATEWAY_TESTING.md). Production routing/accounting, held-out quality and extraction availability remain gates; no schema/migration/dependency impact.
