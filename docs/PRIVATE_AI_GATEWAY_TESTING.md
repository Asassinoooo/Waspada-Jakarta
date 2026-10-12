# Private 9router integration test

This local command connects the existing typed L2 capabilities and investigation planner to Team 12's configured gateway. It is a synthetic compatibility test, separate from the map/source demo. It does not acquire source reports, write a database, execute an investigation tool, publish an event, or configure Cloudflare/Neon/Tailscale.

## Routes and model profiles

| Boundary | Route | Requested model |
| --- | --- | --- |
| Chat discovery | `GET /v1/models` | `Waspada-Jakarta` |
| Embedding discovery | `GET /v1/models/embedding` | `gemini/gemini-embedding-2-preview` |
| Classification, extraction, grounded reasoning, planner | `POST /v1/chat/completions` | `Waspada-Jakarta`, separate versioned instructions |
| Evidence-chunk embedding | `POST /v1/embeddings` | `gemini/gemini-embedding-2-preview`, scalar raw text, 768 dimensions |

The preview route is the user's explicit test selection. No stable-model substitution or cross-model fallback is allowed. The chat alias is a gateway combo: its declared 128,000 context and returned model name do not prove pinned upstream weights. A weekly curation change needs another bounded test and later human-labelled evaluation.

## Run from WSL

Use Ubuntu-26.04, native Linux Node 24.21.0/npm 11.19.0 and the existing installed dependencies. From `/mnt/d/Projects/RPL`, first run the safe default:

```bash
npm run ai:smoke
```

It returns `disabled` without reading credentials or making requests. Real tests require the explicit command:

```bash
npm run ai:smoke:live
```

The live command loads ignored root `.env.local`. Required backend-only variables are `NINEROUTER_URL` and `NINEROUTER_KEY`; the URL may end at the origin or `/v1`. See the blank [environment template](../.env.example). Never use browser `VITE_` variables or commit credentials. Optional `NINEROUTER_CURATION_EPOCH` is a non-secret selection label of at most 64 characters. Without it, the manifest explicitly records a test-run tag, not an operator-confirmed curation epoch.

HTTPS and loopback HTTP are accepted. This user-authorized local CLI explicitly opts into HTTP for literal IPv4 addresses in `100.64.0.0/10`, the tailnet address range. The factory default denies this opt-in; public/LAN HTTP and DNS aliases remain rejected. Address range alone does not establish tailnet membership. No network configuration or HTTPS bridge is created.

## Test flow and bounds

1. Confirm both exact aliases through catalog reads.
2. Classify and extract metadata from an authored Bahasa Indonesia synthetic report.
3. Embed its exact evidence chunk, preserving Unicode spans and hashes.
4. Persist a refs-only context in memory and invoke grounded reasoning on the fixture's sufficient branch, retaining contrary evidence.
5. Persist the insufficient fixture context, skip reasoning, and ask the separate planner for one trusted-menu proposal or abstention. No action is dispatched.

The harness invokes five capability boundaries serially, with no retries. A transport instance allows at most eight HTTP attempts including failures and catalog reads; seven requests are intended. Each request has a 25-second deadline in this CLI. Planner cancellation is propagated; the other typed capability interfaces have per-request transport deadlines. Chat calls reserve input UTF-8 bytes plus framing and output before sending, within the existing 12,000-token application cap. Embedding rejects raw text above 8,192 UTF-8 bytes without clipping; this conservative reservation is not measured token usage.

Chat must return one strict JSON object and valid positive, sum-consistent gateway-reported usage. Output allowance is at most4,096 tokens, reduced as needed within the caller/input/12k bound. Classification/extraction v2 includes deterministic full-report citation candidates beside unchanged source data; these are location hints, not verified support. Relevant full-report citations or known exact narrower spans are allowed, with no guessed offsets. Reasoning v2 describes exact nested types and copies retrieved references. Invalid JSON, references, identity, budgets or usage remains failure. Embedding must return one finite nonzero768-dimensional vector and a compatible reported model identifier. Its route does not supply reliable token usage, so accounting stays `unavailable`, never measured zero. `X-9Router-Token-Saver: off` disables the documented saver; hidden router rewrites, retries and combo fallback are not independently verified.

User-reported Google Free quotas are 100 RPM / 30,000 TPM / 1,000 RPD. The proposed shared 80% allocation is not an implemented global quota ledger. This command is for occasional small tests, not unattended ingestion or load testing.

## Results and limitations

The CLI stores a closed private run manifest in ignored `.codex-build/ai-gateway-smoke/`. It binds synthetic fixture hashes/trace/candidate/context IDs to model/profile tags, safe transport observations, capability/lineage status and call counts. It excludes endpoint, key, headers, raw prompts/responses and vectors. Each run receives a new file; failures return a nonzero exit code.

### Actual local probes — 12 October 2026

**No complete live smoke passed.** The latest v2 smoke accepted classification, embedding, sufficient-context reasoning and planner, but extraction timed out. Both full runs correctly returned a nonzero exit code and attempted no action/publication.

| Probe | Application HTTP attempts | Actual result |
| --- | --- | --- |
| Initial catalog-only probe | 2 GETs | Both exact aliases present; combo declares128,000 context. |
| Initial live CLI before tailnet opt-in | 0 | Configuration rejected HTTP outside loopback; fixed by the reviewed private opt-in, without changing network settings. |
| Full smoke, v1 profiles | 7 | Typed classification/extraction,768-dimensional embedding and planner accepted. Extraction failed the fixture citation-placement oracle; reasoning was `invalid_output`. Overall failure. |
| Separate v1 diagnostics | 2 chat calls | Extraction transport `invalid_response` afterHTTP200; reasoning accepted a valid abstention. No raw outputs retained or printed. |
| Full smoke, v2 profiles | 7 | Classification, embedding, sufficient reasoning, insufficient reasoner skip and planner accepted. Extraction `timeout` at25,002ms. Overall failure. |
| Separate v2 extraction latency probe | 1 chat call | `timeout` at45,006ms; no accepted extraction result or measured usage. |
| User-requested extraction with no client deadline | 1 chat call | Native Node HTTP, `clientDeadlineMs:null`. Completed after75,773ms withHTTP200, but the transport/parser returned `invalid_response` and the adapter returned `provider_error`. No accepted schema2.0 extraction or measured usage. |
| User-requested extraction with no client deadline or output-limit parameters | 1 chat call | Sent only `model`, `messages`, `stream`. Completed after6,499ms withHTTP200; schema2.0 extraction and exact source lineage accepted. Reported usage927 input /555 output /1,482 total tokens. |

Total:21 application HTTP attempts including catalogs/failed calls, with2 embedding calls. Each full run stayed within its own8-attempt ceiling; each separately authorized no-deadline diagnostic allowed exactly one extraction request. No application retry/fallback was enabled. Hidden gateway/provider attempts are unknown. These diagnostics do not change the smoke CLI's25-second deadline, local pipeline's25/26-second gateway/wait limits or L3 budgets.

The two ignored full-run manifests are `smoke-20261012T033519680Z.json` and `smoke-20261012T034959318Z.json`. They retain the failed results; the later run took about41.8 seconds in total. Reported model names differed across operations, so the run does not establish a pinned upstream identity; labels alone do not prove which weights ran. Embedding reported the requested native preview identifier and768 dimensions in both runs; token usage remains unavailable.

A later extraction-only diagnostic passed, as recorded below; neither complete live smoke passed. Further real tests require their own bounded assignment. Client deadlines do not prove upstream work terminated. No model/router configuration was changed, and these small samples do not identify the cause of the earlier failures or establish a failure rate.

## Diagnostic and code verification

### No-deadline extraction diagnostic — actual result

On12 October2026, the user explicitly requested extraction without timeout. The reviewed diagnostic adds `timeoutMs:null` as a trusted transport option, preserving undefined/numeric defaults. A separate Node HTTP/HTTPS transport uses `agent:false` and `timeout:0`, no connection/header/body timers, one attempt, no redirects/retries and a256KiB response cap. SIGINT/SIGTERM can cancel it. Only the authored extraction fixture is sent; there are no discovery, embedding, reasoning, database, source or publication calls.

```sh
# Safe default, disabled and no credentials/request:
npx tsx tools/ai/run-extraction-probe.ts

# Explicit user-authorized synthetic diagnostic; may wait until response/cancellation:
node --env-file=.env.local --import tsx tools/ai/run-extraction-probe.ts --live --no-timeout
```

The single real request ran08:21:05.897–08:22:21.671UTC and returnedHTTP200 after75.773seconds. It failed as `provider_error` / `invalid_response`; usage remained unavailable and no typed extraction was accepted. The safe ignored manifest is `.codex-build/ai-extraction-probe/probe-d1254051-b3cc-45c9-8b4d-c3375cbc5778.json`. It records the fixture hash/identity, no client deadline, native transport, elapsed time and closed observation, without raw response or errors. The content-free manifest does not identify which response/envelope/content check failed, so this result must not be attributed specifically to malformed model JSON or a particular upstream model. Gateway/upstream/OS/network limits remain outside this client setting. Removing the client deadline did not produce a usable extraction in this attempt; no second request was made.

Luna/max implementation `eea2d90` (`feat(ai): add opt-in no-deadline extraction probe`) on its isolated branch was independently reviewed and merged at `29ca903`. Root focused provider/probe/old smoke-CLI checks45/45, Worker517/517, all workspace/tool typecheck and Worker dry-run passed in WSL. The independent reviewer passed focused28/28, AI/Worker typechecks and disabled CLI. No new dependency, router setting, public/domain contract, hosted resource or database change occurred. See [assignment/handoff](assignments/AI-01-EXTRACTION-NO-DEADLINE-PROBE.md).

### No deadline or output-limit parameters — successful rerun

At the user's follow-on request, an explicit diagnostic flag removes output-control parameters from the extraction request. The trusted provider option defaults false and applies to extraction only. The wire payload contains exactly `model`, `messages` and `stream:false`; it omits `max_tokens`, `max_completion_tokens`, `max_output_tokens`, `stop` and sampling controls. No application timer, retry or other capability is added. The former4,096 output-token acceptance check is skipped only in this mode. The schema2.0 total-usage ceiling of12,000 remains a post-response application validation, not a sent generation parameter; the256KiB response cap also remains.

```sh
# One explicitly authorized synthetic extraction, without client timers or output-limit fields:
node --env-file=.env.local --import tsx tools/ai/run-extraction-probe.ts --live --no-timeout --omit-output-limits
```

Root ran this once at09:17:56.824–09:18:03.324UTC on12October2026. It passed after6,499ms withHTTP200. The manifest confirms the exact three wire keys, `finishReason:stop`, one choice, nonempty JSON content and reported usage927 input /555 output /1,482 total tokens. The typed schema2.0 `ExtractionResult` has matching candidate/revision/hash identity, category `utilities_essential_services`, three tags and one `supports` reference covering the unchanged125-code-point synthetic report. Event-time precision remains unknown and no geographic entity/geometry is produced. This diagnostic validates schema and source-reference identity/ranges; it does not run the separate semantic-support oracle or establish factual quality.

The ignored content-free manifest is `.codex-build/ai-extraction-probe/probe-1045be92-c8de-4ffe-ab42-58f3d9f800be.json`. No raw response, provider error, endpoint or key is retained in it or committed. There were no embedding, reasoning, planner, source, database or publication calls. The successful sample does not prove that removing `max_tokens` caused the improvement: the combo's upstream selection is unpinned and these were separate requests. Earlier failures and production deadlines remain recorded and unchanged; a complete live pipeline is still unverified.

Luna/max implementation `ec6af2ebd84c50096349526503a7866208606ff7` (`feat(ai): omit extraction output limits in probe`) changed the same four assigned paths and was independently reviewed before root merge `45ecded`. Agent and independent reviewer passed focused29/29, AI/Worker typechecks and disabled-default CLI. Root passed expanded focused46/46, Worker518/518, AI/Worker typechecks, Worker Wrangler dry-run and diff checks in WSL Ubuntu-26.04. The unchanged web/DB suites were not rerun for this diagnostic. No dependency, public/domain contract, hosted resource or router configuration changed.

### Earlier adapter/harness verification

Final checks in WSL Ubuntu-26.04: Worker suite516/516; focused provider/harness/CLI suite39/39 (22 provider,12 harness,5 CLI); all-workspace/evaluation/AI typecheck; Worker Wrangler4.137.0 dry-run; UI/API smoke; and disabled-default CLI passed. Mocked CLI checks explicitly preload a disabled fetch implementation, so they cannot contact a provider. Existing dependencies only: Node24.21.0/npm11.19.0, tsx4.23.15 and TypeScript7.0.2. The unchanged web/DB suites were not rerun for this slice; no hosted check or deployment was performed. A passing code suite does not override the failed live smokes.

A passing run establishes typed synthetic compatibility only. Context sufficiency is fixture input; this command does not measure retrieval quality, source factuality, held-out Bahasa accuracy, production L3 recovery, hosted connectivity or publication safety. Free-text query embeddings need their own private typed port; the evidence-chunk port must not receive fabricated query lineage. See [ADR-054](decisions/ADR-054-private-model-gateway-testing.md) and [the model integration plan](AI_MODEL_INTEGRATION_PLAN.md).
