# PLATFORM-01 — Cloudflare Workers and Neon Free compatibility report

**Assessment date:** 24 September 2026
**Status:** Conditional fit; provider compatibility is not validated
**Scope:** Local measurements and current official documentation only. No account, database, secret, billing change, deployment, paid model, or live source was used.

## Finding

The local BOOT-01/UI-00 shell builds and its fixture-backed read routes pass tests and smoke checks. Published limits leave plausible headroom for a small class demonstration with bounded reads, scheduled work, model use, and retention. This is not an operational capacity result: the repository has no database adapter, Hyperdrive configuration, durable Workflow, Cron poller, or model call. Provider-side CPU, SQL, Workflow, compute, transfer, cold-start, and inference usage remain unmeasured.

Keep Cloudflare Workers and Neon Free as a conditional prototype target. The required 30-day encrypted off-provider backup and deletion-replay procedure is not implemented or rehearsed. Persist synthetic or historical demo records only until that gate passes; live-source persistence remains blocked. Paid plans, prepaid credits, and automatic paid fallback are outside scope.

## 1. Local prototype measurements

The tested runtime is a Vite React client and Wrangler local Worker with synthetic demo data and two GET routes. No database, source poller, Workflow, authentication, production publication, or AI integration is implemented.

**Environment:** WSL Ubuntu-26.04; native Linux Node.js 24.21.0, npm 11.19.0, Git 2.53.0; locked Vite 8.3.0 and Wrangler 4.137.0. Worktree is mounted under /mnt/d. Timings use Node fetch/performance against Vite's localhost proxy: one first-observed request followed by 50 sequential warm requests per route; p50/p95 use nearest-rank percentiles.

| Local route | Result and response size | First observed | 50 warm requests, p50 / p95 |
| --- | --- | ---: | ---: |
| GET /api/v1/context | HTTP 200; 106 bytes | 50.465 ms | 15.469 / 18.332 ms |
| GET /api/v1/events | HTTP 200; 1,403 bytes | 17.460 ms | 16.372 / 21.086 ms |

The timings include the Node client, localhost networking, Vite proxy, local Wrangler, and WSL scheduling. They are not Cloudflare CPU time, public latency, concurrent-load performance, Neon query time, or Neon transfer size. The first observation is not a Neon cold start. Vite briefly logged proxy connection refusals while Wrangler started; after readiness all measured/smoke requests returned 200.

| WSL check from assigned worktree | Result |
| --- | --- |
| npm run typecheck | Passed for web and Worker |
| npm test | Passed: 9 tests (5 web, 4 Worker) |
| npm run smoke | Passed against local Vite/Wrangler; read routes, demo banner, mobile switch, honest empty state |
| npm run build | Passed: Vite build and Wrangler deploy dry-run; no deployment |
| Vite output | HTML 0.64 kB; CSS 21.41 kB (4.81 kB gzip); JS 259.69 kB (77.59 kB gzip) |
| Wrangler dry-run bundle | 9.46 KiB uncompressed (3.19 KiB gzip); local DATASET_MODE=demo binding only |

These are local artifact sizes. Cloudflare's 64 MiB Worker-size and one-second startup ceilings are official limits; local bundle size does not measure deployed startup time.

## 2. Current official limits and capability

Provider documentation was accessed 24 September 2026. Published ceilings do not guarantee account availability, capacity, latency, or fit of this unimplemented application.

| Area | Official Free limit/capability | Local status and implication |
| --- | --- | --- |
| Workers requests/assets | 100,000 Worker requests/account/day, reset at 00:00 UTC. Static asset requests are free and unlimited when served as assets; API requests invoking Worker code count. | Local only; hosted request counts unknown. |
| Workers execution | 10 ms active CPU/invocation, 128 MB/isolate, 50 external and 1,000 Cloudflare-service subrequests/invocation, six outbound connections concurrently waiting for response headers. | No provider CPU, memory, or subrequest metrics. Keep public reads small and deterministic. |
| Cron Triggers | Up to 5 triggers/Free account; run on UTC time. | The project plan proposes BMKG every 2 minutes, PetaBencana every 5 minutes, and news/traffic every 10 minutes. These intervals are unvalidated proposals, not commitments; Cron does not guarantee exact freshness. |
| Workflows | Free includes 3,000 billable steps/day (billing effective 10 Aug 2026), 1 GB-month state, 100,000 executions/day shared with Workers requests, 1,024 steps/instance, 100 MB persisted state/instance, and 10 ms CPU per step. Retries and rollback handlers do not count toward billed steps. | No Workflow is implemented. Provider retry billing does not change the project rule: failed L3 attempts count against the persisted investigation budget. |
| Hyperdrive | Free includes 100,000 SQL statements/day, resetting 00:00 UTC. Queries, mutations, and schema statements count; cached and uncached queries count. Pooling uses transaction mode; session state is reset when a connection returns to the pool. | No SQL/driver is implemented; statements per read and pool behavior are unknown. |
| Workers AI | 10,000 Neurons/day free allocation, reset 00:00 UTC; exhausted calls fail. Some models require paid billing or prepaid credits. | No model is chosen or called. On quota/access failure, hold work for review; never select a paid model automatically. |
| Neon compute | 100 CU-hours/project/month; autoscaling up to 2 CU (about 8 GB RAM); mandatory scale-to-zero after five minutes idle. CU-hours = compute size × active hours. | No DB or Hyperdrive pool exists. Wake delay, duty cycle, CU use, and pool interaction are unknown. |
| Neon storage/network | 0.5 GB storage and 5 GB public transfer/project/month. Growth writes fail at the storage cap. Compute or transfer exhaustion suspends compute until the monthly period resets or the plan changes. | No schema, rows, indexes, vectors, SQL result traffic, or growth is measured. The 1,403-byte API response is not a DB-size or Neon-egress measure. |
| Neon recovery/metrics | Free has up to 6 hours of instant-restore history capped at 1 GB of changes, one manual snapshot, one day of monitoring; scheduled backups are unavailable. | Does not meet the team's 30-day off-provider backup objective. No backup, restore, or deletion replay was tested. |
| Neon extensions | Current matrix: PostGIS 3.3.3 on PG14–16, 3.5.0 on PG17, 3.6.0 on PG18; pgvector 0.8.0 on PG14–17, 0.8.6 on PG18. Neon documents PostGIS on any Neon project and pgvector on every plan. | Promising documented capability; no PostgreSQL version selected and no extension/query tested on a Free project. |
| Paid boundary | Cloudflare Workers Paid minimum is $5/month/account; some AI models/access above the free quota require paid billing. | Explicitly excluded; quota exhaustion must not enable paid usage. |

Sources are linked in [REFERENCES.md](../REFERENCES.md). Neon’s current plan table (updated 17 Sep 2026) and Free-plan FAQ (updated 23 Sep 2026) state 100 CU-hours/project. An August 2025 pricing article stated 50; Neon’s November 2025 update said compute doubled to 100. The current plan table and FAQ resolve that historical discrepancy.

## 3. Low-volume sensitivity scenarios

These are arithmetic examples, not accepted user counts, benchmarks, or forecasts. The project plan proposes polling BMKG every 2 minutes, PetaBencana every 5 minutes, and news/traffic every 10 minutes; these are not validated commitments. Expected audience and production load remain unspecified.

Assume 10 API reads per active user/day. Static asset requests are excluded; background invocations also consume the shared Workers/Workflows request ceiling.

| Illustrative users/day | Reads/user/day | API requests/day | Share of 100,000 |
| ---: | ---: | ---: | ---: |
| 100 | 10 | 1,000 | 1% |
| 1,000 | 10 | 10,000 | 10% |
| 5,000 | 10 | 50,000 | 50% |
| 10,000 | 10 | 100,000 | 100% |

Hyperdrive read-cap sensitivity, excluding source jobs: 1 statement/read permits 100,000 reads/day; 2 permits 50,000; 5 permits 20,000; 10 permits 10,000. The current API has no SQL; DATA-01/API integration must measure actual query counts and include moderation, source work, and retries.

For scheduled acquisition sensitivity, assume one workflow execution per tick at each proposed interval and 10 billable steps per run. Both values are illustrative: actual steps/run and whether sources share one Workflow schedule or use separate schedules have not been measured. Separate source-specific schedules at the same interval multiply the relevant estimate by their count; combining sources may change steps/run.

| Source group in plan | Proposed interval | Runs/day per schedule | Assumed billable steps/run | Illustrative steps/day | Share of 3,000/day |
| --- | ---: | ---: | ---: | ---: | ---: |
| BMKG | 2 minutes | 720 | 10 | 7,200 | 240% |
| PetaBencana | 5 minutes | 288 | 10 | 2,880 | 96% |
| News/traffic | 10 minutes | 144 | 10 | 1,440 | 48% |

Under this placeholder, the proposed 2-minute BMKG schedule alone exceeds the 3,000-step daily allowance; the 5-minute PetaBencana schedule nearly consumes it. These figures exclude any additional investigation or maintenance work. The proposals remain unchanged in the project plan and are not approved service commitments. Each instance is also limited to 1,024 Free steps; no real step count or retry/replay behavior was tested.

Neon’s 100 CU-hours permits at most 400 active hours/month at 0.25 CU, 200 at 0.5 CU, 100 at 1 CU, or 50 at 2 CU. Continuously active 0.25 CU over 30 days would use 180 CU-hours, above Free. Actual traffic, idle periods, cold starts, and pool behavior must be measured after authorized integration. The 0.5 GB storage and 5 GB transfer caps are known, but there is no DB schema or workload to estimate row/index/vector growth or SQL response bytes. Evenly dividing 5 GB by 30 yields about 167 MB/day only as arithmetic; actual daily use will not be even.

## 4. Quota response and user-visible behavior

These are required integration behaviors, not quota paths exercised in this spike.

| Failure | System response | User/moderator behavior |
| --- | --- | --- |
| Worker request/CPU limit | Fail API work; no scraping or inference in a public read handler; avoid retry storms. | Keep static shell where available; show data unavailable/unknown, never an all-clear. |
| Workflow step/state/subrequest limit | Stop at persisted checkpoint, retain usage/stop reason and existing L3 budget; escalate unresolved gaps. | Show source freshness as stale/unavailable; do not publish unfinished claims. |
| Cron limit or delay | Use few UTC schedules, record last successful fetch and failures. | Do not promise polling cadence; freshness remains distinct from lifecycle/relevance. |
| Hyperdrive cap/connection failure | Stop DB work; no provider substitution or paid fallback. | Data unavailable if it cannot be read; do not label old data current. |
| AI quota/model access | Keep case unresolved or use only an implemented deterministic path; send to moderation. | AI unavailable/review-needed; no unsupported claim is published. |
| Neon compute/transfer suspension | Stop persistence, intake, and publication until service recovers and state is checked. | Explicit unavailable/last-update state, not current coverage. |
| Neon storage cap | Pause growth writes before cap where possible; preserve evidence/audit data. | Reads only while compute works; hold intake/proposals. |
| Extension or backup gap | Fail migration/recovery gate; keep persistence synthetic-only. | Do not invent geometry or claim 30-day recovery. |

Provider errors to normalize include Workers Error 1027 for daily request exhaustion, Error 1102 for CPU/memory limits, Workers AI HTTP 429 for exhausted Neurons, and HTTP 403 for models requiring paid access.

## 5. Decision and remaining gates

**Decision:** retain Workers + Neon Free as the no-cost prototype target, recorded as plausible for a bounded demo but not verified. Local fixture checks pass; documentation does not prove Worker CPU fit, query counts, Workflow fit, extension availability on the chosen PG version, Indonesian model quality, Neon cold-start latency, or quota-failure behavior.

Before live-source persistence or a deployment claim, authorized follow-up must: select a Neon PostgreSQL major and run migrations plus spatial/vector queries on Free; integrate the chosen driver via Hyperdrive and measure statements, result bytes, pool/session behavior, and warm/cold latency; implement and measure bounded source/L3 Workflows including retries and persisted budgets; measure deployed CPU/memory and exercise failure paths without paid fallback; choose a model only after Indonesian evaluation and Free quota measurement; and rehearse free encrypted off-provider backup, 30-day retention, restore, tombstones, and deletion replay.

Unresolved inputs include audience, per-user read rate, validation/selection of proposed polling intervals, route SQL count, retained-data volume, DB region, model/version, quota headroom, map/geocoder terms, and backup destination. Live-source persistence remains blocked until the recovery gate passes.
