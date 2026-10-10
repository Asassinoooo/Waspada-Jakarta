# INT-01-SOURCE-PREVIEW-CORE

Objective: bounded real-source preview with L1 adapters and a separate L4 handler; never incident publication. Dependencies: accepted INT-01 fixtures, `docs/DEMO_DATA_INTEGRATION.md`, committed source-preview-v1 contract and real OSM snapshot. Contract: `apps/worker/src/contracts/source-preview.ts`; existing public v1/schema 2.0 unchanged.

Branch `work/INT-01-SOURCE-PREVIEW-CORE`, worktree `.codex-build/worktrees/int01-source-preview`. Base: planning commit containing this assignment (record exact SHA in handoff). Allowed paths: `apps/worker/src/layers/l1-data-knowledge/source-preview-adapters.ts`, `apps/worker/src/layers/l4-application-integration/source-preview-api.ts`, `apps/worker/src/runtime/source-preview-runtime.ts`, `apps/worker/test/source-preview.test.ts`, this assignment's handoff only. No package/index/config/snapshot/contract edits; root owns wiring and test registration.

Acceptance: follow operating budget and source policy in integration spec. Factory `createSourcePreviewHandler(options?)` returns `(request, env) => Promise<Response>`, accepting injected fetch/clock for tests. Exact demo + exact true flag; snapshot default; `mode=fetch` only accepted query; fixed endpoints; five-minute normalized cache, in-flight coalescing, no retry/fallback, bounded streaming/timeout, sanitized failure. Distinguish source empty/error, partial-source success and rejected records. Deduplicate identities deterministically; reject contradictory duplicates rather than overwrite them. JSON remarks/provider errors cannot become empty. Validate DTO and snapshot. PetaBencana unwrap `statusCode:200, result:FeatureCollection`, point-only flood reports; timestamps must be parseable source instants, no future observations; preserve status as publisher-only. No report text/photo/identity/user link. OSM source centre explicitly labelled. No source network access in agent tests; mocked fetch only. No model/persistence/auth/publication mutation.

Verification in WSL Ubuntu-26.04: existing Node `/home/perry/.nvm/versions/node/v24.21.0/bin` in PATH, existing root dependencies. `node --import tsx --test apps/worker/test/source-preview.test.ts`; Worker typecheck; base diff check. Add meaningful tests for gating, query, streamed oversized body, timeout/body deadline, unsafe fields, malformed coordinates/times, duplicate conflicts, partial failures, cache and concurrent calls. Commit coherent implementation and handoff. Stop for missing decision/contract conflict and contact root; no dependencies, deployment, provider configuration, push, merge or further agents.

## Handoff

### Branch and commits

- Branch: `work/INT-01-SOURCE-PREVIEW-CORE`
- Worktree: `D:/Projects/RPL/.codex-build/worktrees/int01-source-preview`
- Implementation base: `0270af0c0b0233f467bcf680315f3df49f76a331`
- Base adjustment: the original assignment named `95c4113490cf41b920978811184fde312534d43e`; the orchestrator fast-forwarded this branch/worktree to `0270af0c0b0233f467bcf680315f3df49f76a331` before implementation so the exact `source_created_at` contract and snapshot were in place. No legacy `observed_at` compatibility was added.
- Implementation commit: `153739ee5684f7f6eba7cffbc87d16443b5cdeab` — `feat(INT-01): implement bounded source preview core`
- Correction commit: `56f2509c2f6d8d222a77ed54cd7e4ea04c8dba72` — `fix(INT-01): correct preview cleanup and handoff scope`
- Worker compatibility fix: `c8cb9de2521269d78518bacb643d85e8dd579d7e` — `fix(INT-01): use workerd-compatible redirect mode`
- Scope correction: commit `821633c39b977c043691b9590362e67eb21f779c` (`docs(INT-01): record source preview handoff`) initially added a separate handoff file, outside the assignment's allowed paths. This correction moves its delivery record into this section and removes that file without rewriting history. The same correction commit includes the requested early-response abort cleanup and regression checks, plus the fixed 24-hour flood filter on the PetaBencana request.

### Changed paths and behavior

- `apps/worker/src/layers/l1-data-knowledge/source-preview-adapters.ts`: validates the committed OSM snapshot and normalizes bounded OSM and PetaBencana responses into allowlisted records. It rejects malformed, out-of-window, stale/future and contradictory records; deduplicates identical records; drops raw report fields; keeps OSM extent centres distinct from point coordinates; and preserves PetaBencana report creation time as `source_created_at` rather than physical observation time. Its fixed PetaBencana request filters Jakarta floods to `timeperiod=86400`. Each upstream request has its own 25-second deadline and abort signal, including streamed body reads, and cleanup aborts that request on early response rejection. Responses are limited to 1 MiB, JSON nesting and record counts are bounded, redirects and Overpass remarks/provider errors fail closed, and errors are sanitized.
- `apps/worker/src/runtime/source-preview-runtime.ts`: coalesces concurrent fetches and reuses one normalized result for five minutes without stale fallback. Expired cache references are cleared on the next snapshot or fetch access. Expiry controls reuse; absent another request, the in-memory object may remain until isolate disposal. No durable storage or background purge timer is used.
- `apps/worker/src/layers/l4-application-integration/source-preview-api.ts`: exports `createSourcePreviewHandler(options?)`; gates the route to exact demo/feature-flag values, defaults to the dated snapshot, permits only `?mode=fetch`, rejects mutations, validates the final DTO, and returns sanitized errors.
- `apps/worker/test/source-preview.test.ts`: adds 13 mocked-provider tests for the route gates, snapshot, exact source requests, privacy projection, partial failures, redirect rejection, early-rejection abort cleanup, provider errors, date and coordinate filters, contradictory duplicates, body limits, independent deadlines, cache coalescing and stale-refresh behavior.

For unavailable providers, `fetched_at` carries the request-start timestamp for the failed attempt; it does not assert successful acquisition. The response also carries `status: unavailable` and a sanitized error code.

### Verification

Environment versions: WSL Ubuntu-26.04; Node.js `v24.21.0`; npm `11.19.0`; TypeScript `7.0.2`; tsx `4.23.15`; Wrangler `4.137.0`. No dependency was installed or changed.

- `PATH="/home/perry/.nvm/versions/node/v24.21.0/bin:$PATH" node --import tsx --test apps/worker/test/source-preview.test.ts` — passed, 13/13 after the Worker compatibility fix.
- `PATH="/home/perry/.nvm/versions/node/v24.21.0/bin:$PATH" npm run typecheck --workspace=@waspada/worker` — passed.
- `git diff --cached --check 0270af0c0b0233f467bcf680315f3df49f76a331` — passed before the implementation commit.
- `git diff --check 0270af0c0b0233f467bcf680315f3df49f76a331 56f2509c2f6d8d222a77ed54cd7e4ea04c8dba72` — passed after the scope and cleanup correction; the final changed-path set contains only the three assigned source files, the assigned test, and this assignment's handoff section.

Unit tests use mocked fetch responses only. The bounded runtime diagnosis made two requests to the fixed PetaBencana endpoint, recorded status/error metadata only, and did not read or retain either provider body; no further source requests were made. The full Worker suite and Wrangler dry-run were not run by this task; root owns integrated verification.

### Worker runtime diagnosis

A minimal Wrangler `4.137.0` Worker in this worktree used the same module-time `globalThis.fetch.bind(globalThis)`, fixed PetaBencana request, identifying User-Agent and 25-second abort. Two isolated runs made one fixed request each; both threw `TypeError` before receiving a response. The final run's sanitized message was `Invalid redirect value, must be one of "follow" or "manual" ("error" won't be implemented since it does not make sense at the edge; use "manual" and check the response status code)`; there was no cause name or code. No provider body was read or retained. This identifies a workerd `RequestInit` incompatibility rather than a fetch-binding or provider-outage problem. Both adapters now use `redirect: "manual"`; their non-2xx check rejects 3xx responses without following them. A mocked regression test verifies that behavior.

### Integration and remaining work

No dependency, migration, secret, environment configuration, Worker entrypoint or test-registration changes are included. Root owns wiring the handler into the Worker route and configuration, registering the focused test in the Worker test script, reviewing the branch, and running integrated checks. Live hosted access still needs the later quota/terms review described in `docs/DEMO_DATA_INTEGRATION.md`.
