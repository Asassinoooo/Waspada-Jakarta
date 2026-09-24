# Waspada Jakarta — Team 12

Start with the **[Software Development Plan](SOFTWARE_DEVELOPMENT_PLAN.md)** for the complete project scope, requirements, milestones and acceptance gates. The [implementation backlog](docs/IMPLEMENTATION_BACKLOG.md) defines the work packages. Local agent instructions are retained in the Git-ignored `AGENTS.md` file.

This is the local Git repository for the engineering plan and prototype. Source feasibility, domain contracts and UI/API specifications are accepted design baselines; BOOT-01 supplies the local synthetic UI/API shell and UI-00 adds fixture-backed discovery, event detail, map, and read-only evidence review screens. PLATFORM-01's local compatibility report is accepted, but Cloudflare/Neon provider fit remains unverified and the recovery gate still blocks live-source persistence. The complete product and live integrations remain in progress. Deployment targets Cloudflare Workers and Neon Free for a low-volume class demo, subject to measured quota and recovery gates. Local development/testing uses WSL; start with the [local bootstrap guide](docs/BOOTSTRAP.md). See the [delivery log](docs/DELIVERY_LOG.md) for reviews and remaining work.

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

PLATFORM-01 documented Cloudflare Workers and Neon Free compatibility using WSL and current official documentation, without creating cloud resources or enabling live data. Its ceilings and sensitivity estimates inform DATA-01; actual provider behavior and the required off-provider recovery path remain unverified. The supplied course lecture deck and earlier deliverables are retained as source/history, not current architecture specifications.
