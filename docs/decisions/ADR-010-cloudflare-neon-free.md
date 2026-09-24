# ADR-010 — Cloudflare Workers and Neon Free target

- **Status:** Accepted as the prototype deployment target; implementation and quota fit remain unverified. No provider resources were created.
- **Date:** 24 September 2026
- **Owners:** Team 12; platform implementation led by Jesaya and Perry

## Context

The user selected Cloudflare and Neon Free for later deployment and requires the planned system to work without a paid tier. This is a class prototype handling a bounded demonstration dataset. It must retain the five logical AI layers, L1 source processing outside L3, L2 grounding before investigation, and a deterministic L4 publication gate. The current repository contains specifications and fixtures, not a running system.

The providers publish hard ceilings: Workers Free allows 100,000 requests/day, 10 ms CPU per HTTP/Cron/Workflow invocation, 128 MB memory, 50 subrequests per request and six concurrent outbound connections per request. An account has at most five Cron triggers. Workflows Free allows 3,000 steps/day. Hyperdrive Free allows 100,000 SQL statements/day. Neon Free allows 100 CU-hours, 0.5 GB database storage and 5 GB public transfer per project/month; compute scales to zero after five idle minutes, instant restore covers at most six hours or 1 GB of changes, and one manual snapshot is available. Workers AI offers 10,000 Neurons/day at no cost, but some models require a paid plan. Exact sources are listed in [REFERENCES.md](../../REFERENCES.md).

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

## Acceptance gates and unresolved decisions

PLATFORM-01 must test a representative demo workload from WSL; measure warm/cold API latency, Worker CPU per route, SQL statements/request, Workflow steps per pipeline/investigation, Free model access and neuron consumption, PostGIS/pgvector availability, and data/egress growth. It must run a quota-exhaustion simulation and confirm no paid fallback or false-current display. BOOT-01 must remain runnable without provider secrets using synthetic fixtures and mocked models.

Still open: model/version choice after Indonesian evaluation; a free off-provider backup/export mechanism; database region and data residency; source access/reuse rights; map tile/geocoder service and its own free-use terms; quota stop thresholds from measured workload; provider logging retention; and whether the demo can meet the desired response-time target after Neon cold starts. These do not prevent local fixture development. They prevent unreviewed live-source activation or a production-safety claim.

Affected requirements: FR-02/07/08/14/15 and NFR-02/04/05/06/07/08. This decision authorizes a design target only, not creating provider resources, publishing a deployment or enabling live data.
