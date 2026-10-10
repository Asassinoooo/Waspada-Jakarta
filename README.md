# Waspada Jakarta — Team 12

Start with the **[Software Development Plan](SOFTWARE_DEVELOPMENT_PLAN.md)** for the complete project scope, requirements, milestones and acceptance gates. The [implementation backlog](docs/IMPLEMENTATION_BACKLOG.md) defines the work packages. Local agent instructions are retained in the Git-ignored `AGENTS.md` file.

This repository contains the engineering plan and partial prototype. The published-incident demo uses synthetic scenarios and read-only moderator review. A separate **Demo sumber** page adds a dated real OpenStreetMap facility snapshot, an interactive OSM basemap and explicit bounded OSM/PetaBencana source requests. Source previews are unreviewed and never enter published incident APIs. The five layers also have locally tested ingestion, grounding, bounded investigation and publication components; production model providers, database connections, authenticated publication and hosted deployment remain inactive. Broader source rights and human-reviewed evaluation remain pending. Local development/testing uses WSL; see the [bootstrap guide](docs/BOOTSTRAP.md) and [delivery log](docs/DELIVERY_LOG.md).

## Try the source/map demo locally

From WSL Ubuntu-26.04 with native Linux Node on `PATH`, run `npm run dev`, then open [Demo sumber](http://localhost:5173/#demo-sumber). No API key, model service or cloud account is needed. The default contains 100 dated reference points in a bounded central-Jakarta sample; it is incomplete and does not show facility readiness. **Ambil data sumber** explicitly requests OSM facilities and PetaBencana flood reports from the previous 24 hours. A source can return empty or unavailable; neither result establishes safety. Return to the dated snapshot at any time. Internet is required for the basemap and source refreshes.

See [data integration and demo flow](docs/DEMO_DATA_INTEGRATION.md) for the source terms, typed preview contract and request limits. This demo performs deterministic L1 acquisition/validation and a separate L4 preview; model/RAG and L3 investigation are not invoked. It does not persist to Neon or deploy to Cloudflare. Ordinary OSM tiles use visible attribution and browser caching; automated browser checks stub tiles rather than downloading them.

GitHub remote: [Asassinoooo/Waspada-Jakarta](https://github.com/Asassinoooo/Waspada-Jakarta), configured locally as `origin`. Root periodically pushes reviewed, integrated checkpoints; implementation agents commit on their own task branches and do not push.

The current report is the [Google Docs project overview](https://docs.google.com/document/d/1xwSzLJmsHau6jlNGQCZ3deaVnrvCyqS0oNyDZaTv6tM). Google Docs is the maintained report format; the previous LaTeX files are historical and are no longer updated or compiled.

## Current design documents

- [Project plan](PROJECT_PLAN.md): users, event coverage, application scope, five layers and delivery.
- [Architecture](ARCHITECTURE.md): layer responsibilities, model/grounding strategy, investigation limits, publication interfaces and monitoring.
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
