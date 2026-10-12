# AI-01-NINEROUTER-SYNTHETIC-SMOKE

Status: assigned, 12 October 2026. User authorizes a small local integration test using private9router routes; root owns real requests and secrets. This package implements provider-independent synthetic composition only.

## Objective and dependencies

Read SDP first, ADR-054/model plan, L2 contracts/direct-reasoning/context-persistence/planner, then this assignment. Build reusable synthetic fixture/harness exercising existing typed capabilities and the sufficient/insufficient L2 branch; no transport-specific import or live model. Contracts schema2.0/publicv1/planner1.0 unchanged. RAG-01-NINEROUTER-PROVIDER is a separate package; root CLI wires both after acceptance.

Branch/worktree: `work/AI-01-NINEROUTER-SYNTHETIC-SMOKE`, `.codex-build/worktrees/ai01-ninerouter-synthetic-smoke`, exact root planning base. Luna/max implementer, no additional agents. Allowed new files: `tools/ai/ninerouter-smoke.ts`, `tools/ai/ninerouter-fixtures.ts`, `tools/ai/ninerouter-smoke.test.ts`, `tools/ai/tsconfig.json`, plus this assignment. No package/lock/env/Worker/config/schema/DB changes or shared checkout edits. Root owns separate CLI entry, registration, env loading, network and output manifest.

## Shared entry and behavior

Export `runSyntheticModelSmoke(options: {adapter:ModelCapabilityAdapter; planner:InvestigationPlanner; signal?:AbortSignal}): Promise<SyntheticModelSmokeSummary>`. It must not import the future ninerouter transport or read env/fetch/filesystem. Return a closed non-sensitive summary: overall success, each capability status/reason, sufficient/insufficient branch results, lineage checks. No raw model input/output, claimed live incidents or arbitrary generated strings. Expose fixture factories if root needs a test-only manifest identity.

- Use clearly labelled authored Bahasa fixtures with immutable valid Unicode text/hashes/reference spans. Synthetic report dates/time/geometry are explicit data; avoid fabricated real source provenance or inferred danger geography. No source acquisitions or publication calls.
- Invoke exactly one classify, one extract, one evidence-chunk embed, one sufficient-context reasoning, and one insufficient-context planner proposal (at most5 calls on injected providers, serialized). The embedding port is chunk-bound and raw-text; no arbitrary free-text query adapter or fake query lineage.
- Compose the sufficient/insufficient logic through the existing direct-reasoning service and an injected in-memory refs-only context sink. Insufficient context must not invoke the reasoner. Manually invoke the separate planner boundary only after the insufficient result, with a fixed trusted synthetic menu and bounded signal/maxTotalTokens≤12000. Do not execute an action or start an L3 runtime/ledger.
- Typed failures remain failures in the summary; continue unrelated capability probes where possible, no retries/fallback. Check report/chunk/evidence hashes/identities and contrary-evidence preservation; do not present shape/fixtures as semantic accuracy or model evaluation. Distinguish no provider/not configured/errors from success, and never turn an empty success into publication.
- Fixture context sufficiency is explicitly trusted test input, not a model-created factual assertion or a production retrieval-quality result. No DB/Neon/RAG quality claim. Output success means accepted typed local synthetic boundary only.

## Verification and handoff

Use injected scripted test providers. Test actual composition/order/call ceilings, Unicode/hash/reference validity, insufficient reasoner skip, planner menu/abort/token bounds, refs-only context persistence, failures/unknowns and no publication/source/runtime calls. Default mock tests never reach network. No private env reads or external/model/dependency calls.

WSL Ubuntu-26.04/fixed native PATH `/home/perry/.nvm/versions/node/v24.21.0/bin:/usr/local/bin:/usr/bin:/bin`; Node24.21.0/npm11.19.0/existing tsx4.23.15/TypeScript7.0.2. Run `node --import tsx --test tools/ai/ninerouter-smoke.test.ts`, `tsc --noEmit -p tools/ai/tsconfig.json`, staged/base WSL `git diff --check`. No installs. Root registers and reruns integrated tests; root alone uses `.env.local` for a separately bounded synthetic smoke.

Stop/message root for conflicts or contract decisions; continue independent assigned work. Commit coherent implementation/tests and handoff; return exact base/branch/worktree/SHAs/messages/paths/checks/limits/configuration impact. Do not merge/push/deploy/approve own work or spawn agents.

## Root acceptance — 12 October 2026

Local harness accepted after root and independent Luna/max review. Branch `work/AI-01-NINEROUTER-SYNTHETIC-SMOKE`, worktree `.codex-build/worktrees/ai01-ninerouter-synthetic-smoke`, base `64bd95af84c417c436c98a16b2b74e901052b59e`. Only four assigned `tools/ai` files changed; root owns CLI, registration, env template and docs.

- `3e2d404d7999508695a2cc4ea377b91e61f8e02b` — `feat(ai): add synthetic ninerouter smoke harness`
- `7f967f407105c0b2d252d41154774cea1c42e3fc` — `fix(ai): anchor synthetic citation lineage`

Root merges `a31945d8e9b49a488389985345581ef6d42daf43` and `40a1e669ee92526fe0484df30e6e2eccb1ed5fdc` preserve both commits. Final implementer/independent reviewer harness12/12/AI typecheck/diff passed; peer reviewer checked the initial harness and root CLI guards. Root integrated focused39/39 (22 provider,12 harness,5 no-network CLI), Worker516/516, workspace/evaluation/AI typecheck, Worker dry-run and UI/API smoke passed. Default CLI is disabled and makes no request.

The limited fixture oracle accepts relevant whole-report or multiple narrow spans, with identity/hash/Unicode bounds and at least one supports span containing the authored service-topic anchor. In-range disclaimer/emoji references fail it. This checks citation placement for one fixture, not semantic quality. Both paths persist refs-only memory contexts; insufficient skips reasoning and proposes only, never executing an action/publication.

Both real full smokes failed overall; latest v2 passed four model boundaries while extraction timed out25s and again in a separate45s probe. No complete live pass or production RAG readiness is claimed. [Actual probes](../PRIVATE_AI_GATEWAY_TESTING.md) retain failed manifests and remaining gates. Source rights, held-out human evaluation, query embedding and hosted integration remain outside this slice.

Process note: an early worktree repair briefly rewrote Git pointers to WSL paths; the implementer restored Windows paths and used per-command `GIT_DIR`/`GIT_WORK_TREE`/`GIT_COMMON_DIR` afterward. Root verified identities; no history rewrite occurred. One agent turn disconnected during compaction and resumed the same files/branch. Neither event justified model escalation.
