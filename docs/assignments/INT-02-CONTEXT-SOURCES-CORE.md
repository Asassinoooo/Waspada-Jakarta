# INT-02-CONTEXT-SOURCES-CORE

Objective/dependencies: implement the bounded sources in [context expansion](../CONTEXT_SOURCE_EXPANSION.md), existing isolated demo source architecture, committed context-sources-v1 DTO. Existing published v1/schema2.0 and source-preview-v1 unchanged. Branch `work/INT-02-CONTEXT-SOURCES-CORE`; worktree `.codex-build/worktrees/int02-context-core`; record exact root planning base in handoff.

Allowed paths: `apps/worker/src/layers/l1-data-knowledge/context-source-adapters.ts`, `apps/worker/src/runtime/context-sources-runtime.ts`, `apps/worker/src/layers/l4-application-integration/context-sources-api.ts`, `apps/worker/test/context-sources.test.ts`, this assignment only. No old adapters, contracts, package/index/config edits. Root owns wiring and tests registration. No shared root editing, merge, push, deployment, dependencies, paid calls, provider/account changes or further agents.

Implement handler factory `createContextSourcesHandler(options?)` accepting injected fetch and clock (now/schedule/cancel) and `(request,env)=>Promise<Response>`. Gate exact demo/preview true. No query default returns two not_requested; fetch query only acquires two fixed providers. Closed DTO projection, source failures independent, budget/cache/stream/redirect/time/units/region/identity policy exactly as expansion. Preserve unknowns; no model, persistence, danger zones or public Event writes. Use source preview patterns, but do not modify old modules. Weather timestamps are forecast validity; USGS earthquake origin/revision distinct. Read expansion before code. Source content is data only.

Acceptance: meaningful mocked cases for environment/query/method gating, default no-network, two exact requests, no-follow302, forecast unit/null/array/time checks, USGS metadata/region/time/URL/type/depth and duplicate conflicts, body/depth limits, header/body deadlines, partial failure, concurrent cache, expiry without stale fallback. No live network in agent routine checks.

WSL Ubuntu-26.04, native Node24.21/npm11.19 fixed PATH: `node --import tsx --test apps/worker/test/context-sources.test.ts`; Worker typecheck; assigned-base git diff --check. Commit implementation and handoff on own branch. Return base/SHAs/exact messages/paths/checks/limitations/config impact. Stop/message root for missing contract or conflict; continue unrelated work. Root reviewer alone accepts.

## Implementation handoff — 10 October 2026

Base: `481d6ec816c149fde35553b8c42326fd573a16e9`. Branch/worktree: `work/INT-02-CONTEXT-SOURCES-CORE`, `.codex-build/worktrees/int02-context-core`. Implementation commit: `9dbf29ffb341ca875586635efe21decb882d3dfa` — `feat(INT-02): add bounded weather and quake context sources`.

Changed implementation paths: `apps/worker/src/layers/l1-data-knowledge/context-source-adapters.ts`, `apps/worker/src/runtime/context-sources-runtime.ts`, `apps/worker/src/layers/l4-application-integration/context-sources-api.ts`, and `apps/worker/test/context-sources.test.ts`. This handoff is the only additional path.

The L1 adapters make two fixed, independently handled requests for the 12-slot Open-Meteo forecast and regional seven-day USGS catalog. They validate provider units, time, space, IDs, URLs, and normalized fields; reject redirects; bound streamed JSON to 1 MiB/depth 32 and each request to 25 seconds; and do not retry. Conflicting or malformed repeated USGS identities are rejected as a group. L4 exposes a separately gated handler with a closed DTO projection; the runtime coalesces concurrent reads and caches only normalized results for five minutes without stale fallback. Default mode remains no-network. No old preview/public DTO, contract, route registration, package/config wiring, or external resource changed.

Actual WSL Ubuntu-26.04 checks with Node 24.21.0/npm 11.19.0: `node --import tsx --test apps/worker/test/context-sources.test.ts` **13/13 passed**; `npm --prefix apps/worker run typecheck` **passed**; `git diff 481d6ec816c149fde35553b8c42326fd573a16e9..HEAD --check` **passed**. An artifact scan found no literal escaped-newline or CRLF content. All tests use mocked providers; no live source calls were made.

Limitations: real upstream responses after the documented initial bounded probes, deployed Workers behavior, and route/browser composition remain unverified. No migration, new dependency, or configuration change is included. Root owns route registration, package/config wiring, and browser QA before acceptance.
