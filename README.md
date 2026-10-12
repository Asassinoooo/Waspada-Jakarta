# Waspada Jakarta — Team 12

Start with the **[Software Development Plan](SOFTWARE_DEVELOPMENT_PLAN.md)** for the complete project scope, requirements, milestones and acceptance gates. The [implementation backlog](docs/IMPLEMENTATION_BACKLOG.md) defines the work packages. Local agent instructions are retained in the Git-ignored `AGENTS.md` file.

This repository contains the engineering plan and partial prototype. The published-incident demo uses synthetic scenarios and read-only moderator review. A separate **Demo sumber** page adds a dated real OpenStreetMap facility snapshot, an interactive OSM basemap and explicit bounded OSM/PetaBencana source requests. Source previews are unreviewed and never enter published incident APIs. The five layers also have locally tested ingestion, grounding, bounded investigation and publication components; production model providers, database connections, authenticated publication and hosted deployment remain inactive. Broader source rights and human-reviewed evaluation remain pending. Local development/testing uses WSL; see the [bootstrap guide](docs/BOOTSTRAP.md) and [delivery log](docs/DELIVERY_LOG.md).

## Try the source/map demo locally

From WSL Ubuntu-26.04 with native Linux Node on `PATH`, run `npm run dev`, then open [Demo sumber](http://localhost:5173/#demo-sumber). No API key, model service or cloud account is needed. The default contains 100 dated OSM reference points in a bounded central-Jakarta sample; it is incomplete and does not show facility readiness. **Ambil fasilitas & banjir** explicitly requests OSM facilities and PetaBencana reports; **Ambil cuaca & gempa** requests weather forecasts and the regional USGS catalog. Source points share one map with a linked list. Numbered groups count loaded records per provider, expand on zoom, and do not represent danger or corroboration. A source can return empty or unavailable; neither result establishes safety. Snapshot/context resets require no acquisition. Internet is required for the basemap and source refreshes.

See [data integration and demo flow](docs/DEMO_DATA_INTEGRATION.md) for the source terms, typed preview contract and request limits. This demo performs deterministic L1 acquisition/validation and a separate L4 preview; model/RAG and L3 investigation are not invoked. It does not persist to Neon or deploy to Cloudflare. Ordinary OSM tiles use visible attribution and browser caching; automated browser checks stub tiles rather than downloading them.

## Test the private AI gateway locally

From the repository root in WSL, `npm run ai:smoke` stays disabled and makes no model calls. The explicit `npm run ai:smoke:live` command loads ignored `.env.local` variables `NINEROUTER_URL` and `NINEROUTER_KEY`, checks the exact `Waspada-Jakarta` / `gemini/gemini-embedding-2-preview` aliases, and exercises five typed capabilities with authored synthetic reports. It writes only a safe private manifest under ignored `.codex-build`; it does not execute investigation tools, persist to Neon or publish events. The map/source demo remains independent. See [the test guide, bounds and actual results](docs/PRIVATE_AI_GATEWAY_TESTING.md).

The local code checks pass, but no complete live smoke has passed: the latest extraction call timed out at25 seconds and a separate45-second probe also timed out. Classification, embedding768, reasoning and planner were accepted in the latest run. Inspect gateway/upstream extraction availability and latency before another live test or production activation.

GitHub remote: [Asassinoooo/Waspada-Jakarta](https://github.com/Asassinoooo/Waspada-Jakarta), configured locally as `origin`. Root periodically pushes reviewed, integrated checkpoints; implementation agents commit on their own task branches and do not push.

The current report is the [Google Docs project overview](https://docs.google.com/document/d/1xwSzLJmsHau6jlNGQCZ3deaVnrvCyqS0oNyDZaTv6tM). Google Docs is the maintained report format; the previous LaTeX files are historical and are no longer updated or compiled.

## Current design documents

The [local private pipeline](docs/LOCAL_PRIVATE_PIPELINE.md) is a separate, locally accepted synthetic polling/PGlite/AI composition. `npm run pipeline:local` remains disabled unless `--enable` is provided; `--enable --once` runs mocked models and private proposals in disposable state. It does not alter the source map or public event API. Startup, tests and remaining source/model/retrieval gates are documented in the guide.

- [Project plan](PROJECT_PLAN.md): users, event coverage, application scope, five layers and delivery.
- [Architecture](ARCHITECTURE.md): layer responsibilities, model/grounding strategy, investigation limits, publication interfaces and monitoring.
- [AI model integration plan](docs/AI_MODEL_INTEGRATION_PLAN.md): selected local test routes, typed adapter and opt-in synthetic CLI; public/hosted provider activation remains gated.
- [Source acquisition and verification](SOURCE_VERIFICATION_PLAN.md): source combinations, evidence rules, freshness and verification scenarios.
- [Source feasibility](docs/SOURCE_FEASIBILITY.md): dated endpoint checks, live/manual/demo delivery modes, activation gates and retention rules.
- [Domain model](docs/DOMAIN_MODEL.md): schema 2.0 relationships, state transitions and domain invariants.
- [Typed contracts](docs/contracts.schema.json) and [synthetic examples](docs/contracts.examples.json): proposed data boundaries, not a running backend.
- [UI/API specification](docs/UX_API_SPEC.md) and [OpenAPI definition](docs/api/openapi.yaml): proposed wireframes and public/moderator HTTP contracts.
- [Cloudflare/Neon Free decision](docs/decisions/ADR-010-cloudflare-neon-free.md): deployment target, hard quotas, degraded behavior and validation gates.
- [Cloudflare/Neon Free compatibility report](docs/PLATFORM_COMPATIBILITY.md): official limits, local WSL measurements, sensitivity estimates and unverified provider gates.
- [Architecture diagram](docs/diagrams/five-layer-architecture.svg): editable vector source for the report figure.
- [Reference register](REFERENCES.md): sources retained locally until the report's final bibliography is prepared.
- [Updated kickoff deck](deliverables/Waspada_Jakarta_Project_Kickoff_Layered.pptx): five-layer presentation; supersedes the earlier kickoff deck.
- [Architecture alignment record](docs/ARCHITECTURE_ALIGNMENT.md): audit findings, scope and remaining implementation work.

PLATFORM-01 documented Cloudflare Workers and Neon Free compatibility using WSL and current official documentation, without creating cloud resources or enabling live data. DATA-01 now adds a locally tested PostgreSQL/PostGIS/pgvector schema, migration runner and persistence ports. Worker/Neon integration, actual provider behavior and the required off-provider recovery path remain unverified. The supplied course lecture deck and earlier deliverables are retained as source/history, not current architecture specifications.
