# ADR-065 — Hosted topology: Cloudflare Worker and Neon Free, with ingestion on the owner's PC

- **Status:** Accepted on 16 November 2026 by owner decision (HOSTED-01). **Not implemented.** The hosted topology is not built or deployed. `npm run serve:hosted-ingest` does not exist on `main` or on any HOSTED branch, and `apps/worker/wrangler.toml` has no Hyperdrive or static-assets binding.
- **Date:** 2026-11-16
- **Owner:** Team 12
- **Scope:** deployment topology and hosted-only publication settings. It amends the hosted rule of the 11 Nov 2026 amendment to [ADR-061](ADR-061-agent-driven-publication.md); the 11 Nov amendment said that any change to that rule needs a new ADR, and this is that ADR. It builds on [ADR-010](ADR-010-cloudflare-neon-free.md) (Cloudflare Workers and Neon Free). Affects `apps/web/dist` (static assets), the planned `serve:hosted-ingest` entry point, `AUTO_PUBLISH_SOURCE_PERMISSION`, the password hash in `apps/worker/src/accounts/password.ts` ([ADR-060](ADR-060-password-accounts.md)), and [SOURCE_CLEARANCE_PLAN.md](../SOURCE_CLEARANCE_PLAN.md). No migration, no change to the public DTOs, and no change to the publication gate's checks.

## Context

- The repository has no public deployment. The course assignment needs a public URL this week.
- ADR-010 chose Cloudflare Workers and Neon Free, and nothing may require a paid tier. The Worker in this repository defines no cron trigger (`apps/worker/wrangler.toml`), so scheduled ingestion does not run in deployment today (`docs/testing/TEST-SUMMARY.md`, section 7, item 11).
- Local live mode (`npm run serve:live`) runs ingestion, the AI runner and the pollers on the owner's PC. The 11 Nov 2026 amendment to ADR-061 said that hosted or public deployments must keep `AUTO_PUBLISH_SOURCE_PERMISSION=required`, so that a hosted site fails closed.

## Decision

1. **Topology.**
   - A Cloudflare Worker on Workers Free serves the public `/api/v1` routes and the static web assets built to `apps/web/dist`. A Hyperdrive binding connects the Worker to Neon.
   - Neon Free Postgres is the only database. Every connection uses `sslmode=require`.
   - Ingestion, the AI runner (`apps/intelligence`) and the pollers (PetaBencana, BMKG and the 14 RSS feeds) run on the owner's PC through `npm run serve:hosted-ingest`, which writes to Neon. This script is planned and not yet built.
   - The Worker has no cron trigger and no NineRouter access. Model calls happen only on the PC.
   - **Consequence:** the hosted site is only as live as the PC. While the PC is off, nothing new is collected or published. Freshness transitions are run by the PC job (the `serve:live` timer; the Worker has no cron). Whether a passed `review_due_at` still shows `needs_update` while the PC is off is not verified.
2. **Hosted auto-publish.** The hosted site runs auto-publish with `AUTO_PUBLISH_SOURCE_PERMISSION=local_relaxed` (owner decision, 16 Nov 2026). This amends the hosted rule in the 11 Nov amendment to ADR-061. The other automatic checks still apply: no discrepancy, a `primary_initial` or `corroborating` correlation, supported and quoted claims, allowed labels, an `https` source link, a valid schema, and a location and an event time from the source. Discrepancies still wait for a moderator. The moderator publish path has no waiver and is unchanged.
3. **Ingestion acceptance.** Each of the 16 sources below must have at least one successful fetch on staging, and again within the first hour of production. The table is filled in when each step is measured.

**Not chosen (owner decisions, 16 Nov 2026):** scheduled ingestion through a cron trigger on the Worker, and model calls from the Worker.

## Limitations (recorded by the owner, 16 Nov 2026)

1. **Rights: `local_relaxed` on hosted auto-publish.** The source-permission check is waived for all 14 RSS outlets, PetaBencana and BMKG. This is recorded as a rights limitation, not a clearance. It amends the ADR-061 note. `docs/SOURCE_CLEARANCE_PLAN.md` still says that BMKG and ANTARA need permission, and it does not cover the other RSS outlets. The SDP section 10 Rights line still says that hosted or public use is not permitted. This ADR does not change that line; the owner must decide its wording.
2. **No off-provider backup.** There is no 30-day encrypted off-provider backup and no deletion-replay rehearsal (SDP section 10, Phase 3 limitations; `docs/PLATFORM_COMPATIBILITY.md`, line 17). Neon Free's restore history is also limited (`docs/PLATFORM_COMPATIBILITY.md`, line 57).
3. **SSE is per isolate, so the web polls.** Server-sent event streams are held per Worker isolate, so the hosted web app polls the public routes instead of relying on SSE.
4. **No pipeline status on the hosted site.** `#alur-agen` shows no pipeline status on the hosted site.
5. **PBKDF2 cost: unmeasured.** The current cost is 100,000 iterations (`apps/worker/src/accounts/password.ts`, `PASSWORD_HASH_ITERATIONS`). The count is lowered only if a measured login CPU time is too high for the Workers Free CPU limit. A lowered count is applied with a rehash on the next login. This rehash procedure is decided but not implemented. The verifier rejects stored counts below 10,000 (`MIN_STORED_ITERATIONS`). **Measured outcome: pending measurement.**
6. **Source revocation is unchanged.** Revoking a source also turns off its collection, which conflicts with FR-16 (SDP section 10). This is an owner decision that is still open. It is not decided here.

**Related, not one of the six owner limitations.** The F-04 publication check reads `investigation_id` and `case_status`. The L4 publication role cannot read these on hosted grants today, so the check fails closed on hosted (SDP section 10; `docs/testing/DEFECTS.md`, F-04).

## Ingestion acceptance (per source; pending measurement)

Source IDs are taken from `apps/worker/src/runtime/news-poll-runtime.ts` (`DEFAULT_NEWS_FEEDS`), `apps/worker/src/runtime/bmkg-poll-runtime.ts` and `apps/worker/src/layers/l1-data-knowledge/petabencana-ingest.ts` (PetaBencana). The cells stay empty until each fetch is measured.

| # | Source ID | Kind | First successful fetch, staging | First successful fetch, first hour of production | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | `source-antara-metro` | RSS | | | pending |
| 2 | `source-antara-hukum` | RSS | | | pending |
| 3 | `source-antara-terkini` | RSS | | | pending |
| 4 | `source-antara-topnews` | RSS | | | pending |
| 5 | `source-antara-humaniora` | RSS | | | pending |
| 6 | `source-antara-wartabumi` | RSS | | | pending |
| 7 | `source-detik-news` | RSS | | | pending |
| 8 | `source-detik-utama` | RSS | | | pending |
| 9 | `source-cnn-nasional` | RSS | | | pending |
| 10 | `source-cnn-utama` | RSS | | | pending |
| 11 | `source-cnbc-news` | RSS | | | pending |
| 12 | `source-sindonews-nasional` | RSS | | | pending |
| 13 | `source-sindonews-daerah` | RSS | | | pending |
| 14 | `source-tempo-nasional` | RSS | | | pending |
| 15 | `petabencana` | PetaBencana | | | pending |
| 16 | `source-bmkg-gempa` | BMKG | | | pending |

Row 15 uses the poll runtime's default ID (`PETABENCANA_SOURCE_ID`). `apps/worker/src/layers/l1-data-knowledge/source-status.ts` uses `source-petabencana`, and the live seed registers only the RSS feeds. Confirm the ID that rows are written under on staging before filling in this row.

## Consequences

- The hosted site shows what the PC last published. Its liveness depends on the PC.
- Hosted auto-publish now waives the same rights check as local live mode. Every other gate check is unchanged.
- Hosted use of collected text stays a rights decision for the owner (see limitation 1).

## Not implemented and not verified

- Whether a passed `review_due_at` shows `needs_update` on the hosted site while the PC is off is not verified. The transitions run from the PC job, not from the Worker.
- `serve:hosted-ingest` is absent from `package.json` on `main` and on the HOSTED-02 to HOSTED-05 branches, which have no commits beyond `main` (checked 16 Nov 2026).
- `apps/worker/wrangler.toml` has no Hyperdrive binding, no static-assets binding and no cron trigger.
- No staging environment, no production deployment, no Neon connection check, and no PBKDF2 CPU measurement exist.
- This ADR is documentation only. No test, typecheck or build was run for it.
