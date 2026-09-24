# ADR-010 — Cloudflare Workers and Neon Free target

- **Status:** Accepted as the no-cost prototype target; PLATFORM-01 found bounded-demo fit plausible, while provider fit remains unverified. No provider resources were created.
- **Date:** 24 September 2026
- **Owners:** Team 12; platform implementation led by Jesaya and Perry

## Context

The user selected Cloudflare and Neon Free for later deployment and requires the planned system to work without a paid tier. This is a class prototype handling a bounded demonstration dataset. It must retain the five logical AI layers, L1 source processing outside L3, L2 grounding before investigation, and a deterministic L4 publication gate. The current repository contains specifications and fixtures, not a running system.

Current provider documentation lists these Free ceilings: Workers has 100,000 requests/day, 10 ms active CPU per invocation, 128 MB memory, 50 external subrequests and six simultaneous outbound connections waiting for response headers. A Free account has up to five Cron triggers. Workflows has 3,000 billable steps/day, 1,024 steps per instance, and 1 GB-month of persisted state; retries are excluded from billable step count. Hyperdrive has 100,000 SQL statements/day. Neon has 100 CU-hours, 0.5 GB storage and 5 GB public network transfer per project/month; compute scales to zero after five idle minutes, restore history is limited to six hours or 1 GB of changes, and one manual snapshot is included. Workers AI provides 10,000 Neurons/day, while some models require paid billing. These are documented ceilings and capabilities, not measurements of this project. Source links and access/update dates are in [REFERENCES.md](../../REFERENCES.md).

## Decision

Use the following logical modules in one low-volume serverless deployment:

| Component | Prototype choice | Responsibility |
| --- | --- | --- |
| Web | React/TypeScript static assets on Cloudflare Workers | Map, feed, detail, in-site updates and moderator UI. Static asset requests are free and unlimited. The UI can load if the API/database is unavailable; it must then show unavailable/stale coverage clearly. |
| Application/API | Modular TypeScript Worker using same-origin `/api/v1` routes | L4 authentication, request validation, deterministic publication policy, published projections and bounded reads. Public request handlers never scrape or call models. |
| Background execution | Cloudflare Workflows with a small number of Cron triggers | Distinct, bounded L1 acquisition/preprocessing jobs and L3 investigation workflow. L1 is not implemented as an agent. Each invocation performs a small unit of work. |
| Durable project state | Neon Free PostgreSQL, with PostGIS and pgvector enabled after compatibility testing | Source revisions, evidence, spatial metadata, vectors, event/impact versions, audit state, outbox, job/checkpoint counters and quota-use records. |
| Worker-to-database path | Hyperdrive Free with a PostgreSQL driver | Reuse pooled connections. Use short, bounded SQL queries; count each statement against the daily allowance. |
| Models | Capability adapters; Workers AI Free may be evaluated | Deterministic parsing first, separate classification/extraction and embedding/reasoning capabilities. Only models available without payment may enter the target profile; no paid provider or automatic paid fallback. A mocked adapter remains the offline test path. |

Keep source connector, normalization, entity extraction, retrieval, investigation, policy and presentation modules logically separate even though they are packaged into a small number of Cloudflare deployments. The UI and API must read the deployment-selected dataset; clients cannot switch a demo instance to live data. Store L3's event-specific hard counters in Neon and recheck them before each workflow action; platform retries cannot reset the investigation budget.

## Free-tier operating rules

- Treat quota values as ceilings. Add application-level counters and conservative stop thresholds before the documented limit; the exact headroom is set during the compatibility run. Never rely on quota failure as the normal stop mechanism.
- If a quota, Worker CPU, model, or Neon compute limit is reached, stop new acquisition/inference and leave affected cases unresolved or held for moderation. Preserve already published records when the database is available, report source health and last update, and do not label degraded data current. There is no silent upgrade path.
- Neon scale-to-zero creates cold-start delay and the compute quota can suspend connections for the rest of the monthly period. Separate warm and cold API latency in reports. When Neon is unavailable, serve the static shell and an explicit data-unavailable state; do not serve stale cached warnings as current.
- Keep the demonstration corpus small enough for the Neon storage/network limits. Alert and pause automated intake before the storage cap; do not delete current evidence or audit rows to make room. Build reproducible synthetic fixtures for data that can be recreated.
- Neon Free's restore history and single manual snapshot do not satisfy a 30-day external backup policy. Use synthetic/historical demo data only until the team proves a free encrypted off-provider export, retention and deletion-replay path. Do not claim disaster recovery for live data before that rehearsal.
- Model quota exhaustion, provider throttling or a free-model access change must produce an explicit `AI unavailable`/review-needed result. No paid fallback, mandatory paid account, persistent GPU, or paid monitoring is permitted by the current acceptance path.

## Alternatives and trade-offs

- **Single VPS with FastAPI and PostgreSQL:** previously proposed in ADR-001. It offers more predictable process and database control but requires a host, continuous database capacity and a backup arrangement. Superseded because it conflicts with the user's free-tier target.
- **Neon alone with a direct Worker connection:** possible, but Hyperdrive is the recommended Cloudflare path and reduces per-invocation connection setup. Validate actual query behavior with the chosen driver.
- **Cloudflare D1:** free-tier option, but the project needs PostGIS and pgvector-compatible relational retrieval. Keep Neon Postgres as the selected database and verify extension support on the target plan.
- **Always-on production service:** not achievable as a promise under these free quotas. A live safety coverage claim, guaranteed polling interval, sustained public load or guaranteed recovery needs a new measured design decision and potentially resources outside this no-spend target.

## PLATFORM-01 evidence — 24 September 2026

The local WSL Ubuntu-26.04 prototype passed typecheck, all 9 tests, smoke, and build/Wrangler dry-run. Against the local Vite-to-Wrangler proxy, 50 sequential warm reads measured p50/p95 of 15.469/18.332 ms for context (106-byte response) and 16.372/21.086 ms for events (1,403-byte response). The Vite build emitted 259.69 kB JavaScript and 21.41 kB CSS; the Wrangler dry-run bundle was 9.46 KiB uncompressed. These measurements include local runtime/proxy costs and do not measure Cloudflare CPU, hosted latency, database queries, or Neon transfer.

The report [PLATFORM_COMPATIBILITY.md](../PLATFORM_COMPATIBILITY.md) records the source-backed limits, arithmetic sensitivity scenarios, failure actions, and untested items. Neon’s current plan table and FAQ, updated 17 and 23 September respectively, confirm 100 CU-hours/project/month; the 50-CU figure in its older 2025 pricing article is superseded by the provider’s November 2025 update. Neon documentation lists PostGIS and pgvector support by PostgreSQL major version, with pgvector available on every plan. No Free resource was created, so extension activation, Hyperdrive behavior, Neon cold starts, Workflow budgets, and Workers AI access remain untested.

## Acceptance gates and unresolved decisions

PLATFORM-01 completed the local measurements described above, but this does not satisfy provider-side tests. Authorized later integration must still measure deployed Worker CPU, SQL statements/request, Workflow steps and replay, Free model access/Neuron use, extension activation on the selected PostgreSQL version, Neon cold/warm latency, and actual data/egress growth; exercise quota failures without a paid fallback or false-current display. BOOT-01 must remain runnable without provider secrets using synthetic fixtures and mocked models.

Still open: model/version choice after Indonesian evaluation; a free off-provider backup/export mechanism; database region and data residency; source access/reuse rights; map tile/geocoder service and its own free-use terms; quota stop thresholds from measured workload; provider logging retention; and whether the demo can meet the desired response-time target after Neon cold starts. These do not prevent local fixture development. They prevent unreviewed live-source activation or a production-safety claim.

Affected requirements: FR-02/07/08/14/15 and NFR-02/04/05/06/07/08. This decision authorizes a design target only, not creating provider resources, publishing a deployment or enabling live data.
