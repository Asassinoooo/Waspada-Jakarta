# Waspada Jakarta

**Informasi insiden Jakarta yang tenang, berbasis bukti, dan jujur soal ketidakpastian.**
*Calm, evidence-first incident information for Jakarta residents and visitors.*

Waspada Jakarta helps people understand a reported incident in Jakarta. It tries to answer what happened, whether it may affect them, how current the information is, and what evidence supports it. It collects reports from public sources, uses AI to structure and cross-check them, and publishes an incident only after a human moderator has reviewed the evidence.

> ⚠️ **University prototype — not an emergency service.** Waspada Jakarta is a Team 12 project for a Software Engineering (*Rekayasa Perangkat Lunak*) course. It is not hosted publicly, it is not a dispatcher, and it never declares an area "safe". In an emergency, contact **112**.

---

## Highlights

- **Evidence before claims.** Every published statement links back to the exact source text that supports it. Contrary evidence, source status and timestamps are preserved, not overwritten.
- **Human-in-the-loop publication.** AI drafts proposals; moderators review them in an interactive evidence view (`#tinjau-bukti`). Model confidence or valid JSON alone is never treated as proof.
- **Honest freshness.** Lifecycle, evidence status, freshness and personal relevance are tracked separately. "No new reports" or an expired notice is never presented as "resolved" or "safe".
- **Multi-source monitoring.** The local live mode polls PetaBencana flood reports, BMKG weather and earthquake alerts, and 14 Indonesian news RSS feeds. Feeds pass a deterministic relevance filter and a structured triage gate before any AI processing.
- **Map-first web experience** in Bahasa Indonesia. It includes report lists, incident details and history, a source map with OpenStreetMap facilities, local interest preferences, and a 3D view of the evidence embedding space.
- **Accounts and roles.** Optional username and password accounts (Google sign-in was removed by AUTH-PW-01, [ADR-060](docs/decisions/ADR-060-password-accounts.md)), with server-assigned user, moderator and admin roles. Self sign-up always creates a user. Public browsing works without an account, on the web and on Android.
- **Android reader** built with Flutter.

## How it works

The system is organised into five layers ([architecture](ARCHITECTURE.md), [diagram](docs/diagrams/five-layer-architecture.svg)):

| Layer | Role |
| --- | --- |
| **L1 Data & Knowledge** | Acquire approved sources, clean and triage them, chunk text, store evidence, geometry and embeddings |
| **L2 Model & Grounding** | Retrieve existing evidence first, then extract structured, citation-bound incident proposals |
| **L3 Investigation** | Investigate remaining gaps within fixed budgets, with checkpoints and audit trails |
| **L4 Application Integration** | Public and moderation APIs, accounts, the publication gate and public projections |
| **L5 Evaluation & Monitoring** | Quality, latency, cost and source-health telemetry across all layers |

```
Sources (PetaBencana · BMKG · news RSS)
   → triage gate + deterministic filter
   → report revisions & evidence chunks
   → AI job queue → interpretation · embedding · correlation
   → incident proposals → moderator review → published event versions → public views
```

## Tech stack

| Area | Technology |
| --- | --- |
| Web | React 19, Vite, Three.js |
| API | Cloudflare Workers (TypeScript) |
| Data | PostgreSQL + PostGIS + pgvector (PGlite for local/test) |
| AI pipeline | Mastra agents, OpenAI-compatible gateway, 768-dim embeddings |
| Mobile | Flutter / Dart (Android) |
| Planned hosting | Cloudflare Workers + Neon (free tiers) |

## Getting started

Requires Node.js 24 (developed and tested on WSL Ubuntu). Clone the repo and install:

```sh
npm ci
```

**Demo mode** uses synthetic, clearly labelled data and needs no API keys:

```sh
npm run dev
# Web: http://127.0.0.1:5173/#beranda   ·   API: http://127.0.0.1:8787/api/v1
```

You can try the source map at `#demo-sumber`. It shows a dated OpenStreetMap facility snapshot and has buttons for bounded PetaBencana, Open-Meteo and USGS requests. Map clusters count loaded records only. They do not indicate danger or corroboration.

**Local live mode** makes real network and model calls. It needs a model gateway configured in an untracked `.env.local` (see [`.env.example`](.env.example)):

```sh
npm run build:web
npm run serve:live
# Web: http://127.0.0.1:5173 · Moderator review: #tinjau-bukti · 3D embeddings: #visualisasi-3d
```

**Optional demos**
- **Synthetic accounts** (no external sign-in): `npm run accounts:local -- --enable --demo --state accounts-demo`, then `WASPADA_LOCAL_ACCOUNTS=true npm run dev`. See the [accounts guide](docs/ACCOUNTS_AND_ONBOARDING.md).
- **Mocked private pipeline:** `npm run pipeline:local -- --enable --once --state demo`. See the [pipeline guide](docs/LOCAL_PRIVATE_PIPELINE.md).
- **Android:** see [apps/mobile/README.md](apps/mobile/README.md).

## Testing

```sh
npm run typecheck
npm test          # all workspace suites (mocked providers, no external network)
npm run build     # Vite build + Worker dry-run (no deployment)
```

Routine tests use fixtures and mocked model providers. Database tests run each file in its own process on in-memory PGlite. See the [unit test report](DOKUMENTASI_UNIT_TESTING.md) (Indonesian) for the course test documentation.

## Repository layout

```
apps/web           React web app
apps/worker        Cloudflare Worker API (layers L1–L5)
apps/db            SQL migrations, stores, PGlite tests
apps/intelligence  Mastra AI job runner and agents
apps/mobile        Flutter Android client
tools/             Local servers, pipelines, evaluation and AI tooling
docs/              Plans, ADRs, contracts, API spec, assignments
```

## Project status

| Area | Status |
| --- | --- |
| Demo web app, source map, accounts (synthetic) | Working locally |
| Local live mode (real feeds + AI + moderator review) | Accepted locally, 8 Nov 2026 |
| Android reader | Working locally (debug build) |
| Hosted deployment (Cloudflare / Neon) | Not yet deployed |
| Source reuse rights for public/hosted use | Pending ([clearance plan](docs/SOURCE_CLEARANCE_PLAN.md)) |
| Human-reviewed evaluation casebook | Pending |

Known issues and planned fixes are tracked in the [implementation backlog](docs/IMPLEMENTATION_BACKLOG.md).

## Documentation

- [Software Development Plan](SOFTWARE_DEVELOPMENT_PLAN.md): scope, requirements, milestones and acceptance gates
- [Project plan](PROJECT_PLAN.md) and [architecture](ARCHITECTURE.md)
- [Domain model](docs/DOMAIN_MODEL.md), [typed contracts](docs/contracts.schema.json) and [UI/API spec](docs/UX_API_SPEC.md) / [OpenAPI](docs/api/openapi.yaml)
- [Source verification plan](SOURCE_VERIFICATION_PLAN.md), [source feasibility](docs/SOURCE_FEASIBILITY.md) and [clearance plan](docs/SOURCE_CLEARANCE_PLAN.md)
- [AI model integration plan](docs/AI_MODEL_INTEGRATION_PLAN.md)
- [Cloudflare/Neon Free decision](docs/decisions/ADR-010-cloudflare-neon-free.md) and [platform compatibility](docs/PLATFORM_COMPATIBILITY.md)
- [Architecture decision records](docs/decisions/README.md)
- [Developer handoff](HANDOFF.md) and [delivery log](docs/DELIVERY_LOG.md)
- [Project report (Google Docs)](https://docs.google.com/document/d/1xwSzLJmsHau6jlNGQCZ3deaVnrvCyqS0oNyDZaTv6tM)

## Data sources & attribution

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors. Flood reports from [PetaBencana.id](https://petabencana.id). Weather and earthquake information from [BMKG](https://www.bmkg.go.id), [Open-Meteo](https://open-meteo.com) and [USGS](https://earthquake.usgs.gov). News items link back to their original publishers. Each source's terms apply, and source text is treated as data, never as instructions.

## Team

Built by **Team 12** for the Software Engineering (RPL) course. See the [contributors](https://github.com/Asassinoooo/Waspada-Jakarta/graphs/contributors).
