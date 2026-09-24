# Waspada Jakarta — Team 12

Start with the **[Software Development Plan](SOFTWARE_DEVELOPMENT_PLAN.md)** for the complete project scope, requirements, milestones and acceptance gates. The [implementation backlog](docs/IMPLEMENTATION_BACKLOG.md) defines the work packages. Local agent instructions are retained in the Git-ignored `AGENTS.md` file.

This is the local Git repository for the engineering plan and future application. Source feasibility, domain contracts and UI/API specifications are accepted as design baselines; no runtime application has been implemented. Deployment targets Cloudflare Workers and Neon Free for a low-volume class demo, subject to measured quota and recovery gates. Local development/testing uses WSL. See the [delivery log](docs/DELIVERY_LOG.md) for reviews and remaining work.

GitHub remote: [Asassinoooo/Waspada-Jakarta](https://github.com/Asassinoooo/Waspada-Jakarta), configured locally as `origin`. Local commits are published only through an explicit push; configuring the remote alone does not upload them.

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
- [Architecture diagram](docs/diagrams/five-layer-architecture.svg): editable vector source for the report figure.
- [Reference register](REFERENCES.md): sources retained locally until the report's final bibliography is prepared.
- [Updated kickoff deck](deliverables/Waspada_Jakarta_Project_Kickoff_Layered.pptx): five-layer presentation; supersedes the earlier kickoff deck.
- [Architecture alignment record](docs/ARCHITECTURE_ALIGNMENT.md): audit findings, scope and remaining implementation work.

The next implementation task is BOOT-01: build a fixture-backed local skeleton that runs and verifies in WSL, without cloud credentials or live data. The supplied course lecture deck and earlier deliverables are retained as source/history, not current architecture specifications.
